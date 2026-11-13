//! Issue #121: ABeeZee ships Regular only. Italic must be diagnosed as a missing
//! face. After the Regular file is pinned, line count, breaks and the text box
//! are compared with the Sketch frame and kept across edit/save/reopen.
//! This is not a glyph-pixel or Mac/Electron/Metal result.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futureox_design_kernel::{
    binfmt,
    font::{FontResource, Fonts, TextLayout},
    interop,
    scene::Node,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Write};

const TEXT: &str = "Palette poster title wraps here today";
const SIZE: f64 = 28.;

fn font_path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/design-client/public/fonts")
        .join(name)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sketch(layers: Vec<Value>) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, value) in [
        ("meta.json", json!({"appVersion": "93"})),
        (
            "document.json",
            json!({"_class": "document", "pages": [{"_ref": "pages/p"}]}),
        ),
        (
            "pages/p.json",
            json!({"_class": "page", "do_objectID": "p", "name": "Page", "layers": layers}),
        ),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&serde_json::to_vec(&value).unwrap()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn text_layer(id: &str, face: &str, width: f64, height: f64, y: f64) -> Value {
    json!({
        "_class": "text",
        "do_objectID": id,
        "name": id,
        "frame": {"_class": "rect", "x": 0., "y": y, "width": width, "height": height},
        "textBehaviour": 2,
        "attributedString": {
            "_class": "attributedString",
            "string": TEXT,
            "attributes": [{
                "_class": "stringAttribute",
                "location": 0,
                "length": TEXT.encode_utf16().count(),
                "attributes": {
                    "MSAttributedStringFontAttribute": {
                        "_class": "fontDescriptor",
                        "attributes": {"name": face, "size": SIZE}
                    }
                }
            }]
        }
    })
}

fn shaping_node(font_id: &str, width: f64) -> Node {
    serde_json::from_value(json!({
        "id": "reference",
        "kind": "text",
        "name": "reference",
        "text": TEXT,
        "width": width,
        "height": 40.,
        "fontSize": SIZE,
        "textStyle": {"fontId": font_id, "lineHeight": 1.35, "lineHeightAuto": true, "wrap": true, "align": "start", "weight": 400}
    }))
    .unwrap()
}

fn breaks(layout: &TextLayout) -> Vec<(usize, usize)> {
    layout
        .lines
        .iter()
        .map(|line| (line.start, line.end))
        .collect()
}

fn line_text(layout: &TextLayout) -> Vec<String> {
    breaks(layout)
        .into_iter()
        .map(|(start, end)| TEXT[start..end].trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

fn mismatch(left: &[String], right: &[String]) -> usize {
    let count = left.len().max(right.len());
    (0..count)
        .filter(|index| left.get(*index) != right.get(*index))
        .count()
}

fn raw_lines(bytes: &[u8], width: f64) -> Vec<String> {
    let face = ttf_parser::Face::parse(bytes, 0).unwrap();
    let scale = SIZE / f64::from(face.units_per_em());
    let advance = |ch: char| {
        let id = face
            .glyph_index(ch)
            .unwrap_or_else(|| panic!("missing glyph {ch}"));
        f64::from(face.glyph_hor_advance(id).unwrap()) * scale
    };
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut used = 0.;
    for word in TEXT.split(' ') {
        let word_width: f64 = word.chars().map(&advance).sum();
        let space = if current.is_empty() { 0. } else { advance(' ') };
        if !current.is_empty() && used + space + word_width > width {
            lines.push(std::mem::take(&mut current));
            used = 0.;
        }
        if !current.is_empty() {
            current.push(' ');
            used += advance(' ');
        }
        current.push_str(word);
        used += word_width;
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

fn measure_file(bytes: &[u8], font_id: &str, width: f64, default_font: bool) -> TextLayout {
    let mut fonts = Fonts::new();
    if default_font {
        fonts.load(bytes).unwrap();
    } else {
        let mut resources = std::collections::BTreeMap::new();
        resources.insert(
            font_id.to_owned(),
            FontResource {
                family: "Measured".into(),
                data: STANDARD.encode(bytes).into(),
                index: 0,
                postscript: Some("measured".into()),
            },
        );
        fonts = fonts.with_resources(&resources).unwrap();
    }
    fonts
        .node_measure(
            &shaping_node(if default_font { "default" } else { font_id }, width),
            Some(width),
        )
        .unwrap()
}

fn force_default(node: &Node) -> Node {
    let mut node = node.clone();
    if let Some(style) = node.text_style.as_mut() {
        style.font_id = "default".into();
    }
    for run in &mut node.text_runs {
        if run.font_id.is_some() {
            run.font_id = Some("default".into());
        }
    }
    node
}

fn measure_default(node: &Node, noto: &[u8]) -> TextLayout {
    let mut fonts = Fonts::new();
    fonts.load(noto).unwrap();
    let node = force_default(node);
    fonts.node_measure(&node, Some(node.width)).unwrap()
}

fn measure_document(document: &futureox_design_kernel::scene::Document, id: &str) -> TextLayout {
    let fonts = Fonts::new().with_resources(&document.fonts).unwrap();
    let node = &document.nodes[id];
    fonts.node_measure(node, Some(node.width)).unwrap()
}

fn receipt(document: &futureox_design_kernel::scene::Document, id: &str) -> Value {
    let raw = document
        .design_system
        .as_ref()
        .and_then(|system| system.sketch_containers.get("nodeMetadata"))
        .and_then(|metadata| metadata.get(id))
        .and_then(|entry| entry.get("bindings"))
        .and_then(|bindings| bindings.get("sketchPinnedFontLines"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("missing pinned line receipt for {id}"));
    serde_json::from_str(raw).unwrap()
}

fn absent_binding(document: &futureox_design_kernel::scene::Document, id: &str) -> String {
    document
        .design_system
        .as_ref()
        .and_then(|system| system.sketch_containers.get("nodeMetadata"))
        .and_then(|metadata| metadata.get(id))
        .and_then(|entry| entry.get("bindings"))
        .and_then(|bindings| bindings.get("sketchAbsentFontFace"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

#[test]
fn absent_abeezee_names_are_diagnosed_and_shipped_faces_are_not() {
    for name in ["ABeeZee-BoldItalic", "ABeeZee Oblique", "ABeeZee Bold"] {
        let message = futureox_design_kernel::abeezee_font::absent_abeezee_diagnosis(name)
            .unwrap_or_else(|| panic!("{name} was treated as a shipped face"));
        assert!(message.contains("没有同名"), "{message}");
        assert!(
            message.contains("不能把 Regular 或 Italic 的换行"),
            "{message}"
        );
    }
    for name in [
        "ABeeZee",
        "ABeeZee Regular",
        "ABeeZee-Regular",
        "ABeeZee Italic",
        "ABeeZee-Italic",
        "Inter Italic",
    ] {
        assert!(
            futureox_design_kernel::abeezee_font::absent_abeezee_diagnosis(name).is_none(),
            "{name}"
        );
    }
}

#[test]
fn pinned_regular_matches_the_file_and_missing_bold_italic_does_not_borrow_it() {
    let abeezee = std::fs::read(font_path("abeezee/ABeeZee-Regular.ttf")).unwrap();
    let noto = std::fs::read(font_path("NotoSansSC.ttf")).unwrap();
    assert_eq!(
        sha256_hex(&abeezee),
        futureox_design_kernel::abeezee_font::ABEEZEE_REGULAR_SHA256
    );
    let mut chosen = None;
    for width in (140..=360).step_by(4) {
        let width = f64::from(width);
        let reference = line_text(&measure_file(&abeezee, "abeezee", width, false));
        let baseline = line_text(&measure_file(&noto, "default", width, true));
        let raw = raw_lines(&abeezee, width);
        if reference != baseline && reference == raw {
            chosen = Some((width, reference, baseline, raw));
            break;
        }
    }
    let (width, reference_lines, baseline_lines, raw_lines) =
        chosen.expect("no width where ABeeZee line breaks differ from Noto and match raw advances");
    let reference_layout = measure_file(&abeezee, "abeezee", width, false);
    let face = ttf_parser::Face::parse(&abeezee, 0).unwrap();
    let line_box = ((f64::from(face.ascender()) - f64::from(face.descender())
        + f64::from(face.line_gap()))
        * SIZE
        / f64::from(face.units_per_em()))
    .round_ties_even();
    let natural_height = line_box * raw_lines.len() as f64;
    assert!(
        (reference_layout.height - natural_height).abs() < 1e-9,
        "automatic Sketch line box must use the pinned font's metrics on the nearest document point"
    );
    let archive = sketch(vec![
        text_layer(
            "regular",
            "ABeeZee-Regular",
            width,
            reference_layout.height,
            0.,
        ),
        text_layer(
            "italic",
            "ABeeZee-BoldItalic",
            width,
            reference_layout.height,
            400.,
        ),
    ]);
    let report = interop::import_sketch_report(&archive).unwrap();
    let document = &report.document;
    let regular = &document.nodes["regular"];
    let italic = &document.nodes["italic"];
    assert_eq!(regular.text_style.as_ref().unwrap().line_height, 1.35);
    assert!(regular.text_style.as_ref().unwrap().wrap);
    assert_eq!(
        (regular.width, regular.height),
        (width, reference_layout.height)
    );
    assert_eq!(italic.text_style.as_ref().unwrap().font_id, "default");
    assert!(
        italic
            .text_runs
            .iter()
            .all(|run| run.font_id.as_deref().unwrap_or("default") == "default")
    );
    let pinned = document
        .fonts
        .get(&regular.text_style.as_ref().unwrap().font_id)
        .expect("regular face was not pinned");
    let pinned_bytes = STANDARD.decode(pinned.data.as_bytes()).unwrap();
    assert_eq!(sha256_hex(&pinned_bytes), sha256_hex(&abeezee));
    assert_eq!(pinned.postscript.as_deref(), Some("ABeeZee-Regular"));

    let baseline = measure_default(regular, &noto);
    let candidate = measure_document(document, "regular");
    let italic_layout = measure_default(italic, &noto);
    let baseline_lines_imported = line_text(&baseline);
    let candidate_lines = line_text(&candidate);
    let italic_lines = line_text(&italic_layout);
    assert_eq!(
        baseline_lines_imported, baseline_lines,
        "imported default-font breaks drifted from the direct Noto measurement"
    );
    let baseline_mismatch = mismatch(&baseline_lines_imported, &reference_lines);
    let candidate_mismatch = mismatch(&candidate_lines, &reference_lines);
    let italic_versus_regular = mismatch(&italic_lines, &reference_lines);
    let baseline_box_delta = (baseline.height - reference_layout.height).abs();
    let candidate_box_delta = (candidate.height - reference_layout.height).abs();
    let record = receipt(document, "regular");
    println!(
        "ABEEZEE_FIDELITY {}",
        json!({
            "environment": "linux-native-cpu",
            "macElectronMetal": "NOT_RUN",
            "width": width,
            "oracle": "ttf-parser horizontal advances, word wrap at spaces, real ABeeZee-Regular.ttf",
            "oracleLines": raw_lines.clone(),
            "referenceLines": reference_lines.clone(),
            "baselineLines": baseline_lines_imported.clone(),
            "candidateLines": candidate_lines.clone(),
            "italicLines": italic_lines.clone(),
            "baselineLineMismatch": baseline_mismatch,
            "candidateLineMismatch": candidate_mismatch,
            "italicVersusRegularMismatch": italic_versus_regular,
            "baselineBoxHeightDelta": baseline_box_delta,
            "candidateBoxHeightDelta": candidate_box_delta,
            "nativeBox": [regular.width, regular.height],
            "authoredTextBoxPreserved": record["authoredTextBoxPreserved"],
            "glyphPixels": record["glyphPixels"],
            "basis": record["basis"],
            "pinnedFaceIsTheRequest": record["pinnedFaceIsTheRequest"]
        })
    );
    assert!(
        baseline_mismatch > 0,
        "current main's default font unexpectedly matched ABeeZee: {baseline_lines_imported:?}"
    );
    assert!(
        baseline_box_delta > 0.,
        "default-font text box matched the ABeeZee frame: {baseline_box_delta}"
    );
    assert_eq!(candidate_lines, reference_lines);
    assert_eq!(candidate_lines, raw_lines);
    assert_eq!(candidate_mismatch, 0);
    assert_eq!(candidate.height, reference_layout.height);
    assert_eq!(candidate_box_delta, 0.);
    assert_eq!(breaks(&candidate), breaks(&reference_layout));
    assert_eq!(record["kind"], "pinned-font-file");
    assert_eq!(record["basis"], "pinned-font-file");
    assert_eq!(record["sha256"], sha256_hex(&abeezee));
    assert_eq!(record["lineCount"], candidate_lines.len());
    assert_eq!(record["glyphPixels"], false);
    assert_eq!(record["pinnedFaceIsTheRequest"], true);
    assert_eq!(record["authoredTextBoxPreserved"], true);
    assert_eq!(record["nativeBox"]["width"].as_f64(), Some(width));
    assert_eq!(
        record["nativeBox"]["height"].as_f64(),
        Some(reference_layout.height)
    );
    assert!(!record.to_string().contains("目录"));
    assert!(!record.to_string().contains("警告消失"));
    assert!(
        document.design_system.as_ref().unwrap().sketch_containers["nodeMetadata"]["italic"]
            ["bindings"]
            .get("sketchPinnedFontLines")
            .is_none()
    );
    let diagnosis = absent_binding(document, "italic");
    assert!(diagnosis.contains("ABeeZee-BoldItalic"), "{diagnosis}");
    assert!(
        diagnosis.contains("不能把 Regular 或 Italic 的换行"),
        "{diagnosis}"
    );
    assert!(report.warnings.iter().any(
        |warning| warning.contains("不能把 Regular 或 Italic 的换行")
            && warning.contains("ABeeZee-BoldItalic")
    ));
    assert!(
        italic_versus_regular > 0,
        "italic request silently used Regular breaks"
    );
    assert_eq!(italic_lines, baseline_lines_imported);

    let mut edited = document.clone();
    edited.nodes.get_mut("regular").unwrap().opacity = 0.5;
    let reopened = binfmt::decode(&binfmt::encode(&edited)).unwrap();
    assert_eq!(reopened.nodes["regular"].opacity, 0.5);
    assert_eq!(
        (
            reopened.nodes["regular"].width,
            reopened.nodes["regular"].height
        ),
        (width, reference_layout.height)
    );
    assert_eq!(
        line_text(&measure_document(&reopened, "regular")),
        reference_lines
    );
    assert_eq!(
        receipt(&reopened, "regular")["lineCount"],
        reference_lines.len()
    );
    assert!(absent_binding(&reopened, "italic").contains("不能把 Regular 或 Italic 的换行"));
    assert_eq!(
        reopened.nodes["italic"]
            .text_style
            .as_ref()
            .unwrap()
            .font_id,
        "default"
    );

    let exported = interop::export_sketch(&reopened).unwrap();
    let again = interop::import_sketch_report(&exported).unwrap();
    assert_eq!(
        (
            again.document.nodes["regular"].width,
            again.document.nodes["regular"].height
        ),
        (width, reference_layout.height)
    );
    assert_eq!(
        line_text(&measure_document(&again.document, "regular")),
        reference_lines
    );
    assert_eq!(
        breaks(&measure_document(&again.document, "regular")),
        breaks(&reference_layout)
    );
    assert_eq!(
        receipt(&again.document, "regular")["sha256"],
        sha256_hex(&abeezee)
    );
    assert_eq!(receipt(&again.document, "regular")["glyphPixels"], false);
    assert_eq!(
        again.document.nodes["italic"]
            .text_style
            .as_ref()
            .unwrap()
            .font_id,
        "default"
    );
    let files = interop::read_zip_public(&exported).unwrap();
    let page_bytes = files
        .iter()
        .find(|(name, _)| name.starts_with("pages/"))
        .unwrap()
        .1;
    let page: Value = serde_json::from_slice(page_bytes).unwrap();
    let layers = page["layers"].as_array().unwrap();
    let exported_italic = layers
        .iter()
        .find(|layer| layer["name"] == "italic")
        .unwrap();
    let exported_regular = layers
        .iter()
        .find(|layer| layer["name"] == "regular")
        .unwrap();
    assert_eq!(
        exported_italic["attributedString"]["attributes"][0]["attributes"]["MSAttributedStringFontAttribute"]
            ["attributes"]["name"],
        "ABeeZee-BoldItalic",
        "exported italic layer {}",
        exported_italic
    );
    assert_eq!(
        exported_regular["attributedString"]["attributes"][0]["attributes"]["MSAttributedStringFontAttribute"]
            ["attributes"]["name"],
        "ABeeZee-Regular"
    );
    assert_eq!(exported_regular["frame"]["width"].as_f64(), Some(width));
    assert_eq!(
        exported_regular["frame"]["height"].as_f64(),
        Some(reference_layout.height)
    );
    assert!(
        absent_binding(&again.document, "italic").contains("ABeeZee-BoldItalic"),
        "warnings {:?}\nbinding {}\nnode {}",
        again.warnings,
        absent_binding(&again.document, "italic"),
        serde_json::to_string(&again.document.nodes["italic"]).unwrap_or_default()
    );
    assert!(
        again
            .warnings
            .iter()
            .any(|warning| warning.contains("不能把 Regular 或 Italic 的换行"))
    );
}

#[test]
fn bundled_italic_retains_its_own_line_breaks_and_box_on_reopen() {
    let italic = std::fs::read(font_path("abeezee/ABeeZee-Italic.ttf")).unwrap();
    let regular = std::fs::read(font_path("abeezee/ABeeZee-Regular.ttf")).unwrap();
    assert_eq!(
        sha256_hex(&italic),
        futureox_design_kernel::abeezee_font::ABEEZEE_ITALIC_SHA256
    );
    let (width, oracle) = (140..=360)
        .map(f64::from)
        .find_map(|width| {
            let lines = raw_lines(&italic, width);
            let layout = measure_file(&italic, "italic", width, false);
            (line_text(&layout) == lines && lines != raw_lines(&regular, width))
                .then_some((width, layout))
        })
        .expect("find an independently measured width that distinguishes Italic");
    let fixture = sketch(vec![text_layer(
        "italic",
        "ABeeZee-Italic",
        width,
        oracle.height,
        0.,
    )]);
    let report = interop::import_sketch_report(&fixture).unwrap();
    let mut document = report.document;
    let node = document.nodes.get_mut("italic").unwrap();
    assert_eq!((node.width, node.height), (width, oracle.height));
    node.opacity = 0.7;
    let id = &node.text_style.as_ref().unwrap().font_id;
    assert_eq!(
        document.fonts[id].postscript.as_deref(),
        Some("ABeeZee-Italic")
    );
    assert_eq!(receipt(&document, "italic")["postscript"], "ABeeZee-Italic");
    assert_eq!(receipt(&document, "italic")["sha256"], sha256_hex(&italic));
    assert!(absent_binding(&document, "italic").is_empty());
    let reopened = binfmt::decode(&binfmt::encode(&document)).unwrap();
    let sketch = interop::export_sketch(&reopened).unwrap();
    let reimported = interop::import_sketch_report(&sketch).unwrap().document;
    for candidate in [&document, &reopened, &reimported] {
        let n = &candidate.nodes["italic"];
        assert_eq!((n.width, n.height, n.opacity), (width, oracle.height, 0.7));
        let measured = measure_document(candidate, "italic");
        assert_eq!(line_text(&measured), raw_lines(&italic, width));
        assert_eq!(breaks(&measured), breaks(&oracle));
        assert_eq!(measured.height, oracle.height);
    }
}
