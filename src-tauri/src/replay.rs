//! 桌面端请求重放模块：允许开发者在桌面端修改参数后直接重发抓包请求并查看最新响应。

use crate::protocol::session::Result;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// 响应体最大读取字节数（4 MiB），防止异常大响应耗尽内存。
const MAX_REPLAY_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// 请求超时上限（15 秒）。
const REPLAY_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
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

/// 发送一次 HTTP 重放请求并采集完整响应摘要与正文。
pub async fn send(req: ReplayRequest) -> Result<ReplayResponse> {
    let (method, url, headers) = validate_replay(&req)?;
    let client = reqwest::Client::builder()
        .timeout(REPLAY_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("replayFailed: {e}"))?;

    let started = Instant::now();
    let mut builder = client.request(method, url).headers(headers);
    if let Some(body) = req.body
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
        let remaining = MAX_REPLAY_RESPONSE_BYTES.saturating_sub(raw_bytes.len());
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
        };
        let (method, url, headers) = validate_replay(&good).unwrap();
        assert_eq!(method, reqwest::Method::POST);
        assert_eq!(url.host_str(), Some("api.example.test"));
        assert!(!headers.contains_key("host"));
        assert!(!headers.contains_key("content-length"));
        assert_eq!(headers.get("x-token").unwrap(), "abc");
    }
}
