//! Issue #82. USWDS colors labels use a Sketch fixed line box. The independent
//! reference is the text matrix in `uswds-colors.sketch` text-previews.pdf
//! (macOS Quartz, 2020-11-02), not this renderer.
//!
//! Main, before this change, with Public Sans:
//!   "50v"       size 12 line 12  glyph y 10.350 x 0.458  PDF y 10 x 0.458
//!   "5"         size 14 line 24  glyph y 17.075 x 0      PDF y 17 x 0
//!   "blue cool" size 20 line 24  glyph y 19.250 x 0      PDF y 19 x 0
//! Opaque cores were already #2e2e2e. A 16×16 swatch was already exact.
//! The 22×12 "50v" crop versus poppler's raster of that PDF page was
//! analytic 139/264 and figma 131/264 pixels with channel delta > 0.
use base64::Engine as _;
use futureox_design_kernel::fidelity::RasterProfile;
use futureox_design_kernel::font::{FontResource, Fonts};
use futureox_design_kernel::interop::import_sketch_report;
use futureox_design_kernel::scene::Node;
use futureox_design_kernel::{Engine, RenderOptions, View};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Write;

const REGULAR: &[u8] = include_bytes!("PublicSans-Regular.otf");
const LIGHT: &[u8] = include_bytes!("PublicSans-Light.otf");
const PREVIEW: &[u8] = include_bytes!("uswds-50v-sketch-preview.png");

fn resource(family: &str, bytes: &[u8]) -> FontResource {
    FontResource {
        family: family.into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes).into(),
        index: 0,
        postscript: Some(family.into()),
    }
}

fn node(text: &str, font: &str, size: f64, width: f64, height: f64, line: f64, align: &str, snap: bool) -> Node {
    let mut value = json!({
        "id": "t",
        "kind": "text",
        "name": text,
        "text": text,
        "fontSize": size,
        "width": width,
        "height": height,
        "textStyle": {
            "fontId": font,
            "lineHeight": line / size,
            "align": align,
            "wrap": false
        },
        "textRuns": [{
            "start": 0,
            "end": text.encode_utf16().count(),
            "paragraph": {
                "align": align,
                "minimumLineHeight": line,
                "maximumLineHeight": line,
                "spacing": 0,
                "indent": 0
            }
        }],
        "fills": [{ "kind": "solid", "color": "#2E2E2E", "opacity": 1 }]
    });
    if snap {
        value["textStyle"]["lineBoxBaseline"] = json!("nearest-point");
    }
    serde_json::from_value(value).unwrap()
}

fn fonts() -> Fonts {
    let mut resources = BTreeMap::new();
    resources.insert("PublicSans-Regular".into(), resource("Public Sans", REGULAR));
    resources.insert("PublicSans-Light".into(), resource("Public Sans Light", LIGHT));
    let mut fonts = Fonts::new();
    fonts
        .load(include_bytes!("../../../../frontend/design-client/public/fonts/NotoSansSC.ttf"))
        .unwrap();
    fonts.with_resources(&resources).unwrap()
}

#[test]
fn fixed_line_box_baseline_matches_sketch_text_preview_and_keeps_fractional_x() {
    let fonts = fonts();
    // (text, font, size, width, height, line, align, pdf baseline, pdf x, main y)
    let cases = [
        ("50v", "PublicSans-Regular", 12., 22., 12., 12., "center", 10., 0.458, 10.35),
        ("5", "PublicSans-Regular", 14., 84., 23., 24., "start", 17., 0., 17.075),
        ("blue cool", "PublicSans-Light", 20., 128., 23., 24., "start", 19., 0., 19.25),
    ];
    for (text, font, size, width, height, line, align, pdf_y, pdf_x, main_y) in cases {
        let plain = fonts
            .node_layout(
                &node(text, font, size, width, height, line, align, false),
                Some(width),
            )
            .unwrap();
        let snapped = fonts
            .node_layout(
                &node(text, font, size, width, height, line, align, true),
                Some(width),
            )
            .unwrap();
        let before = plain.glyphs[0].y;
        let after = snapped.glyphs[0].y;
        println!(
            "MEASURE baseline text={text:?} main_y={before:.6} candidate_y={after:.6} pdf_y={pdf_y} main_abs_err={:.6} candidate_abs_err={:.6} x={:.6}",
            (before - pdf_y).abs(),
            (after - pdf_y).abs(),
            snapped.glyphs[0].x
        );
        assert!(
            (before - main_y).abs() < 1e-9,
            "{text} unrounded path drifted from measured main {main_y}, got {before}"
        );
        assert!(
            (after - pdf_y).abs() < 1e-6,
            "{text} baseline {after} != Sketch text-matrix {pdf_y}"
        );
        assert!((snapped.glyphs[0].x - pdf_x).abs() < 1e-6, "{text} x moved");
        assert!(
            (before - pdf_y).abs() > (after - pdf_y).abs(),
            "{text} did not move closer to the Sketch baseline"
        );
    }
}

#[test]
fn sketch_fixed_paragraphs_share_a_baseline_with_variable_heights_and_blank_lines() {
    let source = include_bytes!("../../../../testing/fixtures/design/sketch-text-layout-flow.sketch");
    let doc = import_sketch_report(source).unwrap().document;
    let fonts = Fonts::new().with_resources(&doc.fonts).unwrap();
    let node = doc.nodes.values().find(|node| node.name == "text-paragraphs").unwrap();
    let baselines = |node: &Node| {
        let layout = fonts.node_layout(node, Some(node.width)).unwrap();
        layout.lines.iter().filter_map(|line| {
            layout.glyphs.iter().find(|glyph| glyph.cluster == line.start).map(|glyph| glyph.y)
        }).collect::<Vec<_>>()
    };
    // Text matrices from Sketch's native PDF export at 1×, in node coordinates.
    assert_eq!(baselines(node), [23., 57., 99.]);
    let mut blank = node.clone();
    blank.text = "One\n\nThree".into();
    blank.text_runs[1].end = 5;
    blank.text_runs[2].start = 5;
    blank.text_runs[2].end = 10;
    assert_eq!(baselines(&blank), [23., 99.]);
    let mut descending = node.clone();
    for (run, height) in descending.text_runs.iter_mut().zip([40., 30., 20.]) {
        let paragraph = run.paragraph.as_mut().unwrap();
        paragraph.minimum_line_height = height;
        paragraph.maximum_line_height = height;
        paragraph.spacing = 0.;
    }
    assert_eq!(baselines(&descending), [38., 78., 108.]);
}

fn archive(layer: Value) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for (name, value) in [
        ("meta.json", json!({"version": 136})),
        (
            "document.json",
            json!({"_class":"document","colorSpace":1,"pages":[{"_class":"MSJSONFileReference","_ref":"pages/p"}]}),
        ),
        (
            "pages/p.json",
            json!({"_class":"page","do_objectID":"p","name":"USWDS colors","layers":[layer]}),
        ),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

#[test]
fn imported_uswds_label_keeps_encoded_color_and_requests_the_native_baseline() {
    let layer = json!({
        "_class": "text",
        "do_objectID": "T",
        "name": "50v",
        "frame": {"_class":"rect","x":0,"y":0,"width":22,"height":12},
        "attributedString": {
            "_class": "attributedString",
            "string": "50v",
            "attributes": [{
                "_class": "stringAttribute",
                "location": 0,
                "length": 3,
                "attributes": {
                    "MSAttributedStringFontAttribute": {
                        "_class": "fontDescriptor",
                        "attributes": {"name": "PublicSans-Regular", "size": 12}
                    },
                    "MSAttributedStringColorAttribute": {
                        "_class": "color",
                        "red": 0.1803921568627451,
                        "green": 0.1803921568627451,
                        "blue": 0.1803921568627451,
                        "alpha": 1
                    },
                    "paragraphStyle": {
                        "_class": "paragraphStyle",
                        "alignment": 2,
                        "minimumLineHeight": 12,
                        "maximumLineHeight": 12
                    }
                }
            }]
        }
    });
    let report = import_sketch_report(&archive(layer)).unwrap();
    let node = report
        .document
        .nodes
        .values()
        .find(|node| node.kind == "text" && node.text == "50v")
        .expect("imported label");
    assert_eq!(node.fills[0].color, "#2e2e2e");
    assert_eq!(node.text_style.as_ref().unwrap().line_box_baseline, "nearest-point");
    assert_eq!(node.text_style.as_ref().unwrap().align, "center");
    let paragraph = node.text_runs[0].paragraph.as_ref().unwrap();
    assert_eq!((paragraph.minimum_line_height, paragraph.maximum_line_height), (12., 12.));
    let mut laid = node.clone();
    laid.text_style.as_mut().unwrap().font_id = "PublicSans-Regular".into();
    // Admission keeps the source face name in metadata and points the run at
    // the default face until that resource is loaded. This check loads it.
    laid.text_runs[0].font_id = Some("PublicSans-Regular".into());
    let layout = fonts().node_layout(&laid, Some(laid.width)).unwrap();
    let glyph = &layout.glyphs[0];
    assert!((glyph.y - 10.).abs() < 1e-6, "imported label baseline {}", glyph.y);
    assert!((glyph.x - 0.458).abs() < 1e-6, "imported label x {}", glyph.x);
}

fn channel_delta(actual: image::Rgba<u8>, reference: image::Rgba<u8>) -> u8 {
    (0..4).map(|i| actual[i].abs_diff(reference[i])).max().unwrap()
}

#[test]
fn fifty_v_crop_moves_closer_to_the_sketch_preview_without_raising_the_threshold() {
    let reference = image::load_from_memory(PREVIEW).unwrap().to_rgba8();
    assert_eq!((reference.width(), reference.height()), (22, 12));
    let mut document = json!({
        "schemaVersion": 20,
        "id": "uswds-50v",
        "name": "50v",
        "pages": [{
            "id": "p",
            "name": "USWDS colors",
            "background": "#ffffff",
            "children": ["swatch", "t"]
        }],
        "nodes": {
            "swatch": {
                "id": "swatch",
                "kind": "rectangle",
                "name": "swatch",
                "transform": [1, 0, 0, 1, 24, 0],
                "width": 16,
                "height": 16,
                "fills": [{
                    "kind": "solid",
                    "color": "color(srgb 0.9058823529411765 0.9490196078431372 0.9607843137254902)",
                    "opacity": 1
                }]
            }
        },
        "fonts": {
            "PublicSans-Regular": resource("Public Sans", REGULAR)
        }
    });
    document["nodes"]["t"] = serde_json::to_value(node("50v", "PublicSans-Regular", 12., 22., 12., 12., "center", true)).unwrap();
    let mut engine = Engine::new();
    engine
        .load_font(include_bytes!("../../../../frontend/design-client/public/fonts/NotoSansSC.ttf"))
        .unwrap();
    engine.load_document(&document.to_string()).unwrap();
    // Main crop at the same 22×12, 1× viewport, before the baseline snap.
    let main_over0 = [("analytic", 139u32), ("figma", 131u32)];
    for (name, profile, previous) in [
        ("analytic", RasterProfile::Analytic, main_over0[0].1),
        ("figma", RasterProfile::Figma, main_over0[1].1),
    ] {
        let pixels = engine
            .render(&RenderOptions {
                page_id: "p".into(),
                width: 40,
                height: 16,
                view: View { x: 0., y: 0., zoom: 1. },
                transparent: false,
                grid: false,
                pixel_preview: None,
                animation: None,
                raster_profile: profile,
                interactive_effects: false,
                checkerboard: false,
            })
            .unwrap();
        let image = image::RgbaImage::from_raw(40, 16, pixels).unwrap();
        let swatch = image.get_pixel(32, 8);
        assert_eq!(swatch.0, [231, 242, 245, 255], "{name} swatch color changed");
        let mut over0 = 0u32;
        let mut over1 = 0u32;
        let mut over2 = 0u32;
        let mut max = 0u8;
        let mut darkest = [255u8; 4];
        for y in 0..12 {
            for x in 0..22 {
                let actual = image.get_pixel(x, y);
                let delta = channel_delta(*actual, *reference.get_pixel(x, y));
                max = max.max(delta);
                let sum = |px: [u8; 4]| u16::from(px[0]) + u16::from(px[1]) + u16::from(px[2]);
                if sum(actual.0) < sum(darkest) {
                    darkest = actual.0;
                }
                if delta > 0 {
                    over0 += 1;
                }
                if delta > 1 {
                    over1 += 1;
                }
                if delta > 2 {
                    over2 += 1;
                }
            }
        }
        println!(
            "MEASURE pixels profile={name} over0={over0} over1={over1} over2={over2} max={max} darkest={darkest:?} main_over0={previous}"
        );
        let expected = match name {
            "analytic" => 130,
            "figma" => 127,
            _ => unreachable!(),
        };
        assert_eq!(
            over0, expected,
            "{name} delta>0 pixels {over0}, main was {previous}"
        );
        assert!(
            over0 < previous,
            "{name} delta>0 pixels {over0} did not fall below main {previous}"
        );
        assert_eq!(darkest, [46, 46, 46, 255], "{name} text core color changed");
    }
}
