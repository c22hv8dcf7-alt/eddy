#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_updater::UpdaterExt;
use std::sync::Mutex;
use tauri::State;

// Holds a pending update between check and user confirmation
struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

#[tauri::command]
async fn install_pending_update(
    handle: tauri::AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take();
    match update {
        Some(u) => {
            u.download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| format!("install failed: {e}"))?;
            handle.restart();
        }
        None => return Err("no pending update".into()),
    }
    Ok(())
}

#[tauri::command]
fn dismiss_update(pending: State<'_, PendingUpdate>) {
    *pending.0.lock().unwrap() = None;
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![install_pending_update, dismiss_update])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(updater) = handle.updater() {
                    match updater.check().await {
                        Ok(Some(update)) => {
                            let version = update.version.clone();
                            let notes = update.body.clone().unwrap_or_default();
                            // Stash the update, then tell the frontend to show the popup
                            if let Some(state) = handle.try_state::<PendingUpdate>() {
                                *state.0.lock().unwrap() = Some(update);
                                let _ = handle.emit("update-available", serde_json::json!({
                                    "version": version,
                                    "notes": notes,
                                }));
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
