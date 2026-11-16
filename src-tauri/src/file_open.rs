//! OS file-open intents are queued until the WebView can import them.
use crate::protocol::session::Result;
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_PENDING: usize = 32;
#[derive(Default)]
struct Queue {
    paths: VecDeque<PathBuf>,
    overflow: bool,
}
#[derive(Default)]
pub struct OpenFiles(Mutex<Queue>);
impl OpenFiles {
    pub fn enqueue(&self, paths: impl IntoIterator<Item = PathBuf>) {
        if let Ok(mut queue) = self.0.lock() {
            for path in paths {
                if queue.paths.contains(&path) {
                    continue;
                }
                if queue.paths.len() == MAX_PENDING {
                    queue.overflow = true;
                } else {
                    queue.paths.push_back(path);
                }
            }
        }
    }
    pub fn arguments(&self, args: &[String], cwd: &Path) {
        let mut positional = false;
        let paths = args.iter().skip(1).filter_map(|argument| {
            if argument == "--" {
                positional = true;
                return None;
            }
            if !positional && argument.starts_with('-') {
                return None;
            }
            if argument.starts_with("file://") {
                return url::Url::parse(argument).ok()?.to_file_path().ok();
            }
            if argument.contains("://") {
                return None;
            }
            let path = PathBuf::from(argument);
            Some(if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            })
        });
        self.enqueue(paths);
    }
    pub fn pending(&self) -> Result<bool> {
        let queue = self.0.lock().map_err(|_| "internalError")?;
        Ok(!queue.paths.is_empty() || queue.overflow)
    }
    pub fn next(&self) -> Result<Option<PathBuf>> {
        let mut queue = self.0.lock().map_err(|_| "internalError")?;
        if let Some(path) = queue.paths.pop_front() {
            return Ok(Some(path));
        }
        if std::mem::take(&mut queue.overflow) {
            return Err("openQueueFull".into());
        }
        Ok(None)
    }
    pub fn clear(&self) {
        if let Ok(mut queue) = self.0.lock() {
            *queue = Queue::default();
        }
    }
}

pub fn validate(path: &Path) -> Result<PathBuf> {
    let extension = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "peek" | "peekbundle" | "jsonl") {
        return Err("unsupportedFile".into());
    }
    let path = path.canonicalize().map_err(|_| "invalidPath")?;
    if !path.is_file() {
        return Err("invalidPath".into());
    }
    Ok(path)
}

pub fn notify(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let _ = app.emit_to("main", "peek-open-files", ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cold_and_warm_arguments_preserve_spaces_unicode_and_order() {
        let directory = tempfile::tempdir().unwrap();
        let paths = ["测试 会话.peek", "saved.peekbundle"];
        let queue = OpenFiles::default();
        let first = directory.path().join(paths[0]);
        queue.arguments(
            &["peek-desktop".into(), "-psn_0_123".into(), paths[0].into()],
            directory.path(),
        );
        queue.enqueue([first.clone()]);
        queue.arguments(
            &[
                "peek-desktop".into(),
                url::Url::from_file_path(directory.path().join(paths[1]))
                    .unwrap()
                    .to_string(),
            ],
            directory.path(),
        );
        assert_eq!(queue.next().unwrap(), Some(first));
        assert_eq!(queue.next().unwrap(), Some(directory.path().join(paths[1])));
        assert!(queue.next().unwrap().is_none());
    }
    #[test]
    fn queue_is_bounded_reports_overflow_and_cancel_discards_remaining() {
        let queue = OpenFiles::default();
        queue.enqueue((0..100).map(|i| PathBuf::from(format!("{i}.peek"))));
        for i in 0..MAX_PENDING {
            assert_eq!(
                queue.next().unwrap(),
                Some(PathBuf::from(format!("{i}.peek")))
            );
        }
        assert_eq!(queue.next().unwrap_err(), "openQueueFull");
        assert!(queue.next().unwrap().is_none());
        queue.enqueue([PathBuf::from("next.peek")]);
        queue.clear();
        assert!(queue.next().unwrap().is_none());
    }
    #[test]
    fn file_intents_reject_directories_missing_files_and_other_extensions() {
        let directory = tempfile::tempdir().unwrap();
        let valid = directory.path().join("UPPER.PEEK");
        std::fs::write(&valid, "test").unwrap();
        assert_eq!(validate(&valid).unwrap(), valid.canonicalize().unwrap());
        assert_eq!(
            validate(&directory.path().join("missing.peek")).unwrap_err(),
            "invalidPath"
        );
        assert_eq!(
            validate(&directory.path().join("secret.txt")).unwrap_err(),
            "unsupportedFile"
        );
        let folder = directory.path().join("directory.peek");
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(validate(&folder).unwrap_err(), "invalidPath");
    }
}
