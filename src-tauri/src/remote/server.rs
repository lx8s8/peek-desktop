use super::{
    pairing::{Pairing, PairingInfo, SecretVault, SystemVault, now_seconds},
    store::{LiveStore, PendingBody},
};
use crate::{
    body::{self, BodyView},
    protocol::{
        remote::validate_frame,
        session::{Result, validate_body},
    },
    session::{MAX_LINE_BYTES, QueryPage, Session, SessionSummary, StoredEntry},
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::{Mutex as AsyncMutex, Semaphore, mpsc, oneshot, watch},
    task::{JoinHandle, JoinSet},
    time::{Instant, timeout},
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        Message,
        handshake::server::create_response,
        http,
        protocol::{Role, WebSocketConfig},
    },
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

type Socket = WebSocketStream<BufReader<TcpStream>>;

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListenerInfo {
    pub listening: bool,
    pub host: String,
    pub port: u16,
    pub addresses: Vec<String>,
    pub mdns: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSnapshot {
    #[serde(flatten)]
    pub listener: ListenerInfo,
    pub pairing: Option<PairingInfo>,
    pub sessions: Vec<SessionSummary>,
    pub revision: u64,
}
struct Running {
    cancel: CancellationToken,
    task: JoinHandle<()>,
    mdns: Option<mdns_sd::ServiceDaemon>,
}

pub struct Remote {
    pub(super) store: Mutex<LiveStore>,
    pub(super) pairing: Arc<Mutex<Option<Pairing>>>,
    vault: Arc<dyn SecretVault>,
    listener: Mutex<ListenerInfo>,
    running: AsyncMutex<Option<Running>>,
    admission: AsyncMutex<()>,
    pub changes: watch::Sender<u64>,
    revision: AtomicU64,
}
impl Default for Remote {
    fn default() -> Self {
        Self::with_vault(Arc::new(SystemVault))
    }
}
impl Remote {
    pub fn with_vault(vault: Arc<dyn SecretVault>) -> Self {
        let (changes, _) = watch::channel(0);
        Self {
            vault,
            store: Mutex::new(LiveStore::default()),
            pairing: Arc::new(Mutex::new(None)),
            listener: Mutex::new(ListenerInfo::default()),
            running: AsyncMutex::new(None),
            admission: AsyncMutex::new(()),
            changes,
            revision: AtomicU64::new(0),
        }
    }
    pub fn changed(&self) {
        self.changes
            .send_replace(self.revision.fetch_add(1, Ordering::Relaxed) + 1);
    }
    pub fn snapshot(&self) -> Result<RemoteSnapshot> {
        let pairing = self
            .pairing
            .lock()
            .map_err(|_| "internalError")?
            .as_ref()
            .map(|p| p.info(now_seconds()));
        Ok(RemoteSnapshot {
            listener: self.listener.lock().map_err(|_| "internalError")?.clone(),
            pairing,
            sessions: self.summaries()?,
            revision: self.revision.load(Ordering::Relaxed),
        })
    }
    pub fn summaries(&self) -> Result<Vec<SessionSummary>> {
        Ok(self.store.lock().map_err(|_| "internalError")?.summaries())
    }
    pub fn query(
        &self,
        id: &str,
        search: &str,
        filter: &str,
        offset: usize,
        limit: usize,
        revision: u32,
    ) -> Result<QueryPage> {
        let store = self.store.lock().map_err(|_| "internalError")?;
        Ok(store
            .sessions
            .get(id)
            .ok_or("sessionNotFound")?
            .current
            .query(search, filter, offset, limit, revision))
    }
    pub fn entry(&self, id: &str, entry: &str) -> Result<Arc<str>> {
        let store = self.store.lock().map_err(|_| "internalError")?;
        Ok(store
            .sessions
            .get(id)
            .ok_or("sessionNotFound")?
            .current
            .entry(entry)
            .ok_or("entryNotFound")?
            .raw
            .clone())
    }
    pub fn export(&self, id: &str) -> Result<Arc<Session>> {
        Ok(Arc::new(
            self.store
                .lock()
                .map_err(|_| "internalError")?
                .sessions
                .get(id)
                .ok_or("sessionNotFound")?
                .current
                .clone(),
        ))
    }
    pub fn close(&self, id: &str) -> Result<()> {
        let mut store = self.store.lock().map_err(|_| "internalError")?;
        if store.sessions.get(id).is_some_and(|s| s.online) {
            return Err("liveSessionActive".into());
        }
        store.cancel_pending(id, "sessionNotFound");
        store.sessions.remove(id);
        drop(store);
        self.changed();
        Ok(())
    }
    pub async fn start(
        self: &Arc<Self>,
        host: String,
        port: u16,
        advertise: bool,
    ) -> Result<RemoteSnapshot> {
        if host != "127.0.0.1" && host != "0.0.0.0" {
            return Err("invalidBindAddress".into());
        }
        let mut running = self.running.lock().await;
        if running.is_some() {
            return Err("listenerAlreadyRunning".into());
        }
        let listener = TcpListener::bind((host.as_str(), port))
            .await
            .map_err(|_| "listenerBindFailed")?;
        let port = listener
            .local_addr()
            .map_err(|_| "listenerBindFailed")?
            .port();
        let vault = self.vault.clone();
        let pairing = tokio::task::spawn_blocking(move || Pairing::load(vault))
            .await
            .map_err(|_| "internalError")??;
        let server_id = pairing.server_id().to_owned();
        *self.pairing.lock().map_err(|_| "internalError")? = Some(pairing);
        let addresses = if host == "127.0.0.1" {
            vec![format!("127.0.0.1:{port}")]
        } else {
            local_ip_address::list_afinet_netifas()
                .unwrap_or_default()
                .into_iter()
                .filter(|(_, ip)| ip.is_ipv4() && !ip.is_loopback())
                .map(|(_, ip)| format!("{ip}:{port}"))
                .take(16)
                .collect()
        };
        let daemon = if advertise && host == "0.0.0.0" {
            advertise_mdns(&server_id, port).ok()
        } else {
            None
        };
        let mdns = if advertise && host == "0.0.0.0" {
            if daemon.is_some() { "active" } else { "failed" }
        } else {
            "off"
        };
        *self.listener.lock().map_err(|_| "internalError")? = ListenerInfo {
            listening: true,
            host,
            port,
            addresses,
            mdns: mdns.into(),
        };
        let cancel = CancellationToken::new();
        let remote = self.clone();
        let child = cancel.clone();
        let task = tokio::spawn(async move {
            remote.accept_loop(listener, child).await;
        });
        *running = Some(Running {
            cancel,
            task,
            mdns: daemon,
        });
        drop(running);
        self.changed();
        self.snapshot()
    }
    pub async fn stop(&self) -> Result<()> {
        let mut running = self.running.lock().await;
        if let Some(service) = running.take() {
            service.cancel.cancel();
            let _ = service.task.await;
            if let Some(daemon) = service.mdns {
                let _ = daemon.shutdown();
            }
        }
        self.listener.lock().map_err(|_| "internalError")?.listening = false;
        drop(running);
        self.changed();
        Ok(())
    }
    pub async fn issue_code(&self, diagnostics: bool) -> Result<RemoteSnapshot> {
        if !self.listener.lock().map_err(|_| "internalError")?.listening {
            return Err("listenerStopped".into());
        }
        let pairing = self.pairing.clone();
        tokio::task::spawn_blocking(move || {
            pairing
                .lock()
                .map_err(|_| "internalError")?
                .as_mut()
                .ok_or("listenerStopped")?
                .issue_code(diagnostics, now_seconds())
        })
        .await
        .map_err(|_| "internalError")??;
        self.changed();
        self.snapshot()
    }
    pub async fn revoke(&self, device_id: String, diagnostics: Option<bool>) -> Result<()> {
        let pairing = self.pairing.clone();
        let device = device_id.clone();
        tokio::task::spawn_blocking(move || {
            let mut lock = pairing.lock().map_err(|_| "internalError")?;
            let pairing = lock.as_mut().ok_or("listenerStopped")?;
            match diagnostics {
                Some(enabled) => pairing.set_diagnostics(&device, enabled),
                None => pairing.revoke(&device),
            }
        })
        .await
        .map_err(|_| "internalError")??;
        if diagnostics.is_none() {
            for session in self
                .store
                .lock()
                .map_err(|_| "internalError")?
                .sessions
                .values()
                .filter(|s| s.device_id == device_id)
            {
                session.cancel.cancel();
            }
        }
        self.changed();
        Ok(())
    }
    async fn accept_loop(self: Arc<Self>, listener: TcpListener, cancel: CancellationToken) {
        let permits = Arc::new(Semaphore::new(16));
        let mut tasks = JoinSet::new();
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
                accepted = listener.accept() => {
                    let Ok((stream, address)) = accepted else { break; };
                    let Ok(permit) = permits.clone().try_acquire_owned() else { continue; };
                    let core = self.clone(); let child = cancel.child_token();
                    tasks.spawn(async move { let _permit = permit; let _ = core.connection(stream, address, child).await; });
                }
            }
        }
        cancel.cancel();
        while tasks.join_next().await.is_some() {}
        if let Ok(mut info) = self.listener.lock() {
            info.listening = false;
        }
        self.changed();
    }
    async fn connection(
        self: Arc<Self>,
        stream: TcpStream,
        _address: SocketAddr,
        cancel: CancellationToken,
    ) -> Result<()> {
        let _ = stream.set_nodelay(true);
        let mut stream = BufReader::new(stream);
        let request = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            value = timeout(Duration::from_secs(10), read_http(&mut stream)) => value.map_err(|_| "handshakeTimeout")??,
        };
        let path = request.uri().path();
        if request.method() != http::Method::GET || request.uri().query().is_some() {
            return Err("invalidPath".into());
        }
        if path == "/diagnostics/v1/capabilities" {
            let server_id = self
                .pairing
                .lock()
                .map_err(|_| "internalError")?
                .as_ref()
                .ok_or("listenerStopped")?
                .server_id()
                .to_owned();
            let body = json!({"protocol":"peek-desktop-diagnostics", "version":1, "serverId":server_id,"capabilities":["logs","exceptions","ack","gaps"]}).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            timeout(
                Duration::from_secs(5),
                stream.write_all(response.as_bytes()),
            )
            .await
            .map_err(|_| "writeTimeout")?
            .map_err(|_| "writeFailed")?;
            return Ok(());
        }
        if path != "/" && path != "/diagnostics/v1" {
            return Err("invalidPath".into());
        }
        let diagnostics = path == "/diagnostics/v1";
        let response = create_response(&request).map_err(|_| "invalidUpgrade")?;
        let mut encoded = String::from("HTTP/1.1 101 Switching Protocols\r\n");
        for (key, value) in response.headers() {
            encoded.push_str(&format!(
                "{key}: {}\r\n",
                value.to_str().map_err(|_| "invalidUpgrade")?
            ));
        }
        encoded.push_str("\r\n");
        timeout(Duration::from_secs(5), stream.write_all(encoded.as_bytes()))
            .await
            .map_err(|_| "writeTimeout")?
            .map_err(|_| "writeFailed")?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_LINE_BYTES))
            .max_frame_size(Some(MAX_LINE_BYTES));
        let socket = WebSocketStream::from_raw_socket(stream, Role::Server, Some(config)).await;
        if diagnostics {
            return self.diagnostic_connection(socket, cancel).await;
        }
        self.network_connection(socket, cancel).await
    }

    // Replaced by the diagnostics transport in the next implementation step.
    async fn diagnostic_connection(
        &self,
        mut socket: Socket,
        _cancel: CancellationToken,
    ) -> Result<()> {
        send(
            &mut socket,
            json!({"type":"diagnostics.denied","reason":"notReady"}),
        )
        .await
    }
    async fn network_connection(
        self: &Arc<Self>,
        mut socket: Socket,
        cancel: CancellationToken,
    ) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let hello = loop {
            let next = tokio::select! { _ = cancel.cancelled() => return Ok(()), value = tokio::time::timeout_at(deadline, socket.next()) => value.map_err(|_| "helloTimeout")? };
            let text = match next {
                Some(Ok(Message::Text(text))) => text,
                Some(Ok(Message::Binary(_) | Message::Pong(_))) => continue,
                Some(Ok(Message::Ping(bytes))) => {
                    timeout(Duration::from_secs(5), socket.send(Message::Pong(bytes)))
                        .await
                        .map_err(|_| "writeTimeout")?
                        .map_err(|_| "writeFailed")?;
                    continue;
                }
                _ => return Ok(()),
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if validate_frame(&value).ok().flatten() == Some("hello") {
                break value;
            }
        };
        if hello["protocolVersion"] != 1 {
            send(&mut socket,json!({"type":"denied","reason":"protocolVersion","message":"Peek protocol v1 is required."})).await?;
            return Ok(());
        }
        let admission = self.admission.lock().await;
        if hello["sessionId"]
            .as_str()
            .is_none_or(|id| id.is_empty() || id.len() > 256)
            || hello["session"]["name"]
                .as_str()
                .is_some_and(|name| name.len() > 256)
        {
            return Err("invalidSessionId".into());
        }
        let known = self
            .pairing
            .lock()
            .map_err(|_| "internalError")?
            .as_ref()
            .and_then(|p| {
                hello["token"]
                    .as_str()
                    .and_then(|token| p.device_for_token(token, false))
            });
        let capacity = {
            let store = self.store.lock().map_err(|_| "internalError")?;
            store.sessions.len() < super::store::MAX_LIVE_SESSIONS
                || known.is_some_and(|device| {
                    store.sessions.contains_key(&super::store::session_key(
                        &device,
                        hello["sessionId"].as_str().unwrap(),
                    ))
                })
        };
        if !capacity {
            send(&mut socket,json!({"type":"denied","reason":"other","message":"Desktop live session capacity reached. Close an offline session."})).await?;
            return Ok(());
        }
        let pairing = self.pairing.clone();
        let auth_hello = hello.clone();
        let auth = tokio::task::spawn_blocking(move || {
            pairing
                .lock()
                .map_err(|_| "other")?
                .as_mut()
                .ok_or("other")?
                .authorize(
                    auth_hello["protocolVersion"].as_u64().unwrap_or(0),
                    auth_hello["token"].as_str(),
                    auth_hello["code"].as_str(),
                    auth_hello["session"]["name"]
                        .as_str()
                        .unwrap_or("Flutter App"),
                    now_seconds(),
                )
        })
        .await
        .map_err(|_| "internalError")?;
        self.changed();
        let auth = match auth {
            Ok(auth) => auth,
            Err(reason) => {
                let reason = if ["code", "token", "protocolVersion"].contains(&reason.as_str()) {
                    reason
                } else {
                    "other".into()
                };
                send(&mut socket, json!({"type":"denied","reason":reason,"message":"Pairing refused. Check the desktop and try again."})).await?;
                let _ = socket.close(None).await;
                return Ok(());
            }
        };
        if !self.authorized(&auth.device_id, false) {
            return Err("token".into());
        }
        let server_id = self
            .pairing
            .lock()
            .map_err(|_| "internalError")?
            .as_ref()
            .ok_or("listenerStopped")?
            .server_id()
            .to_owned();
        let connection_id = Uuid::new_v4().to_string();
        let (sender, mut outgoing) = mpsc::channel(16);
        let key = self.store.lock().map_err(|_| "internalError")?.begin(
            &auth.device_id,
            hello["sessionId"].as_str().unwrap(),
            &connection_id,
            hello["session"].clone(),
            sender,
            cancel.clone(),
        )?;
        drop(admission);
        let welcome = if !self.authorized(&auth.device_id, false) || cancel.is_cancelled() {
            Err("token".into())
        } else {
            send(&mut socket, json!({"type":"welcome","protocolVersion":1,"server":{"id":server_id,"name":"Peek Desktop","version":env!("CARGO_PKG_VERSION")},"deviceToken":auth.issued_token})).await
        };
        if let Err(error) = welcome {
            self.store
                .lock()
                .map_err(|_| "internalError")?
                .disconnect(&key, &connection_id);
            self.changed();
            return Err(error);
        }
        self.changed();
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        let mut received = Instant::now();
        let result: Result<()> = async {
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    value = outgoing.recv() => { if let Some(value) = value { send(&mut socket, value).await?; } else { break; } },
                    _ = heartbeat.tick() => { if received.elapsed() > Duration::from_secs(60) { break; } send(&mut socket,json!({"type":"ping"})).await?; },
                    frame = socket.next() => {
                        received = Instant::now();
                        if cancel.is_cancelled() { break; }
                        match frame {
                            Some(Ok(Message::Text(text))) => { let text = text.to_string();
                                let ping = if text.len() > 64 * 1024 {
                                    let core = self.clone(); let key = key.clone(); let connection = connection_id.clone();
                                    tokio::task::spawn_blocking(move || core.network_text(&key, &connection, &text)).await.map_err(|_| "internalError")??
                                } else { self.network_text(&key, &connection_id, &text)? };
                                if ping { send(&mut socket,json!({"type":"pong"})).await?; }
                            }
                            Some(Ok(Message::Ping(bytes))) => { timeout(Duration::from_secs(5),socket.send(Message::Pong(bytes))).await.map_err(|_| "writeTimeout")?.map_err(|_| "writeFailed")?; }
                            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                            _ => {},
                        }
                    }
                }
            } Ok(())
        }.await;
        self.store
            .lock()
            .map_err(|_| "internalError")?
            .disconnect(&key, &connection_id);
        self.changed();
        let _ = timeout(Duration::from_secs(1), socket.close(None)).await;
        result
    }
    fn network_text(&self, key: &str, connection: &str, text: &str) -> Result<bool> {
        let value: Value = match serde_json::from_str(text) {
            Ok(value) => value,
            Err(_) => {
                self.invalid_frame(key, connection)?;
                return Ok(false);
            }
        };
        if value["type"] == "ping" {
            return Ok(true);
        }
        self.apply_network(key, connection, text, &value)?;
        Ok(false)
    }
    fn invalid_frame(&self, key: &str, connection: &str) -> Result<()> {
        if let Some(s) = self
            .store
            .lock()
            .map_err(|_| "internalError")?
            .active_mut(key, connection)
        {
            s.staging.as_mut().unwrap_or(&mut s.current).skipped += 1;
            s.version += 1;
        }
        self.changed();
        Ok(())
    }
    pub(super) fn authorized(&self, device: &str, diagnostics: bool) -> bool {
        self.pairing
            .lock()
            .ok()
            .and_then(|p| p.as_ref().map(|p| p.is_authorized(device, diagnostics)))
            .unwrap_or(false)
    }
    fn apply_network(&self, key: &str, connection: &str, text: &str, value: &Value) -> Result<()> {
        if validate_frame(value).is_err() {
            self.invalid_frame(key, connection)?;
            return Ok(());
        }
        let kind = value["type"].as_str().unwrap_or("");
        match kind {
            "entry" if value["op"] == "add" || value["op"] == "update" => {
                #[derive(Deserialize)]
                struct Frame<'a> {
                    #[serde(borrow)]
                    entry: &'a RawValue,
                }
                if let Ok(frame) = serde_json::from_str::<Frame>(text) {
                    if let Ok(entry) = StoredEntry::parse(frame.entry.get()) {
                        let mut store = self.store.lock().map_err(|_| "internalError")?;
                        if store.upsert(key, connection, entry).is_err() {
                            if let Some(s) = store.active_mut(key, connection) {
                                s.staging.as_mut().unwrap_or(&mut s.current).skipped += 1;
                            }
                        }
                    }
                }
            }
            "entry" => self.store.lock().map_err(|_| "internalError")?.remove(
                key,
                connection,
                value["id"].as_str().unwrap_or(""),
            ),
            "synced" => self
                .store
                .lock()
                .map_err(|_| "internalError")?
                .synced(key, connection),
            "cleared" => self
                .store
                .lock()
                .map_err(|_| "internalError")?
                .clear(key, connection),
            "dropped" => {
                if let Some(s) = self
                    .store
                    .lock()
                    .map_err(|_| "internalError")?
                    .active_mut(key, connection)
                {
                    s.dropped = s
                        .dropped
                        .saturating_add(value["count"].as_u64().unwrap_or(0));
                    s.version += 1;
                }
            }
            "bodyResponse" => self.body_response(connection, value)?,
            _ => return Ok(()),
        }
        self.changed();
        Ok(())
    }
    pub async fn body(&self, id: String, entry_id: String, side: String) -> Result<BodyView> {
        let raw = self.entry(&id, &entry_id)?;
        let value: Value = serde_json::from_str(&raw).map_err(|_| "invalidEntry")?;
        if value[&side]["body"]["kind"] != "remote" {
            return body::view(&value[&side]["body"]);
        }
        let request_id = Uuid::new_v4().to_string();
        let (reply, response) = oneshot::channel();
        let sender = {
            let mut store = self.store.lock().map_err(|_| "internalError")?;
            if store.pending.len() >= 32 {
                return Err("bodyBusy".into());
            }
            let s = store
                .sessions
                .get(&id)
                .filter(|s| s.online && s.staging.is_none())
                .ok_or("deviceOffline")?;
            let pending = PendingBody {
                session_id: id.clone(),
                entry_id: entry_id.clone(),
                side: side.clone(),
                connection_id: s.connection_id.clone(),
                generation: s.generation,
                original: raw,
                reply,
            };
            let sender = s.sender.clone();
            store.pending.insert(request_id.clone(), pending);
            sender
        };
        let result = async {
            sender
                .try_send(
                    json!({"type":"bodyRequest","requestId":request_id,"id":entry_id,"side":side}),
                )
                .map_err(|_| "bodyBusy")?;
            timeout(Duration::from_secs(8), response)
                .await
                .map_err(|_| "bodyTimeout")?
                .map_err(|_| "deviceOffline")??;
            let raw = self.entry(&id, &entry_id)?;
            let value: Value = serde_json::from_str(&raw).map_err(|_| "invalidEntry")?;
            body::view(&value[&side]["body"])
        }
        .await;
        self.store
            .lock()
            .map_err(|_| "internalError")?
            .pending
            .remove(&request_id);
        result
    }
    fn body_response(&self, connection: &str, value: &Value) -> Result<()> {
        let request_id = value["requestId"].as_str().unwrap_or("");
        let mut store = self.store.lock().map_err(|_| "internalError")?;
        if !store
            .pending
            .get(request_id)
            .is_some_and(|p| p.connection_id == connection)
        {
            return Ok(());
        }
        let pending = store.pending.remove(request_id).unwrap();
        let result = (|| {
            let session = store
                .sessions
                .get(&pending.session_id)
                .filter(|s| {
                    s.connection_id == connection && s.generation == pending.generation && s.online
                })
                .ok_or("bodyStale")?;
            let original = session
                .current
                .entry(&pending.entry_id)
                .filter(|entry| entry.raw == pending.original)
                .ok_or("bodyStale")?;
            if value["body"].is_null() {
                return Err(match value["error"].as_str() {
                    Some("notFound") => "bodyNotFound",
                    Some("notHeld") => "bodyNotHeld",
                    _ => "bodyFailed",
                }
                .into());
            }
            validate_body(&value["body"])?;
            if value["body"]["kind"] == "remote" {
                return Err("bodyFailed".into());
            }
            let mut entry: Value =
                serde_json::from_str(&original.raw).map_err(|_| "invalidEntry")?;
            entry[&pending.side]["body"] = value["body"].clone();
            let entry = StoredEntry::parse(&entry.to_string())?;
            store.upsert(&pending.session_id, connection, entry)
        })();
        let _ = pending.reply.send(result);
        Ok(())
    }
}

async fn send(socket: &mut Socket, value: Value) -> Result<()> {
    timeout(
        Duration::from_secs(5),
        socket.send(Message::Text(value.to_string().into())),
    )
    .await
    .map_err(|_| "writeTimeout")?
    .map_err(|_| "writeFailed".into())
}
async fn read_http(stream: &mut BufReader<TcpStream>) -> Result<http::Request<()>> {
    let mut bytes = Vec::new();
    loop {
        bytes.push(stream.read_u8().await.map_err(|_| "invalidHttp")?);
        if bytes.len() > 8192 {
            return Err("httpHeaderTooLarge".into());
        }
        if bytes.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut parsed = httparse::Request::new(&mut headers);
    parsed.parse(&bytes).map_err(|_| "invalidHttp")?;
    if parsed.version != Some(1) {
        return Err("invalidHttp".into());
    }
    let mut request = http::Request::builder()
        .method(parsed.method.ok_or("invalidHttp")?)
        .uri(parsed.path.ok_or("invalidHttp")?);
    for header in parsed.headers.iter() {
        request = request.header(header.name, header.value);
    }
    request.body(()).map_err(|_| "invalidHttp".into())
}
fn advertise_mdns(server_id: &str, port: u16) -> Result<mdns_sd::ServiceDaemon> {
    let daemon = mdns_sd::ServiceDaemon::new().map_err(|_| "mdnsFailed")?;
    let short = &server_id[..8];
    let properties = HashMap::from([
        ("protocolVersion".to_owned(), "1".to_owned()),
        ("serverId".to_owned(), server_id.to_owned()),
    ]);
    let service = mdns_sd::ServiceInfo::new(
        "_peek._tcp.local.",
        &format!("Peek Desktop {short}"),
        &format!("peek-{short}.local."),
        (),
        port,
        properties,
    )
    .map_err(|_| "mdnsFailed")?
    .enable_addr_auto();
    if daemon.register(service).is_err() {
        let _ = daemon.shutdown();
        return Err("mdnsFailed".into());
    }
    Ok(daemon)
}
