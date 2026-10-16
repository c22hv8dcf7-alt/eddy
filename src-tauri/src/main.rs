#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_updater::UpdaterExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(updater) = handle.updater() {
                    match updater.check().await {
                        Ok(Some(update)) => {
                            // Download and install the update, then restart.
                            match update.download_and_install(|_, _| {}, || {}).await {
                                Ok(_) => {
                                    eprintln!("update installed, restarting");
                                    handle.restart();
                                }
                                Err(e) => eprintln!("update install failed: {e}"),
                            }
                        }
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
