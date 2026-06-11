import SwiftUI
import AppKit

/// Design tokens. Accent colors are driven by ThemeState so the user can switch palettes.
@MainActor
enum Theme {
    static let brandEmber        = Color(red: 0xC9/255.0, green: 0x52/255.0, blue: 0x1D/255.0)

    /// Shared corner radius for the three selector controls (period segmented,
    /// insight pills, agent tabs) so they share one design-system idiom.
    static let controlRadius: CGFloat = 6

    /// Single horizontal content gutter so every row — header, hero, sections,
    /// selectors, footer — shares one left/right edge.
    static let bodyGutter: CGFloat = 14

    static var brandAccent: Color { ThemeState.shared.preset.base }
    static var brandAccentLight: Color { ThemeState.shared.preset.light }
    static var brandAccentDeep: Color { ThemeState.shared.preset.deep }
    static var brandAccentGlow: Color { ThemeState.shared.preset.glow }

    static let warmSurface       = Color(red: 0xFA/255.0, green: 0xF7/255.0, blue: 0xF3/255.0)
    static let warmSurfaceDark   = Color(red: 0x1C/255.0, green: 0x18/255.0, blue: 0x16/255.0)

    static let categoricalClaude = Color(red: 0xC9/255.0, green: 0x52/255.0, blue: 0x1D/255.0)
    static let categoricalCursor = Color(red: 0x3F/255.0, green: 0x6B/255.0, blue: 0x8C/255.0)
    static let categoricalCodex  = Color(red: 0x4A/255.0, green: 0x7D/255.0, blue: 0x5C/255.0)

    static let oneShotGood  = Color(red: 0x30/255.0, green: 0xD1/255.0, blue: 0x58/255.0)
    static let oneShotMid   = Color(red: 0xFF/255.0, green: 0x9F/255.0, blue: 0x0A/255.0)
    static let oneShotLow   = Color(red: 0xFF/255.0, green: 0x45/255.0, blue: 0x3A/255.0)

    // Semantic colors -- tuned to sit alongside the terracotta accent without clashing.
    static let semanticDanger  = Color(red: 0xC8/255.0, green: 0x3F/255.0, blue: 0x2C/255.0) // brick-red, terracotta-leaning
    static let semanticWarning = Color(red: 0xD9/255.0, green: 0x8F/255.0, blue: 0x29/255.0) // amber, warmer than vanilla
    static let semanticSuccess = Color(red: 0x4E/255.0, green: 0xA8/255.0, blue: 0x65/255.0) // muted green that holds against terracotta
}

extension View {
    /// Show the pointing-hand cursor over a clickable control — the small detail
    /// that distinguishes a real Mac control from a web view. Uses the balanced
    /// pointerStyle API on macOS 15+, with a push/pop fallback below.
    @ViewBuilder func clickableCursor() -> some View {
        if #available(macOS 15, *) {
            self.pointerStyle(.link)
        } else {
            self.onHover { inside in
                if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
        }
    }
}

@MainActor
enum Haptics {
    /// Light haptic for commit actions (refresh, open report, connect). No-op on
    /// non-haptic hardware; independent of Reduce Motion.
    static func tap(_ pattern: NSHapticFeedbackManager.FeedbackPattern = .generic) {
        NSHapticFeedbackManager.defaultPerformer.perform(pattern, performanceTime: .now)
    }
}

/// One shared tactile press feedback for the selector controls so Period /
/// Insight pills / chevrons all depress with the same snappy idiom. Reduce
/// Motion disables the scale. (The matched-geometry selection is untouched —
/// this only scales the label.)
struct PillPressStyle: ButtonStyle {
    var reduceMotion: Bool = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.93 : 1.0)
            .animation(reduceMotion ? nil : .snappy(duration: 0.16, extraBounce: 0.12), value: configuration.isPressed)
    }
}

extension Font {
    /// SF Mono for currency values -- developer-tool identity.
    static func codeMono(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}
