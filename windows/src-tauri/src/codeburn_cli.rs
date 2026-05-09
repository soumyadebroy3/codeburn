// Hardened spawn helper for the `codeburn` CLI. Direct port of
// mac/Sources/CodeBurnMenubar/Security/CodeburnCLI.swift — same env-scrub
// posture, same trusted-path allow-list, same timeout discipline.
//
// Trust model: codeburn is a Node.js script the user installed via npm or
// brew. We refuse to spawn it from anywhere we don't recognize as a
// legitimate package-manager install location, because a binary on `$PATH`
// from a writable directory is a classic privilege-shift vector.
//
// Spawn model (Windows-critical): we use tokio::process::Command instead
// of std::process::Command because std's `output()` deadlocks on Windows
// when the child is a .cmd shim under windows_subsystem="windows" + piped
// stdio. The deadlock manifested as "stuck at codeburn loading" — the
// popover sat indefinitely, codeburn ran fine when invoked from PowerShell
// directly. Tokio's async pipe drains run in parallel so neither stream
// can fill the OS pipe buffer and block the child. Pattern adopted from
// upstream's feat/windows-menubar-tauri PR #101 cli.rs.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

/// Wall-clock cap on a single CLI invocation. After this, we kill the
/// child and surface a CliError::Timeout to the UI. 60s is generous —
/// codeburn's own report typically completes in <2s on warm caches; first
/// run after install can take 10–20s on heavy session corpora.
const SPAWN_TIMEOUT: Duration = Duration::from_secs(60);

/// Hard cap on stdout we'll buffer. codeburn's JSON output for `report`
/// is at most a few hundred KB even for power users; 20 MB is a safety
/// belt for a hostile or runaway CLI.
const MAX_PAYLOAD_BYTES: usize = 20 * 1024 * 1024;
/// Stderr cap is much smaller — anything above 256 KB of stderr means
/// codeburn is in distress and we'd rather truncate the diagnostic than
/// pin RAM.
const MAX_STDERR_BYTES: usize = 256 * 1024;

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
    if let Ok(override_path) = std::env::var("CODEBURN_BIN") {
        let p = PathBuf::from(&override_path);
        if p.is_absolute() && !override_path.chars().any(is_shell_metachar) && p.exists() {
            return Some(p);
        }
    }

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
        "PATHEXT",
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
    #[error("codeburn took longer than {0:?} — the CLI may be hung; try `codeburn report` directly to debug")]
    Timeout(Duration),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("spawn failed: {0}")]
    Spawn(String),
}

/// Run `codeburn <args>` and return stdout. Caller handles JSON parse.
/// Async because we need parallel pipe drain + a wall-clock timeout to
/// avoid hangs on Windows .cmd-shim invocation.
pub async fn run(args: &[&str]) -> Result<String, CliError> {
    let bin = resolve_binary().ok_or(CliError::BinaryNotFound)?;
    let env = scrub_env();

    let mut cmd = Command::new(&bin);
    cmd.args(args)
        .env_clear()
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true); // orphan-cleanup if the Tauri command future is dropped

    // Suppress the cmd.exe console flash on every invocation. Without this
    // flag, every 30s auto-refresh shows a black window blink — visible
    // to the user as "some cmd is keep opening and closing".
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| CliError::Spawn(e.to_string()))?;

    // Take the pipes BEFORE the timeout-wrapped wait so we can drain them
    // concurrently. Without parallel drains, std::process::Command::output()
    // can deadlock on Windows when stderr fills the 64 KB pipe buffer
    // before stdout finishes — the child blocks on stderr.write, Tauri
    // blocks reading stdout to EOF, neither side moves.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CliError::Spawn("missing stdout pipe".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| CliError::Spawn("missing stderr pipe".into()))?;

    let stdout_task = tokio::spawn(async move {
        let mut limited = stdout.take(MAX_PAYLOAD_BYTES as u64);
        let mut buf = Vec::with_capacity(64 * 1024);
        let _ = limited.read_to_end(&mut buf).await;
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut limited = stderr.take(MAX_STDERR_BYTES as u64);
        let mut buf = Vec::with_capacity(4 * 1024);
        let _ = limited.read_to_end(&mut buf).await;
        buf
    });

    let status = match timeout(SPAWN_TIMEOUT, child.wait()).await {
        Ok(s) => s.map_err(|e| CliError::Spawn(e.to_string()))?,
        Err(_) => {
            // Best-effort kill; kill_on_drop also fires when child goes
            // out of scope, but explicit kill makes the timeout deterministic.
            let _ = child.kill().await;
            return Err(CliError::Timeout(SPAWN_TIMEOUT));
        }
    };

    let stdout_bytes = stdout_task.await.unwrap_or_default();
    let stderr_bytes = stderr_task.await.unwrap_or_default();
    let stdout_str = String::from_utf8_lossy(&stdout_bytes).into_owned();

    if !status.success() {
        let stderr_str = String::from_utf8_lossy(&stderr_bytes).into_owned();
        return Err(CliError::NonZeroExit(
            status.code().unwrap_or(-1),
            crate::log_sanitizer::sanitize(&stderr_str),
        ));
    }
    Ok(stdout_str)
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
