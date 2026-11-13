use peek_desktop_lib::{body, session::read_session, storage};
use serde_json::json;
use std::{fs, io::Cursor, sync::atomic::AtomicBool};

#[test]
fn atomic_save_replaces_existing_file_and_retains_original_records() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("saved.peek");
    fs::write(&path, "old content").unwrap();
    let input = fs::read("tests/fixtures/upstream/sessions/basic.peek").unwrap();
    let session = read_session(Cursor::new(input), &AtomicBool::new(false), |_| {}).unwrap();
    storage::save(&path, &session).unwrap();
    let restored = storage::open(&path, &AtomicBool::new(false), |_| {}).unwrap();
    assert_eq!(restored.entries.len(), session.entries.len());
    for (a, b) in session.entries.iter().zip(restored.entries) {
        assert_eq!(a.raw, b.raw);
    }
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn body_views_distinguish_missing_remote_truncation_and_unknown_kinds() {
    assert_eq!(body::view(&json!(null)).unwrap().kind, "empty");
    assert_eq!(
        body::view(&json!({"kind":"remote","size":42}))
            .unwrap()
            .reason
            .as_deref(),
        Some("remote")
    );
    let unknown =
        body::view(&json!({"kind":"future","type":"application/test","size":90})).unwrap();
    assert_eq!(unknown.kind, "unavailable");
    assert_eq!(unknown.reason.as_deref(), Some("notCaptured"));
    assert_eq!(unknown.size, Some(90));
    assert_eq!(
        body::view(&json!({"kind":"unavailable","reason":"future"}))
            .unwrap()
            .reason
            .as_deref(),
        Some("notCaptured")
    );
    let truncated = body::view(&json!({"kind":"text","text":"中文","size":100})).unwrap();
    assert!(truncated.truncated);
    assert_eq!(truncated.captured_bytes, 6);
    let large = "中".repeat(400_000);
    let preview = body::view(&json!({"kind":"text","text":large})).unwrap();
    assert!(preview.preview_truncated);
    assert!(preview.text.len() <= 1024 * 1024);
    assert!(preview.text.ends_with('中'));
    let bytes = body::view(&json!({"kind":"bytes","bytes":"AQID"})).unwrap();
    assert_eq!(bytes.captured_bytes, 3);
    assert!(bytes.text.contains("01 02 03"));
}
