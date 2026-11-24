//! 桌面端请求重放模块：允许开发者在桌面端修改参数后直接重发抓包请求并查看最新响应。

use crate::protocol::session::Result;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{sync::Semaphore, task::JoinSet};

/// 响应体最大读取字节数（4 MiB），防止异常大响应耗尽内存。
const MAX_REPLAY_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// 批量重放单次响应体最大保留字节数（512 KiB），防止 50 次压测占满内存。
const MAX_BATCH_ITEM_RESPONSE_BYTES: usize = 512 * 1024;
/// 请求超时上限（15 秒）。
const REPLAY_TIMEOUT: Duration = Duration::from_secs(15);
/// 批量重复重放最大次数上限。
const MAX_BATCH_COUNT: usize = 50;
/// 批量重复重放最大并发度上限。
const MAX_BATCH_CONCURRENCY: usize = 10;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// 测试环境可选忽略自签名/不受信任 TLS 证书（默认严格校验证书）。
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayBatchRequest {
    #[serde(flatten)]
    pub request: ReplayRequest,
    /// 重复执行次数（1..=50）。
    pub count: usize,
    /// 最大并发数（1..=10）。
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
}

fn default_concurrency() -> usize {
    1
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayResponse {
    pub status: u16,
    pub status_text: String,
    pub duration_ms: f64,
    pub headers: Vec<(String, String)>,
    pub media_type: Option<String>,
    pub body: String,
    pub bytes: usize,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayBatchItem {
    pub index: usize,
    pub ok: bool,
    pub duration_ms: f64,
    pub error: Option<String>,
    pub response: Option<ReplayResponse>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayBatchReport {
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub total_duration_ms: f64,
    pub min_ms: f64,
    pub avg_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
    pub status_counts: Vec<(String, usize)>,
    pub items: Vec<ReplayBatchItem>,
}

/// 校验并构造安全的重放请求目标（仅允许 http / https，过滤易冲突的逐跳头）。
fn validate_replay(req: &ReplayRequest) -> Result<(reqwest::Method, url::Url, HeaderMap)> {
    let parsed_url = url::Url::parse(req.url.trim()).map_err(|_| "replayInvalidUrl".to_string())?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err("replayInvalidUrl".into());
    }
    let method = reqwest::Method::from_bytes(req.method.trim().to_ascii_uppercase().as_bytes())
        .map_err(|_| "replayInvalidMethod".to_string())?;
    let mut header_map = HeaderMap::new();
    for (name, value) in &req.headers {
        let key = name.trim();
        if key.is_empty() {
            continue;
        }
        // 忽略 HTTP/2 伪头和容易导致重发失败的传输层头
        let lower = key.to_ascii_lowercase();
        if key.starts_with(':')
            || matches!(
                lower.as_str(),
                "host" | "content-length" | "connection" | "transfer-encoding" | "accept-encoding"
            )
        {
            continue;
        }
        let header_name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| "replayInvalidHeader".to_string())?;
        let header_value =
            HeaderValue::from_str(value).map_err(|_| "replayInvalidHeader".to_string())?;
        header_map.append(header_name, header_value);
    }
    Ok((method, parsed_url, header_map))
}

/// 内部单次执行辅助，支持复用 `reqwest::Client` 与自定义响应体上限。
async fn send_once(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: url::Url,
    headers: HeaderMap,
    body: Option<String>,
    max_response_bytes: usize,
) -> Result<ReplayResponse> {
    let started = Instant::now();
    let mut builder = client.request(method, url).headers(headers);
    if let Some(body) = body
        && !body.is_empty()
    {
        builder = builder.body(body);
    }
    let mut resp = builder
        .send()
        .await
        .map_err(|e| format!("replayFailed: {e}"))?;

    let status = resp.status();
    let media_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let resp_headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                k.as_str().to_string(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        })
        .collect();

    let mut raw_bytes = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("replayFailed: {e}"))?
    {
        let remaining = max_response_bytes.saturating_sub(raw_bytes.len());
        if chunk.len() > remaining {
            raw_bytes.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        raw_bytes.extend_from_slice(&chunk);
    }

    let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
    let bytes = raw_bytes.len();
    let body = String::from_utf8_lossy(&raw_bytes).into_owned();

    Ok(ReplayResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        duration_ms,
        headers: resp_headers,
        media_type,
        body,
        bytes,
        truncated,
    })
}

fn build_client(accept_invalid_certs: bool) -> Result<reqwest::Client> {
    let mut client_builder = reqwest::Client::builder()
        .timeout(REPLAY_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5));
    if accept_invalid_certs {
        client_builder = client_builder.danger_accept_invalid_certs(true);
    }
    client_builder
        .build()
        .map_err(|e| format!("replayFailed: {e}"))
}

/// 发送一次 HTTP 重放请求并采集完整响应摘要与正文。
pub async fn send(req: ReplayRequest) -> Result<ReplayResponse> {
    let (method, url, headers) = validate_replay(&req)?;
    let client = build_client(req.accept_invalid_certs)?;
    send_once(
        &client,
        method,
        url,
        headers,
        req.body,
        MAX_REPLAY_RESPONSE_BYTES,
    )
    .await
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

/// 批量重复重放同一请求（Repeat Advanced），支持可控并发、状态码分布及 P50/P95 耗时汇总。
pub async fn send_batch(batch: ReplayBatchRequest) -> Result<ReplayBatchReport> {
    let count = batch.count.clamp(1, MAX_BATCH_COUNT);
    let concurrency = batch.concurrency.clamp(1, MAX_BATCH_CONCURRENCY);
    let (method, url, headers) = validate_replay(&batch.request)?;
    let client = build_client(batch.request.accept_invalid_certs)?;
    let permits = Arc::new(Semaphore::new(concurrency));
    let body = batch.request.body;

    let started = Instant::now();
    let mut tasks = JoinSet::new();
    for index in 1..=count {
        let permit_pool = Arc::clone(&permits);
        let client = client.clone();
        let method = method.clone();
        let url = url.clone();
        let headers = headers.clone();
        let body = body.clone();
        tasks.spawn(async move {
            let _permit = permit_pool.acquire_owned().await;
            let one_start = Instant::now();
            match send_once(
                &client,
                method,
                url,
                headers,
                body,
                MAX_BATCH_ITEM_RESPONSE_BYTES,
            )
            .await
            {
                Ok(response) => ReplayBatchItem {
                    index,
                    ok: response.status < 400,
                    duration_ms: response.duration_ms,
                    error: None,
                    response: Some(response),
                },
                Err(error) => ReplayBatchItem {
                    index,
                    ok: false,
                    duration_ms: one_start.elapsed().as_secs_f64() * 1000.0,
                    error: Some(error),
                    response: None,
                },
            }
        });
    }

    let mut items = Vec::with_capacity(count);
    while let Some(joined) = tasks.join_next().await {
        if let Ok(item) = joined {
            items.push(item);
        }
    }
    items.sort_by_key(|item| item.index);
    let total_duration_ms = started.elapsed().as_secs_f64() * 1000.0;

    let mut succeeded = 0usize;
    let mut failed = 0usize;
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut durations: Vec<f64> = Vec::with_capacity(items.len());
    for item in &items {
        durations.push(item.duration_ms);
        if item.ok {
            succeeded += 1;
        } else {
            failed += 1;
        }
        let bucket = item
            .response
            .as_ref()
            .map_or_else(|| "ERR".to_string(), |r| r.status.to_string());
        *counts.entry(bucket).or_insert(0) += 1;
    }
    durations.sort_by(|a, b| a.total_cmp(b));
    let min_ms = durations.first().copied().unwrap_or(0.0);
    let max_ms = durations.last().copied().unwrap_or(0.0);
    let avg_ms = if durations.is_empty() {
        0.0
    } else {
        durations.iter().sum::<f64>() / durations.len() as f64
    };
    let p50_ms = percentile(&durations, 0.50);
    let p95_ms = percentile(&durations, 0.95);

    Ok(ReplayBatchReport {
        total: items.len(),
        succeeded,
        failed,
        total_duration_ms,
        min_ms,
        avg_ms,
        p50_ms,
        p95_ms,
        max_ms,
        status_counts: counts.into_iter().collect(),
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_scheme_method_and_filters_hop_by_hop_headers() {
        let bad = ReplayRequest {
            method: "GET".into(),
            url: "file:///etc/passwd".into(),
            headers: vec![],
            body: None,
            accept_invalid_certs: false,
        };
        assert!(validate_replay(&bad).is_err());

        let good = ReplayRequest {
            method: "post".into(),
            url: "https://api.example.test/v1/items?a=1".into(),
            headers: vec![
                ("Host".into(), "evil.test".into()),
                ("Content-Length".into(), "999".into()),
                (":authority".into(), "api.example.test".into()),
                ("X-Token".into(), "abc".into()),
            ],
            body: Some("{\"ok\":true}".into()),
            accept_invalid_certs: false,
        };
        let (method, url, headers) = validate_replay(&good).unwrap();
        assert_eq!(method, reqwest::Method::POST);
        assert_eq!(url.host_str(), Some("api.example.test"));
        assert!(!headers.contains_key("host"));
        assert!(!headers.contains_key("content-length"));
        assert_eq!(headers.get("x-token").unwrap(), "abc");

        // 反序列化时默认不忽略证书校验，显式传入时按配置生效
        let default_req: ReplayRequest =
            serde_json::from_str(r#"{"method":"POST","url":"https://api.example.test"}"#).unwrap();
        assert!(!default_req.accept_invalid_certs);
        let insecure_req: ReplayRequest = serde_json::from_str(
            r#"{"method":"POST","url":"https://api.example.test","acceptInvalidCerts":true}"#,
        )
        .unwrap();
        assert!(insecure_req.accept_invalid_certs);
    }

    #[tokio::test]
    async fn executes_concurrent_batch_replay_against_local_loopback_server() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let (mut socket, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let _ = socket.read(&mut buf).await;
                    let body = r#"{"ok":true}"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                });
            }
        });

        let report = send_batch(ReplayBatchRequest {
            request: ReplayRequest {
                method: "POST".into(),
                url: format!("http://{addr}/v1/order"),
                headers: vec![("Content-Type".into(), "application/json".into())],
                body: Some(r#"{"item":1}"#.into()),
                accept_invalid_certs: false,
            },
            count: 4,
            concurrency: 2,
        })
        .await
        .unwrap();

        server.await.unwrap();
        assert_eq!(report.total, 4);
        assert_eq!(report.succeeded, 4);
        assert_eq!(report.failed, 0);
        assert_eq!(report.status_counts, vec![("200".into(), 4)]);
        assert_eq!(
            report.items.iter().map(|i| i.index).collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
        assert!(report.p95_ms >= report.min_ms);
    }
}
