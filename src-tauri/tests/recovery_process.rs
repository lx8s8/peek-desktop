//! Cold-process validation: the reader cannot reuse the writer's Rust memory.
use peek_desktop_lib::{
    archive, export, recovery::Recovery, remote::server::Remote, session::Library, storage,
};
use std::{path::PathBuf, sync::atomic::AtomicBool};

fn directory() -> PathBuf {
    PathBuf::from(std::env::var_os("PEEK_RECOVERY_PROCESS_DIR").expect("parent test directory"))
}

#[test]
#[ignore = "invoked by cold_process_snapshot_and_exports"]
fn write_process() {
    let dir = directory();
    let session = storage::open(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/upstream/sessions/basic.peek"),
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    let mut expected = Vec::new();
    session.write(&mut expected).unwrap();
    std::fs::write(dir.join("expected.peek"), expected).unwrap();
    let mut library = Library::default();
    library.insert("cold-process.peek".into(), session).unwrap();
    let remote = Remote::default();
    let raw = r##"{"eventId":"cold-1","runId":"cold-run","emitterId":"main","sequence":"1","occurredAt":"2026-11-16T00:00:00Z","kind":"exception","level":"error","source":"synthetic-process","message":"冷启动😀","exception":{"stackTrace":"#0 original\n#1 caller"},"exact":900719925474099312345,"same":1,"same":2}"##;
    std::fs::write(dir.join("expected.jsonl"), format!("{raw}\n")).unwrap();
    let logs = archive::open_jsonl(&dir.join("expected.jsonl"), &AtomicBool::new(false)).unwrap();
    archive::install(&mut library, &remote, logs, false).unwrap();
    let mut store = Recovery::load(dir.join("cache")).unwrap();
    store.set_enabled(true).unwrap();
    store.save_workspace(&library, &remote, true).unwrap();
    assert!(store.status.available);
}

#[test]
#[ignore = "invoked by cold_process_snapshot_and_exports"]
fn read_process() {
    let dir = directory();
    let mut store = Recovery::load(dir.join("cache")).unwrap();
    assert!(store.status.enabled && store.status.pending);
    let remote = Remote::default();
    let mut library = Library::default();
    let result = store.restore(&mut library, &remote).unwrap();
    let session = library.get(&result.session_id.unwrap()).unwrap();
    let mut actual = Vec::new();
    session.write(&mut actual).unwrap();
    assert_eq!(actual, std::fs::read(dir.join("expected.peek")).unwrap());
    let snapshot = remote.snapshot().unwrap();
    assert!(!snapshot.listener.listening);
    assert_eq!(snapshot.diagnostic_runs.len(), 1);
    assert!(!snapshot.diagnostic_runs[0].online);
    let bundle = archive::capture(&library, &remote, None).unwrap();
    export::diagnostics(&dir.join("recovered.jsonl"), &bundle, false).unwrap();
    assert_eq!(
        std::fs::read(dir.join("recovered.jsonl")).unwrap(),
        std::fs::read(dir.join("expected.jsonl")).unwrap()
    );
    export::har(&dir.join("recovered.har"), &session).unwrap();
    let har: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("recovered.har")).unwrap()).unwrap();
    assert_eq!(har["log"]["entries"].as_array().unwrap().len(), 18);
    export::curl(&session.entries[0].raw).unwrap();
}

#[test]
fn cold_process_snapshot_and_exports() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["write_process", "read_process"] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", name, "--nocapture"])
            .env("PEEK_RECOVERY_PROCESS_DIR", dir.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{name} failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
