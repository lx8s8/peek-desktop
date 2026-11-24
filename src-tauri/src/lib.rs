pub mod app_info;
pub mod archive;
pub mod body;
mod commands;
pub mod export;
pub mod file_open;
pub mod plugins;
pub mod protocol;
pub mod query;
pub mod recovery;
pub mod remote;
pub mod replay;
pub mod session;
pub mod storage;
pub mod stream;
pub mod updates;

pub fn run() {
    use tauri::{Emitter, Manager};
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            app.state::<file_open::OpenFiles>()
                .arguments(&args, std::path::Path::new(&cwd));
            file_open::notify(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(commands::AppState::default())
        .manage(updates::Checker::default())
        .manage(file_open::OpenFiles::default())
        .setup(|app| {
            let args = std::env::args().collect::<Vec<_>>();
            app.state::<file_open::OpenFiles>()
                .arguments(&args, &std::env::current_dir()?);
            commands::start_recovery(app)?;
            commands::start_plugins(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            // Stable command IDs outlive menu rebuilds and JS resource disposal.
            let _ = app.emit_to("main", "peek-menu-command", event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            commands::check_updates,
            commands::open_release_link,
            commands::app_info,
            commands::legal_text,
            commands::open_project_link,
            commands::open_peek,
            commands::open_file_path,
            commands::open_pending_file,
            commands::has_pending_files,
            commands::cancel_import,
            commands::list_sessions,
            commands::close_session,
            commands::query_entries,
            commands::toggle_entry_pin,
            commands::get_entry_metadata,
            commands::get_body,
            commands::save_peek,
            commands::save_bundle,
            commands::export_scope,
            commands::copy_curl,
            commands::copy_snippet,
            commands::replay_request,
            commands::replay_request_batch,
            commands::recovery_status,
            commands::set_recovery_enabled,
            commands::save_recovery,
            commands::restore_recovery,
            commands::start_new_recovery,
            commands::remote_snapshot,
            commands::local_addresses,
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
            commands::query_stream,
            commands::find_stream_matches,
            commands::locate_stream_entry,
            commands::copy_stream_block,
            commands::export_stream_text,
            commands::copy_diagnostics,
            commands::export_diagnostics,
            commands::write_clipboard,
            commands::popup_context_menu,
            commands::list_plugins,
            commands::upsert_plugin,
            commands::remove_plugin,
            commands::set_plugin_enabled,
            commands::set_default_plugin,
            commands::parse_plugin_input,
            commands::parse_plugin_file_path,
            commands::fetch_plugin_from_url,
            commands::pick_plugin_file,
            commands::pick_symbols_directory,
            commands::export_plugin_config,
            commands::save_plugin_file,
            commands::test_symbolicator_plugin,
            commands::symbolicate_stack,
            commands::clear_symbolicate_cache,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Peek Desktop")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { ref urls } = event {
                app.state::<file_open::OpenFiles>()
                    .enqueue(urls.iter().filter_map(|url| url.to_file_path().ok()));
                file_open::notify(app);
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event
                && commands::save_before_exit(app)
            {
                api.prevent_exit();
            }
        });
}
