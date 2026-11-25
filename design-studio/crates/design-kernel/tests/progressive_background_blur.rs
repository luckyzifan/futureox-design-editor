use futureox_design_kernel::{
    editing::{DocumentEditor, DocumentPatch},
    scene::selected_backdrop,
    Engine, RenderOptions,
};
use serde_json::{json, Value};
use std::io::{Cursor, Read};

fn scene() -> Value {
    json!({
        "schemaVersion":19,"id":"d","name":"Progressive background","rasterProfile":"figma",
        "pages":[{"id":"p","name":"Page","children":["stripe","lens","caption"],"background":"#ffffff"}],
        "nodes":{
            "stripe":{"id":"stripe","kind":"rectangle","width":96,"height":64,"fills":[{"kind":"solid","color":"#3355aa"}]},
            "lens":{"id":"lens","kind":"rectangle","width":64,"height":32,"transform":[1,0,0,1,16,16],
                "fills":[{"kind":"solid","color":"#ffffff","opacity":0.1}],
                "effects":[{"kind":"background-blur","radius":4,"color":"#000000"}]},
            "caption":{"id":"caption","kind":"text","text":"Ag","fontSize":18,"width":28,"height":24,
                "transform":[1,0,0,1,34,18],"fills":[{"kind":"solid","color":"#111111"}]}
        }
    })
}

fn options() -> RenderOptions {
    serde_json::from_value(json!({"pageId":"p","width":96,"height":64,"view":{"x":0,"y":0,"zoom":1},"transparent":true})).unwrap()
}

fn render(document: &Value) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_font(include_bytes!("../../../../frontend/design-client/public/fonts/NotoSansSC.ttf")).unwrap();
    engine.load_document(&document.to_string()).unwrap();
    engine.render(&options()).unwrap()
}

fn pixel(pixels: &[u8], x: usize, y: usize) -> [u8; 4] {
    let i = (y * 96 + x) * 4;
    pixels[i..i + 4].try_into().unwrap()
}

fn channel_delta(a: [u8; 4], b: [u8; 4]) -> i16 {
    (0..4).map(|i| (a[i] as i16 - b[i] as i16).abs()).max().unwrap()
}

#[test]
fn sketch_progressive_backdrop_preserves_small_edges_at_device_scale() {
    let mut document = json!({
        "schemaVersion": 19, "id": "d", "name": "Small Sketch backdrop kernel",
        "pages": [{"id":"p", "name":"Page", "children":["black","white","lens"], "background":"#ffffff"}],
        "nodes": {
            "black": {"id":"black", "kind":"rectangle", "width":96, "height":64,
                "fills":[{"kind":"solid", "color":"#000000"}]},
            "white": {"id":"white", "kind":"rectangle", "width":48, "height":64, "transform":[1,0,0,1,48,0],
                "fills":[{"kind":"solid", "color":"#ffffff"}]},
            "lens": {"id":"lens", "kind":"rectangle", "width":64, "height":32, "transform":[1,0,0,1,16,16],
                "fills":[{"kind":"solid", "color":"#ffffff", "opacity":0.1}],
                "effects":[{"kind":"background-blur", "radius":1.2, "color":"#000000", "gradientBlur":{
                    "start":[0,16], "end":[64,16], "startCount":1, "endCount":1, "smooth":true,
                    "sketch":{"shape":"linear", "ellipse":0, "stops":[{"offset":0,"strength":0.5},{"offset":1,"strength":0.5}]}
                }}]}
        }
    });
    let draw = |document: &Value, scale: u32| {
        let mut engine = Engine::new();
        engine.load_document(&document.to_string()).unwrap();
        let options = engine.parse_options(json!({
            "pageId":"p", "width":96*scale, "height":64*scale,
            "view":{"x":0,"y":0,"zoom":scale}, "transparent":true, "rasterProfile":"analytic"
        })).unwrap();
        engine.render(&options).unwrap()
    };
    let progressive = draw(&document, 1);
    let progressive_2x = draw(&document, 2);
    document["nodes"]["lens"]["effects"][0]["visible"] = json!(false);
    assert_eq!(progressive, draw(&document, 1));
    let sharp_2x = draw(&document, 2);
    let edge = (64 * 192 + 95) * 4;
    assert!(progressive_2x[edge] > sharp_2x[edge]);
    assert!(progressive_2x[edge + 4] < sharp_2x[edge + 4]);
}

#[test]
fn sketch_linear_layer_ramp_preserves_very_small_effects_at_the_output_density() {
    let mut document = json!({
        "schemaVersion": 19, "id": "d", "name": "Small Sketch layer kernel",
        "pages": [{"id":"p", "name":"Page", "children":["layer"], "background":"#ffffff"}],
        "nodes": {"layer":{"id":"layer", "kind":"rectangle", "width":32, "height":32, "transform":[1,0,0,1,32,16],
            "fills":[{"kind":"solid", "color":"#ffffff"}],
            "effects":[{"kind":"gaussian-blur", "radius":1.2, "color":"#000000", "gradientBlur":{
                "start":[0,16], "end":[32,16], "startCount":1, "endCount":1, "smooth":true,
                "sketch":{"shape":"linear", "ellipse":0, "stops":[{"offset":0,"strength":0.5},{"offset":1,"strength":0.5}]}
            }}]}}
    });
    let draw = |document: &Value, scale: u32| {
        let mut engine = Engine::new();
        engine.load_document(&document.to_string()).unwrap();
        let options = engine.parse_options(json!({
            "pageId":"p", "width":96*scale, "height":64*scale,
            "view":{"x":0,"y":0,"zoom":scale}, "transparent":true, "rasterProfile":"analytic"
        })).unwrap();
        engine.render(&options).unwrap()
    };
    let small = draw(&document, 1);
    let larger = draw(&document, 2);
    document["nodes"]["layer"]["effects"][0]["visible"] = json!(false);
    assert_eq!(small, draw(&document, 1));
    let sharp = draw(&document, 2);
    let left = (64 * 192 + 63) * 4 + 3;
    assert!(larger[left] > sharp[left]);
    assert!(larger[left+4] < sharp[left+4]);
}

/// Issue #320: the two authored radii are the uniform blurs at the segment ends.
#[test]
fn measure_two_end_radii_against_uniform_endpoint_blurs() {
    let mut stripes = serde_json::Map::new();
    let mut children = Vec::new();
    for index in 0..12 {
        let id = format!("stripe{index}");
        children.push(id.clone());
        stripes.insert(id.clone(), json!({
            "id": id, "kind": "rectangle", "width": 8, "height": 48,
            "transform": [1, 0, 0, 1, index * 8, 0],
            "fills": [{"kind": "solid", "color": if index % 2 == 0 { "#111111" } else { "#eeeeee" }}]
        }));
    }
    children.push("lens".into());
    let lens = |start: f64, end: f64, progressive: bool| {
        let mut effect = json!({"kind":"background-blur","radius":1,"color":"#000000"});
        if progressive {
            effect["gradientBlur"] = json!({
                "start":[0.5, 16], "end":[63.5, 16], "startCount": start, "endCount": end, "smooth": true
            });
        } else {
            effect["radius"] = json!(end);
        }
        json!({
            "id":"lens","kind":"rectangle","width":64,"height":32,"transform":[1,0,0,1,16,8],
            "fills":[{"kind":"solid","color":"#ffffff","opacity":0.1}],
            "effects":[effect]
        })
    };
    let document = |start: f64, end: f64, progressive: bool| {
        let mut nodes = stripes.clone();
        nodes.insert("lens".into(), lens(start, end, progressive));
        json!({
            "schemaVersion":19,"id":"d","name":"Two-end measure","rasterProfile":"figma",
            "pages":[{"id":"p","name":"Page","children":children,"background":"#ffffff"}],
            "nodes": nodes
        })
    };
    let mut engine = Engine::new();
    let draw = |engine: &mut Engine, start: f64, end: f64, progressive: bool| {
        engine.load_document(&document(start, end, progressive).to_string()).unwrap();
        engine.render(&options()).unwrap()
    };
    let progressive = draw(&mut engine, 4., 12., true);
    let start_uniform = draw(&mut engine, 4., 4., false);
    let end_uniform = draw(&mut engine, 12., 12., false);
    let at = |image: &[u8], x: usize| pixel(image, x, 24);
    // Lens local x = world x - 16. Pixel centers 16.5 and 79.5 are the authored ends.
    let samples = [16usize, 32, 48, 64, 79];
    for x in samples {
        eprintln!(
            "x={x} progressive={:?} uniform4={:?} uniform12={:?} d4={} d12={}",
            at(&progressive, x), at(&start_uniform, x), at(&end_uniform, x),
            channel_delta(at(&progressive, x), at(&start_uniform, x)),
            channel_delta(at(&progressive, x), at(&end_uniform, x)),
        );
    }
    let _ = draw(&mut engine, 4., 12., true);
    let started = std::time::Instant::now();
    for _ in 0..3 {
        let _ = draw(&mut engine, 4., 12., true);
    }
    let progressive_ms = started.elapsed().as_secs_f64() * 1000. / 3.;
    let _ = draw(&mut engine, 12., 12., false);
    let started = std::time::Instant::now();
    for _ in 0..3 {
        let _ = draw(&mut engine, 12., 12., false);
    }
    let uniform_ms = started.elapsed().as_secs_f64() * 1000. / 3.;
    eprintln!("two-end progressive mean {progressive_ms:.2} ms, uniform radius 12 mean {uniform_ms:.2} ms");
    let mut filter_source = futureox_design_kernel::blend::Surface::new(futureox_design_kernel::math::Rect::new(0, 0, 256, 256)).unwrap();
    for (i, pixel) in filter_source.pixels.iter_mut().enumerate() {
        pixel.0 = if (i / 8) % 2 == 0 { [0.1, 0.2, 0.8, 1.] } else { [0.9, 0.85, 0.1, 1.] };
    }
    let field = futureox_design_kernel::gradient_blur::CompositeField {
        a: 1. / 256., b: 0., c: 0., start_count: 0., end_count: 0., smooth: true,
    };
    let _ = futureox_design_kernel::effects::portable_tent_blur_edge(&filter_source, 12., true).unwrap();
    let started = std::time::Instant::now();
    for _ in 0..5 {
        let _ = futureox_design_kernel::effects::portable_tent_blur_edge(&filter_source, 12., true).unwrap();
    }
    eprintln!("uniform tent r12 {:.2} ms", started.elapsed().as_secs_f64() * 1000. / 5.);
    let _ = futureox_design_kernel::effects::variable_endpoint_tent(&filter_source, &field, 4., 12., futureox_design_kernel::math::Point::default(), true).unwrap();
    let started = std::time::Instant::now();
    for _ in 0..5 {
        let _ = futureox_design_kernel::effects::variable_endpoint_tent(&filter_source, &field, 4., 12., futureox_design_kernel::math::Point::default(), true).unwrap();
    }
    eprintln!("variable tent 4→12 {:.2} ms", started.elapsed().as_secs_f64() * 1000. / 5.);
    assert_ne!(at(&start_uniform, 79), at(&end_uniform, 79), "the two radii must differ on this stripe");
    assert_eq!(at(&progressive, 16), at(&start_uniform, 16), "the start end is the smaller uniform blur");
    assert_eq!(at(&progressive, 79), at(&end_uniform, 79), "the finish end is the larger uniform blur");
    assert_ne!(at(&progressive, 16), at(&progressive, 79), "the two ends are adjustable");

    let figma = serde_json::from_value(json!({
        "pageId":"p","width":96,"height":64,"view":{"x":0,"y":0,"zoom":1},
        "transparent":true,"rasterProfile":"figma"
    })).unwrap();
    let draw_figma = |engine: &mut Engine, start: f64, end: f64, progressive: bool| {
        engine.load_document(&document(start, end, progressive).to_string()).unwrap();
        engine.render(&figma).unwrap()
    };
    let progressive = draw_figma(&mut engine, 4., 12., true);
    let start_uniform = draw_figma(&mut engine, 4., 4., false);
    let end_uniform = draw_figma(&mut engine, 12., 12., false);
    for y in 8..40 {
        assert_eq!(pixel(&progressive, 16, y), pixel(&start_uniform, 16, y), "figma column 16 y {y}");
        assert_eq!(pixel(&progressive, 79, y), pixel(&end_uniform, 79, y), "figma column 79 y {y}");
    }
}

/// The effect card's default segment runs top to bottom. That ramp has to
/// meet the same uniform radii as a horizontal one.
#[test]
fn vertical_two_end_radii_match_uniform_endpoint_blurs() {
    let mut stripes = serde_json::Map::new();
    let mut children = Vec::new();
    for index in 0..12 {
        let id = format!("stripe{index}");
        children.push(id.clone());
        stripes.insert(id.clone(), json!({
            "id": id, "kind": "rectangle", "width": 8, "height": 48,
            "transform": [1, 0, 0, 1, index * 8, 0],
            "fills": [{"kind": "solid", "color": if index % 2 == 0 { "#111111" } else { "#eeeeee" }}]
        }));
    }
    children.push("lens".into());
    let lens = |start: f64, end: f64, progressive: bool| {
        let mut effect = json!({"kind":"background-blur","radius":1,"color":"#000000"});
        if progressive {
            effect["gradientBlur"] = json!({
                "start":[32, 0.5], "end":[32, 31.5], "startCount": start, "endCount": end, "smooth": true
            });
        } else {
            effect["radius"] = json!(end);
        }
        json!({
            "id":"lens","kind":"rectangle","width":64,"height":32,"transform":[1,0,0,1,16,8],
            "fills":[{"kind":"solid","color":"#ffffff","opacity":0.1}],
            "effects":[effect]
        })
    };
    let document = |start: f64, end: f64, progressive: bool| {
        let mut nodes = stripes.clone();
        nodes.insert("lens".into(), lens(start, end, progressive));
        json!({
            "schemaVersion":19,"id":"d","name":"Vertical two-end measure","rasterProfile":"figma",
            "pages":[{"id":"p","name":"Page","children":children,"background":"#ffffff"}],
            "nodes": nodes
        })
    };
    let figma = serde_json::from_value(json!({"pageId":"p","width":96,"height":64,"view":{"x":0,"y":0,"zoom":1},"transparent":true,"rasterProfile":"figma"})).unwrap();
    let mut engine = Engine::new();
    let draw = |engine: &mut Engine, start: f64, end: f64, progressive: bool| {
        engine.load_document(&document(start, end, progressive).to_string()).unwrap();
        engine.render(&figma).unwrap()
    };
    let progressive = draw(&mut engine, 4., 12., true);
    let start_uniform = draw(&mut engine, 4., 4., false);
    let end_uniform = draw(&mut engine, 12., 12., false);
    assert_eq!(pixel(&progressive, 48, 8), pixel(&start_uniform, 48, 8), "the top end is the smaller uniform blur");
    assert_eq!(pixel(&progressive, 48, 39), pixel(&end_uniform, 48, 39), "the bottom end is the larger uniform blur");
    assert_ne!(pixel(&progressive, 48, 8), pixel(&progressive, 48, 39), "the two ends are adjustable");
    let mut top = 0;
    let mut bottom = 0;
    for x in 16..80 {
        top = top.max(channel_delta(pixel(&progressive, x, 8), pixel(&start_uniform, x, 8)));
        bottom = bottom.max(channel_delta(pixel(&progressive, x, 39), pixel(&end_uniform, x, 39)));
    }
    // The 2× four-sample resolve sits off the exact endpoint on stripe edges.
    // The previous horizontal-then-vertical tent left 2 and 4 codes on these rows.
    assert!(top <= 1 && bottom <= 1, "figma vertical ends top {top} bottom {bottom}");
}

#[test]
fn uniform_background_blur_reopens_and_a_progressive_edit_undoes() {
    let original = scene();
    let bytes = futureox_design_kernel::binfmt::encode_value(&original).unwrap();
    assert_eq!(futureox_design_kernel::binfmt::decode_value(&bytes).unwrap(), original);
    let reopened = render(&original);
    assert_eq!(render(&serde_json::from_str(&original.to_string()).unwrap()), reopened);

    let document = serde_json::from_value(original.clone()).unwrap();
    let mut editor = DocumentEditor::new(document).unwrap();
    let mut lens = editor.document().nodes["lens"].clone();
    lens.effects[0].gradient_blur = Some(serde_json::from_value(json!({
        "start":[0,16],"end":[64,16],"startCount":0,"endCount":8,"smooth":true
    })).unwrap());
    editor.apply(0, DocumentPatch { nodes: [("lens".into(), Some(lens))].into(), ..Default::default() }).unwrap();
    let edited = serde_json::to_value(editor.document()).unwrap();
    assert!(edited["nodes"]["lens"]["effects"][0]["gradientBlur"].is_object());
    assert_ne!(render(&edited), reopened);
    editor.undo().unwrap();
    assert!(editor.document().nodes["lens"].effects[0].gradient_blur.is_none());
    assert_eq!(render(&serde_json::to_value(editor.document()).unwrap()), reopened);
    editor.redo().unwrap();
    assert_eq!(editor.document().nodes["lens"].effects[0].gradient_blur.as_ref().unwrap().end_count, 8.);
}

#[test]
fn foreground_text_stacks_above_the_progressive_background() {
    let mut document = scene();
    document["nodes"]["lens"]["effects"][0]["gradientBlur"] = json!({
        "start":[0,16],"end":[64,16],"startCount":0,"endCount":8,"smooth":true
    });
    document["nodes"]["lens"]["effects"][0]["radius"] = json!(1);
    let with_text = render(&document);
    let mut bare = document.clone();
    bare["nodes"]["caption"]["visible"] = json!(false);
    let bare = render(&bare);
    let mut differed = false;
    for y in 18..42 {
        for x in 34..62 {
            if pixel(&with_text, x, y) != pixel(&bare, x, y) { differed = true; }
        }
    }
    assert!(differed, "foreground text changes pixels inside its box");
}

#[test]
fn glass_keeps_its_place_ahead_of_progressive_background_blur() {
    let progressive = json!({"kind":"background-blur","radius":1,"color":"#000000",
        "gradientBlur":{"start":[0,16],"end":[48,16],"startCount":0,"endCount":6,"smooth":true}});
    let glass = json!({"kind":"glass","radius":2,"color":"#000000","glass":{
        "depth":4,"refraction":0.4,"dispersion":0.2,"lightAngle":30,"lightIntensity":0.5}});
    let mut document = scene();
    document["nodes"]["lens"]["width"] = json!(48);
    document["nodes"]["lens"]["height"] = json!(32);
    let only = |effect: Value| {
        let mut document = document.clone();
        document["nodes"]["lens"]["effects"] = json!([effect]);
        render(&document)
    };
    let pair = |first: Value, second: Value| {
        let mut document = document.clone();
        document["nodes"]["lens"]["effects"] = json!([first, second]);
        render(&document)
    };
    let progressive_pixels = only(progressive.clone());
    let glass_pixels = only(glass.clone());
    assert_ne!(progressive_pixels, glass_pixels);
    assert_eq!(pair(glass.clone(), progressive.clone()), glass_pixels);
    assert_eq!(pair(progressive.clone(), glass.clone()), progressive_pixels);
    let parsed = |value: Value| serde_json::from_value::<futureox_design_kernel::scene::Effect>(value).unwrap();
    let glass_effect = parsed(glass);
    let progressive_effect = parsed(progressive);
    assert_eq!(selected_backdrop(&[glass_effect.clone(), progressive_effect.clone()]).unwrap().kind, "glass");
    assert_eq!(selected_backdrop(&[progressive_effect.clone(), glass_effect.clone()]).unwrap().kind, "background-blur");
    let mut hidden = glass_effect;
    hidden.visible = false;
    assert_eq!(selected_backdrop(&[hidden, progressive_effect]).unwrap().kind, "background-blur");
}

#[test]
fn sketch_blur_array_keeps_progressive_endpoints_next_to_glass() {
    let mut document = scene();
    let progressive = json!({"kind":"background-blur","radius":1,"color":"#000000",
        "colorControls":{"brightness":0,"contrast":1,"saturation":0.75,"hue":0},
        "gradientBlur":{"start":[0,16],"end":[64,16],"startCount":0,"endCount":8,"smooth":true}});
    let glass = json!({"kind":"glass","radius":2,"color":"#000000","glass":{
        "depth":8,"refraction":0.4,"dispersion":0.2,"lightAngle":45,"lightIntensity":0.5}});
    for effects in [json!([glass, progressive]), json!([progressive, glass])] {
        let index = usize::from(effects[0]["kind"] == "glass");
        document["nodes"]["lens"]["effects"] = effects;
        let model = serde_json::from_value(document.clone()).unwrap();
        let bytes = futureox_design_kernel::interop::export_sketch(&model).unwrap();
        let layer = archived_lens(&bytes);
        let style = &layer["style"];
        let blurs = style["blurs"].as_array().unwrap();
        assert_eq!(blurs.len(), 2);
        assert_eq!(blurs[1 - index]["type"], 4);
        let blur = &blurs[index];
        assert_eq!(blur["type"], 3);
        assert_eq!(blur["isProgressive"], true);
        assert_eq!(blur["radius"].as_f64(), Some(8.));
        assert_eq!(blur["saturation"], 0.75);
        let gradient = &blur["gradient"];
        assert_eq!(gradient["from"], "{0, 0.5}");
        assert_eq!(gradient["to"], "{1, 0.5}");
        assert_eq!(gradient["stops"][0]["color"]["alpha"], 0.);
        assert_eq!(gradient["stops"][1]["color"]["alpha"], 1.);
        assert_eq!(style["blur"]["type"], blurs[0]["type"]);
        let lossy = &layer["userInfo"]["com.futureox.design-kernel"]["lossy"];
        assert!(!lossy.as_array().is_some_and(|notes| {
            notes.iter().any(|note| note == "effect-background-blur-omitted")
        }));
        let reopened = futureox_design_kernel::interop::import_sketch(&bytes).unwrap();
        assert_eq!(
            reopened.nodes["lens"].effects[index].gradient_blur,
            model.nodes["lens"].effects[index].gradient_blur,
        );
    }
}

#[test]
fn sketch_progressive_background_exports_authored_filter_support_and_sharp_limit() {
    let mut document = scene();
    for (base, endpoint, expected) in [(4., 8., 32.), (0., 8., 0.), (4., 0.75, 0.), (4., 1., 0.)] {
        document["nodes"]["lens"]["effects"][0] = json!({
            "kind":"background-blur", "radius":base, "color":"#000000",
            "colorControls":{"brightness":0,"contrast":1,"saturation":0.5,"hue":0},
            "gradientBlur":{"start":[0,16],"end":[64,16],"startCount":0,"endCount":endpoint,"smooth":true}
        });
        let model = serde_json::from_value(document.clone()).unwrap();
        let bytes = futureox_design_kernel::interop::export_sketch(&model).unwrap();
        let layer = archived_lens(&bytes);
        let blur = &layer["style"]["blurs"][0];
        assert_eq!(blur["radius"].as_f64(), Some(expected), "base {base}, end {endpoint}");
        assert_eq!(blur["saturation"].as_f64(), Some(0.5));
        assert_eq!(blur.get("isProgressive").and_then(Value::as_bool), (expected > 0.).then_some(true));
        let restored = futureox_design_kernel::interop::import_sketch(&bytes).unwrap();
        assert_eq!(restored.nodes["lens"].effects, model.nodes["lens"].effects);
    }
}

fn archived_lens(bytes: &[u8]) -> Value {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let page = (0..zip.len())
        .find_map(|i| {
            let mut entry = zip.by_index(i).unwrap();
            if !entry.name().unwrap().starts_with("pages/") {
                return None;
            }
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            Some(serde_json::from_slice::<Value>(&bytes).unwrap())
        })
        .unwrap();
    page["layers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|layer| layer["userInfo"]["com.futureox.design-kernel"]["originalId"] == "lens")
        .unwrap()
        .clone()
}
