import SwiftUI

struct HeroSection: View {
    @Environment(AppStore.self) private var store
    @State private var heroPressed: Bool = false

    /// Cycle the hero metric on tap: cost → tokens (↑↓) → cost.
    /// Two-mode UX replaces the previous Settings picker so users discover
    /// the alternate view without digging through preferences. Persists via
    /// UserDefaults.
    private func cycleMetric() {
        switch store.displayMetric {
        case .cost:   store.displayMetric = .tokens
        case .tokens: store.displayMetric = .cost
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
                    .foregroundStyle(
                        LinearGradient(
                            colors: [Theme.brandAccent, Theme.brandAccentDeep],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    // Tap to cycle metric. contentShape makes the whole
                    // bounding box tappable (not just the rendered glyphs).
                    // scaleEffect gives a subtle press-feedback so the
                    // tap target reads as interactive on hover/click.
                    .contentShape(Rectangle())
                    .scaleEffect(heroPressed ? 0.97 : 1.0)
                    .animation(.spring(response: 0.18, dampingFraction: 0.75), value: heroPressed)
                    .onTapGesture {
                        heroPressed = true
                        cycleMetric()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                            heroPressed = false
                        }
                    }
                    .help(metricTooltip)

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    if store.displayMetric == .tokens {
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
                            Text(formatTokens(Double(store.payload.current.outputTokens)))
                        }
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                    } else {
                        Text("\(store.payload.current.calls.asThousandsSeparated()) calls")
                            .font(.system(size: 11))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                        Text("\(store.payload.current.sessions) sessions")
                            .font(.system(size: 10.5))
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                    }
                }
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
                }
                .foregroundStyle(.orange)
                .padding(.top, 2)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 12)
    }

    /// One-line tooltip surfaced on hover. Tells the user the next view
    /// they'd see if they tapped — the affordance is otherwise invisible.
    private var metricTooltip: String {
        switch store.displayMetric {
        case .cost:   return "Tap to show tokens"
        case .tokens: return "Tap to show cost"
        }
    }

    /// Total tokens the model processed for the period: fresh input + cache
    /// read + cache write + output. This is the basis `cost` is billed on and
    /// matches the token counters in Claude Code / Warp / the Anthropic usage
    /// object. The previous hero showed only input+output — on cache-heavy
    /// agentic runs that's ~2-5% of real throughput and read as wildly
    /// inconsistent with the dollar figure beside it.
    private var totalTokens: Int {
        let c = store.payload.current
        return c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheWriteTokens
    }

    /// The "input side" total: everything fed to the model. Cache reads
    /// usually dominate this on agentic workloads.
    private var inputSideTokens: Int {
        let c = store.payload.current
        return c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens
    }

    /// Hero figure text. Falls back to currency for `.cost`; renders the total
    /// token throughput for `.tokens` (the side caption splits it into in↑ / out↓).
    private var heroText: String {
        if store.displayMetric == .tokens {
            let total = Double(totalTokens)
            if total >= 1_000_000_000 { return String(format: "%.2fB tok", total / 1_000_000_000) }
            if total >= 1_000_000 { return String(format: "%.1fM tok", total / 1_000_000) }
            if total >= 1_000 { return String(format: "%.0fK tok", total / 1_000) }
            return String(format: "%.0f tok", total)
        }
        return store.payload.current.cost.asCurrency()
    }

    private func formatTokens(_ n: Double) -> String {
        if n >= 1_000_000_000 { return String(format: "%.2fB", n / 1_000_000_000) }
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return String(format: "%.0fK", n / 1_000) }
        return String(format: "%.0f", n)
    }

    private var caption: String {
        let label = store.payload.current.label.isEmpty ? store.selectedPeriod.rawValue : store.payload.current.label
        if store.selectedPeriod == .today {
            return "\(label) · \(todayDate)"
        }
        return label
    }

    private var todayDate: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE MMM d"
        return formatter.string(from: Date())
    }
}
