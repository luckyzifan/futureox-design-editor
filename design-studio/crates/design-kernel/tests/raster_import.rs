//! Synthetic GIF/TIFF fixtures are Pillow-generated pixels committed as base64
//! text. They are not user media. GIF frame 0 is red with one blue pixel at
//! (1, 1); frame 1 is solid blue. The single-page TIFF is 64×48 RGBA with a
//! translucent red corner. The oriented TIFF is 8×4 RGB, left red and right
//! green, with TIFF orientation 6.
use base64::Engine as _;
use futureox_design_kernel::{Engine, RenderOptions};
use image::AnimationDecoder;

fn fixture(name: &str) -> &'static str {
    match name {
        "png" => include_str!("fixtures/png.b64"),
        "jpg" => include_str!("fixtures/jpg.b64"),
        "webp" => include_str!("fixtures/webp.b64"),
        "gif" => include_str!("fixtures/gif.b64"),
        "tiff" => include_str!("fixtures/tiff.b64"),
        "ori" => include_str!("fixtures/ori.b64"),
        "multi" => include_str!("fixtures/multi.b64"),
        "corrupt-gif" => include_str!("fixtures/corrupt-gif.b64"),
        "abnormal-tiff" => include_str!("fixtures/abnormal-tiff.b64"),
        _ => panic!("unknown fixture {name}"),
    }
}

fn uri(mime: &str, name: &str) -> String {
    format!("data:{mime};base64,{}", fixture(name).trim())
}

fn decode(uri: &str) -> Result<std::sync::Arc<futureox_design_kernel::blend::Surface>, String> {
    Engine::new().image_data(uri)
}

fn rejected(uri: &str) -> String {
    decode(uri)
        .err()
        .unwrap_or_else(|| panic!("codec admitted {uri}"))
}

fn dominant(pixel: &[u8]) -> &'static str {
    let (r, g, b) = (
        u16::from(pixel[0]),
        u16::from(pixel[1]),
        u16::from(pixel[2]),
    );
    if r > b + 40 {
        "red"
    } else if b > r + 40 {
        "blue"
    } else if g > r + 40 && g > b + 40 {
        "green"
    } else {
        "other"
    }
}

#[test]
fn gif_first_frame_and_single_page_tiff_use_the_codec_without_transcoding() {
    let gif_uri = uri("image/gif", "gif");
    let gif = decode(&gif_uri).unwrap();
    assert_eq!((gif.rect.w, gif.rect.h), (64, 48));
    let gif_bytes = gif.rgba8(gif.rect);
    let raw = base64::engine::general_purpose::STANDARD
        .decode(fixture("gif").trim())
        .unwrap();
    let mut frames = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(raw))
        .unwrap()
        .into_frames();
    let first = frames.next().unwrap().unwrap().into_buffer();
    let second = frames.next().unwrap().unwrap().into_buffer();
    assert_eq!(first.dimensions(), (64, 48));
    assert_ne!(
        first.get_pixel(0, 0).0,
        second.get_pixel(0, 0).0,
        "frames must differ"
    );
    // The admitted surface is the codec's first frame, not a later frame and
    // not a flattened animation.
    assert_eq!(
        dominant(&gif_bytes[0..4]),
        dominant(&first.get_pixel(0, 0).0)
    );
    assert_ne!(
        dominant(&gif_bytes[0..4]),
        dominant(&second.get_pixel(0, 0).0)
    );
    assert!(gif_uri.starts_with("data:image/gif;base64,"));
    assert!(!gif_uri.contains("image/png"));

    let tiff_uri = uri("image/tiff", "tiff");
    let tiff = decode(&tiff_uri).unwrap();
    assert_eq!((tiff.rect.w, tiff.rect.h), (64, 48));
    let tiff_bytes = tiff.rgba8(tiff.rect);
    assert_eq!(dominant(&tiff_bytes[0..4]), "red");
    assert!(
        tiff_bytes[3] < 250 && tiff_bytes[3] > 40,
        "corner alpha {}",
        tiff_bytes[3]
    );
    let far = (64 * 48 - 1) * 4;
    assert_eq!(dominant(&tiff_bytes[far..far + 4]), "green");
    assert_eq!(tiff_bytes[far + 3], 255);

    for (name, mime) in [
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("webp", "image/webp"),
    ] {
        let image = decode(&uri(mime, name)).unwrap();
        assert_eq!((image.rect.w, image.rect.h), (64, 48), "{name}");
    }
}

#[test]
fn tiff_orientation_tag_uses_the_same_rotation_as_exif() {
    let raw = image::load_from_memory(
        &base64::engine::general_purpose::STANDARD
            .decode(fixture("ori").trim())
            .unwrap(),
    )
    .unwrap()
    .to_rgba8();
    assert_eq!(raw.dimensions(), (8, 4), "stored samples stay unrotated");
    let decoded = decode(&uri("image/tiff", "ori")).unwrap();
    assert_eq!((decoded.rect.w, decoded.rect.h), (4, 8));
    let mut expected = Vec::new();
    for y in 0..8 {
        for x in 0..4 {
            let (sx, sy) = (y, 3 - x);
            expected.extend(raw.get_pixel(sx, sy).0);
        }
    }
    assert_eq!(decoded.rgba8(decoded.rect), expected);
}

#[test]
fn corrupt_multipage_and_abnormal_samples_reject_before_a_surface_is_returned() {
    let multi = rejected(&uri("image/tiff", "multi"));
    assert!(multi.contains("Multi-page TIFF"), "{multi}");
    let corrupt = rejected(&uri("image/gif", "corrupt-gif"));
    assert!(!corrupt.is_empty(), "{corrupt}");
    let abnormal = rejected(&uri("image/tiff", "abnormal-tiff"));
    assert!(!abnormal.contains("Multi-page TIFF"), "{abnormal}");
    assert!(!abnormal.is_empty(), "{abnormal}");

    // A decodable 1×1 GIF with a logical screen wider than the 8192 guard.
    let mut wide = vec![
        b'G', b'I', b'F', b'8', b'9', b'a', 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02,
        0x02, 0x44, 0x01, 0x00, 0x3b,
    ];
    wide[6..8].copy_from_slice(&9000u16.to_le_bytes());
    let oversized = rejected(&format!(
        "data:image/gif;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&wide)
    ));
    assert!(
        oversized.contains("8192")
            || oversized.contains("limit")
            || oversized.contains("budget")
            || oversized.contains("Dimension"),
        "{oversized}"
    );

    let huge = format!("data:image/gif;base64,{}", "A".repeat(12 * 1024 * 1024));
    assert!(rejected(&huge).contains("12 MB"));
    assert!(rejected("data:image/avif;base64,AAAA").contains("Unsupported image URI"));
}

#[test]
fn imported_gif_renders_the_first_frame_and_keeps_the_original_uri() {
    let gif = uri("image/gif", "gif");
    let doc = serde_json::json!({
        "schemaVersion": 4,
        "id": "d",
        "name": "GIF",
        "pages": [{"id": "p", "name": "Page", "children": ["image"], "background": "#ffffff"}],
        "nodes": {"image": {"id": "image", "kind": "rectangle", "width": 64, "height": 48,
            "fills": [{"kind": "image", "image": gif, "color": "#ffffff", "fit": "stretch", "opacity": 1}]}}
    });
    assert_eq!(doc["nodes"]["image"]["fills"][0]["image"], gif);
    let mut engine = Engine::new();
    engine.load_document(&doc.to_string()).unwrap();
    let options: RenderOptions = serde_json::from_value(serde_json::json!({
        "pageId": "p", "width": 64, "height": 48, "transparent": true, "grid": false,
        "view": {"x": 0.0, "y": 0.0, "zoom": 1.0}, "rasterProfile": "analytic"
    }))
    .unwrap();
    let decoded = engine.image_data(&gif).unwrap();
    assert_eq!(
        engine.render(&options).unwrap(),
        decoded.rgba8(decoded.rect)
    );
}
