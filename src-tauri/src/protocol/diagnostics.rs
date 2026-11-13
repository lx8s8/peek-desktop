//! Initial diagnostics-v1 event contract, isolated from the standard Peek codec.
use super::session::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEvent {
    pub event_id: String,
    pub run_id: String,
    pub emitter_id: String,
    pub sequence: String,
    pub occurred_at: String,
    pub monotonic_micros: Option<String>,
    pub kind: String,
    pub level: String,
    pub source: String,
    pub tag: Option<String>,
    pub message: String,
    pub attributes: Option<Value>,
    pub exception: Option<Exception>,
    pub related_network_entry_id: Option<String>,
    pub trace_id: Option<String>,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub truncated_fields: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exception {
    pub r#type: Option<String>,
    pub message: Option<String>,
    pub stack_trace: String,
    pub stack_format: Option<String>,
}

pub fn validate_decimal(text: &str) -> Result<()> {
    if text.is_empty()
        || !text.bytes().all(|c| c.is_ascii_digit())
        || (text.len() > 1 && text.starts_with('0'))
        || text.parse::<u64>().is_err()
    {
        return Err("expected canonical uint64 decimal string".into());
    }
    Ok(())
}

impl DiagnosticEvent {
    pub fn parse(text: &str) -> Result<Self> {
        if text.len() > 128 * 1024 {
            return Err("event exceeds 128 KiB".into());
        }
        let event: Self = serde_json::from_str(text).map_err(|e| e.to_string())?;
        if [
            &event.event_id,
            &event.run_id,
            &event.emitter_id,
            &event.source,
        ]
        .iter()
        .any(|s| s.is_empty())
        {
            return Err("empty event identity".into());
        }
        validate_decimal(&event.sequence)?;
        if let Some(micros) = &event.monotonic_micros {
            validate_decimal(micros)?;
        }
        if !event.occurred_at.ends_with('Z')
            || chrono::DateTime::parse_from_rfc3339(&event.occurred_at).is_err()
        {
            return Err("invalid occurredAt".into());
        }
        if !matches!(event.kind.as_str(), "log" | "exception")
            || !matches!(
                event.level.as_str(),
                "verbose" | "debug" | "info" | "warning" | "error" | "critical"
            )
        {
            return Err("invalid kind/level".into());
        }
        if event.kind == "exception" && event.exception.is_none() {
            return Err("missing exception".into());
        }
        if event.attributes.as_ref().is_some_and(|v| !v.is_object()) {
            return Err("invalid attributes".into());
        }
        Ok(event)
    }
}
