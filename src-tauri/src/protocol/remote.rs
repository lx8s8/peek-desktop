//! Protocol-v1 shape validation only. Authorization and transport belong to P1.
use super::session::{Header, Result, parse_entry, required_string, validate_body};
use serde_json::Value;

pub fn validate_frame(value: &Value) -> Result<Option<&str>> {
    let kind = required_string(value, "type")?;
    match kind {
        "hello" => {
            value["protocolVersion"]
                .as_u64()
                .ok_or("invalid protocolVersion")?;
            required_string(value, "sessionId")?;
            Header::parse_session(&value["session"], 1)?;
        }
        "welcome" => {
            value["protocolVersion"]
                .as_u64()
                .ok_or("invalid protocolVersion")?;
        }
        "denied" => {
            required_string(value, "reason")?;
            required_string(value, "message")?;
        }
        "entry" => match required_string(value, "op")? {
            "add" | "update" => {
                parse_entry(&value["entry"])?;
            }
            "remove" => {
                required_string(value, "id")?;
            }
            _ => return Err("invalid op".into()),
        },
        "synced" | "dropped" => {
            value["count"].as_u64().ok_or("invalid count")?;
        }
        "bodyRequest" => {
            required_string(value, "requestId")?;
            required_string(value, "id")?;
            if !matches!(value["side"].as_str(), Some("request" | "response")) {
                return Err("invalid side".into());
            }
        }
        "bodyResponse" => {
            required_string(value, "requestId")?;
            if value["body"].is_null() {
                required_string(value, "error")?;
            } else {
                validate_body(&value["body"])?;
            }
        }
        "cleared" | "ping" | "pong" => {}
        _ => return Ok(None),
    }
    Ok(Some(kind))
}
