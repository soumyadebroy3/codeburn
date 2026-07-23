import Foundation
import Testing
@testable import CodeBurnMenubar

// The idle-energy fix (#647/#648): the 30s timer keeps ticking, but the
// expensive Node-spawn cadence backs off on battery / Low Power / display-off
// with the popover closed, and never auto-spawns in Manual mode. RefreshCadence
// is a pure function of those inputs, so its decisions are fully unit-testable.
@Suite("RefreshCadence")
struct RefreshCadenceTests {
    @Test("Auto with the popover open always uses the active cadence")
    func autoPopoverOpenActive() {
        #expect(RefreshCadence.interval(mode: .auto, popoverOpen: true, onBattery: true, lowPowerMode: true)
            == RefreshCadence.activeSeconds)
    }

    @Test("Auto idle on AC stays active")
    func autoIdleOnAC() {
        #expect(RefreshCadence.interval(mode: .auto, popoverOpen: false, onBattery: false, lowPowerMode: false)
            == RefreshCadence.activeSeconds)
    }

    @Test("Auto idle on battery backs off")
    func autoIdleOnBattery() {
        #expect(RefreshCadence.interval(mode: .auto, popoverOpen: false, onBattery: true, lowPowerMode: false)
            == RefreshCadence.batteryIdleSeconds)
    }

    @Test("Auto in Low Power Mode backs off furthest")
    func autoLowPower() {
        #expect(RefreshCadence.interval(mode: .auto, popoverOpen: false, onBattery: true, lowPowerMode: true)
            == RefreshCadence.lowPowerIdleSeconds)
        #expect(RefreshCadence.interval(mode: .auto, popoverOpen: false, onBattery: false, lowPowerMode: true)
            == RefreshCadence.lowPowerIdleSeconds)
    }

    @Test("Manual never auto-spawns")
    func manualNeverSpawns() {
        #expect(RefreshCadence.interval(mode: .manual, popoverOpen: false, onBattery: false, lowPowerMode: false) == nil)
        #expect(RefreshCadence.interval(mode: .manual, popoverOpen: true, onBattery: false, lowPowerMode: false) == nil)
    }

    @Test("A fixed cadence ignores power state")
    func fixedIgnoresPower() {
        #expect(RefreshCadence.interval(mode: .fiveMinutes, popoverOpen: false, onBattery: true, lowPowerMode: true)
            == TimeInterval(UsageRefreshCadence.fiveMinutes.rawValue))
        #expect(RefreshCadence.interval(mode: .fifteenMinutes, popoverOpen: false, onBattery: false, lowPowerMode: false)
            == TimeInterval(UsageRefreshCadence.fifteenMinutes.rawValue))
    }

    @Test("A fixed cadence goes active while the popover is open")
    func fixedGoesActiveWhenOpen() {
        #expect(RefreshCadence.interval(mode: .fiveMinutes, popoverOpen: true, onBattery: true, lowPowerMode: false)
            == RefreshCadence.activeSeconds)
    }

    @Test("Backoff intervals are ordered active < battery < lowPower")
    func backoffOrdering() {
        #expect(RefreshCadence.activeSeconds < RefreshCadence.batteryIdleSeconds)
        #expect(RefreshCadence.batteryIdleSeconds < RefreshCadence.lowPowerIdleSeconds)
    }

    @Test("UsageRefreshCadence defaults to auto when unset and round-trips")
    func cadenceDefaultsAndRoundTrips() {
        UserDefaults.standard.removeObject(forKey: UsageRefreshCadence.defaultsKey)
        #expect(UsageRefreshCadence.current == .auto)
        UsageRefreshCadence.current = .manual
        #expect(UsageRefreshCadence.current == .manual)
        UsageRefreshCadence.current = .fiveMinutes
        #expect(UsageRefreshCadence.current == .fiveMinutes)
        UserDefaults.standard.removeObject(forKey: UsageRefreshCadence.defaultsKey)
    }
}
