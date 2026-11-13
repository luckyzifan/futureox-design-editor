//! Issue #81. Palette examples is not in this tree. These checks pin the
//! bundled ABeeZee-Regular and Noto Sans SC files. Word widths come from
//! those files' hmtx and GPOS, not from a box derived only after the wrapper
//! has already measured itself. A breaking space that does not fit must not
//! drop the word already on the line.
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

fn noto_bytes() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
    ))
    .unwrap()
}

fn noto_fonts() -> Fonts {
    let mut fonts = Fonts::new();
    fonts.load(&noto_bytes()).unwrap();
    fonts
}

/// Breaking spaces hang. No-break spaces do not. Kept aligned with
/// `overflow_hangs` in the kernel.
fn hangs(ch: char) -> bool {
    !matches!(ch, '\u{00A0}' | '\u{202F}' | '\u{FEFF}') && ch.is_whitespace()
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
            if hangs(ch) {
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
        while index < units.len() && hangs(units[index].2) {
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
    // hmtx sum of Palette is 3426 units. GPOS format-1 pairs Pa/le/te are
    // -15/-15/-20, so the kerned width is 3376 units at 28 px. Both numbers
    // are the font file, not the wrapper's previous output.
    let table_word = hmtx_width("Palette", 28.);
    let kerned_word = 3376.0 * 28.0 / 1000.0;
    assert!(
        (table_word - 3426.0 * 28.0 / 1000.0).abs() < 1e-9,
        "hmtx Palette {table_word}"
    );
    assert!(
        (plain - kerned_word).abs() < 1e-6,
        "shaped Palette {plain} is not the font's kerned width {kerned_word} (hmtx {table_word})"
    );
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
    // Two kerned words plus the space between them, plus a quarter of the
    // following space. 7127 font units at 28 px is 199.556.
    let table_width = 7127.0 * 28.0 / 1000.0;
    assert!(
        (width - table_width).abs() < 1e-6,
        "fitted box {width} drifted from the font-table width {table_width}"
    );
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
    let natural = natural_line_box(28.);
    assert!(
        (layout.height - natural * 3.).abs() < 1e-6,
        "text box height {} != 3 * font line box {natural}",
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
    let natural = natural_line_box(28.);
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

/// The old rewind. A separator that does not fit is not consumed, so the last
/// legal break is still the previous separator. The word between them drops
/// onto the next line.
fn rewind_breaks(fonts: &Fonts, text: &str, width: f64) -> Vec<(usize, usize)> {
    let mut flat = text_node(text, 10000., 0., false);
    flat.text_style.as_mut().unwrap().wrap = false;
    let layout = fonts.node_layout(&flat, None).unwrap();
    let units: Vec<_> = layout
        .glyphs
        .iter()
        .map(|glyph| {
            let ch = text.chars().nth(glyph.cluster).unwrap();
            (glyph.cluster, glyph.cluster_end, ch, glyph.advance)
        })
        .collect();
    let mut lines = Vec::new();
    let mut index = 0;
    while index < units.len() {
        let start = units[index].0;
        let mut content = 0.;
        let mut legal = index;
        let mut end = index;
        while end < units.len() {
            if end > index && content + units[end].3 > width {
                break;
            }
            content += units[end].3;
            end += 1;
            if hangs(units[end - 1].2) {
                legal = end;
            }
        }
        if end < units.len() && legal > index {
            end = legal;
        }
        lines.push((start, units[end - 1].1));
        index = end;
    }
    lines
}

fn utf16_slice(text: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16(&units[start..end]).unwrap()
}

#[test]
fn breaking_en_space_keeps_the_fitted_word_on_three_lines() {
    let fonts = noto_fonts();
    let text = "Palette\u{2002}Palette\u{2002}Palette\u{2002}Palette\u{2002}Palette\u{2002}Palette";
    let pair = unwrapped_width(&fonts, "Palette\u{2002}Palette");
    let with_trailing = unwrapped_width(&fonts, "Palette\u{2002}Palette\u{2002}");
    let sep = unwrapped_width(&fonts, "\u{2002}");
    let sep_table = {
        let bytes = noto_bytes();
        let face = ttf_parser::Face::parse(&bytes, 0).unwrap();
        let scale = 28.0 / f64::from(face.units_per_em());
        let id = face.glyph_index('\u{2002}').expect("Noto must draw U+2002");
        f64::from(face.glyph_hor_advance(id).unwrap()) * scale
    };
    assert!(
        (sep - sep_table).abs() < 1e-6,
        "shaped en space {sep} differs from hmtx {sep_table}"
    );
    assert!(
        sep > unwrapped_width(&fonts, " ") * 1.5,
        "en space must be the wide separator, not a missing-glyph stand-in for U+0020"
    );
    assert!(
        with_trailing > pair + sep * 0.5,
        "the trailing en space must be wider than the fit pad"
    );
    let width = pair + sep * 0.25;
    let kept = reference_word_breaks(&fonts, text, width);
    let rewound = rewind_breaks(&fonts, text, width);
    assert_eq!(
        kept.len(),
        3,
        "font-advance reference is not three lines: {kept:?}"
    );
    assert!(
        rewound.len() > kept.len(),
        "the old rewind must still be a longer wrap, otherwise this check does not cover the bug: {rewound:?}"
    );
    let node = text_node(text, width, 0., true);
    let layout = fonts.node_layout(&node, Some(node.width)).unwrap();
    let actual: Vec<_> = layout
        .lines
        .iter()
        .map(|line| (line.start, line.end))
        .collect();
    assert_eq!(
        actual,
        kept,
        "editor wrapped to {} lines",
        layout.lines.len()
    );
    let lines: Vec<String> = kept
        .iter()
        .map(|(start, end)| {
            utf16_slice(text, *start, *end)
                .replace('\u{2002}', " ")
                .trim()
                .to_string()
        })
        .collect();
    assert_eq!(
        lines,
        vec![
            "Palette Palette".to_string(),
            "Palette Palette".to_string(),
            "Palette Palette".to_string(),
        ]
    );
    let natural = {
        let bytes = noto_bytes();
        let face = ttf_parser::Face::parse(&bytes, 0).unwrap();
        (f64::from(face.ascender()) - f64::from(face.descender()) + f64::from(face.line_gap()))
            * 28.0
            / f64::from(face.units_per_em())
    };
    assert!(
        (layout.height - natural * 3.).abs() < 1e-6,
        "height {}",
        layout.height
    );
    let mut document_node = node.clone();
    document_node.opacity = 0.5;
    let encoded = serde_json::to_vec(&document_node).unwrap();
    let reopened: futureox_design_kernel::scene::Node = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(reopened.opacity, 0.5);
    assert_eq!(reopened.text, text);
    assert!((reopened.width - width).abs() < 1e-9);
    assert_eq!(line_spans(&fonts, &reopened), actual);
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
