#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(updater) = handle.updater() {
                    match updater.check().await {
                        Ok(Some(update)) => {
                            let version = update.version.clone();
                            let notes = update.body.clone().unwrap_or_default();
                            let msg = if notes.is_empty() {
                                format!("Eddy {} is available. Install now?", version)
                            } else {
                                format!("Eddy {} is available.\n\n{}\n\nInstall now?", version, notes)
                            };
                            let answer = handle.dialog()
                                .message(msg)
                                .title("Update available")
                                .kind(MessageDialogKind::Info)
                                .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                                    "Install".to_string(),
                                    "Later".to_string(),
                                ))
                                .blocking_show();
                            if answer {
                                match update.download_and_install(|_, _| {}, || {}).await {
                                    Ok(_) => handle.restart(),
                                    Err(e) => eprintln!("update install failed: {e}"),
                                }
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
