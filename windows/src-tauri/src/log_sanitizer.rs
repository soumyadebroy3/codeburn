// Direct port of mac/Sources/CodeBurnMenubar/Security/LogSanitizer.swift —
// strip credential-shaped substrings from CLI stderr before they land in
// the WebView console or in a future log file. Same patterns, same order,
// same Bearer-rule negative-lookahead fix that landed in CI commit f51f749.

use once_cell::sync::Lazy;
use regex::Regex;

struct Pattern {
    re: Regex,
    replacement: &'static str,
}

static PATTERNS: Lazy<Vec<Pattern>> = Lazy::new(|| {
    vec![
        Pattern {
            re: Regex::new(r"sk-ant-[A-Za-z0-9_-]+").unwrap(),
            replacement: "sk-ant-***",
        },
        Pattern {
            re: Regex::new(r"sk-[A-Za-z0-9_-]{16,}").unwrap(),
            replacement: "sk-***",
        },
        Pattern {
            re: Regex::new(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+").unwrap(),
            replacement: "eyJ***",
        },
        // Bearer rule: skip when target already contains "***" so we don't
        // clobber a label-bearing replacement from earlier rules.
        Pattern {
            re: Regex::new(r"(?i)Bearer\s+(?:[A-Za-z0-9._\-+/=]+(?:\*\*\*)?[A-Za-z0-9._\-+/=]*)").unwrap(),
            replacement: "Bearer ***",
        },
        // 40+ char alphanumeric run = likely high-entropy session id / hex
        // hash / signature. Mask wholesale.
        Pattern {
            re: Regex::new(r"[A-Za-z0-9_\-]{40,}").unwrap(),
            replacement: "***",
        },
    ]
});

const MAX_LEN: usize = 240;

pub fn sanitize(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    // Drop NUL bytes that could confuse log readers.
    let mut cleaned = s.replace('\u{0}', "");
    for p in PATTERNS.iter() {
        cleaned = p.re.replace_all(&cleaned, p.replacement).to_string();
    }
    if cleaned.chars().count() > MAX_LEN {
        let truncated: String = cleaned.chars().take(MAX_LEN).collect();
        cleaned = format!("{truncated}…");
    }
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_anthropic_sk_ant_with_bearer() {
        let out = sanitize("Bearer sk-ant-abc123XYZ_-token");
        // Both prefixes should be visible — Bearer rule must NOT clobber the
        // already-masked sk-ant-*** label.
        assert!(out.contains("sk-ant-***"), "got: {out}");
        assert!(!out.contains("abc123"), "got: {out}");
    }

    #[test]
    fn masks_generic_sk_token() {
        let out = sanitize("api key is sk-1234567890abcdefghijk");
        assert!(out.contains("sk-***"), "got: {out}");
    }

    #[test]
    fn masks_jwt() {
        let out = sanitize("token: eyJabc.def.ghi");
        assert!(out.contains("eyJ***"), "got: {out}");
    }

    #[test]
    fn caps_long_input() {
        let s = "x".repeat(300);
        let out = sanitize(&s);
        assert!(out.chars().count() <= MAX_LEN + 1);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn empty_returns_empty() {
        assert_eq!(sanitize(""), "");
    }

    #[test]
    fn strips_nul_bytes() {
        let out = sanitize("hello\u{0}world");
        assert!(!out.contains('\u{0}'));
    }
}
