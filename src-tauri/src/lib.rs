pub mod body;
mod commands;
pub mod protocol;
pub mod remote;
pub mod session;
pub mod storage;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Peek Desktop");
}
