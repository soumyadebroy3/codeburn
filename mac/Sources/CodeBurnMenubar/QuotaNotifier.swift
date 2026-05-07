import Foundation
import UserNotifications

/// Posts a single user notification on each upward severity transition of
/// AggregateQuotaStatus (.normal → .warning → .critical → .danger).
/// Suppresses repeats for `suppressionInterval` to avoid spam.
///
/// Fired from AppDelegate.observeStore() so the cadence matches the popover's
/// own redraws — no extra polling.
@MainActor
final class QuotaNotifier {
    static let shared = QuotaNotifier()

    private let suppressionInterval: TimeInterval = 24 * 60 * 60   // 24 hours

    private var lastSeverity: QuotaSummary.Severity = .normal
    private var lastNotifiedAt: [QuotaSummary.Severity: Date] = [:]
    private var permissionRequested = false

    private init() {}

    func observe(_ status: AppStore.AggregateQuotaStatus) {
        defer { lastSeverity = status.severity }

        // Only fire on UPWARD transitions. Don't fire when the user is
        // already in a critical state — they've seen it; renotifying every
        // popover open is just noise.
        guard status.severity > lastSeverity else { return }
        guard status.severity != .normal else { return }

        let now = Date()
        if let last = lastNotifiedAt[status.severity], now.timeIntervalSince(last) < suppressionInterval {
            return
        }

        let severity = status.severity
        let warnings = status.warnings.map { "\($0.name) at \(Int($0.percent))%" }
        Task { [warnings] in
            await ensurePermission()
            await post(severity: severity, warnings: warnings)
            lastNotifiedAt[severity] = now
        }
    }

    private func ensurePermission() async {
        guard !permissionRequested else { return }
        permissionRequested = true
        do {
            _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        } catch {
            // Permission denied or unavailable — silently fall through. The
            // user can re-grant later from System Settings.
        }
    }

    private func post(severity: QuotaSummary.Severity, warnings: [String]) async {
        let content = UNMutableNotificationContent()
        content.title = title(for: severity)
        content.body = body(for: warnings)
        content.sound = .default

        let req = UNNotificationRequest(
            identifier: "codeburn.quota.\(severity)",
            content: content,
            trigger: nil
        )
        try? await UNUserNotificationCenter.current().add(req)
    }

    private func title(for severity: QuotaSummary.Severity) -> String {
        switch severity {
        case .normal:   return "CodeBurn"
        case .warning:  return "Quota warning"
        case .critical: return "Quota critical"
        case .danger:   return "Quota exhausted"
        }
    }

    private func body(for warnings: [String]) -> String {
        if warnings.isEmpty { return "Your AI coding quota is approaching its limit." }
        return warnings.prefix(3).joined(separator: " · ")
    }
}

extension QuotaSummary.Severity: Comparable {
    static func < (lhs: QuotaSummary.Severity, rhs: QuotaSummary.Severity) -> Bool {
        rank(lhs) < rank(rhs)
    }
    private static func rank(_ s: QuotaSummary.Severity) -> Int {
        switch s {
        case .normal:   return 0
        case .warning:  return 1
        case .critical: return 2
        case .danger:   return 3
        }
    }
}
