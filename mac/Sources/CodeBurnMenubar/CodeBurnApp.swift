import SwiftUI
import AppKit
import Observation
import ServiceManagement

private let refreshIntervalSeconds: UInt64 = 30
private let nanosPerSecond: UInt64 = 1_000_000_000
private let refreshIntervalNanos: UInt64 = refreshIntervalSeconds * nanosPerSecond
private let statusItemWidth: CGFloat = NSStatusItem.variableLength
private let popoverWidth: CGFloat = 360
private let popoverHeight: CGFloat = 660
private let menubarTitleFontSize: CGFloat = 13

@main
struct CodeBurnApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

    var body: some Scene {
        // The Settings scene gives us a real macOS Settings window with the
        // standard ⌘, shortcut and the menubar "Settings…" item. Provider tabs
        // (Claude today, Codex/Cursor/etc. in follow-ups) live inside SettingsView.
        Settings {
            SettingsView()
                .environment(delegate.store)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    /// macOS 27 stops routing right-mouse events to the status-item button's
    /// target/action, so a global right-mouse-down monitor restores the menu.
    private var rightClickMonitor: Any?
    /// Debounce so the legacy action path and the global monitor can't both
    /// present the context menu for a single right-click (macOS <= 26).
    private var lastContextMenuPresentedAt: Date = .distantPast
    /// Closes the (`.applicationDefined`) popover on a genuine click OUTSIDE the
    /// app. Using applicationDefined + this monitor instead of `.transient`
    /// stops internal interactions — provider-tab clicks, and the nested quota
    /// hover popover on the Claude/Codex tabs — from dismissing the popover,
    /// while real outside clicks still close it. Installed on show, removed in
    /// popoverDidClose.
    private var outsideClickMonitor: Any?
    fileprivate let store = AppStore()
    let updateChecker = UpdateChecker()
    /// Held for the lifetime of the app to opt out of App Nap and Automatic Termination.
    private var backgroundActivity: NSObjectProtocol?
    private var pendingRefreshWork: DispatchWorkItem?
    private var refreshLoopTask: Task<Void, Never>?
    private var forceRefreshTask: Task<Void, Never>?

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Set accessory policy before the app's focus chain forms. On macOS Tahoe
        // (26.x), setting it after didFinishLaunching causes ghost status items
        // because the policy gets baked into the initial focus chain.
        NSApp.setActivationPolicy(.accessory)
    }

    private func observeSubscriptionDisconnect() {
        NotificationCenter.default.addObserver(
            forName: .codeBurnSubscriptionDisconnected,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.resetSubscriptionCadenceAnchor()
            }
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        ProcessInfo.processInfo.automaticTerminationSupportEnabled = false
        ProcessInfo.processInfo.disableSuddenTermination()
        backgroundActivity = ProcessInfo.processInfo.beginActivity(
            options: [.automaticTerminationDisabled, .suddenTerminationDisabled],
            reason: "CodeBurn menubar background refresh"
        )

        restorePersistedCurrency()
        setupStatusItem()
        setupPopover()
        observeStore()
        startRefreshLoop()
        setupWakeObservers()
        setupDistributedNotificationListener()
        installLaunchAgentIfNeeded()
        registerLoginItemIfNeeded()
        observeSubscriptionDisconnect()
        warnOnUntrustedBinaryPath()
        Task { await updateChecker.checkIfNeeded() }
    }

    private func setupWakeObservers() {
        // Pause the refresh loop while the machine is asleep. Without this,
        // Task.sleep keeps a wakeup pending across the suspension and the
        // loop tick fires the same instant the wake notifications do,
        // producing 2-3 concurrent CLI spawns within ms of every wake.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.willSleepNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.forceRefreshTask?.cancel()
                self?.forceRefreshTask = nil
                self?.refreshLoopTask?.cancel()
                self?.refreshLoopTask = nil
            }
        }

        // didWakeNotification + screensDidWakeNotification can both fire on
        // the same wake. forceRefresh has a 5-second rate-limit gate so the
        // duplicate is squashed there. Restart the refresh loop too, since
        // we cancelled it on willSleep.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.store.resetLoadingState()
                self?.forceRefresh()
                if self?.refreshLoopTask == nil { self?.startRefreshLoop() }
            }
        }

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.screensDidWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.forceRefresh() }
        }
    }

    private func setupDistributedNotificationListener() {
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("com.codeburn.refresh"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.forceRefresh() }
        }
    }

    private static let launchAgentLabel = "com.codeburn.refresh"
    private static let launchAgentFilename = launchAgentLabel + ".plist"

    private func launchAgentPath() -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/Library/LaunchAgents/\(Self.launchAgentFilename)"
    }

    private func installLaunchAgentIfNeeded() {
        let destPath = launchAgentPath()

        let plist = """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>\(Self.launchAgentLabel)</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/osascript</string>
        <string>-l</string>
        <string>JavaScript</string>
        <string>-e</string>
        <string>ObjC.import("Foundation"); $.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately("com.codeburn.refresh", $(), $(), true)</string>
    </array>
    <key>StartInterval</key>
    <integer>30</integer>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
"""

        do {
            // Read existing through SafeFile so a planted symlink at the LaunchAgents path
            // does NOT cause us to consider an attacker-controlled file as "the current
            // plist" and skip the rewrite. (SafeFile.read throws on symlinks.)
            let existing: String? = (try? SafeFile.read(from: destPath, maxBytes: 16 * 1024))
                .flatMap { String(data: $0, encoding: .utf8) }
            if existing == plist { return }

            // SafeFile.write opens the temp file with O_NOFOLLOW + O_EXCL and renames atomically;
            // a pre-planted symlink at destPath is rejected with Error.symlinkDetected.
            guard let payload = plist.data(using: .utf8) else { return }
            try SafeFile.write(payload, to: destPath, mode: 0o644)

            let unload = Process()
            unload.launchPath = "/bin/launchctl"
            unload.arguments = ["bootout", "gui/\(getuid())/\(Self.launchAgentLabel)"]
            try? unload.run()
            unload.waitUntilExit()

            let load = Process()
            load.launchPath = "/bin/launchctl"
            load.arguments = ["bootstrap", "gui/\(getuid())", destPath]
            try load.run()
            load.waitUntilExit()
        } catch {
            LogSanitizer.logSafe("LaunchAgent setup failed", error)
        }
    }

    /// Tear down the LaunchAgent installed by `installLaunchAgentIfNeeded`. Called from
    /// `applicationWillTerminate` so a user who quits CodeBurn doesn't leave an osascript
    /// firing every 30 s indefinitely.
    private func uninstallLaunchAgent() {
        let destPath = launchAgentPath()
        let bootout = Process()
        bootout.launchPath = "/bin/launchctl"
        bootout.arguments = ["bootout", "gui/\(getuid())/\(Self.launchAgentLabel)"]
        try? bootout.run()
        bootout.waitUntilExit()
        try? FileManager.default.removeItem(atPath: destPath)
    }

    private func registerLoginItemIfNeeded() {
        // SMAppService.mainApp registers the running .app as a login item without invoking
        // AppleScript or System Events. Replaces a string-interpolated AppleScript path
        // (which broke if Bundle.main.bundlePath contained a literal `"`) and removes the
        // AppleEvents privacy prompt.
        if #available(macOS 13.0, *) {
            let svc = SMAppService.mainApp
            switch svc.status {
            case .enabled:
                return
            case .requiresApproval, .notRegistered, .notFound:
                do {
                    try svc.register()
                } catch {
                    LogSanitizer.logSafe("Login item registration failed", error)
                }
            @unknown default:
                return
            }
        }
        // macOS < 13 falls through silently. The minimum supported version of the menubar
        // is 14.0 (LSMinimumSystemVersion) so this branch is dead; kept for compile-time
        // availability handling only.
    }

    private var lastRefreshTime: Date = .distantPast

    private func forceRefresh() {
        let now = Date()
        guard now.timeIntervalSince(lastRefreshTime) > 5 else { return }
        lastRefreshTime = now

        forceRefreshTask?.cancel()
        forceRefreshTask = Task {
            async let main: Void = store.refresh(includeOptimize: false, force: true, showLoading: true)
            async let today: Void = store.refreshQuietly(period: .today)
            _ = await (main, today)
            refreshStatusButton()
        }
    }

    /// Loads the currency code persisted by `codeburn currency` so a relaunch picks up where
    /// the user left off. Rate is resolved from the on-disk FX cache if present, otherwise
    /// fetched live in the background.
    private func restorePersistedCurrency() {
        guard let code = CLICurrencyConfig.loadCode(), code != "USD" else { return }
        let symbol = CurrencyState.symbolForCode(code)
        store.currency = code

        Task {
            let cached = await FXRateCache.shared.cachedRate(for: code)
            await MainActor.run {
                CurrencyState.shared.apply(code: code, rate: cached, symbol: symbol)
            }
            let fresh = await FXRateCache.shared.rate(for: code)
            if let fresh, fresh != cached {
                await MainActor.run {
                    CurrencyState.shared.apply(code: code, rate: fresh, symbol: symbol)
                }
            }
        }
    }

    fileprivate var lastSubscriptionRefreshAt: Date?

    private func startRefreshLoop() {
        refreshLoopTask?.cancel()
        refreshLoopTask = Task { [weak self] in
            // Provider refreshes only run when the user has explicitly connected.
            // Each refresh is a no-op until its corresponding bootstrap flag is set.
            if let self {
                async let claude = self.store.refreshSubscriptionReportingSuccess()
                async let codex  = self.store.refreshCodexReportingSuccess()
                if await claude { self.lastSubscriptionRefreshAt = Date() }
                if await codex   { self.lastCodexRefreshAt = Date() }
            }
            while !Task.isCancelled {
                guard let self else { return }
                // Watchdog: drop loading flags for keys whose refresh
                // attempt is past the watchdog budget. Recovers from
                // wedged-loading after sleep/wake or a network blip
                // without needing the user to relaunch the app.
                // Ports upstream PR #311 / #328 in lightweight form.
                if self.store.resetStaleLoadingState() {
                    // Watchdog actually cleared something. Treat this
                    // like a fresh tick so the popover repaints without
                    // the stale overlay even if `sinceLast` would otherwise
                    // skip below.
                    self.refreshStatusButton()
                }
                // Skip the loop's tick if a wake / manual / distributed-
                // notification refresh just ran. Without this gate, every
                // wake produced two refreshes (forceRefresh from the wake
                // observer plus the loop's natural tick).
                let sinceLast = Date().timeIntervalSince(self.lastRefreshTime)
                if sinceLast >= 5 {
                    if self.store.selectedPeriod != .today || self.store.selectedProvider != .all {
                        async let quiet: Void = self.store.refreshQuietly(period: .today)
                        // force:false so a key refreshed <30s ago by a switch/wake
                        // is served from cache instead of re-forking the CLI — the
                        // 30s tick interval otherwise exactly defeats the 30s TTL.
                        async let main: Void = self.store.refresh(includeOptimize: false, force: false)
                        _ = await (quiet, main)
                    } else {
                        await self.store.refresh(includeOptimize: false, force: false)
                    }
                    self.lastRefreshTime = Date()
                    self.refreshStatusButton()
                }
                // Cadence-driven live-quota refresh, anchored on LAST SUCCESS
                // (not last attempt) so an intermittent failure doesn't reset
                // the timer. Each provider has its own anchor so a Codex 429
                // doesn't delay a due Claude refresh.
                let cadence = SubscriptionRefreshCadence.current
                if cadence != .manual {
                    let claudeElapsed = Date().timeIntervalSince(self.lastSubscriptionRefreshAt ?? .distantPast)
                    if claudeElapsed >= TimeInterval(cadence.rawValue) {
                        let succeeded = await self.store.refreshSubscriptionReportingSuccess()
                        if succeeded { self.lastSubscriptionRefreshAt = Date() }
                    }
                    let codexElapsed = Date().timeIntervalSince(self.lastCodexRefreshAt ?? .distantPast)
                    if codexElapsed >= TimeInterval(cadence.rawValue) {
                        let succeeded = await self.store.refreshCodexReportingSuccess()
                        if succeeded { self.lastCodexRefreshAt = Date() }
                    }
                }
                try? await Task.sleep(nanoseconds: refreshIntervalNanos)
            }
        }
    }

    fileprivate var lastCodexRefreshAt: Date?

    @MainActor
    func refreshSubscriptionNow() {
        Task { [weak self] in
            guard let self else { return }
            // "Refresh Now" should refresh the menubar payload AND every
            // connected provider's live quota — the user's intent is "make
            // this match reality right now."
            async let payload: Void = self.store.refresh(includeOptimize: false, force: true, showLoading: true)
            async let claude: Bool = self.store.refreshSubscriptionReportingSuccess()
            async let codex:  Bool = self.store.refreshCodexReportingSuccess()
            _ = await payload
            if await claude { self.lastSubscriptionRefreshAt = Date() }
            if await codex  { self.lastCodexRefreshAt = Date() }
        }
    }

    /// Reset the cadence anchor so the next loop tick re-evaluates from "now"
    /// rather than measuring against a timestamp from the previous connection.
    /// Triggered on disconnect of any provider — the cost of clearing both
    /// anchors is one extra refresh tick on the unaffected provider, far less
    /// disruptive than waiting a full cadence after a reconnect.
    @MainActor
    func resetSubscriptionCadenceAnchor() {
        lastSubscriptionRefreshAt = nil
        lastCodexRefreshAt = nil
    }

    private func observeStore() {
        // Read closure uses [weak self] so the implicit self capture from
        // accessing store.* doesn't pin self for the lifetime of an
        // unfired observation. withObservationTracking is one-shot per
        // call: once any read property changes, onChange fires and the
        // registration is consumed, then we re-arm. There is at most one
        // active subscription at a time.
        withObservationTracking { [weak self] in
            guard let self else { return }
            _ = self.store.currentPayload
            _ = self.store.todayPayload
            // Track currency so the menubar title catches up immediately on
            // currency switch instead of waiting for the next 30s payload tick.
            _ = self.store.currency
            // Track the live-quota state too so the flame icon re-tints on
            // every subscription / codex usage update, not just every 30s.
            _ = self.store.subscription
            _ = self.store.subscriptionLoadState
            _ = self.store.codexUsage
            _ = self.store.codexLoadState
        } onChange: { [weak self] in
            DispatchQueue.main.async {
                guard let self else { return }
                self.pendingRefreshWork?.cancel()
                let work = DispatchWorkItem { [weak self] in
                    self?.refreshStatusButton()
                    // Surface a system notification when aggregate quota
                    // crosses a severity threshold (warn/crit/danger).
                    if let self {
                        QuotaNotifier.shared.observe(self.store.aggregateQuotaStatus)
                    }
                    self?.observeStore()
                }
                self.pendingRefreshWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: work)
            }
        }
    }

    // MARK: - Status Item

    private var isCompact: Bool {
        UserDefaults.standard.bool(forKey: "CodeBurnMenubarCompact")
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: statusItemWidth)
        guard let button = statusItem.button else { return }

        // Set a simple SF Symbol image immediately to ensure the status item renders.
        // On macOS Tahoe, status items may fail to appear if only an attributed title
        // is set during initial setup.
        let flameConfig = NSImage.SymbolConfiguration(pointSize: menubarTitleFontSize, weight: .medium)
        let flame = NSImage(systemSymbolName: "flame.fill", accessibilityDescription: "CodeBurn")?
            .withSymbolConfiguration(flameConfig)
        flame?.isTemplate = true
        button.image = flame
        button.imagePosition = .imageLeading

        button.target = self
        button.action = #selector(handleButtonClick(_:))
        // Left-click drives the popover. We keep .rightMouseUp in the mask so the
        // legacy action path below still fires on macOS <= 26; on macOS 27 the
        // system consumes the right button entirely and this never fires, so the
        // global monitor (below) is what restores the right-click menu there.
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])

        // macOS 27 no longer routes any right-mouse event to the status-item
        // button's target/action. A global monitor still observes right-mouse-down;
        // we hit-test it against our own status-item window and present the menu
        // ourselves. Harmless and stable on 15/26 too (the debounce in
        // showContextMenu prevents a double-present if the legacy path also fires).
        rightClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.rightMouseDown]) { [weak self] _ in
            guard let self,
                  let button = self.statusItem.button,
                  let window = button.window,
                  window.frame.contains(NSEvent.mouseLocation) else { return }
            DispatchQueue.main.async { self.showContextMenu(from: button) }
        }

        // Defer the full attributed title setup to ensure initial render completes
        DispatchQueue.main.async { [weak self] in
            self?.refreshStatusButton()
        }
    }

    /// Composes the menubar title as a single attributed string with the flame as an inline
    /// NSTextAttachment. NSStatusItem's separate `image` + `attributedTitle` path leaves a
    /// stubborn gap between icon and text on some macOS releases (the icon hugs the left edge
    /// of the status item, the title starts at its own baseline), so we inline both so they
    /// flow as one typographic unit with a single, controllable gap.
    private static func flameTint(for severity: QuotaSummary.Severity) -> NSColor? {
        switch severity {
        case .normal:   return nil                              // template, auto-adapt
        case .warning:  return NSColor.systemYellow            // 70-90%
        case .critical: return NSColor.systemOrange            // 90-100%
        case .danger:   return NSColor.systemRed               // 100%+
        }
    }

    /// How "lit" the menu-bar flame should be (0→1): today's spend against the
    /// daily budget if one is set, otherwise ~1.5× the typical recent day.
    private static func todayBurnFraction(store: AppStore) -> Double {
        let today = store.todayPayload?.current.cost ?? 0
        guard today > 0 else { return 0 }
        let history = store.todayPayload?.history.daily ?? []
        let recent = history.suffix(15).dropLast().map(\.cost).filter { $0 > 0 }
        let typical = recent.isEmpty ? 0 : recent.reduce(0, +) / Double(recent.count)
        let denom = store.dailyBudget > 0 ? store.dailyBudget : (typical > 0 ? typical * 1.5 : today)
        return max(0, min(today / denom, 1))
    }

    private func refreshStatusButton() {
        guard let button = statusItem.button else { return }
        // Skip while the popover is anchored to this button. Rewriting the
        // attributedTitle changes the button's intrinsic width, which makes
        // macOS reflow the status item in the menubar and detaches the
        // anchored popover (it pops to a stale default position). The
        // popoverDidClose delegate calls back through here once the popover
        // is dismissed so the menubar cost catches up immediately on close.
        if popover != nil && popover.isShown { return }

        // Clear any previously-set image so the attachment is the only glyph rendered.
        button.image = nil
        button.imagePosition = .noImage

        let font = NSFont.monospacedDigitSystemFont(ofSize: menubarTitleFontSize, weight: .medium)
        let baseConfig = NSImage.SymbolConfiguration(pointSize: menubarTitleFontSize, weight: .medium)
        // Tint the flame based on the worst-affected connected provider's quota.
        // Normal (<70%) keeps the template (auto white-on-dark / black-on-light);
        // warning/critical/danger override with a fixed palette color so the
        // user gets a glanceable signal even when the menu bar is busy.
        let aggregate = store.aggregateQuotaStatus
        // Daily-budget override: if the user has set a daily budget on the
        // Settings → Alerts panel and today's spend has crossed it, tint
        // the flame yellow so it's glanceable from the menu bar even when
        // no provider quota has hit a warning. Quota severity still wins
        // (a hard-red plan crisis matters more than budget overrun).
        // Upstream PR #349.
        let quotaTint = Self.flameTint(for: aggregate.severity)
        let overBudget = store.dailyBudget > 0
            && (store.todayPayload?.current.cost ?? 0) >= store.dailyBudget
        let tint: NSColor? = quotaTint ?? (overBudget ? .systemYellow : nil)
        let flameConfig: NSImage.SymbolConfiguration
        if let tint {
            flameConfig = baseConfig.applying(.init(paletteColors: [tint]))
        } else {
            flameConfig = baseConfig
        }
        // The flame glyph itself fills with the day's burn (0→1) on macOS 15+,
        // turning the menu-bar icon into an at-a-glance gauge; the palette tint
        // (quota/budget severity) still layers on top. Plain flat flame on 14.
        let burnFraction = Self.todayBurnFraction(store: store)
        let flame: NSImage?
        if #available(macOS 15, *) {
            flame = NSImage(systemSymbolName: "flame.fill", variableValue: burnFraction, accessibilityDescription: "CodeBurn")?
                .withSymbolConfiguration(flameConfig)
        } else {
            flame = NSImage(systemSymbolName: "flame.fill", accessibilityDescription: "CodeBurn")?
                .withSymbolConfiguration(flameConfig)
        }
        flame?.isTemplate = (tint == nil)

        let attachment = NSTextAttachment()
        attachment.image = flame
        if let size = flame?.size {
            attachment.bounds = CGRect(x: 0, y: -3, width: size.width, height: size.height)
        }

        let hasPayload = store.todayPayload != nil
        let compact = isCompact
        let fallback = compact ? "$-" : "$—"
        let formatted = store.todayPayload?.current.cost
        let valueText = compact
            ? (formatted?.asCompactCurrencyWhole() ?? fallback)
            : " " + (formatted?.asCompactCurrency() ?? fallback)

        var textAttrs: [NSAttributedString.Key: Any] = [.font: font, .baselineOffset: -1.0]
        if !hasPayload {
            textAttrs[.foregroundColor] = NSColor.secondaryLabelColor
        }

        let composed = NSMutableAttributedString()
        composed.append(NSAttributedString(attachment: attachment))
        composed.append(NSAttributedString(string: valueText, attributes: textAttrs))
        button.attributedTitle = composed
    }

    // MARK: - Popover

    private func setupPopover() {
        popover = NSPopover()
        popover.contentSize = NSSize(width: popoverWidth, height: popoverHeight)
        // .applicationDefined (not .transient): we close it ourselves via a
        // global outside-click monitor (installOutsideClickMonitor). .transient
        // dismissed the popover on internal interactions too — notably the
        // nested quota hover popover on the Claude/Codex tabs — which read as
        // "clicking a tab closes the popover". Genuine outside clicks still close it.
        popover.behavior = .applicationDefined
        popover.animates = true
        popover.delegate = self

        let content = MenuBarContent()
            .environment(store)
            .environment(updateChecker)
            .frame(width: popoverWidth)

        popover.contentViewController = NSHostingController(rootView: content)
    }

    @objc private func handleButtonClick(_ sender: AnyObject?) {
        guard let button = statusItem.button,
              let event = NSApp.currentEvent else { return }

        // Legacy right-click path for macOS <= 26 (no-op on 27, where the action
        // never receives a right-mouse event — the global monitor handles it).
        if event.type == .rightMouseUp {
            showContextMenu(from: button)
            return
        }

        if popover.isShown {
            popover.performClose(sender)
        } else {
            // Do NOT call NSApp.activate(ignoringOtherApps:) here. On macOS
            // Tahoe an accessory app activating while a popover anchors to
            // its NSStatusItem can race with the system menu bar's auto-hide
            // logic and leave the user's apple-menu hidden until the popover
            // closes. The popover's window takes keyboard focus on its own
            // via makeKeyAndOrderFront, which is enough for keystrokes to
            // reach the SwiftUI content.
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            // Sleep/wake recovery on open: if the Mac slept for hours the wake
            // notification may not have fired, leaving the refresh loop dead, a
            // wedged loading spinner, and stale data. Clear any wedged loading,
            // restart the loop if it died, and pull a fresh fetch if the visible
            // data has gone stale — so opening always shows current usage.
            store.clearWedgedLoading()
            if refreshLoopTask == nil { startRefreshLoop() }
            if store.isCurrentDataStale { forceRefresh() }
            // Warm the other common periods (all-provider) so the first click on
            // 7 Days / 30 Days / Month shows data instead of a spinner. Gated to
            // popover-open so idle machines don't spawn CLIs on a timer.
            store.warmCommonPeriods()
            if let window = popover.contentViewController?.view.window {
                // Pin the popover's window above the status-bar layer but tag
                // it as auxiliary so macOS Tahoe does not treat it as an
                // app-level focus event — that's what was hiding the system
                // menu bar (Terminal's apple-logo / Shell / Edit / View row)
                // every time the popover opened.
                window.level = .statusBar
                window.collectionBehavior.insert(.fullScreenAuxiliary)
                window.collectionBehavior.insert(.canJoinAllSpaces)
                window.makeKeyAndOrderFront(nil)
            }
            installOutsideClickMonitor()
        }
    }

    /// Global monitor that closes the popover on a mouse-down OUTSIDE the app.
    /// Clicks INSIDE the popover are local events the monitor never sees, so
    /// they no longer dismiss it (the `.transient` behavior did). Clicks on our
    /// own status item are ignored here — handleButtonClick owns that toggle, so
    /// closing here too would race it back open.
    private func installOutsideClickMonitor() {
        removeOutsideClickMonitor()
        outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            guard let self, self.popover.isShown else { return }
            if let buttonWindow = self.statusItem.button?.window,
               buttonWindow.frame.contains(NSEvent.mouseLocation) {
                return  // click landed on our status item; let handleButtonClick toggle it
            }
            self.popover.performClose(nil)
        }
    }

    private func removeOutsideClickMonitor() {
        if let monitor = outsideClickMonitor {
            NSEvent.removeMonitor(monitor)
            outsideClickMonitor = nil
        }
    }

    private func showContextMenu(from button: NSStatusBarButton) {
        // Debounce: on macOS <= 26 both the legacy action path and the global
        // monitor can fire for a single right-click. Present at most once per click.
        let now = Date()
        guard now.timeIntervalSince(lastContextMenuPresentedAt) > 0.3 else { return }
        lastContextMenuPresentedAt = now

        let menu = NSMenu()

        // Live glanceable header (non-interactive): today's spend + any quota
        // warnings — the rich status-item summary macOS users expect from a
        // right-click (Battery / Time Machine / Now Playing all do this).
        let todayCost = store.todayPayload?.current.cost
        let header = NSMenuItem(title: "Today: \(todayCost?.asCompactCurrency() ?? "—")", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        for warning in store.aggregateQuotaStatus.warnings {
            let item = NSMenuItem(title: "  \(warning.name) \(Int(warning.percent.rounded()))% of quota", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }
        menu.addItem(.separator())

        let settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

        let refreshNow = NSMenuItem(title: "Refresh Now", action: #selector(refreshNowAction), keyEquivalent: "r")
        refreshNow.target = self
        menu.addItem(refreshNow)

        menu.addItem(.separator())
        let updateItem = NSMenuItem(title: "Check for Updates", action: #selector(checkForUpdates), keyEquivalent: "")
        updateItem.target = self
        menu.addItem(updateItem)
        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "Quit CodeBurn", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        // Present directly. The previous `statusItem.menu = menu; button.performClick`
        // trick relies on the click -> action path that macOS 27 changed; popUp is
        // version-stable.
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.height + 4), in: button)
    }

    private var settingsWindowController: NSWindowController?

    @objc private func openSettings() {
        // Accessory-policy apps (no Dock icon, no main menu) don't get the
        // SwiftUI Settings scene wired into the responder chain reliably, so
        // the standard `showSettingsWindow:` selector silently no-ops. We host
        // the SwiftUI view in our own NSWindowController instead.
        if let controller = settingsWindowController {
            NSApp.activate(ignoringOtherApps: true)
            controller.window?.makeKeyAndOrderFront(nil)
            return
        }

        let hosting = NSHostingController(
            rootView: SettingsView().environment(store)
        )
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 380),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "CodeBurn Settings"
        window.contentViewController = hosting
        window.center()
        window.isReleasedWhenClosed = false
        let controller = NSWindowController(window: window)
        settingsWindowController = controller
        NSApp.activate(ignoringOtherApps: true)
        controller.showWindow(nil)
    }

    @objc private func refreshNowAction() {
        refreshSubscriptionNow()
    }

    private func codeburnAlertIcon() -> NSImage? {
        let config = NSImage.SymbolConfiguration(pointSize: 32, weight: .medium)
        guard let symbol = NSImage(systemSymbolName: "flame.fill", accessibilityDescription: "CodeBurn")?
            .withSymbolConfiguration(config) else { return nil }
        let size = NSSize(width: 64, height: 64)
        let img = NSImage(size: size, flipped: false) { rect in
            let symbolSize = symbol.size
            let x = (rect.width - symbolSize.width) / 2
            let y = (rect.height - symbolSize.height) / 2
            symbol.draw(in: NSRect(x: x, y: y, width: symbolSize.width, height: symbolSize.height))
            return true
        }
        img.isTemplate = false
        return img
    }

    @objc private func checkForUpdates() {
        Task {
            await updateChecker.check()
            let alert = NSAlert()
            alert.icon = codeburnAlertIcon()
            if updateChecker.updateAvailable, let latest = updateChecker.latestVersion {
                alert.messageText = "Update Available"
                alert.informativeText = "v\(latest) is available (you have v\(updateChecker.currentVersion)). Run:\n\ncodeburn menubar --force"
            } else {
                alert.messageText = "Up to Date"
                alert.informativeText = "You're on the latest version (v\(updateChecker.currentVersion))."
            }
            alert.alertStyle = .informational
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Make uninstall idempotent and survive force-quits separately via
        // a future cleanup CLI.
        uninstallLaunchAgent()
        NotificationCenter.default.removeObserver(self)
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        DistributedNotificationCenter.default().removeObserver(self)
        if let monitor = rightClickMonitor {
            NSEvent.removeMonitor(monitor)
            rightClickMonitor = nil
        }
    }

    /// One-shot warning at startup if the user's PATH resolves `codeburn` to a directory
    /// outside Homebrew/system locations. Defends against trivial PATH-shadowing attacks
    /// (e.g. a malicious npm postinstall planting `~/.npm-global/bin/codeburn`). We log
    /// rather than refuse because some legitimate installers (Volta, asdf, n) live under
    /// `$HOME` and the user has explicit consent.
    private func warnOnUntrustedBinaryPath() {
        let resolved = CodeburnCLI.resolveBinaryPath()
        guard let path = resolved.path else { return }
        if resolved.trusted { return }
        NSLog(
            "CodeBurn: 'codeburn' resolved to %@ (outside trusted Homebrew/system locations). " +
            "If you didn't install it there, run `which codeburn` and verify.",
            path
        )
    }

    // MARK: - NSPopoverDelegate

    func popoverShouldDetach(_ popover: NSPopover) -> Bool {
        false
    }

    func popoverDidClose(_ notification: Notification) {
        removeOutsideClickMonitor()
        // Catch up on any menubar title updates that were skipped while the
        // popover was anchored.
        refreshStatusButton()
    }
}
