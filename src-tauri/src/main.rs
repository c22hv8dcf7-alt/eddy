#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_updater::UpdaterExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Check quietly in the background on startup.
                // With "dialog": true in tauri.conf.json, Tauri shows its built-in
                // "update available" prompt when check() finds a newer version.
                if let Ok(updater) = handle.updater() {
                    match updater.check().await {
                        Ok(Some(_)) => {},
                        Ok(None) => {},
                        Err(e) => eprintln!("update check failed: {e}"),
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Eddy");
}
