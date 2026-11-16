use peek_desktop_lib::{
    archive::{self, Bundle, NetworkOrigin, NetworkSnapshot},
    recovery::Recovery,
    remote::server::Remote,
    session::Library,
    storage,
};
use std::{
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};
fn bundle() -> Bundle {
    let session = storage::open(
        Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/upstream/sessions/basic.peek"
        )),
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    Bundle {
        networks: vec![NetworkSnapshot {
            key: "network".into(),
            filename: "test.peek".into(),
            session: Arc::new(session),
            origin: NetworkOrigin::default(),
        }],
        runs: vec![],
    }
}
#[test]
fn detached_snapshot_commits_after_workspace_changes_without_holding_its_lock() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Recovery::load(dir.path().to_owned()).unwrap();
    let remote = Remote::default();
    let library = std::sync::Mutex::new(Library::default());
    let prepared = {
        let mut library = library.lock().unwrap();
        archive::install(&mut library, &remote, bundle(), false).unwrap();
        store.prepare_workspace(&library, &remote, true).unwrap()
    };
    library.try_lock().unwrap().sessions.clear();
    store.commit_workspace(prepared).unwrap();
    drop(store);
    let mut store = Recovery::load(dir.path().to_owned()).unwrap();
    let pending = store.read_pending().unwrap();
    let result = store
        .apply_pending(&mut library.try_lock().unwrap(), &remote, pending)
        .unwrap();
    assert_eq!(
        library
            .lock()
            .unwrap()
            .get(&result.session_id.unwrap())
            .unwrap()
            .entries
            .len(),
        18
    );
}
#[test]
fn recovery_is_explicit_persistent_and_does_not_overwrite_pending_or_empty_workspaces() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Recovery::load(dir.path().to_owned()).unwrap();
    assert!(!store.status.enabled);
    assert!(!store.status.available);
    let remote = Remote::default();
    let mut library = Library::default();
    archive::install(&mut library, &remote, bundle(), false).unwrap();
    store.save_workspace(&library, &remote, false).unwrap();
    assert!(!store.status.available);
    store.set_enabled(true).unwrap();
    store.save_workspace(&library, &remote, false).unwrap();
    assert!(store.status.available);
    drop(store);
    let mut restored = Recovery::load(dir.path().to_owned()).unwrap();
    assert!(restored.status.enabled);
    assert!(restored.status.pending);
    let before = std::fs::read(dir.path().join("workspace-0.peekbundle")).unwrap();
    restored
        .save_workspace(&Library::default(), &remote, false)
        .unwrap();
    assert_eq!(
        std::fs::read(dir.path().join("workspace-0.peekbundle")).unwrap(),
        before
    );
    assert_eq!(
        restored.checkpoint(&bundle()).unwrap_err(),
        "recoveryPending"
    );
    let mut library = Library::default();
    let imported = restored.restore(&mut library, &remote).unwrap();
    let id = imported.session_id.unwrap();
    assert!(library.archives[&id].recovered);
    assert_eq!(library.get(&id).unwrap().entries.len(), 18);
    assert!(!remote.snapshot().unwrap().listener.listening);
    assert!(restored.restore(&mut library, &remote).is_err());
}
#[test]
fn corrupt_newest_slot_falls_back_without_losing_the_previous_valid_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Recovery::load(dir.path().to_owned()).unwrap();
    store.checkpoint(&bundle()).unwrap();
    store.checkpoint(&bundle()).unwrap();
    drop(store);
    std::fs::write(dir.path().join("workspace-1.peekbundle"), "broken").unwrap();
    let mut store = Recovery::load(dir.path().to_owned()).unwrap();
    let mut library = Library::default();
    let remote = Remote::default();
    store.restore(&mut library, &remote).unwrap();
    assert!(store.status.used_backup);
    assert_eq!(library.sessions.len(), 1);
    store.checkpoint(&bundle()).unwrap();
    assert!(
        archive::open(
            &dir.path().join("workspace-0.peekbundle"),
            &AtomicBool::new(false),
            |_| {}
        )
        .is_ok()
    );
    assert!(
        archive::open(
            &dir.path().join("workspace-1.peekbundle"),
            &AtomicBool::new(false),
            |_| {}
        )
        .is_ok()
    );
}
#[test]
fn both_corrupt_slots_leave_current_workspace_intact_and_allow_a_new_record() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("workspace-0.peekbundle"), "broken").unwrap();
    std::fs::write(dir.path().join("workspace-1.peekbundle"), "also broken").unwrap();
    let mut store = Recovery::load(dir.path().to_owned()).unwrap();
    let mut library = Library::default();
    let remote = Remote::default();
    assert_eq!(
        store.restore(&mut library, &remote).err().unwrap(),
        "recoveryCorrupt"
    );
    assert!(library.sessions.is_empty());
    assert!(store.status.pending);
    store.start_new().unwrap();
    store.checkpoint(&bundle()).unwrap();
    assert!(store.status.available);
}
#[test]
fn recovery_cache_has_one_writer_and_cleans_only_its_abandoned_partial_files() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".peek-write-orphan"), "incomplete").unwrap();
    std::fs::write(dir.path().join("keep.peekbundle"), "user file").unwrap();
    let owner = Recovery::load(dir.path().to_owned()).unwrap();
    assert!(!dir.path().join(".peek-write-orphan").exists());
    assert!(dir.path().join("keep.peekbundle").exists());
    assert!(matches!(Recovery::load(dir.path().to_owned()),Err(error) if error=="recoveryInUse"));
    drop(owner);
    assert!(Recovery::load(dir.path().to_owned()).is_ok());
}
#[test]
fn unchanged_workspace_skips_writes_and_failed_new_snapshot_preserves_both_slots() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Recovery::load(dir.path().to_owned()).unwrap();
    store.set_enabled(true).unwrap();
    let mut library = Library::default();
    let remote = Remote::default();
    archive::install(&mut library, &remote, bundle(), false).unwrap();
    store.save_workspace(&library, &remote, false).unwrap();
    store.save_workspace(&library, &remote, false).unwrap();
    assert!(!dir.path().join("workspace-1.peekbundle").exists());
    store.checkpoint(&bundle()).unwrap();
    let a = std::fs::read(dir.path().join("workspace-0.peekbundle")).unwrap();
    let b = std::fs::read(dir.path().join("workspace-1.peekbundle")).unwrap();
    let mut invalid = bundle();
    Arc::make_mut(&mut invalid.networks[0].session)
        .header
        .format_version = 99;
    assert!(store.checkpoint(&invalid).is_err());
    assert_eq!(
        std::fs::read(dir.path().join("workspace-0.peekbundle")).unwrap(),
        a
    );
    assert_eq!(
        std::fs::read(dir.path().join("workspace-1.peekbundle")).unwrap(),
        b
    );
}
