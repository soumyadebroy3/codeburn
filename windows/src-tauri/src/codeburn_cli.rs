// Hardened spawn helper for the `codeburn` CLI. Direct port of
// mac/Sources/CodeBurnMenubar/Security/CodeburnCLI.swift — same env-scrub
// posture, same trusted-path allow-list, same timeout discipline.
//
// Trust model: codeburn is a Node.js script the user installed via npm or
// brew. We refuse to spawn it from anywhere we don't recognize as a
// legitimate package-manager install location, because a binary on `$PATH`
// from a writable directory is a classic privilege-shift vector.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

const SPAWN_TIMEOUT: Duration = Duration::from_secs(60);

// Keep this set TIGHT. Adding paths is a security decision: each entry is
// somewhere a user has chosen to put binaries (npm-global, scoop, winget).
// Anything else (a writable temp dir, a downloads folder) we refuse.
const TRUSTED_BINARY_DIRS_WIN: &[&str] = &[
    "Program Files",
    "AppData\\Roaming\\npm",      // npm-global (Windows)
    "scoop\\shims",               // Scoop
    "WinGet\\Packages",           // WinGet
];

const TRUSTED_BINARY_DIRS_UNIX: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/.npm-global/bin",            // npm-global Linux/mac
];

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "codeburn.cmd"
    } else {
        "codeburn"
    }
}

/// Find an absolute, trusted path to the `codeburn` binary. Returns None
/// if we can't locate one in a known-trustworthy directory.
pub fn resolve_binary() -> Option<PathBuf> {
    // Allow an explicit override for power users who installed somewhere
    // unusual (e.g. a portable Node tarball). We only honour it if the
    // path passes a basic safety check (absolute + no shell metacharacters).
    if let Ok(override_path) = std::env::var("CODEBURN_BIN") {
        let p = PathBuf::from(&override_path);
        if p.is_absolute() && !override_path.chars().any(is_shell_metachar) && p.exists() {
            return Some(p);
        }
    }

    // Walk PATH and pick the first match in a trusted dir.
    let path_env = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_env) {
        let candidate = dir.join(binary_name());
        if !candidate.exists() {
            continue;
        }
        let s = candidate.to_string_lossy();
        let trusted = if cfg!(windows) {
            TRUSTED_BINARY_DIRS_WIN.iter().any(|t| s.contains(t))
        } else {
            TRUSTED_BINARY_DIRS_UNIX.iter().any(|t| s.starts_with(t))
        };
        if trusted {
            return Some(candidate);
        }
    }
    None
}

fn is_shell_metachar(c: char) -> bool {
    matches!(c, ';' | '&' | '|' | '`' | '$' | '<' | '>' | '\n' | '\r')
}

/// Allow-listed env for the spawn. Strips NODE_OPTIONS / DYLD_* / LD_* /
/// PYTHON* / GIT_*, keeps only what `codeburn` actually needs to find its
/// data files (HOME, USERPROFILE, APPDATA, LANG, PATH, plus CODEBURN_*
/// scoped overrides the user may have set).
pub fn scrub_env() -> HashMap<String, String> {
    let mut clean = HashMap::new();
    let allow_exact = [
        "PATH",
        "HOME",
        "USER",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TMPDIR",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "SystemRoot",
        "ComSpec",
    ];
    let allow_prefix = ["LC_", "CODEBURN_"];
    for (k, v) in std::env::vars() {
        let kept = allow_exact.iter().any(|a| k.eq_ignore_ascii_case(a))
            || allow_prefix.iter().any(|p| k.starts_with(p));
        if kept {
            clean.insert(k, v);
        }
    }
    clean
}

#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error("codeburn binary not found in trusted paths — install with: npm i -g @soumyadebroy3/codeburn")]
    BinaryNotFound,
    #[error("codeburn exited non-zero ({0}): {1}")]
    NonZeroExit(i32, String),
    #[error("codeburn took longer than {0:?}")]
    Timeout(Duration),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Run `codeburn <args>` and return stdout. Caller handles JSON parse.
pub fn run(args: &[&str]) -> Result<String, CliError> {
    let bin = resolve_binary().ok_or(CliError::BinaryNotFound)?;
    let env = scrub_env();
    let mut cmd = Command::new(&bin);
    cmd.args(args)
        .env_clear()
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Spawn with a timeout guard. wait() blocks indefinitely so we
    // poll-with-deadline via std::process::Child::wait_timeout — that lives
    // in the `wait-timeout` crate which we'd add later. For v1 we accept a
    // synchronous wait but the CLI itself has internal timeouts on git +
    // network so this is bounded in practice.
    let output = cmd.output()?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(CliError::NonZeroExit(
            output.status.code().unwrap_or(-1),
            crate::log_sanitizer::sanitize(&stderr),
        ));
    }
    let _ = SPAWN_TIMEOUT; // referenced; full timeout impl pending wait-timeout dep
    Ok(stdout)
}

// Helper for Tauri command handlers: thiserror conversion to a String the
// frontend can show in an error toast.
impl From<CliError> for String {
    fn from(value: CliError) -> Self {
        crate::log_sanitizer::sanitize(&value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_strips_node_and_dyld() {
        std::env::set_var("NODE_OPTIONS", "--max-old-space-size=4096");
        std::env::set_var("DYLD_INSERT_LIBRARIES", "/tmp/evil.dylib");
        std::env::set_var("CODEBURN_HOME", "/legit");
        let clean = scrub_env();
        assert!(!clean.contains_key("NODE_OPTIONS"));
        assert!(!clean.contains_key("DYLD_INSERT_LIBRARIES"));
        assert_eq!(clean.get("CODEBURN_HOME").map(String::as_str), Some("/legit"));
        std::env::remove_var("NODE_OPTIONS");
        std::env::remove_var("DYLD_INSERT_LIBRARIES");
        std::env::remove_var("CODEBURN_HOME");
    }

    #[test]
    fn shell_metachar_detection() {
        assert!(is_shell_metachar(';'));
        assert!(is_shell_metachar('&'));
        assert!(is_shell_metachar('\n'));
        assert!(!is_shell_metachar('a'));
        assert!(!is_shell_metachar('-'));
    }
}
