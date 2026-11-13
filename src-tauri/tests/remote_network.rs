mod support;
use serde_json::json;
use support::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

#[tokio::test]
async fn pairing_history_live_updates_and_revocation_work_over_real_websocket() {
    let remote = server().await;
    let (mut client, token) = paired(&remote, "run-one").await;
    let id = remote.summaries().unwrap()[0].id.clone();
    send(
        &mut client,
        json!({"type":"entry","op":"add","entry":entry("a")}),
    )
    .await;
    assert_eq!(remote.query(&id, "", "all", 0, 10, 1).unwrap().total, 0);
    send(&mut client, json!({"type":"synced","count":1})).await;
    eventually(|| remote.query(&id, "", "all", 0, 10, 1).unwrap().total == 1).await;
    let mut completed = entry("a");
    completed["completedAt"] = "2026-11-13T00:00:00.123456Z".into();
    completed["response"] = json!({"status":503});
    send(
        &mut client,
        json!({"type":"entry","op":"update","entry":completed}),
    )
    .await;
    eventually(|| remote.query(&id, "", "errors", 0, 10, 1).unwrap().total == 1).await;
    send(&mut client, json!({"type":"entry","op":"unknown"})).await;
    send(&mut client, json!({"type":"dropped","count":3})).await;
    eventually(|| {
        remote.summaries().unwrap()[0]
            .live
            .as_ref()
            .unwrap()
            .dropped
            == 3
    })
    .await;
    assert_eq!(remote.summaries().unwrap()[0].skipped, 1);
    send(&mut client, json!({"type":"entry","op":"remove","id":"a"})).await;
    eventually(|| remote.query(&id, "", "all", 0, 10, 1).unwrap().total == 0).await;
    let device = remote.summaries().unwrap()[0]
        .live
        .as_ref()
        .unwrap()
        .device_id
        .clone();
    remote.revoke(device, None).await.unwrap();
    eventually(|| !remote.summaries().unwrap()[0].live.as_ref().unwrap().online).await;
    let mut rejected = connect(&remote, "/").await;
    send(&mut rejected,json!({"type":"hello","protocolVersion":1,"token":token,"sessionId":"run-one","session":header()})).await;
    assert_eq!(receive(&mut rejected, "denied").await["reason"], "token");
    remote.stop().await.unwrap();
}

#[tokio::test]
async fn reconnect_commits_new_snapshot_and_cannot_be_overwritten_by_old_peer() {
    let remote = server().await;
    let (mut first, token) = paired(&remote, "run-one").await;
    send(
        &mut first,
        json!({"type":"entry","op":"add","entry":entry("old")}),
    )
    .await;
    send(&mut first, json!({"type":"synced","count":1})).await;
    let id = remote.summaries().unwrap()[0].id.clone();
    eventually(|| remote.query(&id, "", "all", 0, 10, 1).unwrap().total == 1).await;
    let mut second = connect(&remote, "/").await;
    send(&mut second,json!({"type":"hello","protocolVersion":1,"token":token,"sessionId":"run-one","session":header()})).await;
    receive(&mut second, "welcome").await;
    send(
        &mut second,
        json!({"type":"entry","op":"add","entry":entry("new")}),
    )
    .await;
    assert_eq!(
        remote.query(&id, "", "all", 0, 10, 1).unwrap().rows[0].id,
        "old"
    );
    send(&mut second, json!({"type":"synced","count":1})).await;
    eventually(|| {
        remote
            .query(&id, "", "all", 0, 10, 1)
            .unwrap()
            .rows
            .first()
            .is_some_and(|r| r.id == "new")
    })
    .await;
    assert_eq!(remote.summaries().unwrap().len(), 1);
    assert_eq!(
        remote.summaries().unwrap()[0]
            .live
            .as_ref()
            .unwrap()
            .generation,
        2
    );
    send(&mut second, json!({"type":"cleared"})).await;
    eventually(|| remote.query(&id, "", "all", 0, 10, 1).unwrap().total == 0).await;
    remote.stop().await.unwrap();
}

#[tokio::test]
async fn remote_body_is_correlated_and_stale_responses_are_rejected() {
    let remote = server().await;
    let (mut client, _) = paired(&remote, "run").await;
    let mut item = entry("body");
    item["completedAt"] = "2026-11-13T00:00:00.100Z".into();
    item["response"] =
        json!({"status":200,"body":{"kind":"remote","size":40,"type":"application/json"}});
    send(&mut client, json!({"type":"entry","op":"add","entry":item})).await;
    send(&mut client, json!({"type":"synced","count":1})).await;
    let id = remote.summaries().unwrap()[0].id.clone();
    eventually(|| remote.query(&id, "", "all", 0, 10, 1).unwrap().total == 1).await;
    let core = remote.clone();
    let key = id.clone();
    let pending =
        tokio::spawn(async move { core.body(key, "body".into(), "response".into()).await });
    let request = receive(&mut client, "bodyRequest").await;
    let original = "{\"id\":900719925474099312345,\"amount\":0.12345678901234567890}";
    send(&mut client,json!({"type":"bodyResponse","requestId":request["requestId"],"body":{"kind":"text","text":original,"type":"application/json"}})).await;
    assert_eq!(pending.await.unwrap().unwrap().text, original);
    send(
        &mut client,
        json!({"type":"entry","op":"update","entry":item}),
    )
    .await;
    eventually(|| remote.entry(&id, "body").unwrap().contains("remote")).await;
    let core = remote.clone();
    let key = id.clone();
    let pending =
        tokio::spawn(async move { core.body(key, "body".into(), "response".into()).await });
    let request = receive(&mut client, "bodyRequest").await;
    send(&mut client, json!({"type":"cleared"})).await;
    assert_eq!(pending.await.unwrap().err().unwrap(), "bodyStale");
    send(&mut client,json!({"type":"bodyResponse","requestId":request["requestId"],"body":{"kind":"text","text":"stale"}})).await;
    assert_eq!(remote.query(&id, "", "all", 0, 10, 1).unwrap().total, 0);
    remote.stop().await.unwrap();
}

#[tokio::test]
async fn capabilities_do_not_disclose_pairing_and_versions_are_checked_first() {
    let remote = server().await;
    remote.issue_code(true).await.unwrap();
    let mut client = connect(&remote, "/").await;
    send(&mut client,json!({"type":"hello","protocolVersion":2,"code":"invalid","sessionId":"run","session":header()})).await;
    assert_eq!(
        receive(&mut client, "denied").await["reason"],
        "protocolVersion"
    );
    let mut tcp = TcpStream::connect(("127.0.0.1", remote.snapshot().unwrap().listener.port))
        .await
        .unwrap();
    tcp.write_all(b"GET /diagnostics/v1/capabilities HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .unwrap();
    let mut body = String::new();
    tcp.read_to_string(&mut body).await.unwrap();
    assert!(body.starts_with("HTTP/1.1 200"));
    assert!(body.contains("peek-desktop-diagnostics"));
    assert!(!body.contains("token"));
    assert!(!body.contains("code"));
    remote.stop().await.unwrap();
}
