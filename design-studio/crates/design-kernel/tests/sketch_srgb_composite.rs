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

/// Issue #177: Sketch colorSpace 1 shadows composite in encoded sRGB.
/// A black 50% hard shadow over white is RGB 128, not the linear-light
/// encoding near 187. Radius 64 must still paint; the 256 MiB ledger stays.
#[test]
fn sketch_shadow_classes_stay_encoded_and_radius_64_is_admitted() {
    fn shadow_layer(effects: Value, opacity: f64) -> Value {
        json!({"_class":"rectangle","do_objectID":"shape","name":"Shape",
            "frame":{"_class":"rect","x":40,"y":48,"width":96,"height":64},
            "style":{"_class":"style","contextSettings":{"_class":"graphicsContextSettings","opacity":opacity,"blendMode":0},
                "fills":[{"_class":"fill","isEnabled":true,"fillType":0,"color":{"_class":"color","red":0.2,"green":0.4,"blue":0.6,"alpha":1}}],
                "shadows":effects,"innerShadows":[]}})
    }
    fn one(radius: f64, x: f64, y: f64, spread: f64, alpha: f64, inner: bool) -> Value {
        let part = json!({"_class":if inner {"innerShadow"} else {"shadow"},"isEnabled":true,
            "blurRadius":radius,"offsetX":x,"offsetY":y,"spread":spread,
            "color":{"_class":"color","red":0,"green":0,"blue":0,"alpha":alpha},
            "contextSettings":{"_class":"graphicsContextSettings","blendMode":0,"opacity":1}});
        if inner {
            json!({"shadows":[],"inner":[part]})
        } else {
            json!({"shadows":[part],"inner":[]})
        }
    }
    fn render_profile(
        document: &futureox_design_kernel::scene::Document,
        profile: RasterProfile,
    ) -> Result<Vec<u8>, String> {
        let mut engine = Engine::new();
        engine.load_document(&serde_json::to_string(document).unwrap())?;
        let pixels = engine.render(&RenderOptions {
            page_id: document.pages[0].id.clone(),
            width: 512,
            height: 512,
            view: View {
                x: 0.,
                y: 0.,
                zoom: 2.,
            },
            transparent: false,
            grid: false,
            pixel_preview: None,
            animation: None,
            raster_profile: profile,
            interactive_effects: false,
            checkerboard: false,
        })?;
        let ledger = engine.compositing_ledger();
        if ledger.budget_rejections != 0 {
            return Err(format!(
                "budget rejections {} peak {} last {:?}",
                ledger.budget_rejections, ledger.scene_peak_bytes, ledger.last_rejection
            ));
        }
        Ok(pixels)
    }
    fn at(pixels: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * 512 + x) * 4) as usize;
        pixels[i..i + 4].try_into().unwrap()
    }
    let imported = |effects: Value, opacity: f64| {
        let layer = shadow_layer(effects["shadows"].clone(), opacity);
        let mut layer = layer;
        if let Some(inner) = effects.get("inner").and_then(Value::as_array) {
            layer["style"]["innerShadows"] = Value::Array(inner.clone());
        }
        import_sketch_report(&archive(1, json!([layer]), &[]))
            .unwrap()
            .document
    };

    let hard = imported(one(0., 8., 12., 0., 0.5, false), 1.);
    assert!(hard.color_management.is_none());
    let shape = hard.nodes.values().find(|n| n.name == "Shape").unwrap();
    assert_eq!(shape.effects.len(), 1);
    assert_eq!(shape.effects[0].kind, "shadow");
    assert!((shape.effects[0].opacity - 0.5).abs() < 1e-9);
    assert_eq!(shape.effects[0].radius, 0.);
    let pixels = render_profile(&hard, RasterProfile::Analytic).expect("hard shadow");
    // Device rect (80,96)-(272,224). Shadow offset (16,24) leaves a crescent.
    // (106, 234) is inside that crescent and outside the opaque fill.
    let crescent = at(&pixels, 106, 234);
    let encoded = encoded_over_white(0, 0.5);
    let linear = linear_over_white(0, 0.5);
    assert!(
        (i32::from(crescent[0]) - i32::from(encoded)).abs() <= 2
            && crescent[0] == crescent[1]
            && crescent[1] == crescent[2]
            && crescent[3] == 255,
        "hard shadow rgb={crescent:?} encoded {encoded} linear {linear}"
    );
    assert!(
        (i32::from(crescent[0]) - i32::from(linear)).abs() > 20,
        "hard shadow collapsed onto linear light {crescent:?} vs {linear}"
    );
    // Opaque fill is a fixed point of the transfer curve.
    let fill = at(&pixels, 160, 160);
    assert_eq!(fill, [51, 102, 153, 255], "fill {fill:?}");

    let wide = imported(one(64., 0., 10., 0., 0.5, false), 1.);
    let wide_pixels = render_profile(&wide, RasterProfile::Analytic).expect("analytic radius 64");
    let mut shadow_pixels = 0u32;
    let mut changed = 0u32;
    let bare = render_profile(
        &imported(json!({"shadows":[],"inner":[]}), 1.),
        RasterProfile::Analytic,
    )
    .expect("control");
    for (i, (a, b)) in wide_pixels
        .chunks_exact(4)
        .zip(bare.chunks_exact(4))
        .enumerate()
    {
        if a != b {
            changed += 1;
            let x = (i as u32) % 512;
            let y = (i as u32) / 512;
            // Below the fill, the blur must still be visibly darker than white.
            if y > 230 && a[0] < 250 {
                shadow_pixels += 1;
            }
            let _ = x;
        }
    }
    assert!(
        changed > 0 && shadow_pixels > 0,
        "radius 64 cast no admitted shadow (changed {changed})"
    );

    // Independent encoded-sRGB reference: binary silhouette, Gaussian sigma =
    // blurRadius/2 (CSS / Sketch drop-shadow scale), then source-over. This is
    // not the three-box implementation under test.
    fn blur_alpha(src: &[f32], w: usize, h: usize, sigma: f64) -> Vec<f32> {
        if sigma <= 0.05 {
            return src.to_vec();
        }
        let radius = (3. * sigma).ceil() as i32;
        let mut kernel = vec![0f32; (radius * 2 + 1) as usize];
        let mut mass = 0f32;
        for i in -radius..=radius {
            let t = i as f64 / sigma;
            let weight = (-0.5 * t * t).exp() as f32;
            kernel[(i + radius) as usize] = weight;
            mass += weight;
        }
        for weight in &mut kernel {
            *weight /= mass;
        }
        let mut horizontal = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut acc = 0f32;
                for i in -radius..=radius {
                    let sx = (x as i32 + i).clamp(0, w as i32 - 1) as usize;
                    acc += src[y * w + sx] * kernel[(i + radius) as usize];
                }
                horizontal[y * w + x] = acc;
            }
        }
        let mut out = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut acc = 0f32;
                for i in -radius..=radius {
                    let sy = (y as i32 + i).clamp(0, h as i32 - 1) as usize;
                    acc += horizontal[sy * w + x] * kernel[(i + radius) as usize];
                }
                out[y * w + x] = acc;
            }
        }
        out
    }
    fn oracle(radius: f64, ox: f64, oy: f64, spread: f64, alpha: f64, inner: bool) -> Vec<u8> {
        let (w, h) = (512usize, 512usize);
        let (x0, y0, rw, rh) = (80i32, 96i32, 192i32, 128i32);
        let mut cover = vec![0f32; w * h];
        for y in y0..y0 + rh {
            for x in x0..x0 + rw {
                if (0..w as i32).contains(&x) && (0..h as i32).contains(&y) {
                    cover[y as usize * w + x as usize] = 1.;
                }
            }
        }
        let grow = (spread.abs() * 2.).round() as i32;
        if grow > 0 {
            let dilate = if inner { spread < 0. } else { spread > 0. };
            let src = cover.clone();
            for y in 0..h as i32 {
                for x in 0..w as i32 {
                    let mut v = if dilate { 0f32 } else { 1. };
                    for yy in (y - grow).max(0)..=(y + grow).min(h as i32 - 1) {
                        for xx in (x - grow).max(0)..=(x + grow).min(w as i32 - 1) {
                            let s = src[yy as usize * w + xx as usize];
                            v = if dilate { v.max(s) } else { v.min(s) };
                        }
                    }
                    cover[y as usize * w + x as usize] = v;
                }
            }
        }
        // Device sigma is authoredRadius * zoom / 2. Zoom 2 cancels the half.
        let blurred = blur_alpha(&cover, w, h, radius);
        let (dx, dy) = (ox * 2., oy * 2.);
        let sample = |x: f64, y: f64| -> f32 {
            let x0 = x.floor() as i32;
            let y0 = y.floor() as i32;
            let (u, v) = ((x - x0 as f64) as f32, (y - y0 as f64) as f32);
            let tap = |x: i32, y: i32| -> f32 {
                if x < 0 || y < 0 || x >= w as i32 || y >= h as i32 {
                    0.
                } else {
                    blurred[y as usize * w + x as usize]
                }
            };
            let top = tap(x0, y0) * (1. - u) + tap(x0 + 1, y0) * u;
            let bottom = tap(x0, y0 + 1) * (1. - u) + tap(x0 + 1, y0 + 1) * u;
            top * (1. - v) + bottom * v
        };
        let mut image = vec![255u8; w * h * 4];
        for y in 0..h as i32 {
            for x in 0..w as i32 {
                // Grid index x is the pixel whose center is x+0.5, so an
                // integer device offset reads that same pixel.
                let b = sample(x as f64 - dx, y as f64 - dy);
                let shape = if (x0..x0 + rw).contains(&x) && (y0..y0 + rh).contains(&y) {
                    1f64
                } else {
                    0f64
                };
                let coverage = if inner {
                    shape * (1. - f64::from(b))
                } else {
                    f64::from(b)
                };
                let shadow_a = (coverage * alpha).clamp(0., 1.);
                let fill = [51f64, 102., 153.];
                let page = [255f64, 255., 255.];
                // Outer shadow sits under the opaque fill. Inner shadow is
                // source-over the fill and cannot paint the page outside it.
                let rgb: [f64; 3] = if inner {
                    let base = if shape == 1. { fill } else { page };
                    std::array::from_fn(|c| base[c] * (1. - shadow_a))
                } else {
                    let under: [f64; 3] = std::array::from_fn(|c| page[c] * (1. - shadow_a));
                    std::array::from_fn(|c| fill[c] * shape + under[c] * (1. - shape))
                };
                let i = (y as usize * w + x as usize) * 4;
                for c in 0..3 {
                    image[i + c] = rgb[c].round().clamp(0., 255.) as u8;
                }
            }
        }
        image
    }
    fn over_threshold(actual: &[u8], expected: &[u8]) -> f64 {
        let mut bad = 0usize;
        let n = actual.len() / 4;
        for i in 0..n {
            let d = (0..3)
                .map(|c| (actual[i * 4 + c] as i32 - expected[i * 4 + c] as i32).abs())
                .max()
                .unwrap_or(0);
            if d > 16 {
                bad += 1;
            }
        }
        bad as f64 / n as f64 * 100.
    }
    for (name, radius, ox, oy, spread, alpha, inner) in [
        ("drop-hard", 0., 8., 12., 0., 0.5, false),
        ("drop-blur4", 4., 4., 8., 0., 0.5, false),
        ("drop-blur16", 16., 4., 8., 0., 0.5, false),
        ("drop-fractional", 4.5, 0.25, 6.75, 0., 0.5, false),
        ("drop-spread-positive", 12., 4., 8., 8., 0.5, false),
        ("drop-spread-negative", 12., 4., 8., -8., 0.5, false),
        ("inner-hard", 0., 6., 8., 0., 0.5, true),
        ("inner-blur12", 12., 4., 6., 0., 0.5, true),
        ("drop-wide64", 64., 0., 10., 0., 0.5, false),
    ] {
        let doc = imported(one(radius, ox, oy, spread, alpha, inner), 1.);
        let pixels =
            render_profile(&doc, RasterProfile::Analytic).unwrap_or_else(|e| panic!("{name}: {e}"));
        let reference = oracle(radius, ox, oy, spread, alpha, inner);
        let screen = over_threshold(&pixels, &reference);
        assert!(
            screen <= 1.0,
            "{name}: {screen:.3}% of the frame differs by more than 16/255 from the encoded gaussian"
        );
    }
    // Two hard shadows of the original silhouette stack. The second must not
    // cast another copy of the first shadow one offset further down.
    let part = json!({"_class":"shadow","isEnabled":true,"blurRadius":0,"offsetX":8,"offsetY":12,"spread":0,
        "color":{"_class":"color","red":0,"green":0,"blue":0,"alpha":0.5},
        "contextSettings":{"_class":"graphicsContextSettings","blendMode":0,"opacity":1}});
    let stacked = render_profile(
        &imported(json!({"shadows":[part.clone(), part],"inner":[]}), 1.),
        RasterProfile::Analytic,
    )
    .expect("two hard shadows");
    let stacked_crescent = at(&stacked, 106, 234);
    let beyond = at(&stacked, 160, 260);
    assert!(
        stacked_crescent[0] < 100 && beyond[0] > 250,
        "stacked shadows crescent={stacked_crescent:?} beyond={beyond:?}"
    );
    let colored = json!({"_class":"shadow","isEnabled":true,"blurRadius":0,"offsetX":8,"offsetY":12,"spread":0,
        "color":{"_class":"color","red":1,"green":0,"blue":0,"alpha":0.5},
        "contextSettings":{"_class":"graphicsContextSettings","blendMode":0,"opacity":1}});
    let colored_px = at(
        &render_profile(
            &imported(json!({"shadows":[colored],"inner":[]}), 1.),
            RasterProfile::Analytic,
        )
        .expect("colored hard shadow"),
        106,
        234,
    );
    assert!(
        (i32::from(colored_px[0]) - 255).abs() <= 2
            && (i32::from(colored_px[1]) - i32::from(encoded_over_white(0, 0.5))).abs() <= 2
            && colored_px[1] == colored_px[2],
        "colored hard shadow stayed linear: {colored_px:?}"
    );
    let faded = at(
        &render_profile(
            &imported(one(0., 8., 12., 0., 0.5, false), 0.5),
            RasterProfile::Analytic,
        )
        .expect("layer opacity"),
        106,
        234,
    );
    assert!(
        (i32::from(faded[0]) - i32::from(encoded_over_white(0, 0.25))).abs() <= 2,
        "layer opacity did not scale the shadow in encoded space: {faded:?}"
    );
    let figma = render_profile(&wide, RasterProfile::Figma).expect("figma radius 64");
    let figma_bare = render_profile(
        &imported(json!({"shadows":[],"inner":[]}), 1.),
        RasterProfile::Figma,
    )
    .expect("figma control");
    let mut far = 0u32;
    for (i, (a, b)) in figma
        .chunks_exact(4)
        .zip(figma_bare.chunks_exact(4))
        .enumerate()
    {
        let y = (i as u32) / 512;
        if y > 300 && a != b {
            far += 1;
        }
    }
    assert!(
        far > 1000,
        "figma radius 64 lost the wide shadow below the shape ({far} pixels)"
    );
}
