use super::{
    diagnostics::{DiagnosticPage, StoredDiagnostic},
    server::{Remote, Socket, send},
    store::session_key,
};
use crate::protocol::{diagnostics::validate_decimal, session::Result};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use std::{sync::Arc, time::Duration};
use tokio::time::{Instant, timeout};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

impl Remote {
    #[allow(clippy::too_many_arguments)]
    pub fn diagnostic_query(
        &self,
        id: &str,
        search: &str,
        level: &str,
        exceptions: bool,
        offset: usize,
        limit: usize,
        revision: u32,
    ) -> Result<DiagnosticPage> {
        Ok(self
            .diagnostics
            .lock()
            .map_err(|_| "internalError")?
            .runs
            .get(id)
            .ok_or("diagnosticNotFound")?
            .query(search, level, exceptions, offset, limit, revision))
    }
    pub fn diagnostic_detail(&self, id: &str, event: &str) -> Result<Arc<str>> {
        self.diagnostics
            .lock()
            .map_err(|_| "internalError")?
            .runs
            .get(id)
            .ok_or("diagnosticNotFound")?
            .detail(event)
    }
    pub fn close_diagnostic(&self, id: &str) -> Result<()> {
        let mut store = self.diagnostics.lock().map_err(|_| "internalError")?;
        if store.runs.get(id).is_some_and(|r| r.online) {
            return Err("liveSessionActive".into());
        }
        store.runs.remove(id);
        drop(store);
        self.changed();
        Ok(())
    }
    pub(super) async fn diagnostic_connection(
        self: &Arc<Self>,
        mut socket: Socket,
        cancel: CancellationToken,
    ) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(10);
        let hello = loop {
            let next = tokio::select! {_=cancel.cancelled()=>return Ok(()),value=tokio::time::timeout_at(deadline,socket.next())=>value.map_err(|_|"helloTimeout")?};
            match next {
                Some(Ok(Message::Text(text))) => {
                    if text.len() > 16 * 1024 {
                        return Err("helloTooLarge".into());
                    }
                    if let Ok(value) = serde_json::from_str::<Value>(&text)
                        && value["type"] == "diagnostics.hello"
                    {
                        break value;
                    }
                }
                Some(Ok(Message::Ping(bytes))) => {
                    timeout(Duration::from_secs(5), socket.send(Message::Pong(bytes)))
                        .await
                        .map_err(|_| "writeTimeout")?
                        .map_err(|_| "writeFailed")?;
                }
                Some(Ok(Message::Pong(_) | Message::Binary(_))) => {}
                _ => return Ok(()),
            }
        };
        let binding = (|| -> Result<_> {
            if hello["protocol"] != "peek-desktop-diagnostics" || hello["version"] != 1 {
                return Err("protocolVersion".into());
            }
            let device = {
                let guard = self.pairing.lock().map_err(|_| "internalError")?;
                let pairing = guard.as_ref().ok_or("listenerStopped")?;
                if hello["serverId"].as_str() != Some(pairing.server_id()) {
                    return Err("serverIdentity".into());
                }
                pairing
                    .device_for_token(hello["deviceToken"].as_str().ok_or("token")?, true)
                    .ok_or("token")?
            };
            let run = hello["runId"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .ok_or("invalidRunId")?
                .to_owned();
            let network = if hello["networkSessionId"].is_null() {
                None
            } else {
                Some(
                    hello["networkSessionId"]
                        .as_str()
                        .ok_or("invalidSessionId")?,
                )
            };
            let (key, network_cancel) = if let Some(network) = network {
                let key = session_key(&device, network);
                let store = self.store.lock().map_err(|_| "internalError")?;
                let network = store
                    .sessions
                    .get(&key)
                    .filter(|s| s.online && s.device_id == device)
                    .ok_or("sessionBinding")?;
                (Some(key), network.cancel.clone())
            } else {
                (None, CancellationToken::new())
            };
            Ok((device, run, key, network_cancel))
        })();
        let (device, run, network_key, network_cancel) = match binding {
            Ok(binding) => binding,
            Err(reason) => {
                send(
                    &mut socket,
                    json!({"type":"diagnostics.denied","reason":reason}),
                )
                .await?;
                return Ok(());
            }
        };
        let connection = Uuid::new_v4().to_string();
        let id = {
            let mut store = self.diagnostics.lock().map_err(|_| "internalError")?;
            store.begin(
                device.clone(),
                run.clone(),
                network_key,
                connection.clone(),
                cancel.clone(),
            )?
        };
        let accepted = self
            .diagnostics
            .lock()
            .map_err(|_| "internalError")?
            .runs
            .get(&id)
            .unwrap()
            .accepted_strings();
        let result:Result<()>=async {
            if !self.authorized(&device,true)||network_cancel.is_cancelled() {return Err("token".into());}
            send(&mut socket,json!({"type":"diagnostics.welcome","protocol":"peek-desktop-diagnostics","version":1,"runId":run,"accepted":accepted})).await?;
            self.changed();
            let mut heartbeat=tokio::time::interval(Duration::from_secs(15));let mut received=Instant::now();
            loop {
                tokio::select! {
                    _=cancel.cancelled()=>break,
                    _=network_cancel.cancelled()=>break,
                    _=heartbeat.tick()=>{if received.elapsed()>Duration::from_secs(60) {break;}send(&mut socket,json!({"type":"diagnostics.ping"})).await?;},
                    message=socket.next()=>{
                        received=Instant::now(); if cancel.is_cancelled()||network_cancel.is_cancelled() {break;}
                        match message {
                            Some(Ok(Message::Text(text)))=>{
                                let core=self.clone();let id=id.clone();let connection=connection.clone();let text=text.to_string();
                                let response=tokio::task::spawn_blocking(move||core.diagnostic_message(&id,&connection,&text)).await.map_err(|_|"internalError")?;
                                match response {Ok(Some(value))=>send(&mut socket,value).await?,Ok(None)=>{},Err(reason)=>send(&mut socket,json!({"type":"diagnostics.error","reason":reason})).await?}
                            }
                            Some(Ok(Message::Ping(bytes)))=>{timeout(Duration::from_secs(5),socket.send(Message::Pong(bytes))).await.map_err(|_|"writeTimeout")?.map_err(|_|"writeFailed")?;},
                            Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,
                            _=>{},
                        }
                    }
                }
            }Ok(())
        }.await;
        if let Ok(mut store) = self.diagnostics.lock()
            && let Ok(run) = store.active(&id, &connection)
        {
            run.online = false;
            run.version += 1;
        }
        self.changed();
        let _ = timeout(Duration::from_secs(1), socket.close(None)).await;
        result
    }
    fn diagnostic_message(&self, id: &str, connection: &str, text: &str) -> Result<Option<Value>> {
        let value: Value = serde_json::from_str(text).map_err(|_| "invalidMessage")?;
        let emitter = value["emitterId"].as_str().unwrap_or("");
        let sequence = match value["type"].as_str() {
            Some("diagnostics.ping") => return Ok(Some(json!({"type":"diagnostics.pong"}))),
            Some("diagnostics.batch") => {
                #[derive(Deserialize)]
                struct Batch<'a> {
                    #[serde(borrow)]
                    events: Vec<&'a RawValue>,
                }
                let batch: Batch = serde_json::from_str(text).map_err(|_| "invalidBatch")?;
                if batch.events.len() > 64 {
                    return Err("batchTooLarge".into());
                }
                let events = batch
                    .events
                    .iter()
                    .map(|raw| StoredDiagnostic::parse(raw.get()))
                    .collect::<Result<Vec<_>>>()?;
                self.diagnostics
                    .lock()
                    .map_err(|_| "internalError")?
                    .active(id, connection)?
                    .batch(emitter, events)?
            }
            Some("diagnostics.gap") => {
                let from = value["fromSequence"].as_str().ok_or("invalidGap")?;
                let to = value["toSequence"].as_str().ok_or("invalidGap")?;
                validate_decimal(from)?;
                validate_decimal(to)?;
                self.diagnostics
                    .lock()
                    .map_err(|_| "internalError")?
                    .active(id, connection)?
                    .gap(
                        emitter,
                        from.parse().map_err(|_| "invalidGap")?,
                        to.parse().map_err(|_| "invalidGap")?,
                        value["reason"].as_str().unwrap_or("bufferOverflow"),
                    )?
            }
            _ => return Ok(None),
        };
        self.changed();
        Ok(Some(
            json!({"type":"diagnostics.ack","emitterId":emitter,"sequence":sequence}),
        ))
    }
}
