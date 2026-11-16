// Opt-in cross-language check. Requires `flutter` and the package's dependencies.
#[allow(dead_code)]
mod support;
use peek_desktop_lib::query::{ReviewQuery, Scope};
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
    let pairing = snapshot.pairing.unwrap();
    let code = pairing.code.unwrap();
    let server_id = pairing.server_id;
    let dir = tempfile::tempdir().unwrap();
    let done = dir.path().join("validated");
    let log = dir.path().join("flutter.log");
    let file = std::fs::File::create(&log).unwrap();
    let mut child = Command::new("flutter")
        .args(["test", "test/interop_test.dart", "--reporter", "expanded"])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/peek_desktop_bridge"))
        .env("PEEK_INTEROP_PORT", port.to_string())
        .env("PEEK_INTEROP_CODE", code)
        .env("PEEK_INTEROP_SERVER_ID", server_id)
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
                // P2 queries must expose the same official-client/SDK records after reconnect.
                let review = serde_json::to_value(
                    remote
                        .review_diagnostics(
                            &run.id,
                            &ReviewQuery {
                                exceptions: true,
                                grouped: true,
                                tag: "interop-review".into(),
                                limit: 300,
                                ..Default::default()
                            },
                        )
                        .unwrap(),
                )
                .unwrap();
                assert_eq!(review["total"], 1);
                assert_eq!(review["groups"][0]["count"], 1);
                let scope = Scope::Network { id: id.clone() };
                let timeline = serde_json::to_value(
                    remote
                        .timeline(
                            &scope,
                            remote.network_rows(&id).unwrap(),
                            &ReviewQuery {
                                limit: 300,
                                ..Default::default()
                            },
                        )
                        .unwrap(),
                )
                .unwrap();
                assert_eq!(timeline["total"], 5);
                let exception = timeline["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row["kind"] == "exception")
                    .unwrap();
                assert_eq!(exception["association"], "explicit");
                assert_eq!(exception["relatedNetworkEntryId"], "interop-request");
                assert_eq!(exception["runId"], run.id);
                let exported = dir.path().join("interop-diagnostics.jsonl");
                peek_desktop_lib::storage::save_diagnostics(&exported, std::slice::from_ref(&raw))
                    .unwrap();
                assert_eq!(
                    std::fs::read_to_string(exported).unwrap(),
                    format!("{raw}\n")
                );
                // Export after on-demand body loading retains the original JSON text.
                let output = dir.path().join("interop.peek");
                peek_desktop_lib::storage::save(&output, &remote.export(&id).unwrap()).unwrap();
                assert!(
                    std::fs::read_to_string(output)
                        .unwrap()
                        .contains("900719925474099312345")
                );
                // P3: real SDK data and fetched bodies survive archive and disk recovery.
                let bundle = peek_desktop_lib::archive::capture(
                    &peek_desktop_lib::session::Library::default(),
                    &remote,
                    Some(&scope),
                )
                .unwrap();
                let bundle_path = dir.path().join("interop.peekbundle");
                peek_desktop_lib::archive::save(&bundle_path, &bundle).unwrap();
                let loaded = peek_desktop_lib::archive::open(
                    &bundle_path,
                    &std::sync::atomic::AtomicBool::new(false),
                    |_| {},
                )
                .unwrap();
                let recovery_dir = dir.path().join("recovery");
                let mut cache =
                    peek_desktop_lib::recovery::Recovery::load(recovery_dir.clone()).unwrap();
                cache.checkpoint(&loaded).unwrap();
                drop(cache);
                let offline = peek_desktop_lib::remote::server::Remote::default();
                let mut library = peek_desktop_lib::session::Library::default();
                let mut cache = peek_desktop_lib::recovery::Recovery::load(recovery_dir).unwrap();
                let imported = cache.restore(&mut library, &offline).unwrap();
                let archived_id = imported.session_id.unwrap();
                let restored = library.get(&archived_id).unwrap();
                let restored_raw = &restored.entry("interop-request").unwrap().raw;
                assert!(restored_raw.contains("900719925474099312345"));
                assert!(restored_raw.contains("0.12345678901234567890"));
                let restored_run = imported.run_id.unwrap();
                assert_eq!(
                    &*offline
                        .diagnostic_detail(&restored_run, &events.rows[0].event_id)
                        .unwrap(),
                    &*raw
                );
                let restored_timeline = serde_json::to_value(
                    offline
                        .timeline(
                            &Scope::Network {
                                id: archived_id.clone(),
                            },
                            restored.entries.iter().map(|e| e.row.clone()).collect(),
                            &ReviewQuery {
                                limit: 300,
                                ..Default::default()
                            },
                        )
                        .unwrap(),
                )
                .unwrap();
                assert_eq!(restored_timeline["total"], 5);
                assert!(!offline.snapshot().unwrap().listener.listening);
                assert!(
                    offline
                        .snapshot()
                        .unwrap()
                        .diagnostic_runs
                        .iter()
                        .all(|run| !run.online)
                );
                let har_path = dir.path().join("interop.har");
                peek_desktop_lib::export::har(&har_path, &restored).unwrap();
                let har: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(har_path).unwrap()).unwrap();
                assert!(
                    har["log"]["entries"][0]["response"]["content"]["text"]
                        .as_str()
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
        "Connect: parsed QR invitation and recalled history by server identity; official PeekRemote 2.1.1: paired, reconnected, fetched >6 KiB precision body and exported; SDK: 4 logs, original stack, redaction and ACK; P2: filtered group, 5-row timeline, explicit reference and original JSONL verified; P3: archive, two-slot recovery, offline timeline, original diagnostics and precision HAR body verified."
    );
}
