use base64::Engine as _;
use futureox_design_kernel::{Engine, RenderOptions, color::ColorSettings};
use serde_json::{Value, json};
const JPEG: &[u8] = include_bytes!("../../../../testing/fixtures/design/io/orientation-6.jpg");
const P3: &[u8] = include_bytes!("../../../../testing/fixtures/design/io/display-p3-mid-icc.png");
fn uri(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}
fn document(uri: &str, width: u32, height: u32) -> Value {
    json!({"schemaVersion":4,"id":"d","name":"Image metadata","pages":[
        {"id":"p","name":"Page","children":["image"],"background":"#ffffff"}],
        "nodes":{"image":{"id":"image","kind":"rectangle","width":width,"height":height,
            "fills":[{"kind":"image","image":uri,"color":"#ffffff","fit":"stretch"}]}}})
}
fn options(width: u32, height: u32) -> RenderOptions {
    serde_json::from_value(
        json!({"pageId":"p","width":width,"height":height,"transparent":true,
        "grid":false,"view":{"x":0,"y":0,"zoom":1},"rasterProfile":"analytic"}),
    )
    .unwrap()
}
#[test]
fn all_exif_orientations_share_the_same_decoded_size_and_pixel_coordinates() {
    // Only the metadata tag changes; compressed source pixels remain identical.
    let raw = image::load_from_memory(JPEG).unwrap().to_rgba8();
    assert_eq!(raw.dimensions(), (8, 4));
    let marker = [0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06];
    let at = JPEG
        .windows(marker.len())
        .position(|bytes| bytes == marker)
        .unwrap();
    for orientation in 1_u16..=8 {
        let mut source = JPEG.to_vec();
        source[at + 8..at + 10].copy_from_slice(&orientation.to_be_bytes());
        let uri = uri("image/jpeg", &source);
        let (w, h) = if orientation >= 5 { (4, 8) } else { (8, 4) };
        let mut expected = Vec::new();
        for y in 0..h {
            for x in 0..w {
                let (sx, sy) = match orientation {
                    1 => (x, y),
                    2 => (7 - x, y),
                    3 => (7 - x, 3 - y),
                    4 => (x, 3 - y),
                    5 => (y, x),
                    6 => (y, 3 - x),
                    7 => (7 - y, 3 - x),
                    8 => (7 - y, x),
                    _ => unreachable!(),
                };
                expected.extend(raw.get_pixel(sx, sy).0);
            }
        }
        let doc = document(&uri, w, h);
        let mut engine = Engine::new();
        engine.load_document(&doc.to_string()).unwrap();
        let decoded = engine.image_data(&uri).unwrap();
        assert_eq!(
            (decoded.rect.w, decoded.rect.h),
            (w, h),
            "orientation {orientation}"
        );
        assert_eq!(
            decoded.rgba8(decoded.rect),
            expected,
            "decoded orientation {orientation}"
        );
        assert_eq!(
            engine.render(&options(w, h)).unwrap(),
            expected,
            "rendered orientation {orientation}"
        );
        assert_eq!(
            doc["nodes"]["image"]["fills"][0]["image"], uri,
            "source asset bytes retained"
        );
    }
}
#[test]
fn tagged_p3_in_sdr_uses_the_existing_color_transform_before_byte_storage() {
    let uri = uri("image/png", P3);
    let mut doc = document(&uri, 4, 4);
    let mut sdr = Engine::new();
    sdr.load_document(&doc.to_string()).unwrap();
    let pixels = sdr.render(&options(4, 4)).unwrap();
    assert_eq!(
        &pixels[..4],
        &[32, 130, 197, 255],
        "independent Chromium sRGB canvas readback"
    );
    doc["colorManagement"] = serde_json::to_value(ColorSettings::default()).unwrap();
    let mut managed = Engine::new();
    managed.load_document(&doc.to_string()).unwrap();
    let settings = ColorSettings::default();
    let expected: Vec<_> = managed
        .render_linear(&options(4, 4))
        .unwrap()
        .into_iter()
        .flat_map(|p| {
            settings
                .output(p, Default::default())
                .map(|v| (v.clamp(0., 1.) * 255.).round_ties_even() as u8)
        })
        .collect();
    assert_eq!(pixels, expected);
}
#[test]
fn malformed_icc_is_not_silently_ignored_in_an_sdr_document() {
    let mut info = png::Info::with_size(1, 1);
    info.color_type = png::ColorType::Rgba;
    info.bit_depth = png::BitDepth::Eight;
    info.icc_profile = Some(std::borrow::Cow::Borrowed(b"not a valid ICC profile"));
    let mut encoded = Vec::new();
    {
        let mut writer = png::Encoder::with_info(&mut encoded, info)
            .unwrap()
            .write_header()
            .unwrap();
        writer.write_image_data(&[64, 128, 192, 255]).unwrap();
        writer.finish().unwrap();
    }
    let uri = uri("image/png", &encoded);
    let mut engine = Engine::new();
    engine
        .load_document(&document(&uri, 1, 1).to_string())
        .unwrap();
    assert!(
        engine
            .image_data(&uri)
            .err()
            .expect("malformed ICC must fail")
            .contains("ICC")
    );
}
#[test]
fn hdr_png_requires_managed_color_and_retains_highlights_when_enabled() {
    for bytes in [
        include_bytes!(
            "../../../../frontend/design-client/public/color-fixtures/pq-highlights.png"
        )
        .as_slice(),
        include_bytes!(
            "../../../../frontend/design-client/public/color-fixtures/hlg-highlights.png"
        )
        .as_slice(),
    ] {
        let uri = uri("image/png", bytes);
        let mut doc = document(&uri, 4, 4);
        let mut engine = Engine::new();
        engine.load_document(&doc.to_string()).unwrap();
        assert!(
            engine
                .image_data(&uri)
                .err()
                .expect("unmanaged HDR must fail")
                .contains("color-managed")
        );
        doc["colorManagement"] = serde_json::to_value(ColorSettings::default()).unwrap();
        engine.load_document(&doc.to_string()).unwrap();
        let decoded = engine.image_data(&uri).unwrap();
        assert!(decoded.pixels.iter().any(|pixel| pixel.0[0] > 1.0));
    }
}

#[test]
fn malformed_exif_in_real_jpeg_fails_decode_and_render() {
    let marker = [0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06];
    let at = JPEG
        .windows(marker.len())
        .position(|bytes| bytes == marker)
        .unwrap();
    let tiff = JPEG
        .windows(6)
        .position(|bytes| bytes == b"Exif\0\0")
        .unwrap()
        + 6;
    for name in ["orientation-0", "orientation-9", "bad-tiff-magic"] {
        let mut bytes = JPEG.to_vec();
        match name {
            "orientation-0" => bytes[at + 9] = 0,
            "orientation-9" => bytes[at + 9] = 9,
            _ => bytes[tiff + 3] = 43,
        }
        let uri = uri("image/jpeg", &bytes);
        let mut engine = Engine::new();
        engine
            .load_document(&document(&uri, 8, 4).to_string())
            .unwrap();
        assert!(
            engine
                .image_data(&uri)
                .err()
                .expect("invalid EXIF must fail")
                .contains("EXIF"),
            "{name}"
        );
        assert!(
            engine.render(&options(8, 4)).unwrap_err().contains("EXIF"),
            "{name}"
        );
    }
}
