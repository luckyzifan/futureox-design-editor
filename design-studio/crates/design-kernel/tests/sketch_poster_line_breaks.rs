//! Issue #81. Palette examples is not in this tree; these checks use the
//! fixed bundled ABeeZee-Regular file and the face's own hmtx / vertical
//! metrics as the reference. They do not treat a family-name match as
//! wrap agreement.
use futureox_design_kernel::{font::Fonts, interop, layout, scene::Document};
use serde_json::json;
use std::io::{Cursor, Write};

fn abeezee_bytes() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/abeezee/ABeeZee-Regular.ttf"
    ))
    .unwrap()
}

fn fonts() -> Fonts {
    let mut fonts = Fonts::new();
    fonts.load(&abeezee_bytes()).unwrap();
    fonts
}

fn text_node(
    text: &str,
    width: f64,
    spacing: f64,
    auto_line_box: bool,
) -> futureox_design_kernel::scene::Node {
    let node: futureox_design_kernel::scene::Node = serde_json::from_value(json!({
        "id": "title",
        "kind": "text",
        "name": "Palette examples",
        "text": text,
        "fontSize": 28.0,
        "width": width,
        "height": 120.0,
        "textStyle": {
            "fontId": "default",
            "wrap": true,
            "lineHeight": 1.35,
            "lineHeightAuto": auto_line_box,
            "letterSpacing": spacing,
            "align": "start"
        },
        "sizing": {"width": "fixed", "height": "hug"},
        "fills": [{"kind": "solid", "color": "#111111"}]
    }))
    .unwrap();
    node
}

fn line_spans(fonts: &Fonts, node: &futureox_design_kernel::scene::Node) -> Vec<(usize, usize)> {
    fonts
        .node_layout(node, Some(node.width))
        .unwrap()
        .lines
        .iter()
        .map(|line| (line.start, line.end))
        .collect()
}

fn unwrapped_width(fonts: &Fonts, text: &str) -> f64 {
    let mut node = text_node(text, 10000., 0., false);
    node.text_style.as_mut().unwrap().wrap = false;
    fonts.node_layout(&node, None).unwrap().width
}

fn hmtx_width(text: &str, size: f64) -> f64 {
    let bytes = abeezee_bytes();
    let face = ttf_parser::Face::parse(&bytes, 0).unwrap();
    let scale = size / f64::from(face.units_per_em());
    text.chars()
        .map(|ch| {
            let id = face.glyph_index(ch).unwrap();
            f64::from(face.glyph_hor_advance(id).unwrap()) * scale
        })
        .sum()
}

fn natural_line_box(size: f64) -> f64 {
    let bytes = abeezee_bytes();
    let face = ttf_parser::Face::parse(&bytes, 0).unwrap();
    (f64::from(face.ascender()) - f64::from(face.descender()) + f64::from(face.line_gap())) * size
        / f64::from(face.units_per_em())
}

/// Independent of the wrapper. Cluster advances come from one unwrapped
/// shape of the same font file; breaks are a separate greedy word wrap that
/// keeps a word when only the following space overflows.
fn reference_word_breaks(fonts: &Fonts, text: &str, width: f64) -> Vec<(usize, usize)> {
    let mut flat = text_node(text, 10000., 0., false);
    flat.text_style.as_mut().unwrap().wrap = false;
    let layout = fonts.node_layout(&flat, None).unwrap();
    let mut units = Vec::new();
    for glyph in &layout.glyphs {
        let ch = text.chars().nth(glyph.cluster).unwrap();
        units.push((glyph.cluster, glyph.cluster_end, ch, glyph.advance));
    }
    let mut lines = Vec::new();
    let mut index = 0;
    while index < units.len() {
        let start = units[index].0;
        let mut content = 0.;
        let mut pending = 0.;
        let mut end = units[index].1;
        while index < units.len() {
            let (_, next, ch, advance) = units[index];
            if ch == ' ' {
                pending += advance;
                end = next;
                index += 1;
                continue;
            }
            // The shaped advance includes no extra tracking here. A word that
            // fits after the pending space is committed; a space that only
            // overflows stays behind and does not eject the previous word.
            if content > 0. && content + pending + advance > width {
                break;
            }
            content += pending + advance;
            pending = 0.;
            end = next;
            index += 1;
        }
        while index < units.len() && units[index].2 == ' ' {
            end = units[index].1;
            index += 1;
        }
        lines.push((start, end));
    }
    lines
}

fn title() -> String {
    "Palette Palette Palette Palette Palette Palette".to_string()
}

fn fitted_box(fonts: &Fonts) -> f64 {
    let pair = unwrapped_width(fonts, "Palette Palette");
    let with_trailing_space = unwrapped_width(fonts, "Palette Palette ");
    let space = unwrapped_width(fonts, " ");
    assert!(
        with_trailing_space > pair + space * 0.5,
        "the trailing space must be wider than the fit pad"
    );
    pair + space * 0.25
}

#[test]
fn fixed_abeezee_advance_matches_hmtx_and_tracking_is_points() {
    let fonts = fonts();
    let glyph = unwrapped_width(&fonts, "P");
    let tables = hmtx_width("P", 28.);
    assert!(
        (glyph - tables).abs() < 1e-6,
        "shaped advance {glyph} differs from hmtx {tables}"
    );
    let plain = unwrapped_width(&fonts, "Palette");
    let mut tracked = text_node("Palette", 10000., 4., false);
    tracked.text_style.as_mut().unwrap().wrap = false;
    let tracked_width = fonts.node_layout(&tracked, None).unwrap().width;
    // Seven letters, six gaps. Sketch kerning is points, already confirmed
    // by the official v120/v123 Headline glyph bounds (16 * 7 = 112).
    assert!(
        (tracked_width - plain - 24.).abs() < 1e-6,
        "tracking delta {} is not 6 * 4 points",
        tracked_width - plain
    );
}

#[test]
fn fixed_abeezee_title_stays_three_lines_when_the_following_space_overflows() {
    let fonts = fonts();
    let text = title();
    let width = fitted_box(&fonts);
    let reference = reference_word_breaks(&fonts, &text, width);
    assert_eq!(
        reference.len(),
        3,
        "shaped-advance reference is not three lines: {reference:?}"
    );
    let node = text_node(&text, width, 0., true);
    let layout = fonts.node_layout(&node, Some(node.width)).unwrap();
    let actual: Vec<_> = layout
        .lines
        .iter()
        .map(|line| (line.start, line.end))
        .collect();
    assert_eq!(
        actual,
        reference,
        "editor line count {} vs shaped-advance reference {}",
        layout.lines.len(),
        reference.len()
    );
    assert_eq!(
        node.width, width,
        "text box width must stay the fitted frame"
    );
    let natural = natural_line_box(28.).round_ties_even();
    assert!(
        (layout.height - natural * 3.).abs() < 1e-6,
        "text box height {} != 3 * nearest-point font line box {natural}",
        layout.height
    );
    let mut floor = node.clone();
    floor.text_style.as_mut().unwrap().line_height_auto = false;
    let floored = fonts.node_layout(&floor, Some(floor.width)).unwrap();
    assert!(
        (floored.height - 28. * 1.35 * 3.).abs() < 1e-6,
        "removing the Sketch auto line box must restore the 1.35 floor, got {}",
        floored.height
    );
    assert!(
        (natural - 28. * 1.35).abs() > 1.,
        "ABeeZee line box must differ from the 1.35 floor or this check is vacuous"
    );
}

#[test]
fn edit_and_reopen_keep_the_three_line_title_and_frame() {
    let fonts = fonts();
    let text = title();
    let width = fitted_box(&fonts);
    let mut document = sketch_document(&text, width);
    let node = document.nodes.get_mut("title").unwrap();
    node.text_style.as_mut().unwrap().font_id = "default".into();
    node.text_runs.clear();
    let before = line_spans(&fonts, node);
    assert_eq!(before.len(), 3);
    assert_eq!(node.width, width);
    // An edit that does not change wrapping inputs, then FD save/reopen.
    node.opacity = 0.5;
    let encoded = serde_json::to_vec(&document).unwrap();
    let reopened: Document = serde_json::from_slice(&encoded).unwrap();
    let node = &reopened.nodes["title"];
    assert_eq!(node.opacity, 0.5);
    assert_eq!(node.width, width);
    assert_eq!(node.text, text);
    assert!(node.text_style.as_ref().unwrap().line_height_auto);
    assert_eq!(line_spans(&fonts, node), before);
    layout::resolve(&mut document, &fonts).unwrap();
    let solved = &document.nodes["title"];
    assert_eq!(solved.width, width);
    let natural = natural_line_box(28.).round_ties_even();
    assert!(
        (solved.height - natural * 3.).abs() < 1e-6,
        "hug height {}",
        solved.height
    );
    // Sketch export/import keeps the frame and the derived breaks.
    let exported = interop::export_sketch(&document).unwrap();
    let mut imported = interop::import_sketch_report(&exported).unwrap().document;
    let imported_node = imported
        .nodes
        .values_mut()
        .find(|n| n.kind == "text")
        .unwrap();
    imported_node.text_style.as_mut().unwrap().font_id = "default".into();
    imported_node.text_runs.clear();
    assert!((imported_node.width - width).abs() < 1e-6);
    assert_eq!(imported_node.text, text);
    assert!(imported_node.text_style.as_ref().unwrap().line_height_auto);
    assert_eq!(line_spans(&fonts, imported_node), before);
}

fn sketch_document(text: &str, width: f64) -> Document {
    let layer = json!({
        "_class": "text",
        "do_objectID": "title",
        "name": "Palette examples",
        "frame": {"_class": "rect", "x": 12.0, "y": 24.0, "width": width, "height": 90.0},
        "textBehaviour": 1,
        "lineSpacingBehaviour": 2,
        "attributedString": {
            "_class": "attributedString",
            "string": text,
            "attributes": [{
                "_class": "stringAttribute",
                "location": 0,
                "length": text.encode_utf16().count(),
                "attributes": {
                    "MSAttributedStringFontAttribute": {
                        "_class": "fontDescriptor",
                        "attributes": {"name": "ABeeZee-Regular", "size": 28}
                    },
                    "kerning": 0,
                    "paragraphStyle": {"_class": "paragraphStyle", "alignment": 0}
                }
            }]
        }
    });
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, value) in [
        ("meta.json", json!({"appVersion": "93"})),
        ("document.json", json!({"pages": [{"_ref": "pages/p"}]})),
        (
            "pages/p.json",
            json!({"_class": "page", "do_objectID": "p", "name": "Poster", "layers": [layer]}),
        ),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    interop::import_sketch_report(&zip.finish().unwrap().into_inner())
        .unwrap()
        .document
}
