//! Sketch colorSpace 1 composites in encoded sRGB, matching native Sketch.
//! Linear management is restored only for archives this editor marked.
use futureox_design_kernel::fidelity::RasterProfile;
use futureox_design_kernel::interop::{export_sketch, import_sketch_report, read_zip_public};
use futureox_design_kernel::{Engine, RenderOptions, View};
use serde_json::{json, Value};
use std::io::Write;

fn png(width: u32, height: u32, pixels: &[u8]) -> Vec<u8> {
    let image = image::RgbaImage::from_raw(width, height, pixels.to_vec()).unwrap();
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}

fn archive(color_space: i64, layers: Value, images: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    let document = json!({
        "_class": "document",
        "colorSpace": color_space,
        "pages": [{"_class": "MSJSONFileReference", "_ref": "pages/p"}]
    });
    let page = json!({"_class": "page", "do_objectID": "p", "name": "Page", "layers": layers});
    for (name, bytes) in [
        (
            "meta.json",
            serde_json::to_vec(&json!({"version": 136})).unwrap(),
        ),
        ("document.json", serde_json::to_vec(&document).unwrap()),
        ("pages/p.json", serde_json::to_vec(&page).unwrap()),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    for (name, bytes) in images {
        zip.start_file(*name, options).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn rectangle(red: f64, green: f64, blue: f64, alpha: f64) -> Value {
    json!({"_class":"rectangle","do_objectID":"swatch","name":"Swatch",
        "frame":{"x":0,"y":0,"width":16,"height":16},
        "style":{"contextSettings":{"opacity":1,"blendMode":0},
            "fills":[{"isEnabled":true,"fillType":0,"color":{"red":red,"green":green,"blue":blue,"alpha":alpha}}]}})
}

fn render(
    document: &futureox_design_kernel::scene::Document,
    width: u32,
    height: u32,
    zoom: f64,
) -> Vec<u8> {
    let mut engine = Engine::new();
    engine
        .load_document(&serde_json::to_string(document).unwrap())
        .unwrap();
    engine
        .render(&RenderOptions {
            page_id: document.pages[0].id.clone(),
            width,
            height,
            view: View { x: 0., y: 0., zoom },
            transparent: false,
            grid: false,
            pixel_preview: None,
            animation: None,
            raster_profile: RasterProfile::Analytic,
            interactive_effects: false,
            checkerboard: false,
        })
        .unwrap()
}

fn center(bytes: &[u8], width: u32) -> [u8; 4] {
    let x = width / 2;
    let y = x;
    let i = ((y * width + x) * 4) as usize;
    bytes[i..i + 4].try_into().unwrap()
}

fn encoded_over_white(channel: u8, alpha: f64) -> u8 {
    (f64::from(channel) * alpha + 255. * (1. - alpha)).round() as u8
}

fn linear_over_white(channel: u8, alpha: f64) -> u8 {
    let encoded = f64::from(channel) / 255.;
    let linear = if encoded <= 0.04045 {
        encoded / 12.92
    } else {
        ((encoded + 0.055) / 1.055).powf(2.4)
    };
    let mixed = linear * alpha + 1. * (1. - alpha);
    let out = if mixed <= 0.0031308 {
        mixed * 12.92
    } else {
        1.055 * mixed.powf(1. / 2.4) - 0.055
    };
    (out * 255.).round() as u8
}

#[test]
fn sketch_srgb_tag_blends_encoded_and_keeps_the_archive_tag() {
    // The reported swatch: about RGB(45,45,41) at 50% over white.
    // Encoded source-over is RGB(150,150,148). Linear light is about RGB(190,190,189).
    let source = [45u8, 45, 41];
    let bytes = archive(
        1,
        json!([rectangle(45. / 255., 45. / 255., 41. / 255., 0.5)]),
        &[],
    );
    let report = import_sketch_report(&bytes).unwrap();
    assert!(report.document.color_management.is_none());
    assert!(report.document.raster_profile.is_none());
    assert_eq!(
        report
            .document
            .design_system
            .as_ref()
            .unwrap()
            .sketch_containers["sketchDocumentColorSpace"],
        json!(1)
    );
    let pixels = render(&report.document, 16, 16, 1.);
    let rgb = center(&pixels, 16);
    let encoded = source.map(|c| encoded_over_white(c, 0.5));
    let linear = source.map(|c| linear_over_white(c, 0.5));
    assert_eq!(encoded, [150, 150, 148], "{encoded:?}");
    assert!(
        linear[0] >= 185 && linear[2] >= 180,
        "linear reference moved: {linear:?}"
    );
    for i in 0..3 {
        assert!(
            (i32::from(rgb[i]) - i32::from(encoded[i])).abs() <= 2,
            "encoded blend rgb={rgb:?} expected {encoded:?} linear would be {linear:?}"
        );
        assert!(
            (i32::from(rgb[i]) - i32::from(linear[i])).abs() > 20,
            "result still matches linear light: {rgb:?} vs {linear:?}"
        );
    }
    assert_eq!(rgb[3], 255);
    let unmanaged = import_sketch_report(&archive(
        0,
        json!([rectangle(45. / 255., 45. / 255., 41. / 255., 0.5)]),
        &[],
    ))
    .unwrap();
    assert_eq!(center(&render(&unmanaged.document, 16, 16, 1.), 16), rgb);

    let files = read_zip_public(&export_sketch(&report.document).unwrap()).unwrap();
    let document: Value = serde_json::from_slice(&files["document.json"]).unwrap();
    assert_eq!(document["colorSpace"], 1);
    assert!(document
        .pointer("/userInfo/com.futureox.design-kernel/linearSrgbComposite")
        .is_none());
    let reopened = import_sketch_report(&export_sketch(&report.document).unwrap()).unwrap();
    assert!(reopened.document.color_management.is_none());
    assert_eq!(center(&render(&reopened.document, 16, 16, 1.), 16), rgb);
}

#[test]
fn explicit_linear_srgb_composite_still_round_trips() {
    let bytes = archive(1, json!([rectangle(0., 0., 0., 0.5)]), &[]);
    let mut managed = import_sketch_report(&bytes).unwrap().document;
    let encoded = center(&render(&managed, 16, 16, 1.), 16);
    assert!(
        (i32::from(encoded[0]) - i32::from(encoded_over_white(0, 0.5))).abs() <= 2,
        "{encoded:?}"
    );
    managed.schema_version = managed.schema_version.max(3);
    managed.color_management = Some(futureox_design_kernel::color::ColorSettings::default());
    let exported = export_sketch(&managed).unwrap();
    let files = read_zip_public(&exported).unwrap();
    let document: Value = serde_json::from_slice(&files["document.json"]).unwrap();
    assert_eq!(document["colorSpace"], 1);
    assert_eq!(
        document.pointer("/userInfo/com.futureox.design-kernel/linearSrgbComposite"),
        Some(&json!(true))
    );
    let reopened = import_sketch_report(&exported).unwrap().document;
    assert_eq!(
        reopened.color_management.as_ref().map(|c| c.document_space),
        Some(futureox_design_kernel::color::ColorSpace::Srgb)
    );
    let linear = center(&render(&reopened, 16, 16, 1.), 16);
    let expect = linear_over_white(0, 0.5);
    assert!(
        (i32::from(linear[0]) - i32::from(expect)).abs() <= 2,
        "linear rgb={linear:?} expected ~{expect}"
    );
    assert!(
        (i32::from(linear[0]) - i32::from(encoded[0])).abs() > 20,
        "linear path collapsed onto encoded {encoded:?}"
    );
}

#[test]
fn half_scale_bitmap_stays_in_encoded_srgb_and_full_size_is_exact() {
    // 8×4 checker displayed at 4×2. Each interior output pixel covers one 2×2
    // black/white/white/black block. Encoded average is mid-gray; linear-light
    // average encodes near 188.
    let (src_w, src_h) = (8u32, 4u32);
    let mut pixels = Vec::new();
    for y in 0..src_h {
        for x in 0..src_w {
            let v = if (x + y) % 2 == 0 { 0 } else { 255 };
            pixels.extend([v, v, v, 255]);
        }
    }
    let image = png(src_w, src_h, &pixels);
    let layer = |w: f64, h: f64| {
        json!({"_class":"bitmap","do_objectID":"bitmap","name":"Bitmap",
        "frame":{"x":0,"y":0,"width":w,"height":h},
        "image":{"_class":"MSJSONFileReference","_ref":"images/half.png"}})
    };
    let full = import_sketch_report(&archive(
        1,
        json!([layer(8., 4.)]),
        &[("images/half.png", image.clone())],
    ))
    .unwrap();
    assert!(full.document.color_management.is_none());
    let native = render(&full.document, 8, 4, 1.);
    assert_eq!(native, pixels, "original size must stay exact");
    let half = import_sketch_report(&archive(
        1,
        json!([layer(4., 2.)]),
        &[("images/half.png", image)],
    ))
    .unwrap();
    let scaled = render(&half.document, 4, 2, 1.);
    assert_eq!(scaled.len(), 4 * 2 * 4);
    let interior = [
        scaled[(0 * 4 + 1) * 4],
        scaled[(0 * 4 + 2) * 4],
        scaled[(1 * 4 + 1) * 4],
        scaled[(1 * 4 + 2) * 4],
    ];
    for value in interior {
        assert!(
            (120..=136).contains(&value),
            "half scale left encoded mid-gray: {scaled:?}"
        );
        assert!(
            value < 170,
            "half scale used linear-light filtering: {scaled:?}"
        );
    }
}

#[test]
fn unmanaged_srgb_source_reopens_when_color_settings_json_is_null() {
    let report = import_sketch_report(&archive(
        1,
        json!([rectangle(45. / 255., 45. / 255., 41. / 255., 0.5)]),
        &[],
    ))
    .unwrap();
    assert!(report.document.color_management.is_none());
    let mut engine = Engine::new();
    engine
        .load_document(&serde_json::to_string(&report.document).unwrap())
        .unwrap();
    let settings = serde_json::to_string(&engine.color_settings()).unwrap();
    assert_eq!(settings, "null");
    let rejected = serde_json::from_str::<futureox_design_kernel::color::ColorSettings>(&settings)
        .unwrap_err()
        .to_string();
    assert!(
        rejected.contains("invalid type: null, expected struct ColorSettings"),
        "{rejected}"
    );
    let directory = std::env::temp_dir().join(format!(
        "futureox-srgb-source-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("scene.fsc");
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let stored = futureox_design_kernel::scene_store::write(
        &path,
        "source:test",
        &report.document,
        &[],
        &cancel,
    )
    .unwrap();
    let (reopened, _) = futureox_design_kernel::scene_store::Reader::open(&path, &stored, &cancel)
        .unwrap()
        .into_document(&cancel)
        .unwrap();
    assert!(reopened.color_management.is_none());
    assert_eq!(reopened.nodes.len(), report.document.nodes.len());
    let _ = std::fs::remove_dir_all(&directory);
}
