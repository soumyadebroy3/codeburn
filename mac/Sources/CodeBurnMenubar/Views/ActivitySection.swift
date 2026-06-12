import SwiftUI

struct ActivitySection: View {
    @Environment(AppStore.self) private var store
    @State private var isExpanded: Bool = true

    var body: some View {
        CollapsibleSection(
            caption: "Activity",
            isExpanded: $isExpanded,
            trailing: {
                HStack(spacing: 8) {
                    Text("Cost").frame(minWidth: 54, alignment: .trailing)
                    Text("Turns").frame(minWidth: 52, alignment: .trailing)
                    Text("1-shot").frame(minWidth: 44, alignment: .trailing)
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
                .tracking(-0.05)
            }
        ) {
            VStack(alignment: .leading, spacing: 5) {
                let maxCost = store.currentPayload.current.topActivities.map(\.cost).max() ?? 1
                // enumerated offset id: under .all aggregation two activities can
                // share a name, which collapsed/mis-diffed rows with id: \.name.
                ForEach(Array(store.currentPayload.current.topActivities.enumerated()), id: \.offset) { _, activity in
                    ActivityRow(activity: activity, maxCost: maxCost)
                }
            }
        }
    }
}

struct ActivityRow: View {
    let activity: ActivityEntry
    let maxCost: Double
    @State private var isHovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 8) {
            FixedBar(fraction: activity.cost / maxCost)
                .frame(width: 56, height: 6)

            Text(activity.name)
                .font(.system(size: 12.5, weight: .medium))
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(activity.cost.asCompactCurrency())
                .font(.codeMono(size: 12, weight: .medium))
                .tracking(-0.2)
                .frame(minWidth: 54, alignment: .trailing)

            Text("\(activity.turns)")
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 52, alignment: .trailing)

            Text(oneShotText)
                .font(.system(size: 10.5))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 44, alignment: .trailing)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(
            RoundedRectangle(cornerRadius: 5)
                .fill(Color.secondary.opacity(isHovered ? 0.08 : 0))
        )
        .contentShape(Rectangle())
        .onHover { h in
            if reduceMotion { isHovered = h }
            else { withAnimation(.easeOut(duration: 0.12)) { isHovered = h } }
        }
    }

    private var oneShotText: String {
        guard let rate = activity.oneShotRate else { return "—" }
        // With only a handful of edit turns a bare "100%" overstates confidence
        // and reads as if it were over the larger Turns count. Show the raw
        // fraction (hits/edits) until there's a meaningful sample.
        if activity.editTurns < 3 {
            let hits = Int((rate * Double(activity.editTurns)).rounded())
            return "\(hits)/\(activity.editTurns)"
        }
        return "\(Int(rate * 100))%"
    }
}

/// Fixed-width horizontal bar that shows a fill fraction.
struct FixedBar: View {
    let fraction: Double
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geo in
            let target = max(0, min(geo.size.width, geo.size.width * CGFloat(fraction)))
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(.secondary.opacity(0.15))
                RoundedRectangle(cornerRadius: 2)
                    .fill(Theme.brandAccent)
                    // Grow from 0 on appear (and ease when the value changes).
                    .frame(width: (shown || reduceMotion) ? target : 0)
                    .animation(reduceMotion ? nil : .spring(response: 0.55, dampingFraction: 0.85), value: shown)
                    .animation(reduceMotion ? nil : .spring(response: 0.55, dampingFraction: 0.85), value: target)
            }
            .onAppear { shown = true }
        }
    }
}
