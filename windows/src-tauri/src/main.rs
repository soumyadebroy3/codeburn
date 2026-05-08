// Prevent a console window from popping up under release builds. Without
// this attribute, MSI/NSIS-installed double-click launches show a black
// cmd.exe alongside the tray app for a fraction of a second.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    codeburn_tray_lib::run()
}
