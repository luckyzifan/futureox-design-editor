//! Production import of a two-frame GIF and a single-page TIFF.
//! The stored data URI keeps the original bytes. Decoding uses the same
//! Engine path as WASM `image_info` / `render`: GIF contributes only its
//! first frame, and a TIFF with another IFD is rejected before a page is shown.
use base64::Engine as _;
use futureox_design_kernel::{Engine, RenderOptions, binfmt, pdf_export, scene::Document};
use image::ImageEncoder;
use serde_json::{Value, json};

fn uri(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn document(uri: &str, width: u32, height: u32) -> Value {
    json!({"schemaVersion":4,"id":"d","name":"GIF TIFF import","pages":[
        {"id":"p","name":"Page","children":["image"],"background":"#ffffff"}],
        "nodes":{"image":{"id":"image","kind":"rectangle","width":width,"height":height,
            "fills":[{"kind":"image","image":uri,"color":"#ffffff","fit":"stretch"}]}}})
}

fn options(width: u32, height: u32) -> RenderOptions {
    serde_json::from_value(json!({
        "pageId":"p","width":width,"height":height,"transparent":true,
        "grid":false,"view":{"x":0,"y":0,"zoom":1},"rasterProfile":"analytic"
    }))
    .unwrap()
}

fn two_frame_gif() -> Vec<u8> {
    let red = image::RgbaImage::from_pixel(64, 48, image::Rgba([255, 0, 0, 255]));
    let green = image::RgbaImage::from_pixel(64, 48, image::Rgba([0, 255, 0, 255]));
    let mut bytes = Vec::new();
    let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
    encoder
        .encode_frame(image::Frame::from_parts(
            red,
            0,
            0,
            image::Delay::from_numer_denom_ms(80, 1),
        ))
        .unwrap();
    encoder
        .encode_frame(image::Frame::from_parts(
            green,
            0,
            0,
            image::Delay::from_numer_denom_ms(80, 1),
        ))
        .unwrap();
    drop(encoder);
    assert!(
        bytes.starts_with(b"GIF8"),
        "encoder must write a real GIF header"
    );
    bytes
}

fn solid_tiff(width: u32, height: u32, pixel: [u8; 4]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
    for _ in 0..width * height {
        rgba.extend_from_slice(&pixel);
    }
    let mut cursor = std::io::Cursor::new(Vec::new());
    image::codecs::tiff::TiffEncoder::new(&mut cursor)
        .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
        .unwrap();
    cursor.into_inner()
}

fn rejection(
    result: Result<std::sync::Arc<futureox_design_kernel::blend::Surface>, String>,
) -> String {
    match result {
        Ok(_) => panic!("expected the sample to be rejected"),
        Err(error) => error,
    }
}

fn le16(value: u16) -> [u8; 2] {
    value.to_le_bytes()
}
fn le32(value: u32) -> [u8; 4] {
    value.to_le_bytes()
}
fn short_inline(value: u16) -> [u8; 4] {
    let mut bytes = [0; 4];
    bytes[..2].copy_from_slice(&le16(value));
    bytes
}
fn entry(tag: u16, kind: u16, count: u32, value: [u8; 4]) -> [u8; 12] {
    let mut bytes = [0; 12];
    bytes[..2].copy_from_slice(&le16(tag));
    bytes[2..4].copy_from_slice(&le16(kind));
    bytes[4..8].copy_from_slice(&le32(count));
    bytes[8..].copy_from_slice(&value);
    bytes
}

/// Classic little-endian uncompressed RGBA. `next_page` appends a second IFD.
fn manual_tiff(width: u32, height: u32, rgba: &[u8], orientation: u16, next_page: bool) -> Vec<u8> {
    assert_eq!(rgba.len(), width as usize * height as usize * 4);
    let count = 12u16;
    let ifd_bytes = 2 + usize::from(count) * 12 + 4;
    let bits_at = 8 + ifd_bytes;
    let pixels_at = bits_at + 8;
    let second_at = pixels_at + rgba.len();
    let mut tags = [
        entry(256, 4, 1, le32(width)),
        entry(257, 4, 1, le32(height)),
        entry(258, 3, 4, le32(bits_at as u32)),
        entry(259, 3, 1, short_inline(1)),
        entry(262, 3, 1, short_inline(2)),
        entry(273, 4, 1, le32(pixels_at as u32)),
        entry(274, 3, 1, short_inline(orientation)),
        entry(277, 3, 1, short_inline(4)),
        entry(278, 4, 1, le32(height)),
        entry(279, 4, 1, le32(rgba.len() as u32)),
        entry(284, 3, 1, short_inline(1)),
        entry(338, 3, 1, short_inline(2)),
    ];
    tags.sort_by_key(|tag| u16::from_le_bytes([tag[0], tag[1]]));
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"II*\x00");
    bytes.extend_from_slice(&le32(8));
    bytes.extend_from_slice(&le16(count));
    for tag in tags {
        bytes.extend_from_slice(&tag);
    }
    bytes.extend_from_slice(&le32(if next_page { second_at as u32 } else { 0 }));
    for sample in [8u16, 8, 8, 8] {
        bytes.extend_from_slice(&le16(sample));
    }
    bytes.extend_from_slice(rgba);
    if next_page {
        assert_eq!(bytes.len(), second_at);
        // A 1×1 second page is enough to prove the next-IFD pointer is honored.
        let page = manual_tiff(1, 1, &[0, 0, 0, 255], 1, false);
        // Re-base is unnecessary: the primary IFD only checks that next != 0.
        bytes.extend_from_slice(&page);
    }
    bytes
}

fn assert_red(pixel: &[u8]) {
    assert_eq!(
        pixel,
        &[255, 0, 0, 255],
        "expected the first GIF/TIFF frame to stay opaque red"
    );
}

#[test]
fn gif_first_frame_and_single_page_tiff_import_render_save_and_export() {
    let gif = two_frame_gif();
    let tiff = solid_tiff(64, 48, [255, 0, 0, 255]);
    assert_eq!(
        gif,
        include_bytes!("../../../../testing/fixtures/design/io/two-frame-64x48.gif")
    );
    assert_eq!(
        tiff,
        include_bytes!("../../../../testing/fixtures/design/io/red-64x48.tiff")
    );
    if let Ok(dir) = std::env::var("GIF_TIFF_FIXTURE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(format!("{dir}/two-frame.gif"), &gif).unwrap();
        std::fs::write(format!("{dir}/red-64x48.tiff"), &tiff).unwrap();
    }
    let gif_uri = uri("image/gif", &gif);
    let tiff_uri = uri("image/tiff", &tiff);

    let mut gif_engine = Engine::new();
    let decoded = gif_engine.image_data(&gif_uri).unwrap();
    assert_eq!((decoded.rect.w, decoded.rect.h), (64, 48));
    assert!(
        decoded.pixels[0].0[0] > 0.9 && decoded.pixels[0].0[1] < 0.05,
        "first frame is red"
    );
    assert!(
        decoded.pixels[64 * 48 - 1].0[1] < 0.05,
        "the green second frame is not decoded"
    );

    let mut tiff_engine = Engine::new();
    let decoded = tiff_engine.image_data(&tiff_uri).unwrap();
    assert_eq!((decoded.rect.w, decoded.rect.h), (64, 48));
    assert!(decoded.pixels[0].0[0] > 0.9 && decoded.pixels[0].0[3] > 0.99);

    for (label, image_uri, width, height) in [("gif", gif_uri, 64, 48), ("tiff", tiff_uri, 64, 48)]
    {
        let source = document(&image_uri, width, height);
        let json = source.to_string();
        let saved = binfmt::encode_authored_json(&json).unwrap();
        let opened = binfmt::decode_authored_json(&saved).unwrap();
        assert!(
            opened.contains(&image_uri),
            "{label} original bytes must survive save/reopen"
        );
        let mut engine = Engine::new();
        engine.load_document(&opened).unwrap();
        let rendered = engine.render(&options(width, height)).unwrap();
        assert_eq!(rendered.len(), width as usize * height as usize * 4);
        assert_red(&rendered[..4]);
        assert_red(&rendered[rendered.len() - 4..]);
        let typed: Document = serde_json::from_str(&opened).unwrap();
        let pdf = pdf_export::encode_pdf_vector(
            &typed,
            "p",
            width as f64,
            height as f64,
            Some("#ffffff"),
        )
        .unwrap();
        assert!(
            pdf.windows(6).any(|window| window == b"/Image"),
            "{label} export must embed the decoded image"
        );
    }
}

#[test]
fn tiff_orientation_is_applied_and_invalid_or_multipage_samples_are_rejected() {
    let mut pixels = vec![0u8; 2 * 4];
    pixels[..4].copy_from_slice(&[255, 0, 0, 255]);
    pixels[4..].copy_from_slice(&[0, 0, 255, 255]);
    let turned = manual_tiff(2, 1, &pixels, 6, false);
    let mut engine = Engine::new();
    let decoded = engine.image_data(&uri("image/tiff", &turned)).unwrap();
    assert_eq!(
        (decoded.rect.w, decoded.rect.h),
        (1, 2),
        "orientation 6 swaps the stored axes"
    );
    assert!(
        decoded.pixels[0].0[0] > 0.9 && decoded.pixels[0].0[2] < 0.05,
        "top pixel stays the stored left sample"
    );
    assert!(
        decoded.pixels[1].0[2] > 0.9 && decoded.pixels[1].0[0] < 0.05,
        "bottom pixel is the stored right sample"
    );

    let invalid = manual_tiff(1, 1, &[255, 0, 0, 255], 0, false);
    let error = rejection(engine.image_data(&uri("image/tiff", &invalid)));
    assert!(error.contains("expected 1 through 8"), "{error}");

    let pages = manual_tiff(1, 1, &[0, 255, 0, 255], 1, true);
    let error = rejection(Engine::new().image_data(&uri("image/tiff", &pages)));
    assert!(error.contains("Multi-page TIFF"), "{error}");

    let mut huge = manual_tiff(1, 1, &[255, 0, 0, 255], 1, false);
    // Tag 256 is the first sorted IFD entry. Rewrite its inline LONG without
    // allocating a 9000-pixel strip; the decoder must reject before that buffer.
    assert_eq!(&huge[10..12], &le16(256));
    huge[18..22].copy_from_slice(&le32(9000));
    let error = rejection(Engine::new().image_data(&uri("image/tiff", &huge)));
    assert!(error.contains("TIFF decode failed"), "{error}");

    let error = rejection(Engine::new().image_data(&uri("image/gif", b"GIF89a")));
    assert!(error.contains("GIF decode failed"), "{error}");
    let png = {
        let mut encoded = Vec::new();
        image::codecs::png::PngEncoder::new(&mut encoded)
            .write_image(&[1, 2, 3, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        encoded
    };
    let error = rejection(Engine::new().image_data(&uri("image/gif", &png)));
    assert!(
        error.contains("do not match the declared image type"),
        "{error}"
    );
    let error = rejection(Engine::new().image_data(&uri("image/png", &turned)));
    assert!(error.contains("do not match the declared type"), "{error}");
}

#[test]
fn rejected_gif_and_tiff_do_not_replace_an_already_decoded_image() {
    let png = {
        let mut encoded = Vec::new();
        image::codecs::png::PngEncoder::new(&mut encoded)
            .write_image(&[9, 8, 7, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        encoded
    };
    let mut engine = Engine::new();
    let kept = uri("image/png", &png);
    let before = engine.image_data(&kept).unwrap().pixels[0].0;
    assert!(engine.image_data(&uri("image/tiff", b"II*\x00")).is_err());
    assert!(engine.image_data(&uri("image/gif", b"GIF89a")).is_err());
    assert_eq!(engine.image_data(&kept).unwrap().pixels[0].0, before);
}
