use crate::{
    body::{self, BodyView},
    protocol::session::Result,
    remote::server::Remote,
    session::{Library, QueryPage, SessionSummary},
    storage,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{State, ipc::Channel};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn popup_context_menu(
    webview: tauri::Webview,
    window: tauri::Window,
    rid: u32,
    x: f64,
    y: f64,
) -> Result<()> {
    use tauri::{Manager, menu::ContextMenu};
    // Native menu tracking runs a nested event loop on macOS. Release the
    // resource table before entering it so concurrent IPC cannot deadlock it.
    let menu = {
        let resources = webview.resources_table();
        resources
            .get::<tauri::menu::Menu<tauri::Wry>>(rid)
            .map_err(|error| error.to_string())?
    };
    tauri::async_runtime::spawn_blocking(move || {
        menu.popup_at(window, tauri::LogicalPosition::new(x, y))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "internalError".to_string())?
}

#[derive(Default)]
pub struct AppState {
    remote: Arc<Remote>,
    subscriptions: Mutex<std::collections::HashMap<String, Subscription>>,
    library: Arc<Mutex<Library>>,
    import: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    bytes_read: usize,
    total_bytes: u64,
}

struct ImportGuard(Arc<Mutex<Option<Arc<AtomicBool>>>>);
impl Drop for ImportGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.lock() {
            *active = None;
        }
    }
}

#[tauri::command]
pub async fn open_peek(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    progress: Channel<ImportProgress>,
) -> Result<Option<SessionSummary>> {
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = state.import.lock().map_err(|_| "internalError")?;
        if active.is_some() {
            return Err("importBusy".into());
        }
        *active = Some(Arc::clone(&cancelled));
    }
    let guard = ImportGuard(Arc::clone(&state.import));
    let library = Arc::clone(&state.library);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("Peek session", &["peek"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|_| "invalidPath")?;
        let total_bytes = path.metadata().map_err(|e| e.to_string())?.len();
        let mut last = Instant::now() - Duration::from_secs(1);
        let session = storage::open(&path, &cancelled, |bytes_read| {
            if last.elapsed() >= Duration::from_millis(50) {
                let _ = progress.send(ImportProgress {
                    bytes_read,
                    total_bytes,
                });
                last = Instant::now();
            }
        })?;
        let mut library = library.lock().map_err(|_| "internalError")?;
        if cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let filename = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into();
        library.insert(filename, session).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn cancel_import(state: State<'_, AppState>) {
    if let Ok(active) = state.import.lock()
        && let Some(active) = &*active
    {
        active.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummary>> {
    let mut sessions = state
        .library
        .lock()
        .map_err(|_| "internalError")?
        .summaries();
    sessions.extend(state.remote.summaries()?);
    Ok(sessions)
}

#[tauri::command]
pub fn close_session(state: State<'_, AppState>, session_id: String) -> Result<()> {
    if session_id.starts_with("live-") {
        return state.remote.close(&session_id);
    }
    state
        .library
        .lock()
        .map_err(|_| "internalError")?
        .sessions
        .remove(&session_id);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn query_entries(
    state: State<'_, AppState>,
    session_id: String,
    search: String,
    filter: String,
    offset: usize,
    limit: usize,
    revision: u32,
    range: Option<crate::query::TimeRange>,
) -> Result<QueryPage> {
    let range = range.unwrap_or_default().parse()?;
    if session_id.starts_with("live-") {
        let remote = state.remote.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            remote.query_range(
                &session_id,
                &search,
                &filter,
                offset,
                limit,
                revision,
                &range,
            )
        })
        .await
        .map_err(|_| "internalError")?;
    }
    let session = state
        .library
        .lock()
        .map_err(|_| "internalError")?
        .get(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(session.query_range(&search, &filter, offset, limit, revision, &range))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_entry_metadata(
    state: State<'_, AppState>,
    session_id: String,
    entry_id: String,
) -> Result<String> {
    let raw = if session_id.starts_with("live-") {
        state.remote.entry(&session_id, &entry_id)?
    } else {
        state
            .library
            .lock()
            .map_err(|_| "internalError")?
            .get(&session_id)?
            .entry(&entry_id)
            .ok_or("entryNotFound")?
            .raw
            .clone()
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        for side in ["request", "response"] {
            if let Some(object) = value[side].as_object_mut() {
                object.remove("body");
            }
        }
        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_body(
    state: State<'_, AppState>,
    session_id: String,
    entry_id: String,
    side: String,
) -> Result<BodyView> {
    if !matches!(side.as_str(), "request" | "response") {
        return Err("invalidSide".into());
    }
    if session_id.starts_with("live-") {
        return state.remote.body(session_id, entry_id, side).await;
    }
    let session = state
        .library
        .lock()
        .map_err(|_| "internalError")?
        .get(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entry = session.entry(&entry_id).ok_or("entryNotFound")?;
        let value: Value = serde_json::from_str(&entry.raw).map_err(|e| e.to_string())?;
        body::view(&value[&side]["body"])
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_peek(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool> {
    let session = if session_id.starts_with("live-") {
        state.remote.export(&session_id)?
    } else {
        state
            .library
            .lock()
            .map_err(|_| "internalError")?
            .get(&session_id)?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("Peek session", &["peek"])
            .set_file_name("session.peek")
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let mut path = path.into_path().map_err(|_| "invalidPath")?;
        if path.extension().is_none() {
            path.set_extension("peek");
        }
        storage::save(&path, &session)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

struct Subscription {
    cancel: tokio_util::sync::CancellationToken,
    ack: tokio::sync::mpsc::Sender<()>,
    awaiting: Arc<std::sync::atomic::AtomicU64>,
}
#[derive(Clone, Serialize)]
pub struct RemoteUpdate {
    revision: u64,
}

#[tauri::command]
pub async fn remote_snapshot(
    state: State<'_, AppState>,
) -> Result<crate::remote::server::RemoteSnapshot> {
    let remote = state.remote.clone();
    tauri::async_runtime::spawn_blocking(move || remote.snapshot())
        .await
        .map_err(|_| "internalError")?
}
#[tauri::command]
pub async fn start_listener(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    advertise: bool,
) -> Result<crate::remote::server::RemoteSnapshot> {
    state.remote.start(host, port, advertise).await
}
#[tauri::command]
pub async fn stop_listener(state: State<'_, AppState>) -> Result<()> {
    state.remote.stop().await
}
#[tauri::command]
pub async fn issue_pairing_code(
    state: State<'_, AppState>,
    diagnostics: bool,
) -> Result<crate::remote::server::RemoteSnapshot> {
    state.remote.issue_code(diagnostics).await
}
#[tauri::command]
pub async fn revoke_device(
    state: State<'_, AppState>,
    device_id: String,
    diagnostics: Option<bool>,
) -> Result<()> {
    state.remote.revoke(device_id, diagnostics).await
}

#[tauri::command]
pub fn subscribe_remote(
    state: State<'_, AppState>,
    subscription_id: String,
    updates: Channel<RemoteUpdate>,
) -> Result<()> {
    if uuid::Uuid::parse_str(&subscription_id).is_err() {
        return Err("invalidSubscription".into());
    }
    let cancel = tokio_util::sync::CancellationToken::new();
    let (ack, mut acked) = tokio::sync::mpsc::channel(1);
    let awaiting = Arc::new(std::sync::atomic::AtomicU64::new(u64::MAX));
    {
        let mut subscriptions = state.subscriptions.lock().map_err(|_| "internalError")?;
        for (_, old) in subscriptions.drain() {
            old.cancel.cancel();
        }
        subscriptions.insert(
            subscription_id,
            Subscription {
                cancel: cancel.clone(),
                ack,
                awaiting: awaiting.clone(),
            },
        );
    }
    let mut changes = state.remote.changes.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            let revision = *changes.borrow_and_update();
            awaiting.store(revision, Ordering::Release);
            if updates.send(RemoteUpdate { revision }).is_err() {
                break;
            }
            tokio::select! {_=cancel.cancelled()=>break,value=acked.recv()=>if value.is_none(){break;}}
            tokio::select! {_=cancel.cancelled()=>break,result=changes.changed()=>if result.is_err(){break;}}
            tokio::select! {_=cancel.cancelled()=>break,_=tokio::time::sleep(Duration::from_millis(50))=>{}}
        }
    });
    Ok(())
}
#[tauri::command]
pub fn acknowledge_remote(
    state: State<'_, AppState>,
    subscription_id: String,
    revision: u64,
) -> Result<()> {
    if let Some(subscription) = state
        .subscriptions
        .lock()
        .map_err(|_| "internalError")?
        .get(&subscription_id)
        && subscription
            .awaiting
            .compare_exchange(revision, u64::MAX, Ordering::AcqRel, Ordering::Relaxed)
            .is_ok()
    {
        let _ = subscription.ack.try_send(());
    }
    Ok(())
}
#[tauri::command]
pub fn unsubscribe_remote(state: State<'_, AppState>, subscription_id: String) -> Result<()> {
    if let Some(subscription) = state
        .subscriptions
        .lock()
        .map_err(|_| "internalError")?
        .remove(&subscription_id)
    {
        subscription.cancel.cancel();
    }
    Ok(())
}
#[tauri::command]
pub async fn get_entry_info(
    state: State<'_, AppState>,
    session_id: String,
    entry_id: String,
) -> Result<crate::protocol::session::EntryRow> {
    if session_id.starts_with("live-") {
        return state.remote.entry_info(&session_id, &entry_id);
    }
    Ok(state
        .library
        .lock()
        .map_err(|_| "internalError")?
        .get(&session_id)?
        .entry(&entry_id)
        .ok_or("entryNotFound")?
        .row
        .clone())
}
#[tauri::command]
// IPC keeps each query option explicit, matching the network query command.
#[allow(clippy::too_many_arguments)]
pub async fn query_diagnostics(
    state: State<'_, AppState>,
    run_id: String,
    search: String,
    level: String,
    exceptions: bool,
    offset: usize,
    limit: usize,
    revision: u32,
) -> Result<crate::remote::diagnostics::DiagnosticPage> {
    let remote = state.remote.clone();
    tauri::async_runtime::spawn_blocking(move || {
        remote.diagnostic_query(
            &run_id, &search, &level, exceptions, offset, limit, revision,
        )
    })
    .await
    .map_err(|_| "internalError")?
}
#[tauri::command]
pub fn get_diagnostic(
    state: State<'_, AppState>,
    run_id: String,
    event_id: String,
) -> Result<String> {
    Ok(state
        .remote
        .diagnostic_detail(&run_id, &event_id)?
        .to_string())
}
#[tauri::command]
pub fn close_diagnostic(state: State<'_, AppState>, run_id: String) -> Result<()> {
    state.remote.close_diagnostic(&run_id)
}

#[tauri::command]
pub async fn review_diagnostics(
    state: State<'_, AppState>,
    run_id: String,
    query: crate::query::ReviewQuery,
) -> Result<crate::query::ReviewPage> {
    let remote = state.remote.clone();
    tauri::async_runtime::spawn_blocking(move || remote.review_diagnostics(&run_id, &query))
        .await
        .map_err(|_| "internalError")?
}
#[tauri::command]
pub async fn query_timeline(
    state: State<'_, AppState>,
    scope: crate::query::Scope,
    query: crate::query::ReviewQuery,
) -> Result<crate::query::TimelinePage> {
    let remote = state.remote.clone();
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let network = match &scope {
            crate::query::Scope::Network { id } if id.starts_with("live-") => {
                remote.network_rows(id)?
            }
            crate::query::Scope::Network { id } => library
                .lock()
                .map_err(|_| "internalError")?
                .get(id)?
                .entries
                .iter()
                .map(|e| e.row.clone())
                .collect(),
            _ => vec![],
        };
        remote.timeline(&scope, network, &query)
    })
    .await
    .map_err(|_| "internalError")?
}

#[tauri::command]
pub async fn copy_diagnostics(
    state: State<'_, AppState>,
    selection: Vec<crate::query::DiagnosticRef>,
    kind: String,
) -> Result<String> {
    let records = state.remote.selected_diagnostics(&selection)?;
    tauri::async_runtime::spawn_blocking(move || crate::query::copy_diagnostics(&records, &kind))
        .await
        .map_err(|_| "internalError")?
}
#[tauri::command]
pub async fn export_diagnostics(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    selection: Vec<crate::query::DiagnosticRef>,
) -> Result<bool> {
    let records = state.remote.selected_diagnostics(&selection)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("Diagnostic events", &["jsonl"])
            .set_file_name("diagnostics.jsonl")
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let mut path = path.into_path().map_err(|_| "invalidPath")?;
        if path.extension().is_none() {
            path.set_extension("jsonl");
        }
        storage::save_diagnostics(&path, &records)?;
        Ok(true)
    })
    .await
    .map_err(|_| "internalError")?
}

#[tauri::command]
pub fn write_clipboard(app: tauri::AppHandle, text: String) -> Result<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    if text.len() > 1024 * 1024 {
        return Err("selectionTooLarge".into());
    }
    app.clipboard()
        .write_text(text)
        .map_err(|_| "clipboardUnavailable".into())
}
