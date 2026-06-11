import AppKit
import SwiftUI

/// Popover root. Assembles all sections matching the HTML design spec.
struct MenuBarContent: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(spacing: 0) {
            Header()

            Divider().opacity(0.5)

            if showAgentTabs {
                AgentTabStrip()
                Divider().opacity(0.5)
            }

            ZStack {
                if isFreshInstall {
                    FirstRunState()
                        .transition(.opacity)
                } else {
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 0) {
                        HeroSection()
                        InsetSeparator()
                        PeriodSegmentedControl()
                        InsetSeparator()
                        if isFilteredEmpty {
                            EmptyProviderState(provider: store.selectedProvider, period: store.selectedPeriod)
                        } else {
                            HeatmapSection()
                                .padding(.horizontal, 14)
                                .padding(.top, 10)
                                .padding(.bottom, 10)
                                .zIndex(10)
                            InsetSeparator()
                            ActivitySection()
                            InsetSeparator()
                            ModelsSection()
                            InsetSeparator()
                            FindingsSection()
                        }
                    }
                }
                }

                // Overlay fires only on cold cache for the current key. Three
                // states, in priority order (upstream PR #349):
                //   1. We're actively loading this key OR we've never even
                //      tried it yet — show the spinner.
                //   2. We have an explicit fetch error — show the retry card
                //      with the surfaced error text.
                //   3. We attempted, returned nothing, and have no error
                //      either — the attempt was abandoned mid-flight (e.g.
                //      after sleep/wake or a cancelled tab switch). Show a
                //      retry card with a generic explanatory message instead
                //      of an indefinite spinner.
                if !store.hasCachedData {
                    if store.isCurrentKeyLoading || !store.hasAttemptedCurrentKeyLoad {
                        BurnLoadingOverlay(periodLabel: store.selectedPeriod.rawValue)
                            .transition(.opacity)
                    } else if let err = store.lastError {
                        FetchErrorOverlay(
                            error: err,
                            periodLabel: store.selectedPeriod.rawValue,
                            retry: { Task { await store.refresh(includeOptimize: false, force: true, showLoading: true) } }
                        )
                        .transition(.opacity)
                    } else {
                        FetchErrorOverlay(
                            error: "The last refresh stopped before returning data. CodeBurn will keep retrying, or you can retry now.",
                            periodLabel: store.selectedPeriod.rawValue,
                            retry: { Task { await store.refresh(includeOptimize: false, force: true, showLoading: true) } }
                        )
                        .transition(.opacity)
                    }
                }
            }
            .frame(height: 520)
            .animation(.easeInOut(duration: 0.2), value: store.isLoading)

            Divider().opacity(0.5)

            FooterBar()

            StarBanner()
        }
        // One short, intentional accent wash at the very top replaces the
        // muddy full-height bleed. Sits over the popover's native material,
        // fades to clear by ~110pt, and is accent-agnostic across presets.
        .background(alignment: .top) {
            LinearGradient(colors: [Theme.brandAccent.opacity(0.05), .clear],
                           startPoint: .top, endPoint: .bottom)
                .frame(height: 110)
                .allowsHitTesting(false)
        }
    }

    /// A genuinely fresh install: the CLI ran and found no AI tools / no usage
    /// at all, and we're not mid-load or in an error state. Distinct from a
    /// provider-filtered empty view (which still has providers in cache).
    private var isFreshInstall: Bool {
        store.hasCachedData
            && !store.hasAnyProvidersInCache
            && store.currentPayload.current.cost == 0
            && store.currentPayload.current.calls == 0
            && store.lastError == nil
            && !store.isCurrentKeyLoading
    }

    private var isFilteredEmpty: Bool {
        guard store.selectedProvider != .all else { return false }
        if store.currentPayload.current.cost > 0 || store.currentPayload.current.calls > 0 { return false }
        if providerHasCostInAllPayload { return false }
        return true
    }

    private var providerHasCostInAllPayload: Bool {
        guard let allPayload = store.periodAllPayload else { return false }
        let providers = Dictionary(
            allPayload.current.providers.map { ($0.key.lowercased(), $0.value) },
            uniquingKeysWith: +
        )
        return store.selectedProvider.providerKeys.contains { key in
            (providers[key] ?? 0) > 0
        }
    }

    /// Show the tab row whenever the CLI detected at least one AI coding tool installed
    /// on this machine. Hidden only when nothing is detected, which means there's
    /// nothing to filter by anyway.
    private var showAgentTabs: Bool {
        // Sticky: once any cached payload has reported providers, keep the tab strip
        // visible. Without this, the strip disappears for one frame on a period
        // switch when the new key's payload is still empty.
        if store.hasAnyProvidersInCache { return true }
        let payload = store.todayPayload ?? store.currentPayload
        return !payload.current.providers.isEmpty
    }

}

/// Welcome card shown to a brand-new user before any AI tool usage is detected,
/// instead of a dead dashboard of zeros.
private struct FirstRunState: View {
    var body: some View {
        VStack(spacing: 12) {
            FlameMark(size: 42)
            Text("Start tracking your AI spend")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.primary)
            Text("CodeBurn automatically picks up usage from Claude Code, Cursor, Codex, Copilot, Gemini and more — just keep coding and your costs will show up here.")
                .font(.system(size: 11.5))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }
}

private struct EmptyProviderState: View {
    let provider: ProviderFilter
    let period: Period

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "tray")
                .font(.system(size: 26))
                .foregroundStyle(.tertiary)
            Text("No \(provider.rawValue) data for \(periodPhrase)")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }

    private var periodPhrase: String {
        switch period {
        case .today: "today"
        case .sevenDays: "the last 7 days"
        case .thirtyDays: "the last 30 days"
        case .month: "this month"
        case .all: "the last 6 months"
        }
    }
}

/// Shown when a fetch failed and the cache is still empty for this key. The
/// user previously sat on the "Loading…" spinner forever — the popover had
/// no path to recover beyond the next 30s tick (which would just re-fail).
/// Now they see what broke and can retry directly.
private struct FetchErrorOverlay: View {
    let error: String
    let periodLabel: String
    let retry: () -> Void

    var body: some View {
        ZStack {
            Rectangle().fill(.ultraThinMaterial)
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(Theme.brandAccent)
                Text("Couldn't load \(periodLabel)")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(.primary)
                Text(displayError)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
                    .lineLimit(3)
                Button("Retry", action: retry)
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.brandAccent)
                    .controlSize(.small)
            }
            .padding(.horizontal, 20)
        }
    }

    /// Strip the leading subprocess noise that creeps into NSError descriptions
    /// so the visible message is the actual cause, not the framework wrapper.
    private var displayError: String {
        let trimmed = error.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count <= 240 { return trimmed }
        return String(trimmed.prefix(240)) + "…"
    }
}

/// Inset hairline between in-body sections — softer and more macOS-native than
/// an edge-to-edge full-opacity Divider.
private struct InsetSeparator: View {
    var body: some View {
        // Hairline that fades toward its inset ends, so it reads as a soft groove
        // dissolving into the surface rather than a hard ruled line.
        Rectangle()
            .fill(LinearGradient(
                colors: [.primary.opacity(0), .primary.opacity(0.08), .primary.opacity(0)],
                startPoint: .leading, endPoint: .trailing))
            .frame(height: 1)
            .padding(.horizontal, Theme.bodyGutter)
    }
}

/// Translucent overlay that blurs whatever's behind it (the previous tab/period
/// content) and centers the animated burning flame — the brand mark filling
/// bottom-to-top in yellow→orange→red, looping. Honors Reduce Motion by showing
/// the flame statically filled instead of looping.
private struct BurnLoadingOverlay: View {
    let periodLabel: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var fillProgress: CGFloat = 0
    @State private var glowing: Bool = false
    @State private var flicker: CGFloat = 0

    private let flameSize: CGFloat = 64

    var body: some View {
        ZStack {
            // Blur backdrop -- ultraThinMaterial uses live blur of underlying content.
            Rectangle()
                .fill(.ultraThinMaterial)

            VStack(spacing: 14) {
                BurnFlame(size: flameSize, fillProgress: fillProgress, glowing: glowing, flicker: flicker)
                Text("Loading \(periodLabel)…")
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
        .onAppear {
            // Reduce Motion: skip the loop, show the flame fully lit so it still
            // reads as the brand mark.
            guard !reduceMotion else { fillProgress = 1.0; return }
            // Ignite from cold once…
            withAnimation(.easeOut(duration: 0.5)) { fillProgress = 1.0 }
            // …then breathe between half- and full-lit (never drains to empty
            // the way the old 0↔1 loop did, which read as "filling and draining").
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                withAnimation(.easeInOut(duration: 1.15).repeatForever(autoreverses: true)) {
                    fillProgress = 0.55
                }
            }
            // Outer-glow breathing + a faster, subtler candle flicker, out of
            // phase with the fill so the motion reads organic rather than pulsed.
            withAnimation(.easeInOut(duration: 1.15).repeatForever(autoreverses: true)) {
                glowing = true
            }
            withAnimation(.easeInOut(duration: 0.32).repeatForever(autoreverses: true)) {
                flicker = 1
            }
        }
    }
}

private struct BurnFlame: View {
    let size: CGFloat
    let fillProgress: CGFloat
    let glowing: Bool
    var flicker: CGFloat = 0

    var body: some View {
        ZStack {
            // Soft outer glow that pulses, matching the brand terracotta palette.
            Image(systemName: "flame.fill")
                .font(.system(size: size, weight: .regular))
                .foregroundStyle(Theme.brandAccentGlow.opacity(glowing ? 0.6 : 0.22))
                .blur(radius: glowing ? 16 : 7)

            // Empty (cool) flame as base
            Image(systemName: "flame")
                .font(.system(size: size, weight: .regular))
                .foregroundStyle(Theme.brandAccent.opacity(0.25))

            // Burning gradient (brand orange) masked by an animated bottom-up rectangle
            Image(systemName: "flame.fill")
                .font(.system(size: size, weight: .regular))
                .foregroundStyle(
                    LinearGradient(
                        colors: [
                            Theme.brandAccentGlow,
                            Theme.brandAccentLight,
                            Theme.brandAccent,
                            Theme.brandAccentDeep
                        ],
                        startPoint: .bottom,
                        endPoint: .top
                    )
                )
                .mask(
                    GeometryReader { geo in
                        Rectangle()
                            .frame(height: geo.size.height * fillProgress)
                            .frame(maxHeight: .infinity, alignment: .bottom)
                    }
                )
        }
        .frame(width: size, height: size)
        // Candle flicker: a slight width squeeze + tip rise + brightness dip,
        // anchored at the base so the flame "licks" in place without drifting.
        .scaleEffect(x: 1 - flicker * 0.04, y: 1 + flicker * 0.02, anchor: .bottom)
        .opacity(0.9 + (1 - flicker) * 0.1)
    }
}

private struct Header: View {
    @Environment(UpdateChecker.self) private var updateChecker
    @Environment(AppStore.self) private var store
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                HStack(spacing: 7) {
                    // Brand color lives in the FlameMark (accent-driven via
                    // brandAccentLight→Deep), so the lockup tracks the chosen
                    // preset. The wordmark is monochrome — the old two-tone
                    // "Burn" was hardcoded terracotta and ignored 8 of 9 themes.
                    FlameMark(bounceToken: store.currentPayload.generated)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("CodeBurn")
                            .font(.system(size: 13, weight: .semibold))
                            .tracking(-0.15)
                            .foregroundStyle(.primary)
                        Text("AI Coding Cost Tracker")
                            .font(.system(size: 10.5))
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if updateChecker.updateAvailable || updateChecker.updateError != nil {
                    UpdateBadge()
                }
                AccentPicker()
            }
            // Compact warning row when any connected provider crosses 70%.
            // Lists all warning providers with their worst-window percent so
            // the user knows whether to slow down on Claude, Codex, or both.
            QuotaWarningRow(status: store.aggregateQuotaStatus)
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 8)
    }
}

private struct QuotaWarningRow: View {
    let status: AppStore.AggregateQuotaStatus

    var body: some View {
        if !status.warnings.isEmpty {
            HStack(spacing: 6) {
                Image(systemName: severityIcon)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(severityColor)
                Text(message)
                    .font(.system(size: 10.5, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(severityColor)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(severityColor.opacity(0.12))
            )
        }
    }

    private var message: String {
        let parts = status.warnings.map { "\($0.name) \(Int($0.percent.rounded()))%" }
        if parts.count == 1 {
            // Reads "Claude over limit (105%)" when any provider exceeds the
            // quota cap, instead of the awkward "Claude 105% of quota used".
            if case .danger = status.severity {
                return "\(status.warnings[0].name) over limit (\(Int(status.warnings[0].percent.rounded()))%)"
            }
            return "\(parts[0]) of quota used"
        }
        return parts.joined(separator: " · ")
    }

    private var severityColor: Color {
        switch status.severity {
        case .normal:   return .secondary
        case .warning:  return .yellow
        case .critical: return .orange
        case .danger:   return .red
        }
    }

    private var severityIcon: String {
        switch status.severity {
        case .normal:   return "info.circle"
        case .warning:  return "exclamationmark.circle"
        case .critical: return "exclamationmark.triangle"
        case .danger:   return "octagon"
        }
    }
}

private struct AccentPicker: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        HStack(spacing: 0) {
            if store.showingAccentPicker {
                HStack(spacing: 5) {
                    ForEach(AccentPreset.allCases) { preset in
                        Button {
                            withAnimation(.easeInOut(duration: 0.15)) {
                                store.accentPreset = preset
                            }
                        } label: {
                            Circle()
                                .fill(preset.base)
                                .frame(width: 12, height: 12)
                                .overlay(
                                    Circle()
                                        .stroke(.white.opacity(store.accentPreset == preset ? 0.9 : 0), lineWidth: 1.5)
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(preset.rawValue)
                    }
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color.secondary.opacity(0.08))
                )
                .transition(.opacity.combined(with: .move(edge: .trailing)))
            }

            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    store.showingAccentPicker.toggle()
                }
            } label: {
                // Palette glyph + swatch in a capsule so it reads as a theme
                // control, not a meaningless status dot.
                HStack(spacing: 4) {
                    Image(systemName: "paintpalette")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Circle()
                        .fill(store.accentPreset.base)
                        .frame(width: 10, height: 10)
                        .overlay(Circle().stroke(.white.opacity(0.25), lineWidth: 0.5))
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(Capsule().fill(Color.secondary.opacity(0.10)))
            }
            .buttonStyle(.plain)
            .help("Theme color")
            .accessibilityLabel("Change accent color")
            .padding(.leading, 4)
        }
    }
}

private struct UpdateBadge: View {
    @Environment(UpdateChecker.self) private var updateChecker
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            // When an update is genuinely available, click triggers the
            // install. When the badge is only showing because of an
            // update-check error, click re-runs the check so the user can
            // recover without waiting for the next periodic tick.
            // Upstream PR #349.
            if updateChecker.updateAvailable {
                updateChecker.performUpdate()
            } else {
                Task { await updateChecker.check() }
            }
        } label: {
            HStack(spacing: 4) {
                if updateChecker.isUpdating {
                    ProgressView()
                        .controlSize(.mini)
                        .scaleEffect(0.7)
                } else if updateChecker.updateError != nil {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10))
                } else {
                    Image(systemName: "arrow.down.circle.fill")
                        .font(.system(size: 10))
                        // Bounce once when an update appears. Keying on a constant
                        // under Reduce Motion means the value never changes, so it
                        // never animates. (.repeat(.periodic) is macOS 15+; this
                        // one-shot form is macOS 14+.)
                        .symbolEffect(.bounce, value: reduceMotion ? false : updateChecker.updateAvailable)
                }
                Text(badgeLabel)
                    .font(.system(size: 10, weight: .medium))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
        .buttonStyle(.borderedProminent)
        .tint(updateChecker.updateError != nil && !updateChecker.updateAvailable ? .orange : Theme.brandAccent)
        .controlSize(.mini)
        .disabled(updateChecker.isUpdating)
        .help(updateChecker.updateError ?? "")
    }

    private var badgeLabel: String {
        if updateChecker.isUpdating { return "Updating..." }
        if updateChecker.updateError != nil && !updateChecker.updateAvailable { return "Retry check" }
        return "Update"
    }
}

struct FlameMark: View {
    var size: CGFloat = 18
    /// Change this to make the flame give one "burn" bounce (e.g. pass the
    /// payload's `generated` token so the header mark pulses on fresh data).
    /// Default "" never changes, so the static About-tab mark never bounces.
    var bounceToken: String = ""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Theme.brandAccentLight, Theme.brandAccentDeep],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .shadow(color: .black.opacity(0.2), radius: size * 0.06, y: 0.5)
            Image(systemName: "flame.fill")
                .font(.system(size: size * 0.62, weight: .semibold))
                .foregroundStyle(.white)
                .symbolEffect(.bounce, value: reduceMotion ? "" : bounceToken)
        }
        .frame(width: size, height: size)
    }
}

private let starBannerGitHubURL = URL(string: "https://github.com/soumyadebroy3/codeburn")!

/// Shown at the very bottom on first launch. A small terracotta strip nudges users to star the
/// repo; clicking opens GitHub, clicking the close icon hides it forever (persisted to
/// UserDefaults so it never returns across launches).
struct StarBanner: View {
    @AppStorage("codeburn.starBannerDismissed") private var dismissed: Bool = false

    var body: some View {
        if !dismissed {
            HStack(spacing: 8) {
                Image(systemName: "star.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.brandAccent)

                Button {
                    NSWorkspace.shared.open(starBannerGitHubURL)
                } label: {
                    HStack(spacing: 4) {
                        Text("Enjoying CodeBurn?")
                            .foregroundStyle(.primary)
                        Text("Star us on GitHub")
                            .foregroundStyle(Theme.brandAccent)
                            .underline(true, pattern: .solid)
                    }
                    .font(.system(size: 10.5, weight: .medium))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Spacer()

                Button {
                    dismissed = true
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Hide this banner")
            }
            .padding(.horizontal, Theme.bodyGutter)
            .padding(.vertical, 6)
            .background(Theme.brandAccent.opacity(0.08))
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(Color.secondary.opacity(0.18))
                    .frame(height: 0.5)
            }
        }
    }
}

struct FooterBar: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        HStack(spacing: 6) {
            Menu {
                ForEach(SupportedCurrency.allCases) { currency in
                    Button {
                        applyCurrency(code: currency.rawValue)
                    } label: {
                        if currency.rawValue == store.currency {
                            Label("\(currency.displayName) (\(currency.rawValue))", systemImage: "checkmark")
                        } else {
                            Text("\(currency.displayName) (\(currency.rawValue))")
                        }
                    }
                }
            } label: {
                Label(store.currency, systemImage: "dollarsign.circle")
                    .font(.system(size: 11, weight: .medium))
                    .labelStyle(.titleAndIcon)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .fixedSize()

            Button {
                // showLoading: true is safe now that the overlay condition uses
                // `!hasCachedData` instead of `isLoading`. The button icon swaps
                // to the spinner glyph (driven by store.isLoading), giving the
                // user visible feedback the click was registered, but the
                // popover body keeps the existing data instead of blanking out.
                Haptics.tap()
                Task { await store.refresh(includeOptimize: false, force: true, showLoading: true) }
            } label: {
                // Native indeterminate spinner while loading; static arrow otherwise.
                // (A hand-rolled .repeatForever rotation could stick spinning even
                // after loading ended — ProgressView starts/stops cleanly.)
                if store.isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .scaleEffect(0.6)
                        .frame(width: 12, height: 12)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11, weight: .medium))
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(store.isLoading)

            Menu {
                Button("CSV (folder)") { runExport(format: .csv) }
                Button("JSON") { runExport(format: .json) }
            } label: {
                Label("Export", systemImage: "square.and.arrow.down")
                    .font(.system(size: 11, weight: .medium))
                    .labelStyle(.titleAndIcon)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .fixedSize()

            Spacer()

            Text("v\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")")
                .font(.system(size: 10, weight: .regular, design: .monospaced))
                .foregroundStyle(.tertiary)

            Button { Haptics.tap(); openReport() } label: {
                Label("Full Report", systemImage: "terminal")
                    .font(.system(size: 11, weight: .semibold))
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .tint(Theme.brandAccent)
        }
        .padding(.horizontal, Theme.bodyGutter)
        .padding(.vertical, 8)
    }

    private func openReport() {
        TerminalLauncher.open(subcommand: ["report"])
    }

    private enum ExportFormat {
        case csv, json
        var cliName: String { self == .csv ? "csv" : "json" }
        var suffix: String { self == .csv ? "" : ".json" }
    }

    /// Runs `codeburn export` directly into ~/Downloads and reveals the result in Finder. CSV
    /// produces a folder of clean one-table-per-file CSVs; JSON produces a single structured
    /// file. The CLI is spawned with argv (no shell interpretation), so the output path cannot
    /// be abused to inject shell commands even if a pathological value slips through.
    private func runExport(format: ExportFormat) {
        Task {
            let downloads = (NSHomeDirectory() as NSString).appendingPathComponent("Downloads")
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd-HHmmss"
            let base = "codeburn-\(formatter.string(from: Date()))"
            let outputPath = (downloads as NSString).appendingPathComponent(base + format.suffix)

            let process = CodeburnCLI.makeProcess(subcommand: [
                "export", "-f", format.cliName, "-o", outputPath
            ])

            do {
                let fmt = format
                process.terminationHandler = { proc in
                    Task { @MainActor in
                        if proc.terminationStatus == 0 {
                            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: outputPath)])
                        } else {
                            NSLog("CodeBurn: \(fmt.cliName.uppercased()) export exited with status \(proc.terminationStatus)")
                        }
                    }
                }
                try process.run()
            } catch {
                NSLog("CodeBurn: \(format.cliName.uppercased()) export failed: \(error)")
            }
        }
    }

    /// Instant-feeling currency switch. Updates the symbol and any cached FX rate on the main
     /// thread right away so the UI redraws the next frame, then fetches a fresh rate in the
     /// background. CLI config is persisted so other codeburn commands stay in sync.
    private func applyCurrency(code: String) {
        let symbol = CurrencyState.symbolForCode(code)

        Task {
            let cached = await FXRateCache.shared.cachedRate(for: code)
            if let cached {
                store.currency = code
                CurrencyState.shared.apply(code: code, rate: cached, symbol: symbol)
            }

            let fresh = await FXRateCache.shared.rate(for: code)
            store.currency = code
            CurrencyState.shared.apply(code: code, rate: fresh ?? cached, symbol: symbol)
        }

        CLICurrencyConfig.persist(code: code)
    }
}
