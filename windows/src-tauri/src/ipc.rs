// Tauri command handlers exposed to the React frontend via `invoke()`.
// Each handler is the JSON boundary between the WebView and the OS — keep
// inputs validated and outputs typed.
//
// Async because the CLI spawn is async (tokio::process::Command, see
// codeburn_cli.rs for why std::process::Command deadlocks on Windows).
// Tauri 2.x natively supports `async fn` invoke handlers — the runtime
// is the tokio runtime Tauri owns, no extra setup needed.

use serde_json::Value;

use crate::codeburn_cli;

const VALID_PERIODS: &[&str] = &["today", "week", "30days", "month", "all"];

/// Fetch a period report. Returns the parsed JSON the CLI emits on
/// `--format json`. Errors are sanitized strings safe to render in the UI.
#[tauri::command]
pub async fn fetch_report(period: String) -> Result<Value, String> {
    // Defense-in-depth: even though the frontend only sends literals from a
    // typed enum, validate the value before passing it to the spawned
    // process. Belt-and-suspenders for the CLI argv.
    if !VALID_PERIODS.contains(&period.as_str()) {
        return Err(format!("invalid period: {period}"));
    }
    let stdout = codeburn_cli::run(&["report", "--format", "json", "-p", &period])
        .await
        .map_err(String::from)?;
    serde_json::from_str(&stdout).map_err(|e| crate::log_sanitizer::sanitize(&e.to_string()))
}

/// Open the full HTML report in the user's default browser. Generates the
/// file via `codeburn export --format html` first, then hands the path to
/// the OS shell. Same UX as "Full Report" in the Swift menubar.
#[tauri::command]
pub async fn open_full_report() -> Result<(), String> {
    let tmp = std::env::temp_dir().join("codeburn-report.html");
    let tmp_str = tmp.to_string_lossy().into_owned();
    codeburn_cli::run(&[
        "export",
        "--format",
        "html",
        "--all-projects",
        "--output",
        &tmp_str,
    ])
    .await
    .map_err(String::from)?;
    open::that(&tmp).map_err(|e| crate::log_sanitizer::sanitize(&e.to_string()))?;
    Ok(())
}
