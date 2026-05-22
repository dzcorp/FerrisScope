//! Reading images off the system clipboard for chat attachments.
//!
//! WebKitGTK (the Linux webview) doesn't expose a pasted image as a `File`
//! on the DOM `paste` event's `clipboardData.items`, so the frontend's
//! standard paste path comes up empty for images even when the clipboard
//! clearly holds one. This command bridges to the *native* clipboard via the
//! clipboard-manager plugin (arboard) — the same path the app already uses
//! for text copy/paste on webkit2gtk — and hands back the image as a
//! base64-encoded PNG, ready to attach as an `ImageAttachment`.

use base64::Engine;
use serde::Serialize;
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ClipboardImageWire {
    /// Always `"image/png"` — we re-encode the clipboard's raw RGBA bitmap.
    pub mime: String,
    /// Base64 PNG bytes, no data-URL prefix (matches `ImageAttachment`).
    pub data: String,
}

/// Encode a raw RGBA8 bitmap as PNG bytes. Pure + total: validates the buffer
/// length against the dimensions so a malformed clipboard payload surfaces as
/// an error rather than a panic inside the encoder.
fn encode_rgba_to_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 {
        return Err("empty clipboard image".into());
    }
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(4))
        .ok_or("image dimensions overflow")?;
    if rgba.len() != expected {
        return Err(format!(
            "rgba buffer is {} bytes, expected {expected} for {width}x{height}",
            rgba.len()
        ));
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Read an image from the system clipboard, re-encode it as PNG, and return
/// it base64-encoded. `Ok(None)` when the clipboard holds no image (the
/// common case — text, files, or empty) so the frontend can no-op quietly.
#[tauri::command]
pub(crate) async fn read_clipboard_image(
    app: tauri::AppHandle,
) -> Result<Option<ClipboardImageWire>, String> {
    // arboard's clipboard read is blocking and, per the plugin's own warning,
    // must not run on the main thread — `spawn_blocking` keeps it off both the
    // UI thread and the async runtime's reactor.
    let png = tokio::task::spawn_blocking(move || {
        // `read_image` errors when there's no image on the clipboard; treat
        // that as "nothing to attach" rather than a hard failure.
        let Ok(image) = app.clipboard().read_image() else {
            return Ok::<Option<Vec<u8>>, String>(None);
        };
        let png = encode_rgba_to_png(image.rgba(), image.width(), image.height())?;
        Ok(Some(png))
    })
    .await
    .map_err(|e| format!("clipboard task join error: {e}"))??;

    Ok(png.map(|bytes| ClipboardImageWire {
        mime: "image/png".to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_rgba_to_png_roundtrips_dimensions_and_pixels() {
        // 2x1 RGBA: opaque red, opaque green.
        let rgba = vec![255, 0, 0, 255, 0, 255, 0, 255];
        let bytes = encode_rgba_to_png(&rgba, 2, 1).expect("encode");
        // PNG magic header.
        assert_eq!(
            &bytes[..8],
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
        );
        // Decodes back to the same dimensions + pixels.
        let decoder = png::Decoder::new(std::io::Cursor::new(&bytes));
        let mut reader = decoder.read_info().expect("read_info");
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).expect("frame");
        assert_eq!((info.width, info.height), (2, 1));
        assert_eq!(&buf[..info.buffer_size()], &rgba[..]);
    }

    #[test]
    fn encode_rgba_to_png_rejects_size_mismatch() {
        // Claims 4x4 (256 bytes) but only 8 provided.
        let err = encode_rgba_to_png(&[0; 8], 4, 4).unwrap_err();
        assert!(err.contains("expected"), "unexpected error: {err}");
    }

    #[test]
    fn encode_rgba_to_png_rejects_empty_dims() {
        assert!(encode_rgba_to_png(&[], 0, 0).is_err());
    }
}
