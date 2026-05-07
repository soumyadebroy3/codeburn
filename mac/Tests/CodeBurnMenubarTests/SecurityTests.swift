import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("LogSanitizer redacts credentials")
struct LogSanitizerTests {
    @Test("masks Anthropic-style sk-ant-* tokens")
    func sk_ant() {
        let out = LogSanitizer.sanitize("Bearer sk-ant-abc123XYZ_-token")
        #expect(out != nil)
        #expect(out!.contains("sk-ant-***"))
        #expect(!out!.contains("sk-ant-abc123"))
    }

    @Test("masks generic sk-* tokens (16+ chars)")
    func sk_generic() {
        let out = LogSanitizer.sanitize("api key is sk-1234567890abcdefghijk")
        #expect(out != nil)
        #expect(out!.contains("sk-***"))
    }

    @Test("masks JWTs")
    func jwt() {
        let out = LogSanitizer.sanitize("token=eyJhbGciOi.J9.signaturepartXYZ123")
        #expect(out != nil)
        #expect(out!.contains("eyJ***"))
    }

    @Test("masks Bearer headers case-insensitively")
    func bearer_ci() {
        let out = LogSanitizer.sanitize("authorization: bearer raw_value_42")
        #expect(out != nil)
        #expect(out!.contains("Bearer ***") || out!.contains("bearer ***"))
    }

    @Test("masks long high-entropy substrings")
    func generic_high_entropy() {
        let out = LogSanitizer.sanitize("session=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF1234")
        #expect(out != nil)
        #expect(out!.contains("***"))
        #expect(!out!.contains("abcdefghijklmnopqrstuvwxyz"))
    }

    @Test("caps output length at 240+ellipsis")
    func length_cap() {
        let big = String(repeating: "a", count: 800)
        let out = LogSanitizer.sanitize(big)
        #expect(out != nil)
        #expect(out!.count <= 245)
    }

    @Test("returns nil on nil/empty")
    func nilOnEmpty() {
        #expect(LogSanitizer.sanitize(nil) == nil)
        #expect(LogSanitizer.sanitize("") == nil)
    }
}

@Suite("CodeburnCLI argv validation")
struct CodeburnCLISafeArgsTests {
    @Test("accepts plain program names and absolute paths")
    func acceptsPlainNames() {
        #expect(CodeburnCLI.isSafe("codeburn"))
        #expect(CodeburnCLI.isSafe("/usr/local/bin/codeburn"))
        #expect(CodeburnCLI.isSafe("/opt/homebrew/bin/node"))
        #expect(CodeburnCLI.isSafe("--version"))
        #expect(CodeburnCLI.isSafe("--period"))
    }

    @Test("rejects shell metacharacters")
    func rejectsMetacharacters() {
        #expect(!CodeburnCLI.isSafe("codeburn; rm -rf ~"))
        #expect(!CodeburnCLI.isSafe("codeburn && pwn"))
        #expect(!CodeburnCLI.isSafe("codeburn|pipe"))
        #expect(!CodeburnCLI.isSafe("codeburn`backtick`"))
        #expect(!CodeburnCLI.isSafe("codeburn$VAR"))
        #expect(!CodeburnCLI.isSafe("codeburn'quote'"))
        #expect(!CodeburnCLI.isSafe("codeburn\"dq\""))
        #expect(!CodeburnCLI.isSafe("codeburn\nnewline"))
        #expect(!CodeburnCLI.isSafe("codeburn>redirect"))
        #expect(!CodeburnCLI.isSafe("codeburn<redirect"))
        #expect(!CodeburnCLI.isSafe("codeburn(paren)"))
    }
}

@Suite("CodeburnCLI environment scrub")
struct CodeburnCLIEnvScrubTests {
    @Test("strips NODE_OPTIONS and DYLD_*")
    func stripsDangerous() {
        // Set during the test, restore after.
        setenv("NODE_OPTIONS", "--require ./pwn.js", 1)
        setenv("DYLD_INSERT_LIBRARIES", "/tmp/evil.dylib", 1)
        setenv("NODE_EXTRA_CA_CERTS", "/tmp/evil.pem", 1)
        defer {
            unsetenv("NODE_OPTIONS")
            unsetenv("DYLD_INSERT_LIBRARIES")
            unsetenv("NODE_EXTRA_CA_CERTS")
        }
        let scrubbed = CodeburnCLI.scrubbedEnvironment()
        #expect(scrubbed["NODE_OPTIONS"] == nil)
        #expect(scrubbed["DYLD_INSERT_LIBRARIES"] == nil)
        #expect(scrubbed["NODE_EXTRA_CA_CERTS"] == nil)
    }

    @Test("preserves PATH/HOME/USER and CODEBURN_*")
    func preservesAllowed() {
        setenv("CODEBURN_VERBOSE", "1", 1)
        defer { unsetenv("CODEBURN_VERBOSE") }
        let scrubbed = CodeburnCLI.scrubbedEnvironment()
        #expect(scrubbed["PATH"] != nil)
        #expect(scrubbed["HOME"] != nil)
        #expect(scrubbed["CODEBURN_VERBOSE"] == "1")
    }

    @Test("PATH is augmented with Homebrew prefixes")
    func pathAugmented() {
        let scrubbed = CodeburnCLI.scrubbedEnvironment()
        let path = scrubbed["PATH"] ?? ""
        #expect(path.contains("/opt/homebrew/bin"))
        #expect(path.contains("/usr/local/bin"))
    }
}

@Suite("SafeFile rejects symlinks")
struct SafeFileSymlinkTests {
    private func makeTmpDir() -> String {
        let path = NSTemporaryDirectory().appending("codeburn-safefile-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        return path
    }

    @Test("write throws when destination is a symlink")
    func writeRejectsSymlink() {
        let dir = makeTmpDir()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let realTarget = dir + "/real-secret.txt"
        try! "secret".data(using: .utf8)!.write(to: URL(fileURLWithPath: realTarget))
        let symlinkPath = dir + "/cache.json"
        try! FileManager.default.createSymbolicLink(atPath: symlinkPath, withDestinationPath: realTarget)

        #expect(throws: SafeFile.Error.self) {
            try SafeFile.write(Data("clobber".utf8), to: symlinkPath)
        }

        // Real target untouched.
        let after = try? String(contentsOfFile: realTarget, encoding: .utf8)
        #expect(after == "secret")
    }

    @Test("read throws when source is a symlink")
    func readRejectsSymlink() {
        let dir = makeTmpDir()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let realTarget = dir + "/real.txt"
        try! Data("hello".utf8).write(to: URL(fileURLWithPath: realTarget))
        let symlinkPath = dir + "/link.txt"
        try! FileManager.default.createSymbolicLink(atPath: symlinkPath, withDestinationPath: realTarget)

        #expect(throws: SafeFile.Error.self) {
            _ = try SafeFile.read(from: symlinkPath)
        }
    }

    @Test("write succeeds on regular file and round-trips")
    func writeRoundTrip() {
        let dir = makeTmpDir()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let path = dir + "/cache.json"
        let payload = Data("{\"k\": 1}".utf8)
        try! SafeFile.write(payload, to: path)
        let read = try! SafeFile.read(from: path)
        #expect(read == payload)
    }

    @Test("read enforces size limit")
    func readEnforcesSizeLimit() {
        let dir = makeTmpDir()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let path = dir + "/big.bin"
        let payload = Data(count: 4 * 1024)
        try! SafeFile.write(payload, to: path)
        #expect(throws: SafeFile.Error.self) {
            _ = try SafeFile.read(from: path, maxBytes: 1024)
        }
    }
}
