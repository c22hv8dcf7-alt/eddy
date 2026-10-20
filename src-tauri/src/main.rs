#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
async fn check_for_update(handle: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let updater = handle
        .updater()
        .map_err(|e| format!("updater failed: {e}"))?;
    match updater
        .check()
        .await
        .map_err(|e| format!("check failed: {e}"))?
    {
        Some(update) => Ok(Some(serde_json::json!({
            "version": update.version,
            "notes": update.body.unwrap_or_default(),
        }))),
        None => Ok(None),
    }
}

#[tauri::command]
async fn install_pending_update(handle: tauri::AppHandle) -> Result<(), String> {
    let updater = handle
        .updater()
        .map_err(|e| format!("updater failed: {e}"))?;
    match updater
        .check()
        .await
        .map_err(|e| format!("check failed: {e}"))?
    {
        Some(update) => {
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| format!("install failed: {e}"))?;
            handle.restart();
        }
        None => Err("no update available".into()),
    }
}

#[tauri::command]
fn dismiss_update() {
    // No-op: frontend just closes the modal
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            check_for_update,
            install_pending_update,
            dismiss_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running Eddy");
}
