pub mod archive;
pub mod body;
mod commands;
pub mod export;
pub mod protocol;
pub mod query;
pub mod remote;
pub mod session;
pub mod storage;

pub fn run() {
    use tauri::Emitter;
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(commands::AppState::default())
        .on_menu_event(|app, event| {
            // Stable command IDs outlive menu rebuilds and JS resource disposal.
            let _ = app.emit_to("main", "peek-menu-command", event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_peek,
            commands::cancel_import,
            commands::list_sessions,
            commands::close_session,
            commands::query_entries,
            commands::get_entry_metadata,
            commands::get_body,
            commands::save_peek,
            commands::save_bundle,
            commands::export_scope,
            commands::copy_curl,
            commands::remote_snapshot,
            commands::start_listener,
            commands::stop_listener,
            commands::issue_pairing_code,
            commands::revoke_device,
            commands::subscribe_remote,
            commands::acknowledge_remote,
            commands::unsubscribe_remote,
            commands::get_entry_info,
            commands::query_diagnostics,
            commands::get_diagnostic,
            commands::close_diagnostic,
            commands::review_diagnostics,
            commands::query_timeline,
            commands::copy_diagnostics,
            commands::export_diagnostics,
            commands::write_clipboard,
            commands::popup_context_menu,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Peek Desktop");
}
