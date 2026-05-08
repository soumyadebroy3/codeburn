import Foundation

/// Strip control characters and any token-shaped substrings from server-error
/// strings before they land in `NSLog` (which writes to the macOS unified log
/// readable by any local user via `log stream`) or the UI.
///
/// Anthropic / OpenAI error envelopes don't typically echo tokens, but a
/// future change on the server side could; this layer makes the menubar
/// robust to that. Used by both AppStore (UI surfaces) and credential-store
/// NSLog sites (refresh-rotation persistence failures, decode failures).
enum LogSanitizer {
    private static let patterns: [(pattern: String, replacement: String)] = [
        (#"sk-ant-[A-Za-z0-9_-]+"#, "sk-ant-***"),
        (#"sk-[A-Za-z0-9_-]{16,}"#, "sk-***"),
        (#"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"#, "eyJ***"),
        // Bearer rule must NOT clobber a credential already masked by an
        // earlier rule (e.g. "Bearer sk-ant-***"). The negative lookahead
        // skips the match when the post-Bearer token already contains "***",
        // preserving label-bearing replacements like "sk-ant-***" / "eyJ***".
        (#"(?i)Bearer\s+(?!\S*\*\*\*)\S+"#, "Bearer ***"),
        // Generic high-entropy hex/base64 segments 32+ chars long are usually
        // session IDs, signatures, or refresh tokens. Mask them.
        (#"[A-Za-z0-9_\-]{40,}"#, "***"),
    ]

    static func sanitize(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        var cleaned = s.replacingOccurrences(of: "\u{0000}", with: "")
        for entry in patterns {
            cleaned = cleaned.replacingOccurrences(
                of: entry.pattern,
                with: entry.replacement,
                options: .regularExpression
            )
        }
        if cleaned.count > 240 { cleaned = String(cleaned.prefix(240)) + "…" }
        return cleaned
    }

    /// NSLog wrapper that runs every interpolated value through `sanitize` first.
    /// Use at every site that logs a server error body, exception, or any
    /// string that might contain a credential.
    static func logSafe(_ tag: String, _ value: Any) {
        let s = LogSanitizer.sanitize(String(describing: value)) ?? "<empty>"
        NSLog("CodeBurn: %@: %@", tag, s)
    }
}
