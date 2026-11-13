use crate::{
    body::{self, BodyView},
    protocol::session::Result,
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

#[derive(Default)]
pub struct AppState {
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
pub fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummary>> {
    Ok(state
        .library
        .lock()
        .map_err(|_| "internalError")?
        .summaries())
}

#[tauri::command]
pub fn close_session(state: State<'_, AppState>, session_id: String) -> Result<()> {
    state
        .library
        .lock()
        .map_err(|_| "internalError")?
        .sessions
        .remove(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn query_entries(
    state: State<'_, AppState>,
    session_id: String,
    search: String,
    filter: String,
    offset: usize,
    limit: usize,
    revision: u32,
) -> Result<QueryPage> {
    let session = state
        .library
        .lock()
        .map_err(|_| "internalError")?
        .get(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(session.query(&search, &filter, offset, limit, revision))
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
    let session = state
        .library
        .lock()
        .map_err(|_| "internalError")?
        .get(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entry = session.entry(&entry_id).ok_or("entryNotFound")?;
        let mut value: Value = serde_json::from_str(&entry.raw).map_err(|e| e.to_string())?;
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
    let session = state
        .library
        .lock()
        .map_err(|_| "internalError")?
        .get(&session_id)?;
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
