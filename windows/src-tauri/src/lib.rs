// Tauri 2.x library entry. main.rs delegates here so the same code can be
// linked into desktop, mobile-stub, or test targets in the future. For now
// this is the only entry point.

mod codeburn_cli;
mod log_sanitizer;
mod ipc;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            // Build the right-click context menu. Left-click toggles the
            // popover; users only see this menu via right-click on the tray
            // icon, matching Windows convention.
            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let refresh_item = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
            let report_item = MenuItem::with_id(app, "report", "Open full report", true, None::<&str>)?;
            let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show_item, &refresh_item, &report_item, &separator, &quit_item],
            )?;

            // Tray icon. Tooltip + menu + click handlers wired here. The
            // tooltip text gets overwritten with today's spend once the
            // first fetch_report call returns, via emit_to from JS.
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("icon").clone())
                .icon_as_template(false)
                .tooltip("CodeBurn — loading…")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
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
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            // Toggle: if visible, hide; otherwise show + focus.
                            match window.is_visible() {
                                Ok(true) => {
                                    let _ = window.hide();
                                }
                                _ => {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    }
                })
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
