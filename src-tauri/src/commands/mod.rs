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
    recovery: Arc<Mutex<crate::recovery::Recovery>>,
    shutdown: AtomicBool,
    remote: Arc<Remote>,
    subscriptions: Mutex<std::collections::HashMap<String, Subscription>>,
    library: Arc<Mutex<Library>>,
    import: Arc<Mutex<Option<Arc<AtomicBool>>>>,
    stream_cache: Arc<Mutex<crate::stream::StreamCache>>,
    timeline_cache: Arc<Mutex<crate::query::TimelineCache>>,
    plugins: Arc<Mutex<crate::plugins::PluginManager>>,
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

fn begin_import(state: &AppState) -> Result<(Arc<AtomicBool>, ImportGuard)> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut active = state.import.lock().map_err(|_| "internalError")?;
    if active.is_some() {
        return Err("importBusy".into());
    }
    *active = Some(Arc::clone(&cancelled));
    Ok((cancelled, ImportGuard(Arc::clone(&state.import))))
}

fn import_file(
    path: std::path::PathBuf,
    library: Arc<Mutex<Library>>,
    remote: Arc<Remote>,
    cancelled: Arc<AtomicBool>,
    progress: Channel<ImportProgress>,
) -> Result<Option<crate::archive::Imported>> {
    let path = crate::file_open::validate(&path)?;
    let total_bytes = path.metadata().map_err(|e| e.to_string())?.len();
    let mut last = Instant::now() - Duration::from_secs(1);
    let mut report = |bytes_read| {
        if last.elapsed() >= Duration::from_millis(50) {
            let _ = progress.send(ImportProgress {
                bytes_read,
                total_bytes,
            });
            last = Instant::now();
        }
    };
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "peekbundle" | "jsonl") {
        let bundle = if extension == "peekbundle" {
            crate::archive::open(&path, &cancelled, &mut report)?
        } else {
            crate::archive::open_jsonl(&path, &cancelled)?
        };
        let mut library = library.lock().map_err(|_| "internalError")?;
        if cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        return crate::archive::install(&mut library, &remote, bundle, false).map(Some);
    }
    let session = storage::open(&path, &cancelled, report)?;
    let mut library = library.lock().map_err(|_| "internalError")?;
    if cancelled.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    let filename = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into();
    let summary = library.insert(filename, session)?;
    Ok(Some(crate::archive::Imported {
        session_id: Some(summary.id),
        run_id: None,
    }))
}

#[tauri::command]
pub async fn open_peek(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    progress: Channel<ImportProgress>,
) -> Result<Option<crate::archive::Imported>> {
    let (cancelled, guard) = begin_import(&state)?;
    let library = Arc::clone(&state.library);
    let remote = state.remote.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let Some(path) = app
            .dialog()
            .file()
            .add_filter(
                "Peek sessions and diagnostics",
                &["peek", "peekbundle", "jsonl"],
            )
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        import_file(
            path.into_path().map_err(|_| "invalidPath")?,
            library,
            remote,
            cancelled,
            progress,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn has_pending_files(files: State<'_, crate::file_open::OpenFiles>) -> Result<bool> {
    files.pending()
}

#[tauri::command]
pub async fn open_pending_file(
    state: State<'_, AppState>,
    files: State<'_, crate::file_open::OpenFiles>,
    progress: Channel<ImportProgress>,
) -> Result<Option<crate::archive::Imported>> {
    let (cancelled, guard) = begin_import(&state)?;
    let Some(path) = files.next()? else {
        return Ok(None);
    };
    let library = Arc::clone(&state.library);
    let remote = state.remote.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        import_file(path, library, remote, cancelled, progress)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn cancel_import(state: State<'_, AppState>, files: State<'_, crate::file_open::OpenFiles>) {
    files.clear();
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
    let mut library = state.library.lock().map_err(|_| "internalError")?;
    library.sessions.remove(&session_id);
    library.archives.remove(&session_id);
    state
        .remote
        .diagnostics
        .lock()
        .map_err(|_| "internalError")?
        .runs
        .retain(|_, run| run.network_key.as_deref() != Some(&session_id));
    state.remote.changed();
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
    host_filter: Option<String>,
    exclude_patterns: Option<Vec<String>>,
) -> Result<QueryPage> {
    let range = range.unwrap_or_default().parse()?;
    let excludes = exclude_patterns.unwrap_or_default();
    if session_id.starts_with("live-") {
        let remote = state.remote.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            remote.query_range_filtered(
                &session_id,
                &search,
                &filter,
                offset,
                limit,
                revision,
                &range,
                host_filter.as_deref(),
                &excludes,
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
        Ok(session.query_range_filtered(
            &search,
            &filter,
            offset,
            limit,
            revision,
            &range,
            host_filter.as_deref(),
            &excludes,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 切换抓包请求的固定（Pinned）状态，支持实时会话与已打开离线会话。
#[tauri::command]
pub fn toggle_entry_pin(
    state: State<'_, AppState>,
    session_id: String,
    entry_id: String,
) -> Result<bool> {
    if session_id.starts_with("live-") {
        return state.remote.toggle_pin(&session_id, &entry_id);
    }
    let pinned = state
        .library
        .lock()
        .map_err(|_| "internalError")?
        .toggle_pin(&session_id, &entry_id)?;
    state.remote.changed();
    Ok(pinned)
}

/// 通过明确文件路径导入（供窗口拖放文件直开使用）。
#[tauri::command]
pub async fn open_file_path(
    state: State<'_, AppState>,
    path: String,
    progress: Channel<ImportProgress>,
) -> Result<Option<crate::archive::Imported>> {
    let (cancelled, guard) = begin_import(&state)?;
    let library = Arc::clone(&state.library);
    let remote = state.remote.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        import_file(
            std::path::PathBuf::from(path),
            library,
            remote,
            cancelled,
            progress,
        )
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
pub async fn local_addresses() -> Result<Vec<String>> {
    tauri::async_runtime::spawn_blocking(crate::remote::addresses::local_addresses)
        .await
        .map_err(|_| "internalError")?
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
    let timeline_cache = state.timeline_cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let offline = match &scope {
            crate::query::Scope::Network { id } if !id.starts_with("live-") => {
                let session = library.lock().map_err(|_| "internalError")?.get(id)?;
                Some((
                    session.entries.len() as u64,
                    session.entries.iter().map(|e| e.row.clone()).collect(),
                ))
            }
            _ => None,
        };
        let mut cache = timeline_cache.lock().map_err(|_| "internalError")?;
        remote.timeline_cached(&mut cache, &scope, offline, &query)
    })
    .await
    .map_err(|_| "internalError")?
}

/// 解析作用域并从两级流式缓存中构建或命中排好序的日志流快照。
fn build_stream_snapshot(
    remote: &Remote,
    library: &Mutex<Library>,
    stream_cache: &Mutex<crate::stream::StreamCache>,
    scope: &crate::query::Scope,
    query: &crate::stream::StreamQuery,
) -> Result<Arc<crate::stream::StreamSnapshot>> {
    let (net_version, network) = match scope {
        crate::query::Scope::Network { id } if id.starts_with("live-") => {
            remote.network_entries(id)?
        }
        crate::query::Scope::Network { id } => {
            let session = library.lock().map_err(|_| "internalError")?.get(id)?;
            (session.entries.len() as u64, session.entries.clone())
        }
        crate::query::Scope::Diagnostic { .. } => (0, Vec::new()),
    };
    let (diag_version, diagnostics) = remote.diagnostic_raw_items(scope)?;
    let version_stamp = format!("{net_version}|{diag_version}");
    let mut cache = stream_cache.lock().map_err(|_| "internalError")?;
    cache.build_snapshot(scope, version_stamp, &network, &diagnostics, query)
}

#[tauri::command]
pub async fn query_stream(
    state: State<'_, AppState>,
    scope: crate::query::Scope,
    query: crate::stream::StreamQuery,
) -> Result<crate::stream::StreamPage> {
    let remote = state.remote.clone();
    let library = state.library.clone();
    let stream_cache = state.stream_cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = build_stream_snapshot(&remote, &library, &stream_cache, &scope, &query)?;
        Ok(snapshot.slice(query.line_offset, query.line_limit, query.revision))
    })
    .await
    .map_err(|_| "internalError")?
}

/// 在保留上下文的定位模式下，返回日志流中全部匹配关键词的行号。
#[tauri::command]
pub async fn find_stream_matches(
    state: State<'_, AppState>,
    scope: crate::query::Scope,
    query: crate::stream::StreamQuery,
) -> Result<crate::stream::StreamMatches> {
    let remote = state.remote.clone();
    let library = state.library.clone();
    let stream_cache = state.stream_cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = build_stream_snapshot(&remote, &library, &stream_cache, &scope, &query)?;
        Ok(snapshot.find_matches(&query.search))
    })
    .await
    .map_err(|_| "internalError")?
}

/// 按网络请求 ID 定位该条目在日志流中的首行行号（供网络列表跨 Tab 跳转使用）。
#[tauri::command]
pub async fn locate_stream_entry(
    state: State<'_, AppState>,
    scope: crate::query::Scope,
    query: crate::stream::StreamQuery,
    entry_id: String,
    preferred_kind: Option<String>,
) -> Result<Option<usize>> {
    let remote = state.remote.clone();
    let library = state.library.clone();
    let stream_cache = state.stream_cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = build_stream_snapshot(&remote, &library, &stream_cache, &scope, &query)?;
        Ok(snapshot.locate_entry(&entry_id, preferred_kind.as_deref()))
    })
    .await
    .map_err(|_| "internalError")?
}

#[tauri::command]
pub async fn copy_stream_block(
    state: State<'_, AppState>,
    scope: crate::query::Scope,
    query: crate::stream::StreamQuery,
    block_id: String,
) -> Result<String> {
    let remote = state.remote.clone();
    let library = state.library.clone();
    let stream_cache = state.stream_cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = build_stream_snapshot(&remote, &library, &stream_cache, &scope, &query)?;
        let text = snapshot.block_text(&block_id)?;
        if text.len() > 1024 * 1024 {
            return Err("selectionTooLarge".into());
        }
        Ok(text)
    })
    .await
    .map_err(|_| "internalError")?
}

#[tauri::command]
pub async fn export_stream_text(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    scope: crate::query::Scope,
    query: crate::stream::StreamQuery,
) -> Result<bool> {
    let remote = state.remote.clone();
    let library = state.library.clone();
    let stream_cache = state.stream_cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = build_stream_snapshot(&remote, &library, &stream_cache, &scope, &query)?;
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("Console log", &["log", "txt"])
            .set_file_name("console-stream.log")
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let mut path = path.into_path().map_err(|_| "invalidPath")?;
        if path.extension().is_none() {
            path.set_extension("log");
        }
        storage::save_stream(&path, &snapshot)?;
        Ok(true)
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

#[tauri::command]
pub async fn save_bundle(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    scope: crate::query::Scope,
) -> Result<bool> {
    let remote = state.remote.clone();
    let library = state.library.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bundle = crate::archive::capture(
            &*library.lock().map_err(|_| "internalError")?,
            &remote,
            Some(&scope),
        )?;
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("Peek bundle", &["peekbundle"])
            .set_file_name("session.peekbundle")
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let mut path = path.into_path().map_err(|_| "invalidPath")?;
        if path.extension().is_none() {
            path.set_extension("peekbundle");
        }
        crate::archive::save(&path, &bundle)?;
        Ok(true)
    })
    .await
    .map_err(|_| "internalError")?
}

#[tauri::command]
pub async fn export_scope(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    scope: crate::query::Scope,
    kind: String,
) -> Result<bool> {
    let extension = match kind.as_str() {
        "har" => "har",
        "jsonl" => "jsonl",
        "text" => "txt",
        _ => return Err("invalidExport".into()),
    };
    let library = state.library.clone();
    let remote = state.remote.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bundle = crate::archive::capture(
            &*library.lock().map_err(|_| "internalError")?,
            &remote,
            Some(&scope),
        )?;
        if kind == "har" && bundle.networks.is_empty() {
            return Err("sessionNotFound".into());
        }
        if kind != "har" && bundle.runs.is_empty() {
            return Err("diagnosticNotFound".into());
        }
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("Session export", &[extension])
            .set_file_name(format!("session.{extension}"))
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let mut path = path.into_path().map_err(|_| "invalidPath")?;
        if path.extension().is_none() {
            path.set_extension(extension);
        }
        if kind == "har" {
            crate::export::har(&path, &bundle.networks[0].session)?;
        } else {
            crate::export::diagnostics(&path, &bundle, kind == "text")?;
        }
        Ok(true)
    })
    .await
    .map_err(|_| "internalError")?
}
#[tauri::command]
pub async fn copy_curl(
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
    tauri::async_runtime::spawn_blocking(move || crate::export::curl(&raw))
        .await
        .map_err(|_| "internalError")?
}

/// 生成多种客户端代码片段（`curl` / `dio` / `fetch`）。
#[tauri::command]
pub async fn copy_snippet(
    state: State<'_, AppState>,
    session_id: String,
    entry_id: String,
    format: String,
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
    tauri::async_runtime::spawn_blocking(move || match format.as_str() {
        "curl" => crate::export::curl(&raw),
        "dio" => crate::export::dart_dio(&raw),
        "fetch" => crate::export::fetch_js(&raw),
        _ => Err("invalidExport".into()),
    })
    .await
    .map_err(|_| "internalError")?
}

/// 在桌面端直接重放自定义/微调后的 HTTP 请求。
#[tauri::command]
pub async fn replay_request(
    request: crate::replay::ReplayRequest,
) -> Result<crate::replay::ReplayResponse> {
    crate::replay::send(request).await
}

fn persist_workspace(
    recovery: &Mutex<crate::recovery::Recovery>,
    library: &Mutex<Library>,
    remote: &Remote,
    force: bool,
) -> Result<()> {
    let mut store = recovery.lock().map_err(|_| "internalError")?;
    let result = (|| {
        let prepared = {
            let library = library.lock().map_err(|_| "internalError")?;
            store.prepare_workspace(&library, remote, force)?
        };
        store.commit_workspace(prepared)
    })();
    if let Err(error) = &result {
        store.status.error = Some(error.clone());
    }
    result
}
pub fn start_recovery(app: &tauri::App) -> std::result::Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    let directory = app.path().app_data_dir()?.join("recovery");
    let state = app.state::<AppState>();
    let recovery = state.recovery.clone();
    let library = state.library.clone();
    let remote = state.remote.clone();
    tauri::async_runtime::spawn(async move {
        let init = recovery.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let loaded = crate::recovery::Recovery::load(directory);
            if let Ok(mut state) = init.lock() {
                match loaded {
                    Ok(loaded) => *state = loaded,
                    Err(error) => state.status.error = Some(error),
                }
            }
        })
        .await;
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let recovery = recovery.clone();
            let library = library.clone();
            let remote = remote.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                persist_workspace(&recovery, &library, &remote, false)
            })
            .await;
        }
    });
    Ok(())
}
pub fn save_before_exit(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    let state = app.state::<AppState>();
    if state.shutdown.swap(true, Ordering::SeqCst) {
        return false;
    }
    let recovery = state.recovery.clone();
    let library = state.library.clone();
    let remote = state.remote.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            persist_workspace(&recovery, &library, &remote, false)
        })
        .await;
        handle.exit(0);
    });
    true
}
#[tauri::command]
pub async fn recovery_status(
    state: State<'_, AppState>,
) -> Result<crate::recovery::RecoveryStatus> {
    let recovery = state.recovery.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(recovery.lock().map_err(|_| "internalError")?.status.clone())
    })
    .await
    .map_err(|_| "internalError")?
}
#[tauri::command]
pub async fn set_recovery_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<crate::recovery::RecoveryStatus> {
    let recovery = state.recovery.clone();
    tauri::async_runtime::spawn_blocking(move || {
        recovery
            .lock()
            .map_err(|_| "internalError")?
            .set_enabled(enabled)
    })
    .await
    .map_err(|_| "internalError")?
}
#[tauri::command]
pub async fn save_recovery(state: State<'_, AppState>) -> Result<crate::recovery::RecoveryStatus> {
    let recovery = state.recovery.clone();
    let library = state.library.clone();
    let remote = state.remote.clone();
    tauri::async_runtime::spawn_blocking(move || {
        persist_workspace(&recovery, &library, &remote, true)?;
        Ok(recovery.lock().map_err(|_| "internalError")?.status.clone())
    })
    .await
    .map_err(|_| "internalError")?
}
#[tauri::command]
pub async fn restore_recovery(state: State<'_, AppState>) -> Result<crate::archive::Imported> {
    let recovery = state.recovery.clone();
    let library = state.library.clone();
    let remote = state.remote.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut store = recovery.lock().map_err(|_| "internalError")?;
        let result = (|| {
            let pending = store.read_pending()?;
            store.apply_pending(
                &mut *library.lock().map_err(|_| "internalError")?,
                &remote,
                pending,
            )
        })();
        if let Err(error) = &result {
            store.status.error = Some(error.clone());
        }
        result
    })
    .await
    .map_err(|_| "internalError")?
}
#[tauri::command]
pub async fn start_new_recovery(
    state: State<'_, AppState>,
) -> Result<crate::recovery::RecoveryStatus> {
    let recovery = state.recovery.clone();
    tauri::async_runtime::spawn_blocking(move || {
        recovery.lock().map_err(|_| "internalError")?.start_new()
    })
    .await
    .map_err(|_| "internalError")?
}

#[tauri::command]
pub fn app_info() -> crate::app_info::AppInfo {
    crate::app_info::info()
}

#[tauri::command]
pub fn legal_text(document: &str) -> Result<String> {
    crate::app_info::legal_text(document).map(str::to_owned)
}

#[tauri::command]
pub async fn open_project_link(app: tauri::AppHandle, link: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let url = crate::app_info::project_link(&link)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "openLinkFailed".into())
}

#[tauri::command]
pub async fn check_updates(
    checker: State<'_, crate::updates::Checker>,
) -> Result<crate::updates::UpdateInfo> {
    checker.check().await
}
#[tauri::command]
pub async fn open_release_link(app: tauri::AppHandle, url: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    if !crate::updates::valid_release_link(&url) {
        return Err("invalidProjectLink".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "openLinkFailed".into())
}

/// 在应用启动时初始化堆栈还原插件管理器。
pub fn start_plugins(app: &tauri::App) -> std::result::Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    let base_dir = app
        .path()
        .app_config_dir()
        .or_else(|_| app.path().app_data_dir())?;
    let state = app.state::<AppState>();
    if let Ok(mut mgr) = state.plugins.lock() {
        mgr.initialize(base_dir);
    }
    Ok(())
}

/// 导出的插件文本与一键安装链接载体。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedPluginBundle {
    pub json: String,
    pub link: String,
}

#[tauri::command]
pub fn list_plugins(state: State<'_, AppState>) -> Result<crate::plugins::PluginListSnapshot> {
    let mgr = state.plugins.lock().map_err(|_| "internalError")?;
    Ok(mgr.list())
}

#[tauri::command]
pub fn upsert_plugin(
    state: State<'_, AppState>,
    plugin: crate::plugins::SymbolicatorPlugin,
    keep_existing_secret: Option<bool>,
    set_as_default: Option<bool>,
) -> Result<crate::plugins::PluginListSnapshot> {
    let mut mgr = state.plugins.lock().map_err(|_| "internalError")?;
    mgr.upsert(
        plugin,
        keep_existing_secret.unwrap_or(true),
        set_as_default.unwrap_or(false),
    )
}

#[tauri::command]
pub fn remove_plugin(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<crate::plugins::PluginListSnapshot> {
    let mut mgr = state.plugins.lock().map_err(|_| "internalError")?;
    mgr.remove(&plugin_id)
}

#[tauri::command]
pub fn set_plugin_enabled(
    state: State<'_, AppState>,
    plugin_id: String,
    enabled: bool,
) -> Result<crate::plugins::PluginListSnapshot> {
    let mut mgr = state.plugins.lock().map_err(|_| "internalError")?;
    mgr.set_enabled(&plugin_id, enabled)
}

#[tauri::command]
pub fn set_default_plugin(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<crate::plugins::PluginListSnapshot> {
    let mut mgr = state.plugins.lock().map_err(|_| "internalError")?;
    mgr.set_default(&plugin_id)
}

#[tauri::command]
pub fn parse_plugin_input(raw_text: String) -> Result<crate::plugins::ParsedPluginPreview> {
    crate::plugins::parse_plugin_package(&raw_text)
}

#[tauri::command]
pub fn parse_plugin_file_path(path: String) -> Result<crate::plugins::ParsedPluginPreview> {
    crate::plugins::parse_plugin_file(std::path::Path::new(&path))
}

#[tauri::command]
pub async fn fetch_plugin_from_url(
    url: String,
    token: Option<String>,
) -> Result<crate::plugins::ParsedPluginPreview> {
    crate::plugins::fetch_plugin_from_url(&url, token.as_deref()).await
}

#[tauri::command]
pub async fn pick_plugin_file(
    app: tauri::AppHandle,
) -> Result<Option<crate::plugins::ParsedPluginPreview>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Peek Plugin", &["json", "peekplugin"])
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
    })
    .await
    .map_err(|_| "internalError")?;
    let Some(path) = picked else {
        return Ok(None);
    };
    crate::plugins::parse_plugin_file(&path).map(Some)
}

#[tauri::command]
pub async fn pick_symbols_directory(app: tauri::AppHandle) -> Result<Option<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|_| "internalError")?;
    Ok(picked)
}

#[tauri::command]
pub fn export_plugin_config(
    state: State<'_, AppState>,
    plugin_id: String,
    include_secrets: Option<bool>,
) -> Result<ExportedPluginBundle> {
    let plugin = {
        let mgr = state.plugins.lock().map_err(|_| "internalError")?;
        mgr.find_plugin(&plugin_id)
            .ok_or_else(|| "未找到指定插件".to_string())?
    };
    let (json, link) =
        crate::plugins::export_plugin_bundle(&plugin, include_secrets.unwrap_or(false))?;
    Ok(ExportedPluginBundle { json, link })
}

#[tauri::command]
pub async fn save_plugin_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    include_secrets: Option<bool>,
) -> Result<bool> {
    let (filename, content) = {
        let mgr = state.plugins.lock().map_err(|_| "internalError")?;
        let plugin = mgr
            .find_plugin(&plugin_id)
            .ok_or_else(|| "未找到指定插件".to_string())?;
        let (json, _) =
            crate::plugins::export_plugin_bundle(&plugin, include_secrets.unwrap_or(false))?;
        (format!("{}.peekplugin.json", plugin.id), json)
    };
    let target = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(&filename)
            .add_filter("Peek Plugin", &["json", "peekplugin"])
            .blocking_save_file()
            .and_then(|f| f.into_path().ok())
    })
    .await
    .map_err(|_| "internalError")?;
    let Some(path) = target else {
        return Ok(false);
    };
    std::fs::write(&path, content.as_bytes()).map_err(|e| format!("保存插件文件失败: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub async fn test_symbolicator_plugin(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<crate::plugins::PluginTestResult> {
    let plugin = {
        let mgr = state.plugins.lock().map_err(|_| "internalError")?;
        mgr.find_plugin(&plugin_id)
            .ok_or_else(|| "未找到指定插件".to_string())?
    };
    Ok(crate::plugins::test_plugin(&plugin).await)
}

#[tauri::command]
pub async fn symbolicate_stack(
    state: State<'_, AppState>,
    request: crate::plugins::SymbolicateRequest,
) -> Result<crate::plugins::SymbolicateResponse> {
    let (plugin, key, cached) = {
        let mgr = state.plugins.lock().map_err(|_| "internalError")?;
        let plugin = mgr.resolve_plugin(request.plugin_id.as_deref())?;
        let key = crate::plugins::cache_key(&plugin, &request);
        let cached = if request.force_refresh {
            None
        } else {
            mgr.get_cached(&key)
        };
        (plugin, key, cached)
    };

    if let Some(hit) = cached {
        return Ok(hit);
    }

    let response = crate::plugins::execute_symbolicate(&plugin, &request).await;
    if response.ok
        && let Ok(mut mgr) = state.plugins.lock()
    {
        mgr.put_cached(key, response.clone());
    }
    Ok(response)
}

#[tauri::command]
pub fn clear_symbolicate_cache(state: State<'_, AppState>) -> Result<()> {
    let mut mgr = state.plugins.lock().map_err(|_| "internalError")?;
    mgr.clear_cache();
    Ok(())
}
