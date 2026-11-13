pub mod body;
mod commands;
pub mod protocol;
pub mod query;
pub mod remote;
pub mod session;
pub mod storage;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_peek,
            commands::cancel_import,
            commands::list_sessions,
            commands::close_session,
            commands::query_entries,
            commands::get_entry_metadata,
            commands::get_body,
            commands::save_peek,
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Peek Desktop");
}
