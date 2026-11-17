mod image;

use crate::protocol::session::{Result, body_size};
use base64::{Engine, prelude::BASE64_STANDARD};
use serde::Serialize;
use serde_json::Value;

const MAX_PREVIEW: usize = 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyView {
    pub kind: String,
    pub media_type: Option<String>,
    pub size: Option<u64>,
    pub captured_bytes: usize,
    pub truncated: bool,
    pub preview_truncated: bool,
    pub text: String,
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<image::ImagePreview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_unavailable: Option<&'static str>,
}

pub fn view(body: &Value) -> Result<BodyView> {
    let original_kind = body["kind"].as_str().unwrap_or("empty");
    let kind = match original_kind {
        "text" | "bytes" | "form" | "empty" | "remote" | "unavailable" => original_kind,
        _ => "unavailable",
    };
    let mut view = BodyView {
        kind: kind.into(),
        media_type: body["type"].as_str().map(Into::into),
        size: body_size(body),
        captured_bytes: 0,
        truncated: body["truncated"].as_bool().unwrap_or(false),
        preview_truncated: false,
        text: String::new(),
        reason: None,
        image: None,
        image_unavailable: None,
    };
    match kind {
        "text" => {
            let text = body["text"].as_str().ok_or("invalidBody")?;
            view.captured_bytes = text.len();
            let mut end = text.len().min(MAX_PREVIEW);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            view.text = text[..end].into();
            view.preview_truncated = end < text.len();
        }
        "bytes" => {
            let bytes = BASE64_STANDARD
                .decode(body["bytes"].as_str().ok_or("invalidBody")?)
                .map_err(|_| "invalidBody")?;
            view.captured_bytes = bytes.len();
            let truncated =
                view.truncated || view.size.is_some_and(|size| size > bytes.len() as u64);
            (view.image, view.image_unavailable) =
                image::preview(&bytes, view.media_type.as_deref(), truncated);
            view.preview_truncated = bytes.len() > 4096;
            for (i, chunk) in bytes[..bytes.len().min(4096)].chunks(16).enumerate() {
                view.text.push_str(&format!("{:08x}  ", i * 16));
                for byte in chunk {
                    view.text.push_str(&format!("{byte:02x} "));
                }
                view.text.push('\n');
            }
        }
        "form" => {
            let text = serde_json::to_string_pretty(body).map_err(|e| e.to_string())?;
            view.captured_bytes = text.len();
            let mut end = text.len().min(MAX_PREVIEW);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            view.text = text[..end].into();
            view.preview_truncated = end < text.len();
        }
        "unavailable" => {
            view.reason = Some(
                body["reason"]
                    .as_str()
                    .filter(|reason| {
                        matches!(
                            *reason,
                            "streamed" | "tooLarge" | "notCaptured" | "unreadable"
                        )
                    })
                    .unwrap_or("notCaptured")
                    .into(),
            );
        }
        "remote" => view.reason = Some("remote".into()),
        _ => {}
    }
    view.truncated |= matches!(kind, "text" | "bytes")
        && view
            .size
            .is_some_and(|size| size > view.captured_bytes as u64);
    Ok(view)
}
