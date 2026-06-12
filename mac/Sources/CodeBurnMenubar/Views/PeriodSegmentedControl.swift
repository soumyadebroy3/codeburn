import SwiftUI

struct PeriodSegmentedControl: View {
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var ns
    @State private var hovered: Period?

    var body: some View {
        HStack(spacing: 1) {
            ForEach(Period.allCases) { period in
                let isSel = store.selectedPeriod == period
                Button {
                    store.switchTo(period: period)
                } label: {
                    Text(period.rawValue)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(isSel ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PillPressStyle(reduceMotion: reduceMotion))
                .background {
                    // Neutral elevated capsule (NOT accent): the period control is
                    // a MODE switch, distinct from the accent-filled insight/agent
                    // FILTERS. The selected fill slides via matchedGeometry.
                    ZStack {
                        if isSel {
                            RoundedRectangle(cornerRadius: Theme.controlRadius)
                                .fill(Color(NSColor.windowBackgroundColor).opacity(0.85))
                                .shadow(color: .black.opacity(0.06), radius: 1, y: 0.5)
                                .matchedGeometryEffect(id: "periodSel", in: ns)
                        } else if hovered == period {
                            RoundedRectangle(cornerRadius: Theme.controlRadius)
                                .fill(Color.secondary.opacity(0.10))
                        }
                    }
                }
                .onHover { h in
                    let next: Period? = h ? period : (hovered == period ? nil : hovered)
                    if reduceMotion { hovered = next }
                    else { withAnimation(.easeOut(duration: 0.12)) { hovered = next } }
                }
                .accessibilityAddTraits(isSel ? [.isButton, .isSelected] : .isButton)
                .clickableCursor()
            }
        }
        .padding(2)
        .background(
            RoundedRectangle(cornerRadius: Theme.controlRadius + 1)
                .fill(Color.secondary.opacity(0.08))
        )
        .padding(.horizontal, Theme.bodyGutter)
        .padding(.top, 6)
        .padding(.bottom, 10)
        .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: store.selectedPeriod)
    }
}
