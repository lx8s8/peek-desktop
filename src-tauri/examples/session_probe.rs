//! P0 repeatable core probe, not a WebView or release performance benchmark.
use peek_desktop_lib::storage;
use std::{path::Path, sync::atomic::AtomicBool, time::Instant};

fn main() {
    let path = std::env::args().nth(1).expect("provide a .peek file path");
    let start = Instant::now();
    let session =
        storage::open(Path::new(&path), &AtomicBool::new(false), |_| {}).expect("valid session");
    let import_ms = start.elapsed().as_secs_f64() * 1000.0;
    let mut durations = Vec::new();
    for revision in 0..20 {
        let start = Instant::now();
        let page = session.query("records/99", "all", 0, 300, revision);
        assert!(page.rows.len() <= 300);
        durations.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    durations.sort_by(f64::total_cmp);
    println!(
        "records={} raw_bytes={} skipped={} import_ms={:.2} search_p50_ms={:.2} search_p95_ms={:.2}",
        session.entries.len(),
        session.raw_bytes,
        session.skipped,
        import_ms,
        durations[9],
        durations[18]
    );
}
