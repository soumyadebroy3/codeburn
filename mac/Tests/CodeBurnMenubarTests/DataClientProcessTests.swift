import Foundation
import Testing
@testable import CodeBurnMenubar

// The wedge fix (upstream #462) replaced a blocking `process.waitUntilExit()`
// with an async wait via `ProcessExitSignal`, and added an `AsyncSemaphore` to
// cap concurrent CLI spawns. Both primitives must hold their contracts under
// concurrency — that's what kept the menubar off "Loading…" forever.

@Suite("ProcessExitSignal")
struct ProcessExitSignalTests {
    @Test("wait returns when fulfilled after waiting begins")
    func waitThenFulfill() async {
        let signal = ProcessExitSignal()
        async let waited: Void = signal.wait()
        // Give wait() a beat to park, then fulfill from another task.
        try? await Task.sleep(nanoseconds: 5_000_000)
        signal.fulfill()
        await waited  // must not hang
    }

    @Test("wait returns immediately when already fulfilled (fulfill-before-wait)")
    func fulfillThenWait() async {
        let signal = ProcessExitSignal()
        signal.fulfill()
        await signal.wait()  // must return without hanging
    }

    @Test("a second fulfill is a harmless no-op")
    func doubleFulfill() async {
        let signal = ProcessExitSignal()
        signal.fulfill()
        signal.fulfill()
        await signal.wait()
    }
}

@Suite("AsyncSemaphore")
struct AsyncSemaphoreTests {
    private actor PeakCounter {
        private var current = 0
        private(set) var peak = 0
        func enter() { current += 1; peak = max(peak, current) }
        func leave() { current -= 1 }
    }

    @Test("never lets more than its count run concurrently")
    func capsConcurrency() async {
        let sem = AsyncSemaphore(2)
        let peak = PeakCounter()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<12 {
                group.addTask {
                    await sem.acquire()
                    await peak.enter()
                    try? await Task.sleep(nanoseconds: 8_000_000)
                    await peak.leave()
                    await sem.release()
                }
            }
        }
        let observed = await peak.peak
        #expect(observed <= 2, "semaphore should cap concurrency at 2, saw \(observed)")
        #expect(observed > 0)
    }

    @Test("all waiters eventually acquire and complete")
    func allWaitersDrain() async {
        let sem = AsyncSemaphore(1)
        let count = 20
        let done = await withTaskGroup(of: Void.self) { group -> Int in
            for _ in 0..<count {
                group.addTask {
                    await sem.acquire()
                    await sem.release()
                }
            }
            var n = 0
            for await _ in group { n += 1 }
            return n
        }
        #expect(done == count)
    }
}
