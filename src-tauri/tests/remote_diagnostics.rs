mod support;
use peek_desktop_lib::remote::server::Remote;
use serde_json::{Value, json};
use std::sync::Arc;
use support::*;

fn event(sequence: u64, kind: &str) -> Value {
    let mut value = json!({"eventId":format!("diag-run/main/{sequence}"),"runId":"diag-run","emitterId":"main","sequence":sequence.to_string(),"occurredAt":"2026-11-13T00:00:00.000Z","kind":kind,"level":if kind=="exception"{"error"}else{"info"},"source":"talker","message":"合成日志","attributes":{"safe":true}});
    if kind == "exception" {
        value["exception"] = json!({"type":"SyntheticError","message":"合成异常","stackTrace":"#0 originalSyntheticFrame\n#1 syntheticMain","stackFormat":"dart"});
    }
    value
}
async fn setup() -> (Arc<Remote>, Client, String, Client) {
    let remote = server().await;
    let (mut network, token) = paired(&remote, "network-run").await;
    send(
        &mut network,
        json!({"type":"entry","op":"add","entry":entry("network")}),
    )
    .await;
    send(&mut network, json!({"type":"synced","count":1})).await;
    let mut diagnostics = connect(&remote, "/diagnostics/v1").await;
    send(&mut diagnostics, hello(&remote, &token)).await;
    receive(&mut diagnostics, "diagnostics.welcome").await;
    (remote, network, token, diagnostics)
}
fn hello(remote: &Remote, token: &str) -> Value {
    json!({"type":"diagnostics.hello","protocol":"peek-desktop-diagnostics","version":1,"serverId":remote.snapshot().unwrap().pairing.unwrap().server_id,"deviceToken":token,"runId":"diag-run","networkSessionId":"network-run"})
}

#[tokio::test]
async fn logs_stacks_dedup_gaps_and_reconnect_acknowledgements_are_consistent() {
    let (remote, _network, token, mut diagnostics) = setup().await;
    send(&mut diagnostics,json!({"type":"diagnostics.batch","emitterId":"main","events":[event(1,"log"),event(2,"exception")]})).await;
    assert_eq!(
        receive(&mut diagnostics, "diagnostics.ack").await["sequence"],
        "2"
    );
    let id = remote.snapshot().unwrap().diagnostic_runs[0].id.clone();
    let page = remote
        .diagnostic_query(&id, "", "all", false, 0, 300, 1)
        .unwrap();
    assert_eq!(page.total, 2);
    assert!(
        remote
            .diagnostic_detail(&id, "diag-run/main/2")
            .unwrap()
            .contains("originalSyntheticFrame")
    );
    send(&mut diagnostics,json!({"type":"diagnostics.batch","emitterId":"main","events":[event(1,"log"),event(2,"exception")]})).await;
    assert_eq!(
        receive(&mut diagnostics, "diagnostics.ack").await["sequence"],
        "2"
    );
    assert_eq!(remote.snapshot().unwrap().diagnostic_runs[0].duplicates, 2);
    send(
        &mut diagnostics,
        json!({"type":"diagnostics.batch","emitterId":"main","events":[event(4,"log")]}),
    )
    .await;
    assert_eq!(
        receive(&mut diagnostics, "diagnostics.error").await["reason"],
        "sequenceGap"
    );
    send(&mut diagnostics,json!({"type":"diagnostics.gap","emitterId":"main","fromSequence":"3","toSequence":"3","reason":"bufferOverflow"})).await;
    assert_eq!(
        receive(&mut diagnostics, "diagnostics.ack").await["sequence"],
        "3"
    );
    send(
        &mut diagnostics,
        json!({"type":"diagnostics.batch","emitterId":"main","events":[event(4,"log")]}),
    )
    .await;
    assert_eq!(
        receive(&mut diagnostics, "diagnostics.ack").await["sequence"],
        "4"
    );
    let mut reconnect = connect(&remote, "/diagnostics/v1").await;
    send(&mut reconnect, hello(&remote, &token)).await;
    assert_eq!(
        receive(&mut reconnect, "diagnostics.welcome").await["accepted"]["main"],
        "4"
    );
    assert_eq!(remote.snapshot().unwrap().diagnostic_runs.len(), 1);
    assert_eq!(remote.snapshot().unwrap().diagnostic_runs[0].gap_count, 1);
    assert_eq!(
        remote.summaries().unwrap()[0]
            .live
            .as_ref()
            .unwrap()
            .diagnostic_count,
        3
    );
    remote.stop().await.unwrap();
}

#[tokio::test]
async fn diagnostic_revocation_does_not_interrupt_standard_network() {
    let (remote, mut network, token, _diagnostics) = setup().await;
    let device = remote.snapshot().unwrap().pairing.unwrap().devices[0]
        .id
        .clone();
    remote.revoke(device, Some(false)).await.unwrap();
    eventually(|| !remote.snapshot().unwrap().diagnostic_runs[0].online).await;
    assert!(remote.summaries().unwrap()[0].live.as_ref().unwrap().online);
    send(&mut network, json!({"type":"ping"})).await;
    receive(&mut network, "pong").await;
    let mut rejected = connect(&remote, "/diagnostics/v1").await;
    send(&mut rejected, hello(&remote, &token)).await;
    assert_eq!(
        receive(&mut rejected, "diagnostics.denied").await["reason"],
        "token"
    );
    remote.stop().await.unwrap();
}

#[tokio::test]
async fn diagnostic_identity_and_session_binding_are_checked_before_acceptance() {
    let (remote, _network, token, _diagnostics) = setup().await;
    for (field, value, reason) in [
        ("serverId", json!("other"), "serverIdentity"),
        ("networkSessionId", json!("wrong-run"), "sessionBinding"),
        ("version", json!(2), "protocolVersion"),
    ] {
        let mut peer = connect(&remote, "/diagnostics/v1").await;
        let mut message = hello(&remote, &token);
        message[field] = value;
        send(&mut peer, message).await;
        assert_eq!(
            receive(&mut peer, "diagnostics.denied").await["reason"],
            reason
        );
    }
    assert_eq!(remote.snapshot().unwrap().diagnostic_runs.len(), 1);
    remote.stop().await.unwrap();
}

#[tokio::test]
async fn invalid_batch_is_atomic_and_duplicate_sequences_cannot_create_extra_records() {
    let (remote, _network, _token, mut diagnostics) = setup().await;
    let mut conflict = event(1, "log");
    conflict["eventId"] = "different-id".into();
    send(
        &mut diagnostics,
        json!({"type":"diagnostics.batch","emitterId":"main","events":[event(1,"log"),conflict]}),
    )
    .await;
    receive(&mut diagnostics, "diagnostics.error").await;
    assert_eq!(remote.snapshot().unwrap().diagnostic_runs[0].count, 0);
    send(&mut diagnostics,json!({"type":"diagnostics.batch","emitterId":"main","events":[event(1,"log"),event(1,"log")]})).await;
    assert_eq!(
        receive(&mut diagnostics, "diagnostics.ack").await["sequence"],
        "1"
    );
    assert_eq!(remote.snapshot().unwrap().diagnostic_runs[0].count, 1);
    remote.stop().await.unwrap();
}
