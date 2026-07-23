import SwiftUI

private let heroDateFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "EEE, MMM d"   // "Wed, Jun 10"
    return f
}()

struct HeroSection: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var heroPressed: Bool = false

    /// Whether the current period has Codex credit usage. Credits only join
    /// the hero's tap-cycle when there's something to show — a non-Codex user
    /// never sees a "0 cr" state.
    private var creditsAvailable: Bool {
        store.currentPayload.current.codexCredits > 0
    }

    /// The effective metric to render. Normalizes a stale persisted `.credits`
    /// down to `.cost` when the current period has no credits, so switching to
    /// a non-Codex period never leaves the hero stuck on an empty credits view.
    private var metric: DisplayMetric {
        if store.displayMetric == .credits && !creditsAvailable { return .cost }
        return store.displayMetric
    }

    /// Cycle the hero metric on tap: cost → tokens (↑↓) → credits → cost.
    /// Credits is skipped when the period has none. Replaces the old Settings
    /// picker so users discover the alternate views without digging through
    /// preferences. Persists via UserDefaults.
    private func cycleMetric() {
        switch metric {
        case .cost:    store.displayMetric = .tokens
        case .tokens:  store.displayMetric = creditsAvailable ? .credits : .cost
        case .credits: store.displayMetric = .cost
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionCaption(text: caption)

            HStack(alignment: .firstTextBaseline) {
                Text(heroText)
                    .font(.system(size: 32, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .tracking(-1)
                    // Flat accent fill: a vertical accent→deep gradient muddied
                    // the bottom of the digits at 32pt; solid reads cleaner and
                    // lets the numericText roll animate crisply. Accent-agnostic.
                    .foregroundStyle(Theme.brandAccent)
                    // Soft accent bloom behind the figure so it reads as a
                    // luminous focal point, not flat text on the material. Sits
                    // behind the glyphs — no hit-testing, no legibility hit.
                    .background(alignment: .leading) {
                        RadialGradient(colors: [Theme.brandAccentGlow.opacity(0.18), .clear],
                                       center: .leading, startRadius: 2, endRadius: 120)
                            .blur(radius: 18)
                            .frame(height: 86)
                            .offset(y: 2)
                            .allowsHitTesting(false)
                    }
                    // Roll the figure when it ticks (30s refresh, cost↔tokens,
                    // period/provider switch) instead of a hard digit cut.
                    .contentTransition(reduceMotion ? .identity : .numericText())
                    .animation(reduceMotion ? nil : .snappy(duration: 0.35), value: heroText)
                    // Tap to cycle metric. contentShape makes the whole bounding
                    // box tappable; scaleEffect gives subtle press feedback.
                    .contentShape(Rectangle())
                    .scaleEffect(heroPressed ? 0.97 : 1.0)
                    .animation(reduceMotion ? nil : .spring(response: 0.18, dampingFraction: 0.75), value: heroPressed)
                    // Press tracks the finger (down on touch, release + cycle on
                    // lift) rather than a fixed 0.12s timer that could leave the
                    // press stuck if the view churned mid-delay.
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { _ in if !heroPressed { heroPressed = true } }
                            .onEnded { _ in cycleMetric(); heroPressed = false }
                    )
                    .help(metricTooltip)
                    .accessibilityLabel(accessibilityMetricLabel)
                    .accessibilityValue(heroText)
                    .accessibilityHint(metricTooltip)
                    .accessibilityAddTraits(.isButton)
                    .clickableCursor()

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    if metric == .tokens {
                        // ↑ in — everything fed to the model (fresh input + cache
                        // read + cache write). ↓ out — tokens the model generated.
                        // Arrows follow the upload=in / download=out convention.
                        HStack(spacing: 2) {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 9, weight: .semibold))
                            Text(formatTokens(Double(inputSideTokens)))
                        }
                        .font(.system(size: 11))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        HStack(spacing: 2) {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 9, weight: .semibold))
                            Text(formatTokens(Double(store.currentPayload.current.outputTokens)))
                        }
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    } else {
                        Text("\(store.currentPayload.current.calls.asThousandsSeparated()) calls")
                            .font(.system(size: 11))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                        Text("\(store.currentPayload.current.sessions) sessions")
                            .font(.system(size: 10.5))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
            }

            // 14-day trend at a glance, without opening the Trend tab. Reuses
            // the existing accent-driven SparklineView and tracks the hero metric.
            if sparkPoints.count >= 2 {
                SparklineView(points: sparkPoints)
                    .frame(height: 22)
                    .padding(.top, 2)
                    .accessibilityLabel("14-day \(metric == .tokens ? "token" : "spend") trend")
            }

            // Daily budget warning banner — uses todayPayload (always-warm
            // today/all key) for the trigger so the warning still fires when
            // the user is viewing a non-today period. Provider-filtered
            // today total feeds the threshold check via todayPayload to
            // match the menubar flame tint logic.
            if store.selectedPeriod == .today,
               store.dailyBudget > 0,
               let todayCost = store.todayPayload?.current.cost,
               todayCost >= store.dailyBudget {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10))
                    Text("Daily budget of \(store.dailyBudget.asCurrency()) exceeded")
                        .font(.system(size: 11, weight: .medium))
                        .monospacedDigit()
                }
                .foregroundStyle(.orange)
                .padding(.top, 2)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 12)
    }

    /// Last 14 days of the hero metric, feeding the inline sparkline. Credits
    /// have no per-day series in the daily history, so that mode reuses the
    /// spend sparkline as a secondary at-a-glance trend.
    private var sparkPoints: [Double] {
        let days = store.currentPayload.history.daily.suffix(14)
        return metric == .tokens ? days.map(\.effectiveTokens) : days.map(\.cost)
    }

    /// One-line tooltip surfaced on hover. Tells the user the next view
    /// they'd see if they tapped — the affordance is otherwise invisible.
    private var metricTooltip: String {
        switch metric {
        case .cost:    return "Tap to show tokens"
        case .tokens:  return creditsAvailable ? "Tap to show Codex credits" : "Tap to show cost"
        case .credits: return "Tap to show cost"
        }
    }

    /// Accessibility label for the hero figure, tracking the active metric.
    private var accessibilityMetricLabel: String {
        switch metric {
        case .cost:    return "Total cost"
        case .tokens:  return "Total tokens"
        case .credits: return "Codex credits"
        }
    }

    /// Total tokens the model processed for the period: fresh input + cache
    /// read + cache write + output. This is the basis `cost` is billed on and
    /// matches the token counters in Claude Code / Warp / the Anthropic usage
    /// object. The previous hero showed only input+output — on cache-heavy
    /// agentic runs that's ~2-5% of real throughput and read as wildly
    /// inconsistent with the dollar figure beside it.
    private var totalTokens: Int {
        let c = store.currentPayload.current
        return c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheWriteTokens
    }

    /// The "input side" total: everything fed to the model. Cache reads
    /// usually dominate this on agentic workloads.
    private var inputSideTokens: Int {
        let c = store.currentPayload.current
        return c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens
    }

    /// Hero figure text. Currency for `.cost`; total token throughput for
    /// `.tokens` (the side caption splits it into in↑ / out↓); Codex credit
    /// total for `.credits`.
    private var heroText: String {
        switch metric {
        case .tokens:
            let total = Double(totalTokens)
            if total >= 1_000_000_000 { return String(format: "%.2fB tok", total / 1_000_000_000) }
            if total >= 1_000_000 { return String(format: "%.1fM tok", total / 1_000_000) }
            if total >= 1_000 { return String(format: "%.0fK tok", total / 1_000) }
            return String(format: "%.0f tok", total)
        case .credits:
            let cr = store.currentPayload.current.codexCredits
            if cr >= 1_000_000 { return String(format: "%.1fM cr", cr / 1_000_000) }
            if cr >= 1_000 { return String(format: "%.1fK cr", cr / 1_000) }
            // Sub-1K credits keep one decimal only when fractional, so a whole
            // number reads "42 cr" not "42.0 cr".
            return cr == cr.rounded() ? String(format: "%.0f cr", cr) : String(format: "%.1f cr", cr)
        case .cost:
            return store.currentPayload.current.cost.asCurrency()
        }
    }

    private func formatTokens(_ n: Double) -> String {
        if n >= 1_000_000_000 { return String(format: "%.2fB", n / 1_000_000_000) }
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "%.0fK", n / 1_000) }
        return String(format: "%.0f", n)
    }

    private var caption: String {
        // Today's CLI label is already "Today (2026-06-10)" — pairing it with a
        // second formatted date duplicated the day, so for today we render one
        // clean "Today · Wed, Jun 10". Other periods use the CLI label as-is.
        if store.selectedPeriod == .today {
            return "Today · \(heroDateFormatter.string(from: Date()))"
        }
        let label = store.currentPayload.current.label
        return label.isEmpty ? store.selectedPeriod.rawValue : label
    }
}
