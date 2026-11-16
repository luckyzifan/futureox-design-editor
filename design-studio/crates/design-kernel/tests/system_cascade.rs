//! Missing Sketch fonts keep their source name. Local rendering can use a
//! host-supplied system cascade face instead of scaled packaged glyphs.
use futureox_design_kernel::editing::{DocumentEditor, DocumentPatch};
use futureox_design_kernel::font::{self, Fonts};
use futureox_design_kernel::{Engine, binfmt, interop};
use serde_json::{Value, json};
use std::io::{Cursor, Write};

fn noto() -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../frontend/design-client/public/fonts/NotoSansSC.ttf"),
    )
    .unwrap()
}

fn loaded() -> Fonts {
    let mut fonts = Fonts::new();
    fonts.load(&noto()).unwrap();
    fonts
}

/// One Han glyph, advance 980/1000 em, restricted OS/2 embedding bits.
fn rectangle_face() -> Vec<u8> {
    let upem = 1000u16;
    let advance = 980u16;
    let glyph = simple_rect(40, 0, 700, 720);
    let mut glyf = glyph;
    if glyf.len() % 2 == 1 {
        glyf.push(0);
    }
    let loca = {
        let mut out = Vec::new();
        out.extend_from_slice(&0u32.to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes());
        out.extend_from_slice(&(glyf.len() as u32).to_be_bytes());
        out
    };
    let mut hmtx = Vec::new();
    for (advance, lsb) in [(upem / 2, 0i16), (advance, 40i16)] {
        hmtx.extend_from_slice(&advance.to_be_bytes());
        hmtx.extend_from_slice(&lsb.to_be_bytes());
    }
    let tables = vec![
        tbl(b"OS/2", os2_restricted()),
        tbl(b"cmap", cmap_han()),
        tbl(b"glyf", {
            let mut both = Vec::new();
            both.extend_from_slice(&glyf);
            both
        }),
        tbl(b"head", head(upem)),
        tbl(b"hhea", hhea(advance)),
        tbl(b"hmtx", hmtx),
        tbl(b"loca", loca),
        tbl(b"maxp", maxp()),
        tbl(b"name", name_table()),
        tbl(b"post", post()),
    ];
    assemble(tables)
}

fn simple_rect(x0: i16, y0: i16, x1: i16, y1: i16) -> Vec<u8> {
    let points = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)];
    let mut out = Vec::new();
    out.extend_from_slice(&1i16.to_be_bytes());
    out.extend_from_slice(&x0.to_be_bytes());
    out.extend_from_slice(&y0.to_be_bytes());
    out.extend_from_slice(&x1.to_be_bytes());
    out.extend_from_slice(&y1.to_be_bytes());
    out.extend_from_slice(&3u16.to_be_bytes());
    out.extend_from_slice(&0u16.to_be_bytes());
    let mut prev = (0i16, 0i16);
    let mut dx = Vec::new();
    let mut dy = Vec::new();
    for point in points {
        out.push(0x01);
        dx.extend_from_slice(&(point.0 - prev.0).to_be_bytes());
        dy.extend_from_slice(&(point.1 - prev.1).to_be_bytes());
        prev = point;
    }
    out.extend_from_slice(&dx);
    out.extend_from_slice(&dy);
    out
}

fn os2_restricted() -> Vec<u8> {
    let mut out = vec![0u8; 78];
    out[4..6].copy_from_slice(&400u16.to_be_bytes());
    out[8..10].copy_from_slice(&2u16.to_be_bytes());
    out
}

fn cmap_han() -> Vec<u8> {
    let code = u32::from('中');
    let mut sub = Vec::new();
    sub.extend_from_slice(&12u16.to_be_bytes());
    sub.extend_from_slice(&0u16.to_be_bytes());
    sub.extend_from_slice(&28u32.to_be_bytes());
    sub.extend_from_slice(&0u32.to_be_bytes());
    sub.extend_from_slice(&1u32.to_be_bytes());
    sub.extend_from_slice(&code.to_be_bytes());
    sub.extend_from_slice(&code.to_be_bytes());
    sub.extend_from_slice(&1u32.to_be_bytes());
    let mut cmap = Vec::new();
    cmap.extend_from_slice(&0u16.to_be_bytes());
    cmap.extend_from_slice(&2u16.to_be_bytes());
    cmap.extend_from_slice(&0u16.to_be_bytes());
    cmap.extend_from_slice(&4u16.to_be_bytes());
    cmap.extend_from_slice(&20u32.to_be_bytes());
    cmap.extend_from_slice(&3u16.to_be_bytes());
    cmap.extend_from_slice(&10u16.to_be_bytes());
    cmap.extend_from_slice(&20u32.to_be_bytes());
    cmap.extend_from_slice(&sub);
    cmap
}

fn head(upem: u16) -> Vec<u8> {
    let mut out = vec![0u8; 54];
    out[0..2].copy_from_slice(&1u16.to_be_bytes());
    out[4..8].copy_from_slice(&0x00010000u32.to_be_bytes());
    out[12..16].copy_from_slice(&0x5F0F3CF5u32.to_be_bytes());
    out[16..18].copy_from_slice(&0x000Bu16.to_be_bytes());
    out[18..20].copy_from_slice(&upem.to_be_bytes());
    put_i16(&mut out, 36, 40);
    put_i16(&mut out, 40, 700);
    put_i16(&mut out, 42, 720);
    out[46..48].copy_from_slice(&8u16.to_be_bytes());
    put_i16(&mut out, 48, 2);
    put_i16(&mut out, 50, 1);
    out
}

fn hhea(advance: u16) -> Vec<u8> {
    let mut out = vec![0u8; 36];
    out[0..2].copy_from_slice(&1u16.to_be_bytes());
    put_i16(&mut out, 4, 800);
    put_i16(&mut out, 6, -200);
    out[10..12].copy_from_slice(&advance.to_be_bytes());
    put_i16(&mut out, 12, 0);
    put_i16(&mut out, 16, 740);
    put_i16(&mut out, 18, 1);
    out[34..36].copy_from_slice(&2u16.to_be_bytes());
    out
}

fn maxp() -> Vec<u8> {
    let mut out = vec![0u8; 32];
    out[0..4].copy_from_slice(&0x00010000u32.to_be_bytes());
    out[4..6].copy_from_slice(&2u16.to_be_bytes());
    out[6..8].copy_from_slice(&4u16.to_be_bytes());
    out[8..10].copy_from_slice(&1u16.to_be_bytes());
    out[14..16].copy_from_slice(&2u16.to_be_bytes());
    out
}

fn name_table() -> Vec<u8> {
    let records = [(1u16, "Cascade Rect"), (2, "Regular"), (6, "CascadeRect")];
    let mut strings = Vec::new();
    let mut encoded = Vec::new();
    for (id, value) in records {
        let utf16: Vec<u8> = value
            .encode_utf16()
            .flat_map(|unit| unit.to_be_bytes())
            .collect();
        encoded.push((id, strings.len(), utf16.len()));
        strings.extend_from_slice(&utf16);
    }
    let count = encoded.len() as u16;
    let storage = 6 + encoded.len() * 12;
    let mut out = Vec::new();
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&count.to_be_bytes());
    out.extend_from_slice(&(storage as u16).to_be_bytes());
    for (id, start, len) in encoded {
        out.extend_from_slice(&3u16.to_be_bytes());
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&0x0409u16.to_be_bytes());
        out.extend_from_slice(&id.to_be_bytes());
        out.extend_from_slice(&(len as u16).to_be_bytes());
        out.extend_from_slice(&(start as u16).to_be_bytes());
    }
    out.extend_from_slice(&strings);
    out
}

fn post() -> Vec<u8> {
    let mut out = vec![0u8; 32];
    out[0..4].copy_from_slice(&0x00030000u32.to_be_bytes());
    out
}

fn put_i16(bytes: &mut [u8], at: usize, value: i16) {
    bytes[at..at + 2].copy_from_slice(&value.to_be_bytes());
}

struct Table {
    tag: [u8; 4],
    raw_len: usize,
    data: Vec<u8>,
}

fn tbl(tag: &[u8; 4], mut data: Vec<u8>) -> Table {
    let raw_len = data.len();
    while data.len() % 4 != 0 {
        data.push(0);
    }
    Table {
        tag: *tag,
        raw_len,
        data,
    }
}

fn checksum(bytes: &[u8]) -> u32 {
    bytes.chunks(4).fold(0u32, |sum, chunk| {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

fn assemble(mut tables: Vec<Table>) -> Vec<u8> {
    tables.sort_by_key(|table| table.tag);
    let count = tables.len() as u16;
    let mut search = 1u16;
    let mut entry = 0u16;
    while search * 2 <= count {
        search *= 2;
        entry += 1;
    }
    let mut offset = 12 + tables.len() * 16;
    let mut font = Vec::new();
    font.extend_from_slice(&0x00010000u32.to_be_bytes());
    font.extend_from_slice(&count.to_be_bytes());
    font.extend_from_slice(&(search * 16).to_be_bytes());
    font.extend_from_slice(&entry.to_be_bytes());
    font.extend_from_slice(&(count * 16 - search * 16).to_be_bytes());
    for table in &tables {
        font.extend_from_slice(&table.tag);
        font.extend_from_slice(&checksum(&table.data).to_be_bytes());
        font.extend_from_slice(&(offset as u32).to_be_bytes());
        font.extend_from_slice(&(table.raw_len as u32).to_be_bytes());
        offset += table.data.len();
    }
    for table in &tables {
        font.extend_from_slice(&table.data);
    }
    let head = font.windows(4).position(|tag| tag == b"head").unwrap();
    let head_off = u32::from_be_bytes(font[head + 8..head + 12].try_into().unwrap()) as usize;
    let sum = checksum(&font);
    let adjustment = 0xB1B0_AFBAu32.wrapping_sub(sum);
    font[head_off + 8..head_off + 12].copy_from_slice(&adjustment.to_be_bytes());
    font
}

fn title_node(text: &str) -> futureox_design_kernel::scene::Node {
    serde_json::from_value(json!({
        "id": "title",
        "kind": "text",
        "name": "精品可视化素材淘宝店",
        "text": text,
        "fontSize": 46,
        "width": 508,
        "height": 120,
        "textStyle": {"fontId": "default", "wrap": true, "align": "center", "lineBoxBaseline": "sketch-font-leading"},
        "fills": [{"kind": "solid", "color": "#ffffff"}],
        "effects": [{"kind": "shadow", "radius": 4, "x": 1, "y": 1, "spread": 0, "color": "#2b73ff", "opacity": 0.9}]
    })).unwrap()
}

fn layout(fonts: &Fonts, text: &str) -> futureox_design_kernel::font::TextLayout {
    fonts.node_layout(&title_node(text), Some(508.)).unwrap()
}

#[test]
fn packaged_fallback_keeps_the_measured_scale_until_a_cascade_face_is_installed() {
    let fonts = loaded();
    let before = layout(&fonts, "中");
    assert!((before.glyphs[0].advance - 43.4492481203).abs() < 1e-9);
    assert_eq!(before.glyphs[0].font_id, "default");
    let packaged = fonts.node_path(&title_node("中")).unwrap().svg_data();

    let face = rectangle_face();
    let mut with_face = loaded();
    assert!(with_face.install_system_cascade(None, Some(&face)).unwrap());
    let after = layout(&with_face, "中");
    assert_eq!(after.glyphs[0].font_id, "system-cascade-display");
    assert!((after.glyphs[0].advance - 46. * 0.98).abs() < 1e-9);
    let resolved = with_face.node_path(&title_node("中")).unwrap().svg_data();
    assert_ne!(resolved, packaged);

    let mut latin_only = loaded();
    let subset = font::prepare_system_cascade_face(&noto(), 0, "A").unwrap();
    assert!(
        latin_only
            .install_system_cascade(None, Some(&subset))
            .unwrap()
    );
    let still_packaged = layout(&latin_only, "中");
    assert_eq!(still_packaged.glyphs[0].font_id, "default");
    assert!((still_packaged.glyphs[0].advance - 43.4492481203).abs() < 1e-9);
}

#[test]
fn display_cascade_wraps_and_centers_with_the_face_advance() {
    let mut fonts = loaded();
    fonts
        .install_system_cascade(None, Some(&rectangle_face()))
        .unwrap();
    let text = "中".repeat(12);
    let laid = layout(&fonts, &text);
    assert_eq!(
        laid.lines.len(),
        2,
        "11 glyphs fit the 508 pt box and the 12th wraps"
    );
    assert_eq!(laid.lines[0].end - laid.lines[0].start, 11);
    assert_eq!(laid.lines[1].end - laid.lines[1].start, 1);
    let advance = 46. * 0.98;
    let line1 = (508. - 11. * advance) / 2.;
    let line2 = (508. - advance) / 2.;
    assert!((laid.glyphs[0].x - line1).abs() < 1e-6);
    assert!((laid.glyphs[11].x - line2).abs() < 1e-6);
    assert!(
        laid.glyphs
            .iter()
            .all(|glyph| glyph.font_id == "system-cascade-display")
    );
}

#[test]
fn editor_text_keeps_packaged_glyphs_when_a_cascade_face_is_installed() {
    let mut fonts = loaded();
    fonts
        .install_system_cascade(None, Some(&rectangle_face()))
        .unwrap();
    let node = serde_json::from_value(json!({"id":"t","kind":"text","text":"中","fontSize":46,"width":200,"height":80,"textStyle":{"wrap":false},"fills":[{"kind":"solid","color":"#000"}]}))
        .unwrap();
    let laid = fonts.node_layout(&node, Some(200.)).unwrap();
    assert_eq!(laid.glyphs[0].font_id, "default");
    assert!((laid.glyphs[0].advance - 46.).abs() < 1e-6);
}

#[test]
fn cascade_png_and_shadow_differ_from_packaged_glyphs_without_embedding() {
    let face = rectangle_face();
    let text = "中中";
    let document = |cascade: bool| {
        let mut engine = Engine::new();
        engine.load_font(&noto()).unwrap();
        if cascade {
            engine.install_system_cascade(None, Some(&face)).unwrap();
        }
        let mut node = title_node(text);
        node.width = 140.;
        node.text_style.as_mut().unwrap().align = "start".into();
        let doc = json!({
            "schemaVersion": 4,
            "id": "d",
            "name": "cascade",
            "pages": [{"id": "p", "name": "p", "background": "#101010", "children": ["title"]}],
            "nodes": {"title": node}
        });
        engine.load_document(&doc.to_string()).unwrap();
        engine
    };
    let mut packaged = document(false);
    let mut resolved = document(true);
    let options = serde_json::from_value(json!({"pageId":"p","width":160,"height":120,"view":{"x":0,"y":0,"zoom":1},"transparent":true})).unwrap();
    let packaged_png = packaged.render(&options).unwrap();
    let resolved_png = resolved.render(&options).unwrap();
    let ink = |bytes: &[u8]| bytes.chunks(4).filter(|px| px[3] != 0).count();
    assert!(ink(&packaged_png) > 20, "packaged text must paint");
    assert!(ink(&resolved_png) > 20, "cascade text must paint");
    assert_ne!(packaged_png, resolved_png);
    assert!(packaged_png.chunks(4).any(|px| px.iter().any(|c| *c != 0)));
    assert!(
        resolved_png.chunks(4).any(|px| px[2] > px[0] && px[2] > 20),
        "blue shadow ink is present"
    );
    let pdf = resolved.export_pdf_vector(&options).unwrap();
    assert!(!pdf.windows(11).any(|window| window == b"CascadeRect"));
    assert!(
        !pdf.windows(4)
            .any(|window| window == b" Tj\n" || window == b" Tj ")
    );
}

#[test]
fn source_name_survives_typography_edit_undo_save_and_sketch_export() {
    let sketch = sketch_archive("中中中中中中中中中中中中", 46, 508.);
    let imported = interop::import_sketch_report(&sketch).unwrap().document;
    let node = imported
        .nodes
        .values()
        .find(|node| node.kind == "text")
        .unwrap();
    assert_eq!(node.text_style.as_ref().unwrap().font_id, "default");
    let mut editor = DocumentEditor::new(imported.clone()).unwrap();
    let mut edited = imported.clone();
    let id = node.id.clone();
    edited.nodes.get_mut(&id).unwrap().font_size = 32.;
    editor
        .apply(0, DocumentPatch::between(&imported, &edited).unwrap())
        .unwrap();
    assert_eq!(editor.document().nodes[&id].font_size, 32.);
    editor.undo().unwrap();
    assert_eq!(editor.document().nodes[&id].font_size, 46.);
    let saved = binfmt::encode(editor.document());
    let reopened = binfmt::decode(&saved).unwrap();
    assert_eq!(reopened.nodes[&id].font_size, 46.);
    assert!(!saved.windows(11).any(|window| window == b"CascadeRect"));
    let exported = interop::export_sketch(&reopened).unwrap();
    let page = interop::read_zip_public(&exported)
        .unwrap()
        .into_iter()
        .find(|(name, _)| name.starts_with("pages/"))
        .unwrap()
        .1;
    let layer = serde_json::from_slice::<Value>(&page).unwrap();
    let font_name = layer["layers"][0]["attributedString"]["attributes"][0]["attributes"]["MSAttributedStringFontAttribute"]["attributes"]["name"].as_str().unwrap().to_owned();
    assert_eq!(font_name, "YouSheBiaoTiHei");
    assert!(!exported.windows(11).any(|window| window == b"CascadeRect"));

    let mut with_face = loaded();
    let face = rectangle_face();
    with_face.install_system_cascade(None, Some(&face)).unwrap();
    let laid = with_face
        .node_layout(&reopened.nodes[&id], Some(reopened.nodes[&id].width))
        .unwrap();
    assert_eq!(laid.glyphs[0].font_id, "system-cascade-display");
    let mut chosen = reopened.clone();
    use base64::Engine as _;
    chosen.fonts.insert(
        "chosen".into(),
        futureox_design_kernel::font::FontResource {
            family: "Cascade Rect".into(),
            data: base64::engine::general_purpose::STANDARD
                .encode(&face)
                .into(),
            index: 0,
            postscript: Some("CascadeRect".into()),
        },
    );
    {
        let node = chosen.nodes.get_mut(&id).unwrap();
        node.text_style.as_mut().unwrap().font_id = "chosen".into();
        for run in &mut node.text_runs {
            run.font_id = Some("chosen".into());
        }
    }
    assert!(
        interop::export_sketch(&chosen).is_err(),
        "restricted embedding bits still reject a document font"
    );
    let mut history = DocumentEditor::new(reopened.clone()).unwrap();
    history
        .apply(0, DocumentPatch::between(&reopened, &chosen).unwrap())
        .unwrap();
    let mut rendering = loaded();
    rendering.install_system_cascade(None, Some(&face)).unwrap();
    let rendering = rendering.with_resources(&chosen.fonts).unwrap();
    let chosen_layout = rendering
        .node_layout(
            &history.document().nodes[&id],
            Some(history.document().nodes[&id].width),
        )
        .unwrap();
    assert_eq!(chosen_layout.glyphs[0].font_id, "chosen");
    history.undo().unwrap();
    assert_eq!(
        history.document().nodes[&id]
            .text_style
            .as_ref()
            .unwrap()
            .font_id,
        "default"
    );
    let restored = rendering
        .node_layout(
            &history.document().nodes[&id],
            Some(history.document().nodes[&id].width),
        )
        .unwrap();
    assert_eq!(restored.glyphs[0].font_id, "system-cascade-display");
    let exported = interop::export_sketch(history.document()).unwrap();
    let page = interop::read_zip_public(&exported)
        .unwrap()
        .into_iter()
        .find(|(name, _)| name.starts_with("pages/"))
        .unwrap()
        .1;
    let layer = serde_json::from_slice::<Value>(&page).unwrap();
    assert_eq!(
        layer["layers"][0]["attributedString"]["attributes"][0]["attributes"]["MSAttributedStringFontAttribute"]
            ["attributes"]["name"],
        "YouSheBiaoTiHei"
    );
}

#[test]
fn subset_of_packaged_noto_keeps_han_advances_and_drops_other_characters() {
    let source = noto();
    let original = ttf_parser::Face::parse(&source, 0).unwrap();
    let subset = font::prepare_system_cascade_face(&source, 0, "中文").unwrap();
    assert!(subset.len() < source.len() / 4);
    let face = ttf_parser::Face::parse(&subset, 0).unwrap();
    for ch in ['中', '文'] {
        let before = original
            .glyph_hor_advance(original.glyph_index(ch).unwrap())
            .unwrap();
        let after = face
            .glyph_hor_advance(face.glyph_index(ch).unwrap())
            .unwrap();
        assert_eq!(before, after, "{ch}");
        let old_box = original
            .glyph_bounding_box(original.glyph_index(ch).unwrap())
            .unwrap();
        let new_box = face
            .glyph_bounding_box(face.glyph_index(ch).unwrap())
            .unwrap();
        assert_eq!(
            (old_box.x_min, old_box.y_min, old_box.x_max, old_box.y_max),
            (new_box.x_min, new_box.y_min, new_box.x_max, new_box.y_max)
        );
    }
    assert!(face.glyph_index('A').is_none());
    assert!(font::prepare_system_cascade_face(&rectangle_face(), 0, "中A").is_err());
}

#[test]
fn resolver_is_not_called_again_for_the_same_missing_text() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    fn resolve(text: &str, size: f64) -> Result<Option<Vec<u8>>, String> {
        assert!(text.contains('中'));
        assert!(size >= 20.);
        CALLS.fetch_add(1, Ordering::SeqCst);
        Ok(Some(rectangle_face()))
    }
    let mut fonts = loaded();
    let doc = document_from(title_node(&"中".repeat(12)));
    assert!(fonts.refresh_system_cascade_with(&doc, resolve).unwrap());
    let calls = CALLS.load(Ordering::SeqCst);
    assert_eq!(calls, 1);
    assert!(!fonts.refresh_system_cascade_with(&doc, resolve).unwrap());
    assert_eq!(CALLS.load(Ordering::SeqCst), calls);
    let mut edited = doc.clone();
    edited.nodes.get_mut("title").unwrap().text.push('文');
    fonts.refresh_system_cascade_with(&edited, resolve).unwrap();
    assert!(CALLS.load(Ordering::SeqCst) > calls);
}

fn document_from(
    node: futureox_design_kernel::scene::Node,
) -> futureox_design_kernel::scene::Document {
    serde_json::from_value(json!({
        "schemaVersion": 4,
        "id": "d",
        "name": "cascade",
        "pages": [{"id": "p", "name": "p", "background": "#ffffff", "children": ["title"]}],
        "nodes": {"title": node}
    }))
    .unwrap()
}

fn sketch_archive(text: &str, size: i64, width: f64) -> Vec<u8> {
    let layer = json!({"_class":"text","do_objectID":"title","name":"精品可视化素材淘宝店",
        "frame":{"x":705.5,"y":0,"width":width,"height":160},
        "textBehaviour":1,
        "lineSpacingBehaviour":1,
        "style":{"contextSettings":{"opacity":1}},
        "attributedString":{"string":text,"attributes":[{"location":0,"length":text.encode_utf16().count(),
            "attributes":{"MSAttributedStringFontAttribute":{"attributes":{"name":"YouSheBiaoTiHei","size":size}},
                "paragraphStyle":{"alignment":2,"minimumLineHeight":50.764,"maximumLineHeight":50.764}}}]}});
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, value) in [
        ("meta.json", json!({"appVersion":"93"})),
        ("document.json", json!({"pages":[{"_ref":"pages/p"}]})),
        (
            "pages/p.json",
            json!({"_class":"page","do_objectID":"p","name":"Page","layers":[layer]}),
        ),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
