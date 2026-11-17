use base64::{Engine, prelude::BASE64_STANDARD};
use image::{ImageFormat, ImageReader, Limits};
use serde::Serialize;
use std::io::Cursor;

const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_IMAGE_SIDE: u32 = 8192;
const MAX_IMAGE_PIXELS: u64 = 16_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreview {
    pub data_url: String,
    pub media_type: &'static str,
    pub width: u32,
    pub height: u32,
}

pub fn preview(
    bytes: &[u8],
    declared_type: Option<&str>,
    truncated: bool,
) -> (Option<ImagePreview>, Option<&'static str>) {
    let guessed = image::guess_format(bytes).ok();
    let (format, media_type) = match guessed {
        Some(ImageFormat::Png) => (ImageFormat::Png, "image/png"),
        Some(ImageFormat::Jpeg) => (ImageFormat::Jpeg, "image/jpeg"),
        Some(ImageFormat::Gif) => (ImageFormat::Gif, "image/gif"),
        Some(ImageFormat::WebP) => (ImageFormat::WebP, "image/webp"),
        _ => {
            return (
                None,
                if declared_type.is_some_and(|t| t.to_ascii_lowercase().starts_with("image/")) {
                    let declared = declared_type
                        .unwrap_or_default()
                        .split(';')
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .to_ascii_lowercase();
                    Some(
                        if guessed.is_some()
                            || !matches!(
                                declared.as_str(),
                                "image/png" | "image/jpeg" | "image/gif" | "image/webp"
                            )
                        {
                            "imageUnsupported"
                        } else {
                            "imageInvalid"
                        },
                    )
                } else {
                    None
                },
            );
        }
    };
    if truncated {
        return (None, Some("imageTruncated"));
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return (None, Some("imageTooLarge"));
    }
    // Inspect headers before sending any bytes to the WebView. Limits on encoded
    // size alone do not bound the decoded dimensions of compressed images.
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_SIDE);
    limits.max_image_height = Some(MAX_IMAGE_SIDE);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let (width, height) = match reader.into_dimensions() {
        Ok(dimensions) => dimensions,
        Err(image::ImageError::Limits(_)) => return (None, Some("imageTooLarge")),
        Err(_) => return (None, Some("imageInvalid")),
    };
    if width == 0 || height == 0 {
        return (None, Some("imageInvalid"));
    }
    if width > MAX_IMAGE_SIDE
        || height > MAX_IMAGE_SIDE
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
    {
        return (None, Some("imageTooLarge"));
    }
    (
        Some(ImagePreview {
            // Use the byte signature, never a caller-provided MIME type or URL.
            data_url: format!("data:{media_type};base64,{}", BASE64_STANDARD.encode(bytes)),
            media_type,
            width,
            height,
        }),
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body::view;
    use image::{DynamicImage, RgbImage};
    use serde_json::json;

    fn encoded(format: ImageFormat) -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(RgbImage::new(3, 2))
            .write_to(&mut output, format)
            .unwrap();
        output.into_inner()
    }
    #[test]
    fn common_raster_formats_use_captured_bytes_and_real_mime_type() {
        for (format, mime) in [
            (ImageFormat::Png, "image/png"),
            (ImageFormat::Jpeg, "image/jpeg"),
            (ImageFormat::Gif, "image/gif"),
            (ImageFormat::WebP, "image/webp"),
        ] {
            let bytes = encoded(format);
            let result = view(&json!({"kind":"bytes", "type":"application/octet-stream", "bytes":BASE64_STANDARD.encode(&bytes)})).unwrap();
            let image = result.image.unwrap();
            assert_eq!((image.width, image.height), (3, 2));
            assert_eq!(image.media_type, mime);
            assert_eq!(
                image.data_url,
                format!("data:{mime};base64,{}", BASE64_STANDARD.encode(bytes))
            );
            assert!(result.image_unavailable.is_none());
        }
    }
    #[test]
    fn truncated_oversized_or_invalid_images_keep_the_hex_fallback() {
        let png = encoded(ImageFormat::Png);
        let result = view(&json!({"kind":"bytes", "type":"image/png", "bytes":BASE64_STANDARD.encode(&png), "size":png.len()+1})).unwrap();
        assert_eq!(result.image_unavailable, Some("imageTruncated"));
        assert!(result.image.is_none());
        assert!(!result.text.is_empty());
        let mut too_large = png.clone();
        too_large.resize(MAX_IMAGE_BYTES + 1, 0);
        assert_eq!(preview(&too_large, None, false).1, Some("imageTooLarge"));
        assert_eq!(
            preview(b"\x89PNG\r\n\x1a\n", None, false).1,
            Some("imageInvalid")
        );
        assert!(
            preview(b"<svg onload='alert(1)'/>", Some("image/svg+xml"), false)
                .0
                .is_none()
        );
        assert!(
            preview(b"<html>not an image</html>", Some("image/png"), false)
                .0
                .is_none()
        );
        assert!(preview(b"plain bytes", None, false).1.is_none());
    }
    #[test]
    fn enormous_dimensions_are_rejected_before_webview_decoding() {
        // A small compressed PNG can still declare an excessive decoded size.
        let image = DynamicImage::ImageRgb8(RgbImage::new(MAX_IMAGE_SIDE + 1, 1));
        let mut output = Cursor::new(Vec::new());
        image.write_to(&mut output, ImageFormat::Png).unwrap();
        assert_eq!(
            preview(output.get_ref(), None, false).1,
            Some("imageTooLarge")
        );
        let mut gif = encoded(ImageFormat::Gif);
        gif[6..8].copy_from_slice(&5000_u16.to_le_bytes());
        gif[8..10].copy_from_slice(&4000_u16.to_le_bytes());
        assert_eq!(preview(&gif, None, false).1, Some("imageTooLarge"));
    }
}
