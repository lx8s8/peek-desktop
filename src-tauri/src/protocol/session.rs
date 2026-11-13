use base64::{Engine, prelude::BASE64_STANDARD};
use chrono::DateTime;
use serde::Serialize;
use serde_json::Value;

pub type Result<T> = std::result::Result<T, String>;

pub fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or_else(|| format!("invalid {key}"))
}

fn timestamp(value: &Value, key: &str) -> Result<i64> {
    let text = required_string(value, key)?;
    if !text.ends_with('Z') {
        return Err(format!("{key} must be UTC"));
    }
    DateTime::parse_from_rfc3339(text)
        .map(|time| time.timestamp_micros())
        .map_err(|_| format!("invalid {key}"))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub format_version: u64,
    pub peek_version: String,
    pub name: Option<String>,
    pub platform: String,
    pub started_at: String,
}

impl Header {
    pub fn parse(value: &Value) -> Result<Self> {
        if value["format"] != "peek" {
            return Err("not a Peek session".into());
        }
        let version = value["formatVersion"]
            .as_u64()
            .filter(|n| *n >= 1)
            .ok_or("unsupported formatVersion")?;
        Self::parse_session(value, version)
    }

    pub fn parse_session(value: &Value, format_version: u64) -> Result<Self> {
        timestamp(value, "startedAt")?;
        Ok(Self {
            format_version,
            peek_version: required_string(value, "peekVersion")?.into(),
            name: value["name"].as_str().map(Into::into),
            platform: required_string(value, "platform")?.into(),
            started_at: required_string(value, "startedAt")?.into(),
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryRow {
    pub id: String,
    pub source: String,
    pub method: String,
    pub url: String,
    pub started_at: String,
    pub duration_ms: Option<f64>,
    pub status: Option<i64>,
    pub state: &'static str,
    pub pinned: bool,
    pub response_bytes: Option<u64>,
}

/// Validate known fields, but retain the original line separately for lossless export.
pub fn parse_entry(value: &Value) -> Result<EntryRow> {
    let id = required_string(value, "id")?;
    if id.is_empty() {
        return Err("empty id".into());
    }
    let started = timestamp(value, "startedAt")?;
    let request = &value["request"];
    let method = required_string(request, "method")?;
    let url = required_string(request, "url")?;
    url::Url::parse(url).map_err(|_| "invalid url")?;
    validate_headers(&request["headers"])?;
    validate_body(&request["body"])?;
    if !request["extra"].is_null() && !request["extra"].is_object() {
        return Err("invalid extra".into());
    }
    let response = &value["response"];
    let failure = &value["failure"];
    let finished = !response.is_null() || !failure.is_null();
    if finished == value["completedAt"].is_null() {
        return Err("completedAt must match response/failure".into());
    }
    let duration_ms = if finished {
        Some((timestamp(value, "completedAt")? - started).max(0) as f64 / 1000.0)
    } else {
        None
    };
    let status = if !response.is_null() {
        validate_headers(&response["headers"])?;
        validate_body(&response["body"])?;
        if !response["redirects"].is_null() {
            for redirect in response["redirects"]
                .as_array()
                .ok_or("invalid redirects")?
            {
                redirect["status"]
                    .as_i64()
                    .ok_or("invalid redirect status")?;
                required_string(redirect, "method")?;
                required_string(redirect, "location")?;
            }
        }
        Some(response["status"].as_i64().ok_or("invalid status")?)
    } else {
        None
    };
    if !failure.is_null() {
        required_string(failure, "kind")?;
        required_string(failure, "message")?;
    }
    if !value["timings"].is_null() {
        let timings = value["timings"].as_object().ok_or("invalid timings")?;
        for key in [
            "blocked", "dns", "connect", "ssl", "send", "wait", "receive",
        ] {
            if let Some(n) = timings.get(key).filter(|n| !n.is_null()) {
                n.as_f64()
                    .filter(|n| n.is_finite())
                    .ok_or("invalid timing")?;
            }
        }
    }
    Ok(EntryRow {
        id: id.into(),
        source: required_string(value, "source")?.into(),
        method: method.into(),
        url: url.into(),
        started_at: required_string(value, "startedAt")?.into(),
        duration_ms,
        status,
        state: if !failure.is_null() {
            "failed"
        } else if finished {
            "completed"
        } else {
            "pending"
        },
        pinned: value["pinned"].as_bool().unwrap_or(false),
        response_bytes: body_size(&response["body"]),
    })
}

pub fn validate_headers(value: &Value) -> Result<()> {
    if value.is_null() {
        return Ok(());
    }
    for pair in value.as_array().ok_or("invalid headers")? {
        let pair = pair.as_array().ok_or("invalid header pair")?;
        if pair.len() != 2 || pair.iter().any(|item| !item.is_string()) {
            return Err("invalid header pair".into());
        }
    }
    Ok(())
}

pub fn validate_body(body: &Value) -> Result<()> {
    if body.is_null() {
        return Ok(());
    }
    match required_string(body, "kind")? {
        "text" => {
            required_string(body, "text")?;
        }
        "bytes" => {
            BASE64_STANDARD
                .decode(required_string(body, "bytes")?)
                .map_err(|_| "invalid base64")?;
        }
        "form" => {
            validate_headers(&body["fields"])?;
            if !body["files"].is_null() {
                for file in body["files"].as_array().ok_or("invalid files")? {
                    required_string(file, "name")?;
                }
            }
        }
        "unavailable" => {
            required_string(body, "reason")?;
        }
        "remote" => {
            body["size"].as_u64().ok_or("invalid remote size")?;
        }
        _ => {} // Unknown kinds have the unavailable/notCaptured fallback in the viewer.
    }
    Ok(())
}

pub fn body_size(body: &Value) -> Option<u64> {
    body["size"]
        .as_u64()
        .or_else(|| match body["kind"].as_str()? {
            "text" => Some(body["text"].as_str()?.len() as u64),
            "bytes" => Some(BASE64_STANDARD.decode(body["bytes"].as_str()?).ok()?.len() as u64),
            "empty" => Some(0),
            _ => None,
        })
}
