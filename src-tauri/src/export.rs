use crate::{archive::Bundle, protocol::session::Result, session::Session};
use base64::{Engine, prelude::BASE64_STANDARD};
use serde_json::{Value, json};
use std::{
    io::{BufWriter, Write},
    path::Path,
};

pub fn atomic(
    path: &Path,
    action: impl FnOnce(&mut BufWriter<&mut std::fs::File>) -> Result<()>,
) -> Result<()> {
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("invalidPath")?)
        .map_err(|e| e.to_string())?;
    {
        let mut writer = BufWriter::new(temp.as_file_mut());
        action(&mut writer)?;
        writer.flush().map_err(|e| e.to_string())?;
    }
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}
fn headers(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|pair| Some(json!({"name":pair[0].as_str()?,"value":pair[1].as_str()?})))
        .collect()
}
fn mime(body: &Value) -> &str {
    body["type"].as_str().unwrap_or("application/octet-stream")
}
fn content(body: &Value) -> Value {
    let captured = match body["kind"].as_str() {
        Some("text") => body["text"].as_str().map(|s| s.len()),
        Some("bytes") => body["bytes"]
            .as_str()
            .and_then(|s| BASE64_STANDARD.decode(s).ok())
            .map(|b| b.len()),
        _ => None,
    };
    let mut result = json!({"size":body["size"].as_u64().or(captured.map(|n|n as u64)).unwrap_or(0),"_peekUnknownSize":body["size"].is_null() && captured.is_none(), "mimeType":mime(body), "_peekBody":body});
    match body["kind"].as_str() {
        Some("text") => {
            result["text"] = body["text"].clone();
        }
        Some("bytes") => {
            result["text"] = body["bytes"].clone();
            result["encoding"] = "base64".into();
        }
        _ => {}
    }
    result["_peekTruncated"] = json!(
        body["truncated"] == true
            || captured.is_some_and(|n| body["size"].as_u64().is_some_and(|size| size > n as u64))
    );
    result
}
fn entry(raw: &str) -> Result<Value> {
    let e: Value = serde_json::from_str(raw).map_err(|_| "invalidEntry")?;
    let request = &e["request"];
    let response = &e["response"];
    let url = url::Url::parse(request["url"].as_str().ok_or("invalidEntry")?)
        .map_err(|_| "invalidEntry")?;
    let body = &request["body"];
    let body_content = content(body);
    let mut req = json!({"method":request["method"],"url":request["url"],"httpVersion":request["version"].as_str().unwrap_or(""),"headers":headers(&request["headers"]),"queryString":url.query_pairs().map(|(name,value)|json!({"name":name,"value":value})).collect::<Vec<_>>(),"cookies":[],"headersSize":-1,"bodySize":body_content["size"],"_peekBody":body});
    match body["kind"].as_str() {
        Some("text") => req["postData"] = json!({"mimeType":mime(body),"text":body["text"]}),
        Some("form") => {
            req["postData"] = json!({"mimeType":mime(body),"params":body["fields"].as_array().into_iter().flatten().map(|pair|json!({"name":pair[0],"value":pair[1]})).collect::<Vec<_>>(),"_peekFiles":body["files"]})
        }
        _ => {}
    }
    let mut timings = serde_json::Map::new();
    for key in [
        "blocked", "dns", "connect", "ssl", "send", "wait", "receive",
    ] {
        timings.insert(
            key.into(),
            e["timings"][key]
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .map(|n| json!(n))
                .unwrap_or_else(|| {
                    if matches!(key, "send" | "wait" | "receive") {
                        json!(0)
                    } else {
                        json!(-1)
                    }
                }),
        );
    }
    let unknown: Vec<_> = [
        "blocked", "dns", "connect", "ssl", "send", "wait", "receive",
    ]
    .into_iter()
    .filter(|key| {
        e["timings"][*key]
            .as_f64()
            .is_none_or(|n| !n.is_finite() || n < 0.0)
    })
    .collect();
    let measured: f64 = ["blocked", "dns", "connect", "send", "wait", "receive"]
        .iter()
        .filter_map(|k| timings[*k].as_f64())
        .filter(|n| *n >= 0.0)
        .sum();
    let duration = crate::session::StoredEntry::parse(raw)?.row.duration_ms;
    let time = measured;
    let redirect = response["headers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| {
            p[0].as_str()
                .is_some_and(|name| name.eq_ignore_ascii_case("location"))
        })
        .and_then(|p| p[1].as_str())
        .unwrap_or("");
    Ok(
        json!({"startedDateTime":e["startedAt"],"time":time,"request":req,
        "response":{"status":response["status"].as_i64().unwrap_or(0),"statusText":response["message"].as_str().unwrap_or(""),"httpVersion":response["version"].as_str().unwrap_or(""),"headers":headers(&response["headers"]),"cookies":[],"content":content(&response["body"]),"redirectURL":redirect,"headersSize":-1,"bodySize":-1},
        "cache":{},"timings":timings,"_peek":{"id":e["id"],"source":e["source"],"failure":e["failure"],"timings":e["timings"],"unknownTimingFields":unknown,"durationMs":duration,"note":"Retained capture; missing and truncated bodies are described in _peekBody. Unknown protocol/timings are not inferred."}}),
    )
}
pub fn har(path: &Path, session: &Session) -> Result<()> {
    atomic(path, |writer| {
        writer.write_all(br#"{"log":{"version":"1.2","creator":{"name":"Peek Desktop","version":"0.1.0"},"entries":["#).map_err(|e|e.to_string())?;
        for (index, stored) in session.entries.iter().enumerate() {
            if index > 0 {
                writer.write_all(b",").map_err(|e| e.to_string())?;
            }
            serde_json::to_writer(&mut *writer, &entry(&stored.raw)?).map_err(|e| e.to_string())?;
        }
        writer.write_all(b"]}}\n").map_err(|e| e.to_string())?;
        Ok(())
    })
}
pub fn diagnostics(path: &Path, bundle: &Bundle, text: bool) -> Result<()> {
    atomic(path, |writer| {
        for run in &bundle.runs {
            for raw in &run.records {
                if text {
                    let event = crate::protocol::diagnostics::DiagnosticEvent::parse(raw)?;
                    writeln!(
                        writer,
                        "{} [{}] {} {}",
                        event.occurred_at, event.level, event.source, event.message
                    )
                    .map_err(|e| e.to_string())?;
                    if let Some(exception) = event.exception {
                        writeln!(writer, "{}", exception.stack_trace).map_err(|e| e.to_string())?;
                    }
                } else {
                    writeln!(writer, "{raw}").map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    })
}
fn quote(text: &str) -> Result<String> {
    if text.contains('\0') {
        return Err("curlUnsupported".into());
    }
    Ok(format!("'{}'", text.replace('\'', "'\"'\"'")))
}
pub fn curl(raw: &str) -> Result<String> {
    let entry: Value = serde_json::from_str(raw).map_err(|_| "invalidEntry")?;
    let request = &entry["request"];
    let url = request["url"].as_str().ok_or("invalidEntry")?;
    let parsed = url::Url::parse(url).map_err(|_| "curlUnsupported")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("curlUnsupported".into());
    }
    let mut args = vec![
        "curl".to_string(),
        "--globoff".into(),
        "--request".into(),
        quote(request["method"].as_str().ok_or("invalidEntry")?)?,
        "--url".into(),
        quote(url)?,
    ];
    for pair in request["headers"].as_array().into_iter().flatten() {
        let name = pair[0].as_str().ok_or("invalidEntry")?;
        let value = pair[1].as_str().ok_or("invalidEntry")?;
        if name.contains(['\r', '\n']) || value.contains(['\r', '\n']) {
            return Err("curlUnsupported".into());
        }
        args.extend(["--header".into(), quote(&format!("{name}: {value}"))?]);
    }
    let body = &request["body"];
    match body["kind"].as_str() {
        None | Some("empty") => {}
        Some("text") => {
            let text = body["text"].as_str().ok_or("curlUnsupported")?;
            if body["truncated"] == true
                || body["size"].as_u64().is_some_and(|n| n > text.len() as u64)
            {
                return Err("curlUnsupported".into());
            }
            args.extend(["--data-raw".into(), quote(text)?]);
        }
        Some("form")
            if body["files"]
                .as_array()
                .is_none_or(|files| files.is_empty())
                && mime(body) == "application/x-www-form-urlencoded" =>
        {
            let mut encoded = url::form_urlencoded::Serializer::new(String::new());
            for field in body["fields"].as_array().into_iter().flatten() {
                encoded.append_pair(
                    field[0].as_str().ok_or("curlUnsupported")?,
                    field[1].as_str().ok_or("curlUnsupported")?,
                );
            }
            args.extend(["--data-raw".into(), quote(&encoded.finish())?]);
        }
        _ => return Err("curlUnsupported".into()),
    }
    let text = args.join(" ");
    if text.len() > 1024 * 1024 {
        return Err("selectionTooLarge".into());
    }
    Ok(text)
}
