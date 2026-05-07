import Foundation

/// Single entry point for spawning the `codeburn` CLI. All callers route through here so the
/// binary argv is validated once and no code path ever passes user-influenced strings through
/// a shell (`/bin/zsh -c`, `open --args`, AppleScript). This closes the shell-injection attack
/// surface end-to-end.
enum CodeburnCLI {
    /// Matches a plain file path / program name: alphanumerics, dot, underscore, slash, hyphen,
    /// space. Deliberately excludes shell metacharacters (`$`, `;`, `&`, `|`, quotes, backticks,
    /// newlines) so a malicious `CODEBURN_BIN="codeburn; rm -rf ~"` can't slip through.
    private static let safeArgPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9 ._/\\-]+$")

    /// PATH additions for GUI-launched apps, which otherwise get a minimal PATH that misses
    /// Homebrew and npm global installs.
    private static let additionalPathEntries = ["/opt/homebrew/bin", "/usr/local/bin"]

    /// Directories the CLI binary is expected to live in. PATH entries OUTSIDE this set are
    /// suspicious — a user-writable dir like `~/bin` ahead of `/usr/local/bin` in PATH is a
    /// classic privilege-shift vector. We log a warning the first time we resolve outside the
    /// allow-list so the user can investigate, but we don't refuse — power users frequently
    /// install npm packages under `~/.npm-global/bin` or `~/.volta/bin` and expect them to work.
    private static let trustedBinaryRoots = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
    ]

    /// Env vars copied to the child process. Everything else is dropped — this defeats
    /// `NODE_OPTIONS=--require ./pwn.js`, `NODE_EXTRA_CA_CERTS=/tmp/evil.pem`, and the
    /// DYLD_*/LD_* family that would otherwise silently inject code into the spawned `node`.
    /// Add new prefixes here only if you are sure the child needs them.
    private static let allowedEnvKeys: Set<String> = [
        "PATH", "HOME", "USER", "LOGNAME", "SHELL",
        "TMPDIR", "TZ", "LANG",
    ]
    private static let allowedEnvPrefixes: [String] = [
        "LC_",
        "CODEBURN_",
    ]

    /// Returns the argv that launches the CLI. Dev override via `CODEBURN_BIN` is honoured only
    /// if every whitespace-delimited token passes `safeArgPattern`. Otherwise falls back to the
    /// plain `codeburn` name (resolved via PATH).
    static func baseArgv() -> [String] {
        guard let raw = ProcessInfo.processInfo.environment["CODEBURN_BIN"], !raw.isEmpty else {
            return ["codeburn"]
        }
        let parts = raw.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard parts.allSatisfy(isSafe) else {
            NSLog("CodeBurn: refusing unsafe CODEBURN_BIN; using default 'codeburn'")
            return ["codeburn"]
        }
        return parts
    }

    /// Builds a `Process` that runs the CLI with the given subcommand args. Uses `/usr/bin/env`
    /// so PATH lookup happens without involving a shell, and augments PATH with Homebrew
    /// defaults. Caller sets stdout/stderr pipes and calls `run()`.
    static func makeProcess(subcommand: [String]) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.environment = scrubbedEnvironment()
        // `env --` treats everything following as argv, not VAR=val pairs -- guards against an
        // argument accidentally resembling an env assignment.
        process.arguments = ["--"] + baseArgv() + subcommand
        // The menubar runs as an accessory app with no foreground window, and macOS
        // background-throttles accessory apps and their children. Without this lift the
        // codeburn subprocess parses 5-10x slower than the same command run from a
        // user-interactive terminal, which starves the 15s refresh cadence on large corpora.
        process.qualityOfService = .userInitiated
        return process
    }

    static func isSafe(_ s: String) -> Bool {
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        return safeArgPattern.firstMatch(in: s, range: range) != nil
    }

    /// Build a sanitised environment dictionary: keep only the explicit allow-list and
    /// the configured prefixes, then augment PATH with Homebrew/standard install locations.
    static func scrubbedEnvironment() -> [String: String] {
        let parent = ProcessInfo.processInfo.environment
        var clean: [String: String] = [:]
        for (k, v) in parent {
            if allowedEnvKeys.contains(k) {
                clean[k] = v
                continue
            }
            for prefix in allowedEnvPrefixes where k.hasPrefix(prefix) {
                clean[k] = v
                break
            }
        }
        clean["PATH"] = augmentedPath(clean["PATH"] ?? "")
        return clean
    }

    /// Detect a probable PATH-hijack of the resolved CLI binary. Returns the absolute path the
    /// shell would resolve, plus a flag indicating whether it sits in a trusted directory.
    /// Does NOT block the spawn — `which` may return user-installed locations like
    /// `~/.volta/bin/codeburn`, which are legitimate. Caller logs a warning when untrusted so
    /// the user has a chance to investigate.
    static func resolveBinaryPath() -> (path: String?, trusted: Bool) {
        // Use scrubbedEnvironment so the lookup runs through the same PATH the actual spawn
        // sees — otherwise the warning would chase a different binary than the one we run.
        let env = scrubbedEnvironment()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.environment = env
        process.arguments = ["--", "/usr/bin/which", baseArgv()[0]]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return (nil, false) }
        } catch {
            return (nil, false)
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let raw = String(data: data, encoding: .utf8) else { return (nil, false) }
        let path = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return (nil, false) }

        let trusted = trustedBinaryRoots.contains { path == $0 + "/codeburn" || path.hasPrefix($0 + "/") }
        return (path, trusted)
    }

    private static func augmentedPath(_ existing: String) -> String {
        var parts = existing.split(separator: ":", omittingEmptySubsequences: true).map(String.init)
        for extra in additionalPathEntries where !parts.contains(extra) {
            parts.append(extra)
        }
        return parts.joined(separator: ":")
    }
}
