// Tauri 2.x library entry. main.rs delegates here so the same code can be
// linked into desktop, mobile-stub, or test targets in the future. For now
// this is the only entry point.

mod codeburn_cli;
mod log_sanitizer;
mod ipc;

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewWindow, Window,
    WindowEvent,
};

const POPOVER_LABEL: &str = "popover";

/// Track when the popover was last hidden so the tray-icon click that fires
/// AFTER the Focused(false) hide doesn't immediately re-show it. Without
/// this debounce, clicking the tray icon while the popover is visible
/// produces:
///   1. focus moves to tray → popover gets Focused(false) → window.hide()
///   2. tray click handler fires → toggle → popover.show() — RE-SHOWN
/// With the guard: step 2's show() is skipped if step 1 happened <300ms ago.
/// Pattern adapted from upstream's PR #101 (closed-not-merged, but the
/// pattern is sound — closed only because they hadn't tested on Windows yet).
static LAST_HIDDEN_MS: AtomicI64 = AtomicI64::new(0);
const TOGGLE_DEBOUNCE_MS: i64 = 300;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn build_tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
    let report = MenuItem::with_id(app, "report", "Open full report", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    Menu::with_items(app, &[&show, &refresh, &report, &separator, &quit])
}

/// Show the popover, anchoring it near the top-right of the primary monitor
/// (where the Windows system tray lives). Forces focus AFTER show() because
/// the window has `focus: false` in tauri.conf.json — that prevents
/// internal control clicks from triggering Focused(false), but the user's
/// initial open does need focus so click-outside-to-dismiss works.
fn show_popover<R: Runtime>(window: &WebviewWindow<R>) {
    position_popover_near_tray(window);
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Hide accepts `&Window` (the type the WindowEvent closure provides) so the
/// outer-event handler can call it without a label lookup. Internally it just
/// records the timestamp + hides — no WebviewWindow-specific calls needed.
fn hide_window(window: &Window<impl Runtime>) {
    LAST_HIDDEN_MS.store(now_ms(), Ordering::Relaxed);
    let _ = window.hide();
}

fn toggle_popover<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(POPOVER_LABEL) else { return };
    if window.is_visible().unwrap_or(false) {
        LAST_HIDDEN_MS.store(now_ms(), Ordering::Relaxed);
        let _ = window.hide();
        return;
    }
    // Debounce: if we just hid, the user's click is the same one that caused
    // the hide — don't immediately re-show.
    if now_ms() - LAST_HIDDEN_MS.load(Ordering::Relaxed) < TOGGLE_DEBOUNCE_MS {
        return;
    }
    show_popover(&window);
}

/// Place the popover in the top-right corner of the primary monitor with a
/// margin reserved for the taskbar. This is the simplest "near the tray"
/// approach on Windows; Tauri's tray click events don't include pixel
/// coordinates, so we can't precisely anchor to the icon itself. Linux gets
/// real coords from StatusNotifierItem::Activate, but we don't ship there.
fn position_popover_near_tray<R: Runtime>(window: &WebviewWindow<R>) {
    const POPOVER_W: f64 = 380.0;
    const POPOVER_H: f64 = 560.0;
    const MARGIN: f64 = 12.0;
    const TASKBAR: f64 = 52.0;

    let Ok(Some(monitor)) = window.primary_monitor() else { return };
    let scale = monitor.scale_factor();
    let screen = monitor.size();
    let screen_w_logical = (screen.width as f64) / scale;
    let screen_h_logical = (screen.height as f64) / scale;

    let x = (screen_w_logical - POPOVER_W - MARGIN).max(MARGIN);
    let y = (screen_h_logical - POPOVER_H - TASKBAR).max(MARGIN);

    let _ = window.set_size(LogicalSize::new(POPOVER_W, POPOVER_H));
    let _ = window.set_position(LogicalPosition::new(x, y));
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "show" => {
            if let Some(w) = app.get_webview_window(POPOVER_LABEL) {
                show_popover(&w);
            }
        }
        "refresh" => {
            if let Some(w) = app.get_webview_window(POPOVER_LABEL) {
                let _ = w.emit("tray:refresh", ());
            }
        }
        "report" => {
            let _ = ipc::open_full_report();
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

fn handle_tray_click<R: Runtime>(app: &AppHandle<R>, event: &TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        toggle_popover(app);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        // tauri-plugin-updater intentionally omitted for v1: it requires
        // an Ed25519 keypair (private key in CI secrets, public key
        // embedded here) and we don't yet have a key-management story for
        // the fork. Without `pubkey` set, the plugin panics on init with
        // PluginInitialization("updater", "missing field `pubkey`") and
        // the whole app exits before the tray icon registers. Users update
        // via `codeburn tray --force` instead.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window(POPOVER_LABEL) {
                show_popover(&w);
            }
        }))
        .invoke_handler(tauri::generate_handler![
            ipc::fetch_report,
            ipc::open_full_report,
        ])
        .setup(|app| {
            // Make sure popover starts hidden — we control visibility via
            // tray click only. tauri.conf.json also has `visible: false`,
            // this is belt-and-suspenders.
            if let Some(w) = app.get_webview_window(POPOVER_LABEL) {
                let _ = w.hide();
            }

            let menu = build_tray_menu(app.handle())?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("icon").clone())
                .icon_as_template(false)
                .tooltip("CodeBurn — loading…")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()))
                .on_tray_icon_event(|tray, event| handle_tray_click(tray.app_handle(), &event))
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide-on-blur for the popover (macOS NSPopover-like dismissal).
            // Combined with `focus: false` in tauri.conf.json + the
            // LAST_HIDDEN_MS debounce in toggle_popover, this only fires when
            // the user clicks OUTSIDE the popover (another app, the desktop,
            // etc.) — internal control clicks no longer disturb focus
            // because the window starts unfocused and only set_focus()
            // (called once from show_popover) puts focus on it.
            //
            // CloseRequested also routes through hide() so killing the
            // popover via Alt+F4 just hides it; the tray icon stays alive.
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if window.label() == POPOVER_LABEL {
                        hide_window(window);
                    }
                }
                WindowEvent::Focused(false) => {
                    if window.label() == POPOVER_LABEL {
                        hide_window(window);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|_app, event| {
            // Don't exit when the popover window is closed — we're a tray
            // app, the lifecycle is owned by the tray icon, not by any
            // window. Without this, Tauri tries to exit after the last
            // window closes (the popover) and the tray dies with it.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}
