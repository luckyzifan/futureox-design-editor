use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::{Value, json};

fn backdrop(id: &str, x: f64, y: f64, width: f64, radius: f64) -> Value {
    json!({
        "id": id, "kind": "rectangle", "width": width, "height": 45,
        "transform": [1, 0, 0, 1, x, y],
        "effects": [{ "kind": "background-blur", "radius": radius,
            "color": "#000000", "sketchBackdrop": true }]
    })
}

fn options() -> RenderOptions {
    serde_json::from_value(json!({
        "pageId": "p", "width": 512, "height": 384,
        "view": { "x": -2.4, "y": 0, "zoom": 1 }, "rasterProfile": "figma"
    })).unwrap()
}

fn document() -> Value {
    json!({
        "schemaVersion": 20, "id": "d", "name": "Native lenses",
        "pages": [{ "id": "p", "name": "Page", "background": "#0d80ff", "children": ["ink","lens"] }],
        "nodes": {
            "ink": { "id": "ink", "kind": "rectangle", "width": 80, "height": 188,
                "fills": [{ "kind": "solid", "color": "#ff4b52" }] },
            "lens": backdrop("lens", 25., 50., 128., 24.)
        }
    })
}

#[test]
fn separated_sketch_lenses_do_not_consume_the_figma_viewport_padding_budget() {
    let mut engine = Engine::new();
    let options = options();
    let mut doc = document();
    engine.load_document(&doc.to_string()).unwrap();
    let expected = engine.render_unretained(&options).unwrap();
    for i in 0..7 {
        let id = format!("remote-{i}");
        doc["pages"][0]["children"].as_array_mut().unwrap().push(json!(id));
        doc["nodes"][&id] = backdrop(&id, 820. + i as f64 * 20., 90., 12., 24.);
    }
    engine.load_document(&doc.to_string()).unwrap();
    let actual = engine.render_unretained(&options).unwrap();
    assert!(actual == expected, "distant lenses changed exact viewport pixels");
    assert!(engine.render(&options).unwrap() == expected);
}

#[test]
fn a_reachable_sketch_capture_must_fit_the_existing_support_cap() {
    let mut engine = Engine::new();
    let mut doc = document();
    doc["pages"][0]["children"] = json!(["ink", "lens", "second"]);
    doc["nodes"]["lens"] = backdrop("lens", 0., 0., 1400., 100.);
    doc["nodes"]["second"] = backdrop("second", 1., 0., 1400., 100.);
    engine.load_document(&doc.to_string()).unwrap();
    assert!(engine.render_unretained(&options()).unwrap_err().contains("1024-pixel budget"));
}

#[test]
#[ignore = "requires a local copy of the LFS 117.sketch regression fixture"]
fn real_117_figma_viewport_keeps_the_same_effects_as_the_admitted_reference() {
    use sha2::{Digest, Sha256};
    use std::{fs, path::Path};

    let digest = |bytes: &[u8]| Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let path = std::env::var_os("FUTUREOX_TEST_117_SKETCH").expect("set FUTUREOX_TEST_117_SKETCH");
    let bytes = fs::read(path).unwrap();
    assert_eq!(digest(&bytes),
        "d494693eadf269e7fa29e4cc56e893f5890c02f4d96f4561065c851818a85d70");
    // Exercise the same portable import report used by the desktop UI.
    let document = futureox_design_kernel::interop::import_sketch_report(&bytes).unwrap().document;
    let board = &document.nodes["ED0CF14B-2E8E-4BE7-97C8-0C061012FEE3"];
    let page = document.pages.iter().find(|page| page.children.contains(&board.id)).unwrap();
    let mut options = options();
    options.page_id = page.id.clone();
    options.view.x -= board.transform.0[4];
    options.view.y -= board.transform.0[5];

    // These lenses are beyond the viewport plus the support of the on-screen
    // lenses. The remaining pair fits the ordinary padding rule, providing
    // an independent control for the new fallback.
    let mut reference = document.clone();
    for id in ["166F6B9D-6877-42B3-A122-D98F7A4FC569",
        "B94EEA71-9B5D-45D9-B097-1CFC19BE0BBF", "8AECA82C-50F9-42CE-BC3C-2CC8FF632177",
        "D33DE82E-B1D8-4051-B679-E03135D605DC", "D1C42B0D-4231-4CA2-BA74-5ABCF035FB24"] {
        let lens = reference.nodes.get_mut(id).unwrap();
        assert!(lens.effects.iter().any(|effect| effect.sketch_backdrop && effect.visible));
        for effect in &mut lens.effects {
            if effect.sketch_backdrop {
                effect.visible = false;
            }
        }
    }
    let mut engine = Engine::new();
    let font = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../frontend/design-client/public/fonts/NotoSansSC.ttf");
    engine.load_font(&fs::read(font).unwrap()).unwrap();
    engine.load_document(&serde_json::to_string(&document).unwrap()).unwrap();
    let actual = engine.render_unretained(&options).unwrap();
    assert_eq!(actual.len(), 512 * 384 * 4);
    assert!(engine.render(&options).unwrap() == actual);
    engine.load_document(&serde_json::to_string(&reference).unwrap()).unwrap();
    let expected = engine.render_unretained(&options).unwrap();
    let differences = actual.chunks_exact(4).zip(expected.chunks_exact(4)).filter(|(a, b)| a != b).count();
    assert_eq!(differences, 0, "Figma viewport differs from its ordinary-padding control");
    eprintln!("117 Figma viewport: {} bytes, SHA-256 {}", actual.len(), digest(&actual));
}
