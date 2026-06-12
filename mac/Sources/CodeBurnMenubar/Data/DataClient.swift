import Foundation

/// Upper bound on payload + stderr bytes read from the CLI. Real payloads top out near 500 KB
/// (365 days of history with dozens of models); anything larger is pathological and truncating
/// prevents unbounded memory growth. Hard timeout guards against a hung CLI keeping Process and
/// Pipe file descriptors pinned forever.
private let maxPayloadBytes = 20 * 1024 * 1024
private let maxStderrBytes = 256 * 1024
private let spawnTimeoutSeconds: UInt64 = 45
private let maxConcurrentSpawns = 6

enum DataClientError: Error {
    case spawn(String)
    case nonZeroExit(code: Int32, stderr: String)
    case decode(Error)
    case timeout
    case outputTooLarge
}

/// Runs the CLI via argv (no shell interpretation). See `CodeburnCLI` for why we never route
/// commands through `/bin/zsh -c` anymore.
struct DataClient {
    static func fetch(period: Period, provider: ProviderFilter, includeOptimize: Bool) async throws -> MenubarPayload {
        var subcommand = [
            "status",
            "--format", "menubar-json",
            "--period", period.cliArg,
            "--provider", provider.cliArg,
        ]
        if !includeOptimize {
            subcommand.append("--no-optimize")
        }

        let result = try await runCLI(subcommand: subcommand)
        guard result.exitCode == 0 else {
            throw DataClientError.nonZeroExit(code: result.exitCode, stderr: result.stderr)
        }
        do {
            return try JSONDecoder().decode(MenubarPayload.self, from: result.stdout)
        } catch {
            throw DataClientError.decode(error)
        }
    }

    private struct ProcessResult {
        let stdout: Data
        let stderr: String
        let exitCode: Int32
    }

    /// Caps concurrent CLI spawns so a wake-burst of refreshes can't fan out into
    /// dozens of node processes at once.
    private static let spawnLimiter = AsyncSemaphore(maxConcurrentSpawns)

    private static func runCLI(subcommand: [String]) async throws -> ProcessResult {
        await spawnLimiter.acquire()
        defer { Task { await spawnLimiter.release() } }
        let process = CodeburnCLI.makeProcess(subcommand: subcommand)

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        // Bridge the process exit to an async signal set up BEFORE run(), so the
        // exit can never be missed and the wait never blocks a worker thread.
        let exitSignal = ProcessExitSignal()
        process.terminationHandler = { _ in exitSignal.fulfill() }

        do {
            try process.run()
        } catch {
            throw DataClientError.spawn(error.localizedDescription)
        }

        // Wall-clock timeout: if the CLI hangs (parser stuck, disk stall), kill it.
        // Log when this fires so a recurring stuck-popover state has an actual
        // diagnostic — historically users saw "Loading..." forever with no signal
        // about what failed; the only way to debug was to read process state at
        // the wrong time. The log line names the subcommand so we can correlate
        // with a specific period/provider combination.
        let timeoutTask = Task.detached(priority: .utility) {
            try? await Task.sleep(nanoseconds: spawnTimeoutSeconds * 1_000_000_000)
            if process.isRunning {
                NSLog("CodeBurn: CLI subprocess timed out after %llus for %@ — terminating",
                      spawnTimeoutSeconds, subcommand.joined(separator: " "))
                process.terminate()
            }
        }
        defer { timeoutTask.cancel() }

        // If the caller cancels its Task (rapid period/provider tab clicks
        // cancel switchTask in AppStore), terminate the in-flight subprocess.
        // Without this the cancelled Task returns immediately but the spawned
        // CLI keeps running to completion, piling up zombie codeburn processes
        // on rapid UI interactions. We hold a strong reference to the Process
        // in the cancellation handler so the closure can find it even if the
        // surrounding scope has gone async.
        let (out, err) = await withTaskCancellationHandler {
            // Drain both pipes concurrently so a large stderr can't deadlock stdout
            // (the child blocks on write once the pipe buffer fills). `drain`
            // also enforces a byte cap.
            async let stdoutData = drain(outPipe.fileHandleForReading, limit: maxPayloadBytes)
            async let stderrData = drain(errPipe.fileHandleForReading, limit: maxStderrBytes)
            return await (stdoutData, stderrData)
        } onCancel: {
            if process.isRunning {
                process.terminate()
            }
        }
        // Wait for exit via terminationHandler, never by parking a worker thread
        // in waitUntilExit. That blocking syscall on Swift's cooperative pool
        // wedged the menubar on "Loading…" under load: enough concurrent slow
        // CLIs parked every worker thread inside waitUntilExit, leaving nothing
        // free to drain pipes or fire the timeout. terminationHandler fires on a
        // Foundation-managed queue and blocks nothing.
        await exitSignal.wait()

        if out.count >= maxPayloadBytes {
            throw DataClientError.outputTooLarge
        }

        let stderrString = String(data: err, encoding: .utf8) ?? ""
        return ProcessResult(stdout: out, stderr: stderrString, exitCode: process.terminationStatus)
    }

    /// Pulls bytes off a pipe until EOF or `limit`. Intentionally uses `availableData`, which
    /// returns empty on EOF -- no blocking once the child exits.
    private static func drain(_ handle: FileHandle, limit: Int) async -> Data {
        await Task.detached(priority: .utility) {
            var buffer = Data()
            while buffer.count < limit {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                let remaining = limit - buffer.count
                if chunk.count > remaining {
                    buffer.append(chunk.prefix(remaining))
                    break
                }
                buffer.append(chunk)
            }
            return buffer
        }.value
    }
}

/// One-shot async signal that bridges `Process.terminationHandler` (invoked on a
/// Foundation-internal queue) to an awaiting task without blocking a worker
/// thread. Safe against fulfill-before-wait.
final class ProcessExitSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var fulfilled = false
    private var continuation: CheckedContinuation<Void, Never>?

    func fulfill() {
        lock.lock()
        if fulfilled { lock.unlock(); return }
        fulfilled = true
        let cont = continuation
        continuation = nil
        lock.unlock()
        cont?.resume()
    }

    func wait() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            lock.lock()
            if fulfilled {
                lock.unlock()
                cont.resume()
            } else {
                continuation = cont
                lock.unlock()
            }
        }
    }
}

/// Minimal actor-based async semaphore. Caps concurrency without blocking a
/// thread (unlike DispatchSemaphore.wait()).
actor AsyncSemaphore {
    private var available: Int
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(_ count: Int) { available = count }

    func acquire() async {
        if available > 0 {
            available -= 1
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        if waiters.isEmpty {
            available += 1
        } else {
            waiters.removeFirst().resume()
        }
    }
}
