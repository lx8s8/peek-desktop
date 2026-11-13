use futures_util::{SinkExt, StreamExt};
use peek_desktop_lib::{
    protocol::session::Result,
    remote::{pairing::SecretVault, server::Remote},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::{
    net::TcpStream,
    time::{Duration, timeout},
};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};

#[derive(Default)]
pub struct Vault(Mutex<Option<String>>);
impl SecretVault for Vault {
    fn read(&self) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn write(&self, value: &str) -> Result<()> {
        *self.0.lock().unwrap() = Some(value.into());
        Ok(())
    }
}
pub type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub async fn server() -> Arc<Remote> {
    let remote = Arc::new(Remote::with_vault(Arc::new(Vault::default())));
    remote.start("127.0.0.1".into(), 0, false).await.unwrap();
    remote
}
pub fn header() -> Value {
    json!({"peekVersion":"2.1.1","name":"Synthetic App","platform":"ios","startedAt":"2026-11-13T00:00:00.000Z"})
}
pub fn entry(id: &str) -> Value {
    json!({"id":id,"source":"synthetic","startedAt":"2026-11-13T00:00:00.000Z","request":{"method":"GET","url":format!("https://synthetic.example.test/{id}")}})
}
pub async fn connect(remote: &Remote, path: &str) -> Client {
    tokio_tungstenite::connect_async(format!(
        "ws://127.0.0.1:{}{path}",
        remote.snapshot().unwrap().listener.port
    ))
    .await
    .unwrap()
    .0
}
pub async fn send(client: &mut Client, value: Value) {
    client
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
pub async fn receive(client: &mut Client, kind: &str) -> Value {
    timeout(Duration::from_secs(3), async {
        loop {
            match client.next().await.unwrap().unwrap() {
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["type"] == kind {
                        return value;
                    }
                    if value["type"] == "ping" {
                        send(client, json!({"type":"pong"})).await;
                    }
                }
                Message::Ping(bytes) => client.send(Message::Pong(bytes)).await.unwrap(),
                _ => {}
            }
        }
    })
    .await
    .expect("expected frame")
}
pub async fn paired(remote: &Remote, run: &str) -> (Client, String) {
    let code = remote
        .issue_code(true)
        .await
        .unwrap()
        .pairing
        .unwrap()
        .code
        .unwrap();
    let mut client = connect(remote, "/").await;
    client
        .send(Message::Binary(vec![1, 2, 3].into()))
        .await
        .unwrap();
    send(
        &mut client,
        json!({"type":"hello","protocolVersion":1,"code":code,"sessionId":run,"session":header()}),
    )
    .await;
    let welcome = receive(&mut client, "welcome").await;
    (client, welcome["deviceToken"].as_str().unwrap().into())
}
pub async fn eventually(mut predicate: impl FnMut() -> bool) {
    timeout(Duration::from_secs(3), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("state should converge");
}
