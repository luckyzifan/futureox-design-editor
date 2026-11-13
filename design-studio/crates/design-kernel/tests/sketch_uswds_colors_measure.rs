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
//!
//! Labels with no fixed line box were still on the raw font metrics.
//! Public Sans Bold at 12px drew baseline 11.4 and advanced 14.1; the
//! Quartz preview of the colors-page columns is 11, then +14. That shift
//! reaches 1.3px by the last row.
use base64::Engine as _;
use futureox_design_kernel::fidelity::RasterProfile;
use futureox_design_kernel::font::{FontResource, Fonts};
use futureox_design_kernel::interop::import_sketch_report;
use futureox_design_kernel::scene::Node;
use futureox_design_kernel::{Engine, RenderOptions, View};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Write;

const REGULAR: &[u8] = include_bytes!("PublicSans-Regular.otf");
const LIGHT: &[u8] = include_bytes!("PublicSans-Light.otf");
const BOLD: &[u8] = include_bytes!("PublicSans-Bold.otf");
const PREVIEW: &[u8] = include_bytes!("uswds-50v-sketch-preview.png");
const OLD_PREVIEW: &[u8] = include_bytes!("uswds-old-sketch-preview.png");
const COLUMN_PREVIEW: &[u8] = include_bytes!("uswds-column-sketch-preview.png");
const CHANGED_PREVIEW: &[u8] = include_bytes!("uswds-changed-sketch-preview.png");

fn resource(family: &str, bytes: &[u8]) -> FontResource {
    FontResource {
        family: family.into(),
        data: base64::engine::general_purpose::STANDARD
            .encode(bytes)
            .into(),
        index: 0,
        postscript: Some(family.into()),
    }
}

fn node(
    text: &str,
    font: &str,
    size: f64,
    width: f64,
    height: f64,
    line: f64,
    align: &str,
    snap: bool,
) -> Node {
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
    resources.insert(
        "PublicSans-Regular".into(),
        resource("Public Sans", REGULAR),
    );
    resources.insert(
        "PublicSans-Light".into(),
        resource("Public Sans Light", LIGHT),
    );
    resources.insert("PublicSans-Bold".into(), resource("Public Sans", BOLD));
    let mut fonts = Fonts::new();
    fonts
        .load(include_bytes!(
            "../../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
        .unwrap();
    fonts.with_resources(&resources).unwrap()
}

#[test]
fn fixed_line_box_baseline_matches_sketch_text_preview_and_keeps_fractional_x() {
    let fonts = fonts();
    // (text, font, size, width, height, line, align, pdf baseline, pdf x, main y)
    let cases = [
        (
            "50v",
            "PublicSans-Regular",
            12.,
            22.,
            12.,
            12.,
            "center",
            10.,
            0.458,
            10.35,
        ),
        (
            "5",
            "PublicSans-Regular",
            14.,
            84.,
            23.,
            24.,
            "start",
            17.,
            0.,
            17.075,
        ),
        (
            "blue cool",
            "PublicSans-Light",
            20.,
            128.,
            23.,
            24.,
            "start",
            19.,
            0.,
            19.25,
        ),
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
    // The flow archive is a local testing fixture, not part of the git tree.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../testing/fixtures/design/sketch-text-layout-flow.sketch");
    let source = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("NOT_RUN {}: {error}", path.display());
            return;
        }
    };
    let doc = import_sketch_report(&source).unwrap().document;
    let fonts = Fonts::new().with_resources(&doc.fonts).unwrap();
    let node = doc
        .nodes
        .values()
        .find(|node| node.name == "text-paragraphs")
        .unwrap();
    let baselines = |node: &Node| {
        let layout = fonts.node_layout(node, Some(node.width)).unwrap();
        layout
            .lines
            .iter()
            .filter_map(|line| {
                layout
                    .glyphs
                    .iter()
                    .find(|glyph| glyph.cluster == line.start)
                    .map(|glyph| glyph.y)
            })
            .collect::<Vec<_>>()
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
    assert_eq!(
        node.text_style.as_ref().unwrap().line_box_baseline,
        "nearest-point"
    );
    assert_eq!(node.text_style.as_ref().unwrap().align, "center");
    let paragraph = node.text_runs[0].paragraph.as_ref().unwrap();
    assert_eq!(
        (paragraph.minimum_line_height, paragraph.maximum_line_height),
        (12., 12.)
    );
    let mut laid = node.clone();
    laid.text_style.as_mut().unwrap().font_id = "PublicSans-Regular".into();
    // Admission keeps the source face name in metadata and points the run at
    // the default face until that resource is loaded. This check loads it.
    laid.text_runs[0].font_id = Some("PublicSans-Regular".into());
    let layout = fonts().node_layout(&laid, Some(laid.width)).unwrap();
    let glyph = &layout.glyphs[0];
    assert!(
        (glyph.y - 10.).abs() < 1e-6,
        "imported label baseline {}",
        glyph.y
    );
    assert!(
        (glyph.x - 0.458).abs() < 1e-6,
        "imported label x {}",
        glyph.x
    );
}

fn channel_delta(actual: image::Rgba<u8>, reference: image::Rgba<u8>) -> u8 {
    (0..4)
        .map(|i| actual[i].abs_diff(reference[i]))
        .max()
        .unwrap()
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
    document["nodes"]["t"] = serde_json::to_value(node(
        "50v",
        "PublicSans-Regular",
        12.,
        22.,
        12.,
        12.,
        "center",
        true,
    ))
    .unwrap();
    let mut engine = Engine::new();
    engine
        .load_font(include_bytes!(
            "../../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
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
                view: View {
                    x: 0.,
                    y: 0.,
                    zoom: 1.,
                },
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
        assert_eq!(
            swatch.0,
            [231, 242, 245, 255],
            "{name} swatch color changed"
        );
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
            // Analytic now paints the FreeType mask. Figma profiles keep the
            // outlines, so that count stays on the previous analytic-adjacent
            // rasterizer.
            "analytic" => 121,
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

fn auto_label(
    text: &str,
    font: &str,
    size: f64,
    width: f64,
    height: f64,
    color: &str,
    origin_x: f64,
) -> Node {
    serde_json::from_value(json!({
        "id": "t",
        "kind": "text",
        "name": text,
        "text": text,
        "fontSize": size,
        "width": width,
        "height": height,
        "transform": [1, 0, 0, 1, origin_x, 0],
        "textStyle": {
            "fontId": font,
            "lineHeight": 1.35,
            "lineHeightAuto": true,
            "align": "start",
            "wrap": false
        },
        "fills": [{ "kind": "solid", "color": color, "opacity": 1 }]
    }))
    .unwrap()
}

fn line_baselines(fonts: &futureox_design_kernel::font::Fonts, node: &Node) -> Vec<f64> {
    let layout = fonts.node_layout(node, Some(node.width)).unwrap();
    layout
        .lines
        .iter()
        .filter_map(|line| {
            layout
                .glyphs
                .iter()
                .find(|glyph| glyph.cluster == line.start)
                .map(|glyph| glyph.y)
        })
        .collect()
}

fn render_label(
    node: Node,
    fonts_doc: serde_json::Value,
    width: u32,
    height: u32,
) -> image::RgbaImage {
    let mut document = json!({
        "schemaVersion": 20,
        "id": "uswds-label",
        "name": "label",
        "pages": [{
            "id": "p",
            "name": "USWDS colors",
            "background": "#ffffff",
            "children": ["t"]
        }],
        "fonts": fonts_doc
    });
    document["nodes"]["t"] = serde_json::to_value(node).unwrap();
    let mut engine = Engine::new();
    engine
        .load_font(include_bytes!(
            "../../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
        .unwrap();
    engine.load_document(&document.to_string()).unwrap();
    let pixels = engine
        .render(&RenderOptions {
            page_id: "p".into(),
            width,
            height,
            view: View {
                x: 0.,
                y: 0.,
                zoom: 1.,
            },
            transparent: false,
            grid: false,
            pixel_preview: None,
            animation: None,
            raster_profile: RasterProfile::Analytic,
            interactive_effects: false,
            checkerboard: false,
        })
        .unwrap();
    image::RgbaImage::from_raw(width, height, pixels).unwrap()
}

fn screen(actual: &image::RgbaImage, reference: &image::RgbaImage) -> (u32, u32, u8) {
    let mut over0 = 0u32;
    let mut over16 = 0u32;
    let mut max = 0u8;
    for y in 0..reference.height() {
        for x in 0..reference.width() {
            let delta = channel_delta(*actual.get_pixel(x, y), *reference.get_pixel(x, y));
            max = max.max(delta);
            if delta > 0 {
                over0 += 1;
            }
            if delta > 16 {
                over16 += 1;
            }
        }
    }
    (over0, over16, max)
}

#[test]
fn unspecified_line_box_matches_quartz_column_pitch_and_old_new_baseline() {
    let fonts = fonts();
    let old = auto_label("Old", "PublicSans-Bold", 12., 20., 14., "#2e2e2e", 0.);
    let baselines = line_baselines(&fonts, &old);
    assert_eq!(baselines, vec![11.]);
    let layout = fonts.node_layout(&old, Some(old.width)).unwrap();
    assert!(
        (layout.height - 14.).abs() < 1e-6,
        "Old line box {}",
        layout.height
    );
    // Raw ascender 11.4 and natural pitch 14.1 are what main drew.
    assert!((baselines[0] - 11.4).abs() > 0.3);

    let column = "5\n10\n20\n30\n40\n50\n60\n70\n80\u{2028}90";
    let column = auto_label(column, "PublicSans-Bold", 12., 16., 140., "#000000", 0.);
    assert_eq!(
        line_baselines(&fonts, &column),
        vec![11., 25., 39., 53., 67., 81., 95., 109., 123., 137.]
    );

    let changed = auto_label(
        "Changed values in 2.6.0",
        "PublicSans-Light",
        20.,
        218.,
        24.,
        "#2e2e2e",
        0.5,
    );
    let changed_lines = line_baselines(&fonts, &changed);
    assert_eq!(changed_lines, vec![19.]);
    let changed_layout = fonts.node_layout(&changed, Some(changed.width)).unwrap();
    assert!(
        (changed_layout.height - 24.).abs() < 1e-6,
        "{}",
        changed_layout.height
    );

    // Kerning, not a second centering rule, is why "80v" is not at the
    // advance-only center 0.416. The PDF text matrix is 0.455.
    let eighty = fonts
        .node_layout(
            &node(
                "80v",
                "PublicSans-Regular",
                12.,
                22.,
                12.,
                12.,
                "center",
                true,
            ),
            Some(22.),
        )
        .unwrap();
    assert!(
        (eighty.glyphs[0].x - 0.455).abs() < 1e-6,
        "80v x {}",
        eighty.glyphs[0].x
    );
    assert!(
        (eighty.glyphs[0].y - 10.).abs() < 1e-6,
        "80v y {}",
        eighty.glyphs[0].y
    );
}

#[test]
fn unspecified_line_box_crops_move_under_the_misplaced_column() {
    let old_ref = image::load_from_memory(OLD_PREVIEW).unwrap().to_rgba8();
    let column_ref = image::load_from_memory(COLUMN_PREVIEW).unwrap().to_rgba8();
    let changed_ref = image::load_from_memory(CHANGED_PREVIEW).unwrap().to_rgba8();
    assert_eq!((old_ref.width(), old_ref.height()), (20, 14));
    assert_eq!((column_ref.width(), column_ref.height()), (16, 140));
    assert_eq!((changed_ref.width(), changed_ref.height()), (219, 24));
    let bold = resource("Public Sans", BOLD);
    let light = resource("Public Sans Light", LIGHT);
    let old = render_label(
        auto_label("Old", "PublicSans-Bold", 12., 20., 14., "#2e2e2e", 0.),
        json!({ "PublicSans-Bold": bold }),
        20,
        14,
    );
    let column = render_label(
        auto_label(
            "5\n10\n20\n30\n40\n50\n60\n70\n80\u{2028}90",
            "PublicSans-Bold",
            12.,
            16.,
            140.,
            "#000000",
            0.,
        ),
        json!({ "PublicSans-Bold": resource("Public Sans", BOLD) }),
        16,
        140,
    );
    let changed = render_label(
        auto_label(
            "Changed values in 2.6.0",
            "PublicSans-Light",
            20.,
            218.,
            24.,
            "#2e2e2e",
            0.5,
        ),
        json!({ "PublicSans-Light": light }),
        219,
        24,
    );
    let (old0, old16, old_max) = screen(&old, &old_ref);
    let (col0, col16, col_max) = screen(&column, &column_ref);
    let (chg0, chg16, chg_max) = screen(&changed, &changed_ref);
    println!(
        "MEASURE auto old over0={old0} over16={old16} max={old_max} column over0={col0} over16={col16} max={col_max} changed over0={chg0} over16={chg16} max={chg_max}"
    );
    // Unrounded analytic coverage was over16 103/280 (max 149) for "Old"
    // and 908/2240 (max 255) for the column. Line-box rounding left
    // 22/285/402. Splash's FreeType mask brings every one of those under
    // the channel-delta > 16 screening line. The locks are this engine
    // against poppler 24.02.0 at 72 dpi, not a raised threshold.
    assert_eq!((old0, old16, old_max), (108, 0, 13), "Old crop");
    assert_eq!((col0, col16, col_max), (827, 0, 16), "column crop");
    assert_eq!((chg0, chg16, chg_max), (1173, 0, 13), "changed crop");
    assert_eq!(old16, 0, "Old still exceeds the screening line");
    assert_eq!(col16, 0, "column still exceeds the screening line");
    assert_eq!(chg16, 0, "changed still exceeds the screening line");
}

const SEMIBOLD: &[u8] = include_bytes!("PublicSans-SemiBold.otf");
const ROBOTO: &[u8] = include_bytes!("RobotoMono-Regular.ttf");
const ORACLE: &str = include_str!("uswds-text-preview-oracle.json");

fn preview_fonts() -> Fonts {
    let mut resources = BTreeMap::new();
    resources.insert(
        "PublicSans-Regular".into(),
        resource("Public Sans", REGULAR),
    );
    resources.insert(
        "PublicSans-Light".into(),
        resource("Public Sans Light", LIGHT),
    );
    resources.insert("PublicSans-Bold".into(), resource("Public Sans", BOLD));
    resources.insert(
        "PublicSans-SemiBold".into(),
        resource("Public Sans", SEMIBOLD),
    );
    resources.insert("RobotoMono-Regular".into(), resource("Roboto Mono", ROBOTO));
    let mut fonts = Fonts::new();
    fonts
        .load(include_bytes!(
            "../../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
        .unwrap();
    fonts.with_resources(&resources).unwrap()
}

fn oracle_node(row: &Value) -> Node {
    let runs = row["runs"].as_array().unwrap();
    let first = &runs[0];
    let size = first["size"].as_f64().unwrap();
    let fixed = runs.iter().all(|run| {
        let min = run["min"].as_f64().unwrap();
        let max = run["max"].as_f64().unwrap();
        min > 0. && (min - max).abs() <= 1e-9
    });
    let mut style = json!({
        "fontId": first["font"],
        "lineHeight": if fixed { first["min"].as_f64().unwrap() / size } else { 1.35 },
        "align": first["align"],
        "wrap": false
    });
    if fixed {
        style["lineBoxBaseline"] = json!("nearest-point");
    } else {
        style["lineHeightAuto"] = json!(true);
    }
    let text_runs: Vec<Value> = runs
        .iter()
        .map(|run| {
            let mut value = json!({
                "start": run["start"],
                "end": run["end"],
                "fontId": run["font"],
                "fontSize": run["size"]
            });
            if fixed {
                value["paragraph"] = json!({
                    "align": run["align"],
                    "minimumLineHeight": run["min"],
                    "maximumLineHeight": run["max"],
                    "spacing": 0,
                    "indent": 0
                });
            }
            value
        })
        .collect();
    serde_json::from_value(json!({
        "id": "t",
        "kind": "text",
        "name": "preview",
        "text": row["text"],
        "fontSize": size,
        "width": row["w"],
        "height": row["h"],
        "transform": [1, 0, 0, 1, row["tx"].as_f64().unwrap_or(0.), row["ty"].as_f64().unwrap_or(0.)],
        "textStyle": style,
        "textRuns": text_runs,
        "fills": [{ "kind": "solid", "color": first["color"], "opacity": 1 }]
    }))
    .unwrap()
}

#[test]
fn every_shipped_text_preview_matches_the_quartz_text_matrix() {
    let fonts = preview_fonts();
    let rows: Vec<Value> = serde_json::from_str(ORACLE).unwrap();
    assert!(rows.len() > 900, "oracle shrunk to {}", rows.len());
    let mut y_err = 0f64;
    let mut x_err = 0f64;
    let mut failures = Vec::new();
    for row in &rows {
        let node = oracle_node(row);
        let layout = match fonts.node_layout(&node, Some(node.width)) {
            Ok(layout) => layout,
            Err(error) => {
                failures.push(format!("page {} layout {error}", row["page"]));
                continue;
            }
        };
        let mut got_y = Vec::new();
        let mut got_x = Vec::new();
        for line in &layout.lines {
            if let Some(glyph) = layout
                .glyphs
                .iter()
                .find(|glyph| glyph.cluster == line.start)
            {
                got_y.push(glyph.y);
                got_x.push(glyph.x);
            }
        }
        let want_y: Vec<f64> = row["ys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        let want_x: Vec<f64> = row["xs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        if got_y.len() != want_y.len() {
            failures.push(format!(
                "page {} {:?} lines got {} want {}",
                row["page"],
                row["text"],
                got_y.len(),
                want_y.len()
            ));
            continue;
        }
        for (got, want) in got_y.iter().zip(&want_y) {
            y_err = y_err.max((got - want).abs());
        }
        for (got, want) in got_x.iter().zip(&want_x) {
            x_err = x_err.max((got - want).abs());
        }
        // Eleven centered labels differ by 6 or 8 font units (0.036–0.048px),
        // a kern pair Quartz did not apply. That shift stays under the 16/255
        // screening line. Baselines are exact.
        if got_y
            .iter()
            .zip(&want_y)
            .any(|(got, want)| (got - want).abs() > 1e-3)
            || got_x
                .iter()
                .zip(&want_x)
                .any(|(got, want)| (got - want).abs() > 0.05)
        {
            failures.push(format!(
                "page {} {:?} y {got_y:?} want {want_y:?} x {got_x:?} want {want_x:?}",
                row["page"], row["text"]
            ));
        }
    }
    println!(
        "MEASURE preview matrices pages={} max_y_err={y_err:.6} max_x_err={x_err:.6} failures={}",
        rows.len(),
        failures.len()
    );
    assert_eq!(y_err, 0., "a text-preview baseline moved");
    assert!(
        x_err <= 0.048 + 1e-6,
        "horizontal origin error {x_err} exceeds the measured 8-unit kern residual"
    );
    assert!(
        failures.is_empty(),
        "{} text matrices missed the Quartz preview:\n{}",
        failures.len(),
        failures
            .iter()
            .take(12)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// Full poppler sweep of the shipped text-preview pages. Not part of the
/// default test run: it reads a local `pdftoppm -r 72` directory.
#[test]
#[ignore = "set USWDS_PREVIEW_PNG to a 72 dpi pdftoppm directory of text-previews.pdf"]
fn poppler_preview_pixel_sweep() {
    let Ok(dir) = std::env::var("USWDS_PREVIEW_PNG") else {
        eprintln!("NOT_RUN USWDS_PREVIEW_PNG is unset");
        return;
    };
    let rows: Vec<Value> = serde_json::from_str(ORACLE).unwrap();
    let fonts_doc = json!({
        "PublicSans-Regular": resource("Public Sans", REGULAR),
        "PublicSans-Light": resource("Public Sans Light", LIGHT),
        "PublicSans-Bold": resource("Public Sans", BOLD),
        "PublicSans-SemiBold": resource("Public Sans", SEMIBOLD),
        "RobotoMono-Regular": resource("Roboto Mono", ROBOTO)
    });
    let mut engine = Engine::new();
    engine
        .load_font(include_bytes!(
            "../../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
        .unwrap();
    let mut compared = 0u64;
    let mut over16 = 0u64;
    let mut colors_over16 = 0u64;
    let mut colors_pixels = 0u64;
    let mut max = 0u8;
    let mut hot = Vec::new();
    for row in &rows {
        let page = row["page"].as_u64().unwrap();
        let path = std::path::Path::new(&dir).join(format!("p-{page:03}.png", page = page + 1));
        let reference = image::open(&path).unwrap().to_rgba8();
        let node = oracle_node(row);
        let width = reference.width();
        let height = reference.height();
        let image = render_label_with(&mut engine, node, &fonts_doc, width, height);
        let mut page_over16 = 0u32;
        let mut page_max = 0u8;
        let overlap_w = width.min(row["w"].as_f64().unwrap().round() as u32);
        let overlap_h = height.min(row["h"].as_f64().unwrap().round() as u32);
        for y in 0..overlap_h {
            for x in 0..overlap_w {
                let delta = channel_delta(*image.get_pixel(x, y), *reference.get_pixel(x, y));
                page_max = page_max.max(delta);
                if delta > 16 {
                    page_over16 += 1;
                }
            }
        }
        let area = u64::from(overlap_w) * u64::from(overlap_h);
        compared += area;
        over16 += u64::from(page_over16);
        if row["board"] == "colors" {
            colors_pixels += area;
            colors_over16 += u64::from(page_over16);
        }
        max = max.max(page_max);
        if page_max > 100 && hot.len() < 12 {
            hot.push(format!(
                "page {page} {:?} max {page_max} over16 {page_over16}",
                row["text"]
            ));
        }
    }
    let artboard = 3193u64 * 3821u64;
    println!(
        "MEASURE sweep pages={} compared={compared} over16={over16} max={max} colors_pixels={colors_pixels} colors_over16={colors_over16} colors_artboard_pct={:.4} hot={hot:?}",
        rows.len(),
        100.0 * colors_over16 as f64 / artboard as f64
    );
    assert!(
        hot.is_empty(),
        "a preview still misses by more than 100: {hot:?}"
    );
    assert!(colors_pixels > 0, "colors-page text neighborhood was empty");
    assert!(
        colors_over16 * 100 < colors_pixels,
        "colors-page text neighborhood still exceeds the 1% screening line: {colors_over16}/{colors_pixels}"
    );
    assert!(
        colors_over16 * 100 < artboard,
        "colors-page text still exceeds the 1% artboard screening line: {colors_over16}/{artboard}"
    );
}

fn render_label_with(
    engine: &mut Engine,
    node: Node,
    fonts_doc: &Value,
    width: u32,
    height: u32,
) -> image::RgbaImage {
    let mut document = json!({
        "schemaVersion": 20,
        "id": "uswds-label",
        "name": "label",
        "pages": [{
            "id": "p",
            "name": "USWDS colors",
            "background": "#ffffff",
            "children": ["t"]
        }],
        "fonts": fonts_doc
    });
    document["nodes"]["t"] = serde_json::to_value(node).unwrap();
    engine.load_document(&document.to_string()).unwrap();
    let pixels = engine
        .render(&RenderOptions {
            page_id: "p".into(),
            width,
            height,
            view: View {
                x: 0.,
                y: 0.,
                zoom: 1.,
            },
            transparent: false,
            grid: false,
            pixel_preview: None,
            animation: None,
            raster_profile: RasterProfile::Analytic,
            interactive_effects: false,
            checkerboard: false,
        })
        .unwrap();
    image::RgbaImage::from_raw(width, height, pixels).unwrap()
}
