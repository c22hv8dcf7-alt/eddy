#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
async fn install_pending_update(handle: tauri::AppHandle) -> Result<(), String> {
    let updater = handle.updater().map_err(|e| format!("updater failed: {e}"))?;
    match updater.check().await.map_err(|e| format!("check failed: {e}"))? {
        Some(update) => {
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| format!("install failed: {e}"))?;
            handle.restart();
        }
        None => return Err("no update available".into()),
    }
    Ok(())
}

#[tauri::command]
fn dismiss_update() {
    // No-op: frontend just closes the modal
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![install_pending_update, dismiss_update])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(updater) = handle.updater() {
                    match updater.check().await {
                        Ok(Some(update)) => {
                            let version = update.version.clone();
                            let notes = update.body.clone().unwrap_or_default();
                            let _ = handle.emit("update-available", serde_json::json!({
                                "version": version,
                                "notes": notes,
                            }));
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
