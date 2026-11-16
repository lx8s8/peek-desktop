//! Repeatable P3 core disk probe. Input is synthetic; no UI/throughput claim.
use peek_desktop_lib::{
    archive, export, recovery::Recovery, remote::server::Remote, session::Library, storage,
};
use std::{path::PathBuf, sync::atomic::AtomicBool, time::Instant};
fn main() {
    let path = PathBuf::from(std::env::args().nth(1).expect("synthetic .peek path"));
    let start = Instant::now();
    let session = storage::open(&path, &AtomicBool::new(false), |_| {}).unwrap();
    let count = session.entries.len();
    let expected = session.query("records/99", "all", 0, 300, 1).total;
    let raw_bytes = session.raw_bytes;
    let import_ms = start.elapsed().as_secs_f64() * 1000.0;
    let mut library = Library::default();
    library.insert("synthetic.peek".into(), session).unwrap();
    let remote = Remote::default();
    let bundle = archive::capture(&library, &remote, None).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("network.peekbundle");
    let start = Instant::now();
    archive::save(&destination, &bundle).unwrap();
    let save_ms = start.elapsed().as_secs_f64() * 1000.0;
    let bytes = destination.metadata().unwrap().len();
    let start = Instant::now();
    let loaded = archive::open(&destination, &AtomicBool::new(false), |_| {}).unwrap();
    let read_ms = start.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(loaded.networks[0].session.entries.len(), count);
    let start = Instant::now();
    let har = dir.path().join("network.har");
    export::har(&har, &loaded.networks[0].session).unwrap();
    let har_ms = start.elapsed().as_secs_f64() * 1000.0;
    let mut recovery = Recovery::load(dir.path().join("recovery")).unwrap();
    recovery.checkpoint(&loaded).unwrap();
    drop(recovery);
    let mut recovery = Recovery::load(dir.path().join("recovery")).unwrap();
    let mut restored = Library::default();
    let start = Instant::now();
    let imported = recovery.restore(&mut restored, &remote).unwrap();
    let recovery_ms = start.elapsed().as_secs_f64() * 1000.0;
    let session = restored.get(&imported.session_id.unwrap()).unwrap();
    assert_eq!(session.entries.len(), count);
    assert_eq!(
        session.query("records/99", "all", 0, 300, 1).total,
        expected
    );
    println!(
        "records={count} raw_bytes={raw_bytes} bundle_bytes={bytes} har_bytes={} import_ms={import_ms:.2} archive_save_ms={save_ms:.2} archive_open_ms={read_ms:.2} har_ms={har_ms:.2} recovery_ms={recovery_ms:.2}",
        har.metadata().unwrap().len()
    );
}
