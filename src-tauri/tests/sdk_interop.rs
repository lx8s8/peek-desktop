// Opt-in cross-language check. Requires `flutter` and the package's dependencies.
#[allow(dead_code)]
mod support;
use std::{
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use support::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires Flutter; run with --ignored --nocapture"]
async fn official_flutter_client_and_private_sdk_interoperate_with_rust() {
    let remote = server().await;
    let snapshot = remote.issue_code(true).await.unwrap();
    let port = snapshot.listener.port;
    let code = snapshot.pairing.unwrap().code.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let done = dir.path().join("validated");
    let log = dir.path().join("flutter.log");
    let file = std::fs::File::create(&log).unwrap();
    let mut child = Command::new("flutter")
        .args(["test", "test/interop_test.dart", "--reporter", "expanded"])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/peek_desktop_bridge"))
        .env("PEEK_INTEROP_PORT", port.to_string())
        .env("PEEK_INTEROP_CODE", code)
        .env("PEEK_INTEROP_DONE", &done)
        .stdout(Stdio::from(file.try_clone().unwrap()))
        .stderr(Stdio::from(file))
        .spawn()
        .expect("Flutter must be available");
    let check = tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            if child.try_wait().unwrap().is_some() {
                return Err("Flutter exited before validation".to_string());
            }
            let snapshot = remote.snapshot().unwrap();
            if let Some(session) = snapshot.sessions.first()
                && session.live.as_ref().unwrap().generation >= 2
                && !session.live.as_ref().unwrap().syncing
                && snapshot
                    .diagnostic_runs
                    .first()
                    .is_some_and(|run| run.count == 4)
            {
                let id = session.id.clone();
                let row = remote.query(&id, "", "all", 0, 300, 1).unwrap();
                assert_eq!(row.total, 1);
                assert_eq!(row.rows[0].status, Some(200));
                let body = remote
                    .body(id.clone(), "interop-request".into(), "response".into())
                    .await
                    .unwrap();
                assert!(body.text.contains("900719925474099312345"));
                assert!(body.text.contains("0.12345678901234567890"));
                assert!(body.text.len() > 6000);
                let run = &snapshot.diagnostic_runs[0];
                assert_eq!(run.network_session_key.as_deref(), Some(id.as_str()));
                let events = remote
                    .diagnostic_query(&run.id, "", "all", true, 0, 300, 1)
                    .unwrap();
                assert_eq!(events.total, 1);
                let raw = remote
                    .diagnostic_detail(&run.id, &events.rows[0].event_id)
                    .unwrap();
                assert!(raw.contains("originalSyntheticFrame"));
                assert!(!raw.contains("synthetic-secret"));
                assert!(raw.contains("[REDACTED]"));
                // Export after on-demand body loading retains the original JSON text.
                let output = dir.path().join("interop.peek");
                peek_desktop_lib::storage::save(&output, &remote.export(&id).unwrap()).unwrap();
                assert!(
                    std::fs::read_to_string(output)
                        .unwrap()
                        .contains("900719925474099312345")
                );
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    if !matches!(check, Ok(Ok(()))) {
        let _ = child.kill();
        let _ = child.wait();
        remote.stop().await.unwrap();
        panic!(
            "Interop failed: {check:?}\n{}",
            std::fs::read_to_string(log).unwrap()
        );
    }
    std::fs::write(done, "validated").unwrap();
    let end = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > end {
            let _ = child.kill();
            panic!("Flutter did not stop");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    remote.stop().await.unwrap();
    assert!(
        status.success(),
        "{}",
        std::fs::read_to_string(log).unwrap()
    );
    println!(
        "Official PeekRemote 2.1.1: paired, reconnected, fetched >6 KiB precision body and exported; SDK: 4 logs, original stack, redaction and ACK verified."
    );
}
