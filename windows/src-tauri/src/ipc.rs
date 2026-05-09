// Tauri command handlers exposed to the React frontend via `invoke()`.
// Each handler is the JSON boundary between the WebView and the OS — keep
// inputs validated and outputs typed.
//
// Async because the CLI spawn is async (tokio::process::Command, see
// codeburn_cli.rs for why std::process::Command deadlocks on Windows).
// Tauri 2.x natively supports `async fn` invoke handlers — the runtime
// is the tokio runtime Tauri owns, no extra setup needed.

use serde::Serialize;
use serde_json::Value;

use crate::codeburn_cli;

const VALID_PERIODS: &[&str] = &["today", "week", "30days", "month", "all"];
const VALID_PROVIDERS: &[&str] = &[
    "all", "claude", "codex", "cursor", "copilot", "gemini", "droid", "opencode",
];

fn sanitize(msg: impl AsRef<str>) -> String {
    crate::log_sanitizer::sanitize(msg.as_ref())
}

/// Legacy report endpoint kept for tray menu "Refresh" wiring; the popover
/// now uses fetch_payload.
#[tauri::command]
pub async fn fetch_report(period: String) -> Result<Value, String> {
    if !VALID_PERIODS.contains(&period.as_str()) {
        return Err(format!("invalid period: {period}"));
    }
    let stdout = codeburn_cli::run(&["report", "--format", "json", "-p", &period])
        .await
        .map_err(String::from)?;
    serde_json::from_str(&stdout).map_err(|e| sanitize(e.to_string()))
}

/// Fetch the menubar payload — same JSON the macOS menubar consumes.
/// `include_optimize=false` skips the optimize pass; the popover passes false
/// on its 60s background refreshes.
#[tauri::command]
pub async fn fetch_payload(
    period: String,
    provider: String,
    include_optimize: bool,
) -> Result<Value, String> {
    if !VALID_PERIODS.contains(&period.as_str()) {
        return Err(format!("invalid period: {period}"));
    }
    if !VALID_PROVIDERS.contains(&provider.as_str()) {
        return Err(format!("invalid provider: {provider}"));
    }
    let mut args: Vec<&str> = vec![
        "status",
        "--format",
        "menubar-json",
        "--period",
        &period,
        "--provider",
        &provider,
    ];
    if !include_optimize {
        args.push("--no-optimize");
    }
    let stdout = codeburn_cli::run(&args).await.map_err(String::from)?;
    serde_json::from_str(&stdout).map_err(|e| sanitize(e.to_string()))
}

#[derive(Serialize)]
pub struct CurrencyState {
    code: String,
    symbol: String,
    rate: f64,
}

/// Set the active currency and return {code, symbol, rate}. Implemented by
/// shelling to `codeburn currency CODE` (which persists the config and
/// refreshes the FX cache), then parsing the human-readable stdout. Keeping
/// the CLI as the source of truth means terminal `codeburn currency` and
/// the picker stay coherent.
#[tauri::command]
pub async fn set_currency(code: String) -> Result<CurrencyState, String> {
    let upper = code.to_uppercase();
    if !is_valid_currency_code(&upper) {
        return Err(format!("invalid currency code: {code}"));
    }
    if upper == "USD" {
        codeburn_cli::run(&["currency", "--reset"])
            .await
            .map_err(String::from)?;
        return Ok(CurrencyState {
            code: "USD".into(),
            symbol: "$".into(),
            rate: 1.0,
        });
    }
    let stdout = codeburn_cli::run(&["currency", &upper])
        .await
        .map_err(String::from)?;
    Ok(parse_currency_stdout(&stdout, &upper))
}

fn is_valid_currency_code(code: &str) -> bool {
    code.len() == 3 && code.chars().all(|c| c.is_ascii_uppercase())
}

/// Parses output like:
///   Currency set to GBP.
///   Symbol: £
///   Rate: 1 USD = 0.79 GBP
fn parse_currency_stdout(stdout: &str, expected_code: &str) -> CurrencyState {
    let mut symbol: Option<String> = None;
    let mut rate: Option<f64> = None;
    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Symbol:") {
            symbol = Some(rest.trim().to_string());
        } else if let Some(rest) = trimmed.strip_prefix("Rate:") {
            // "1 USD = 0.79 GBP"
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if let Some(v) = parts.get(3) {
                rate = v.parse::<f64>().ok();
            }
        }
    }
    CurrencyState {
        code: expected_code.to_string(),
        symbol: symbol.unwrap_or_else(|| expected_code.to_string()),
        rate: rate.unwrap_or(1.0),
    }
}

/// Open the full HTML report in the user's default browser.
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
    open::that(&tmp).map_err(|e| sanitize(e.to_string()))?;
    Ok(())
}

/// Wire the popover's "Open Full Report" / "Export" buttons. Allowlisted
/// against a small set of CLI subcommands before reaching the spawn boundary.
#[tauri::command]
pub async fn open_terminal_command(args: Vec<String>) -> Result<(), String> {
    let head = args.first().map(String::as_str).unwrap_or("");
    match head {
        "report" => open_full_report().await,
        "export" => {
            let format = args
                .iter()
                .skip_while(|a| a.as_str() != "-f")
                .nth(1)
                .map(String::as_str)
                .unwrap_or("");
            if !matches!(format, "csv" | "json") {
                return Err(format!("invalid export format: {format}"));
            }
            let tmp = std::env::temp_dir().join(if format == "csv" {
                "codeburn-export"
            } else {
                "codeburn-export.json"
            });
            let tmp_str = tmp.to_string_lossy().into_owned();
            codeburn_cli::run(&[
                "export",
                "--format",
                format,
                "--all-projects",
                "--output",
                &tmp_str,
            ])
            .await
            .map_err(String::from)?;
            open::that(&tmp).map_err(|e| sanitize(e.to_string()))?;
            Ok(())
        }
        other => Err(format!("disallowed command: {other}")),
    }
}

#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}
