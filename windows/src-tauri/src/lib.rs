// Tauri 2.x library entry. main.rs delegates here so the same code can be
// linked into desktop, mobile-stub, or test targets in the future. For now
// this is the only entry point.

mod codeburn_cli;
mod log_sanitizer;
mod ipc;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, WindowEvent,
};

/// Construct the right-click menu shown on the tray icon. Items use
/// stable IDs ("show", "refresh", "report", "quit") so the on_menu_event
/// handler matches against literals rather than dynamic strings.
fn build_tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
    let report = MenuItem::with_id(app, "report", "Open full report", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    Menu::with_items(app, &[&show, &refresh, &report, &separator, &quit])
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "show" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        "refresh" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.emit("tray:refresh", ());
            }
        }
        "report" => {
            let _ = ipc::open_full_report();
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

fn handle_tray_click<R: Runtime>(app: &AppHandle<R>, event: &TrayIconEvent) {
    let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else { return };
    // Toggle: if visible, hide; otherwise show + focus.
    if let Ok(true) = window.is_visible() {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
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
        // via `codeburn tray --force` instead. Re-add when we ship signed
        // updates.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // Single-instance: re-launching the tray while one is running just
        // focuses the existing popover (mirrors macOS Swift app behaviour).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            ipc::fetch_report,
            ipc::open_full_report,
        ])
        .setup(|app| {
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
            // Hide-on-blur for the popover so clicking outside closes it,
            // matching macOS NSPopover behaviour.
            if let WindowEvent::Focused(false) = event {
                if window.label() == "main" {
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
