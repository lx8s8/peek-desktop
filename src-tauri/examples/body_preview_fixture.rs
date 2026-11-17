//! Generate an offline session for checking body views in the native WebView.
use base64::{Engine, prelude::BASE64_STANDARD};
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::{Value, json};
use std::{
    fs::OpenOptions,
    io::{BufWriter, Cursor, Write},
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: body_preview_fixture <new-file.peek>")?;
    let file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let mut output = BufWriter::new(file);
    writeln!(
        output,
        "{}",
        json!({"format":"peek", "formatVersion":1, "peekVersion":"fixture", "platform":"test", "startedAt":"2026-11-17T00:00:00.000Z"})
    )?;
    let mut bodies = vec![(
        "json",
        json!({"kind":"text", "type":"application/json", "text":r#"{"id":900719925474099312345,"amount":0.12345678901234567890,"users":[{"name":"测试用户","state":"ready"},{"name":"Second user","state":"READY"}],"markup":"<img src=x onerror=alert(1)>"}"#}),
    )];
    let pixels = RgbImage::from_fn(256, 160, |x, y| {
        Rgb([x as u8, y as u8, ((x + y) / 2) as u8])
    });
    for (name, format, mime) in [
        ("png", ImageFormat::Png, "image/png"),
        ("jpeg", ImageFormat::Jpeg, "image/jpeg"),
        ("gif", ImageFormat::Gif, "image/gif"),
        ("webp", ImageFormat::WebP, "image/webp"),
    ] {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(pixels.clone()).write_to(&mut bytes, format)?;
        bodies.push((name, json!({"kind":"bytes", "type":mime, "bytes":BASE64_STANDARD.encode(bytes.into_inner())})));
    }
    let mut incomplete = bodies[1].1.clone();
    incomplete["truncated"] = Value::Bool(true);
    bodies.push(("truncated", incomplete));
    bodies.push(("invalid", json!({"kind":"bytes", "type":"image/png", "bytes":BASE64_STANDARD.encode(b"not an image")})));
    bodies.push(("svg", json!({"kind":"text", "type":"image/svg+xml", "text":"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'><text>Inert SVG data</text></svg>"})));
    for (index, (name, body)) in bodies.into_iter().enumerate() {
        writeln!(
            output,
            "{}",
            json!({"id":format!("preview-{name}"), "source":"body-preview-fixture", "startedAt":format!("2026-11-17T00:00:{index:02}.000Z"), "completedAt":format!("2026-11-17T00:00:{index:02}.100Z"), "request":{"method":"GET", "url":format!("https://example.test/preview/{name}")}, "response":{"status":200, "headers":[["Content-Type",body["type"]]], "body":body}})
        )?;
    }
    output.flush()?;
    Ok(())
}
