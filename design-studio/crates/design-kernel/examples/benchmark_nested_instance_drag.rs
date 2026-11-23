//! Isolated native CPU timings for dragging a nested component instance.
//! No GPU, Metal, Electron, or official-desktop claim. Images are not in the fixture.
//!
//! Stages, per warm drag frame:
//! - interchange: `DocumentPatch` JSON encode + decode
//! - derivation: resident `component_updates::State::patch` (override propagation,
//!   nested instance expansion, layout). Variant swaps are a separate op.
//! - redraw: interaction-pose admission, document-patch install, GPU-packet compile,
//!   and a small CPU pixel render of the same pose.
use futureox_design_kernel::{
    Engine, RenderOptions, component_updates::State, components, curve_boolean,
    editing::DocumentPatch, font::Fonts, layout, scene::Document,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{env, hint::black_box, time::Instant};

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn rect(id: &str, x: f64, y: f64) -> Value {
    json!({"id":id,"name":id,"kind":"rectangle","width":18,"height":12,
        "transform":[1,0,0,1,x,y],"fills":[{"kind":"solid","color":"#3c6e9a"}]})
}

fn frame(id: &str, w: f64, h: f64, children: &[&str]) -> Value {
    json!({"id":id,"name":id,"kind":"frame","width":w,"height":h,"children":children,
        "fills":[{"kind":"solid","color":"#f4f7fb"}]})
}

fn text(id: &str, value: &str) -> Value {
    json!({"id":id,"name":id,"kind":"text","width":72,"height":16,"text":value,"fontSize":12,
        "transform":[1,0,0,1,28,8],"fills":[{"kind":"solid","color":"#1c2834"}]})
}

fn component(mut node: Value, children: &[&str]) -> Value {
    node["children"] = json!(children);
    node["component"] = json!({"variants":{},"properties":{}});
    node
}

fn instance_of(id: &str, component_id: &str, key: Option<&str>, x: f64, y: f64) -> Value {
    let mut node = frame(id, 120.0, 36.0, &[]);
    node["transform"] = json!([1, 0, 0, 1, x, y]);
    node["instance"] = json!({"componentId":component_id,"overrides":{},"propertyValues":{}});
    if let Some(key) = key {
        node["componentKey"] = json!(key);
    }
    node
}

fn owned_layer(prefix: &str, role: &str, mut node: Value) -> (String, Value) {
    let id = format!("{prefix}-{role}");
    node["id"] = json!(id);
    node["name"] = json!(id);
    (id, node)
}

/// Card → button variant instance → icon instance → badge instance.
/// The dragged node is the nested button, not the top-level card and not an image.
fn nested_variant_document(buttons: usize, icon_shapes: usize) -> Document {
    let mut nodes = serde_json::Map::new();
    let mut roots = Vec::new();

    let mut badge_children = Vec::new();
    for i in 0..4 {
        let id = format!("badge-r{i}");
        badge_children.push(id.clone());
        nodes.insert(
            id.clone(),
            rect(&id, (i % 2) as f64 * 8.0, (i / 2) as f64 * 6.0),
        );
    }
    let badge_ids: Vec<&str> = badge_children.iter().map(String::as_str).collect();
    nodes.insert(
        "badge".into(),
        component(frame("badge", 16.0, 12.0, &badge_ids), &badge_ids),
    );
    roots.push("badge".into());

    let mut icon_children = vec!["badge-slot".into()];
    nodes.insert(
        "badge-slot".into(),
        instance_of("badge-slot", "badge", Some("badgeSlot"), 2.0, 2.0),
    );
    for i in 0..icon_shapes {
        let id = format!("icon-r{i}");
        icon_children.push(id.clone());
        nodes.insert(
            id.clone(),
            rect(&id, (i % 4) as f64 * 6.0, (i / 4) as f64 * 6.0),
        );
    }
    let icon_ids: Vec<&str> = icon_children.iter().map(String::as_str).collect();
    nodes.insert(
        "icon".into(),
        component(frame("icon", 28.0, 28.0, &icon_ids), &icon_ids),
    );
    roots.push("icon".into());

    for (id, variant, label) in [
        ("button-default", "默认", "按钮"),
        ("button-hover", "悬停", "悬停"),
    ] {
        let (icon_id, icon) = owned_layer(
            id,
            "icon-slot",
            instance_of("tmp", "icon", Some("iconSlot"), 4.0, 4.0),
        );
        let (label_id, label_node) = owned_layer(id, "label", text("tmp", label));
        let (chrome_id, chrome) = owned_layer(id, "chrome", rect("tmp", 0.0, 30.0));
        nodes.insert(icon_id.clone(), icon);
        nodes.insert(label_id.clone(), label_node);
        nodes.insert(chrome_id.clone(), chrome);
        let owned = [icon_id, label_id, chrome_id];
        let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
        let mut master = component(frame(id, 120.0, 36.0, &refs), &refs);
        master["component"]["variants"] = json!({"状态": variant});
        nodes.insert(id.into(), master);
    }
    nodes.insert(
        "button-set".into(),
        json!({"id":"button-set","name":"button-set","kind":"section","width":320,"height":80,
            "componentSet":true,"children":["button-default","button-hover"],"fills":[]}),
    );
    roots.push("button-set".into());

    let mut card_children = Vec::new();
    for i in 0..buttons {
        let id = format!("action-{i}");
        let key = format!("action{i}");
        let mut inst = instance_of(
            &id,
            "button-default",
            Some(&key),
            8.0,
            8.0 + i as f64 * 40.0,
        );
        inst["width"] = json!(120.0);
        inst["height"] = json!(36.0);
        nodes.insert(id.clone(), inst);
        card_children.push(id);
    }
    for i in 0..6 {
        let id = format!("card-r{i}");
        card_children.push(id.clone());
        nodes.insert(id.clone(), rect(&id, 140.0, i as f64 * 16.0));
    }
    let card_refs: Vec<&str> = card_children.iter().map(String::as_str).collect();
    nodes.insert(
        "card".into(),
        component(
            frame("card", 280.0, 40.0 + buttons as f64 * 40.0, &card_refs),
            &card_refs,
        ),
    );
    roots.push("card".into());

    for i in 0..4 {
        let id = format!("card-instance-{i}");
        let mut inst = instance_of(
            &id,
            "card",
            None,
            24.0 + (i % 2) as f64 * 300.0,
            24.0 + (i / 2) as f64 * 360.0,
        );
        inst["width"] = json!(280.0);
        inst["height"] = json!(40.0 + buttons as f64 * 40.0);
        // Stable text and fill overrides. A drag must not re-decide the variant.
        let mut overrides = serde_json::Map::new();
        overrides.insert(
            "action0/button-default-label".into(),
            json!({"text": format!("卡片{i}")}),
        );
        overrides.insert(
            "action0/iconSlot/icon-r0".into(),
            json!({"fills":[{"kind":"solid","color":"#c4552a"}]}),
        );
        inst["instance"]["overrides"] = Value::Object(overrides);
        nodes.insert(id.clone(), inst);
        roots.push(id);
    }

    serde_json::from_value(json!({
        "schemaVersion": 21,
        "id": "nested-instance-drag",
        "name": "nested instance drag",
        "pages": [{"id":"page","name":"page","background":"#ffffff","children": roots}],
        "nodes": nodes
    }))
    .expect("fixture")
}

fn single_instance_document() -> Document {
    let mut nodes = serde_json::Map::new();
    nodes.insert("mark".into(), rect("mark", 4.0, 4.0));
    nodes.insert(
        "solo".into(),
        component(frame("solo", 40.0, 24.0, &["mark"]), &["mark"]),
    );
    let mut inst = instance_of("solo-instance", "solo", None, 30.0, 30.0);
    inst["width"] = json!(40.0);
    inst["height"] = json!(24.0);
    nodes.insert("solo-instance".into(), inst);
    serde_json::from_value(json!({
        "schemaVersion": 21, "id": "single-instance", "name": "single",
        "pages": [{"id":"page","name":"page","background":"#ffffff","children":["solo","solo-instance"]}],
        "nodes": nodes
    }))
    .unwrap()
}

fn generated(doc: &Document, owner: &str, key: &str) -> String {
    doc.nodes
        .values()
        .find(|n| {
            n.instance_origin
                .as_ref()
                .is_some_and(|o| o.owner == owner && o.key == key)
        })
        .unwrap_or_else(|| panic!("missing generated {owner} {key}"))
        .id
        .clone()
}

fn materialize(base: &Document, reply: &Value) -> Document {
    let mut doc = base.clone();
    for id in reply["removed"].as_array().unwrap() {
        doc.nodes.remove(id.as_str().unwrap());
    }
    for (id, node) in reply["nodes"].as_object().unwrap() {
        doc.nodes
            .insert(id.clone(), serde_json::from_value(node.clone()).unwrap());
    }
    doc
}

fn resolve_all(doc: &mut Document, fonts: &Fonts) {
    doc.validate().expect("authored");
    components::resolve(doc).expect("components");
    layout::resolve(doc, fonts).expect("layout");
    curve_boolean::resolve(doc).expect("boolean");
    doc.validate().expect("resolved");
}

/// Editor drag of one nested button: move its generated transform and record
/// that transform on the owning instance. The variant `componentId` stays put.
fn drag_nested(doc: &Document, owner: &str, key: &str, dx: f64) -> Document {
    let mut next = doc.clone();
    let id = generated(&next, owner, key);
    let transform = {
        let node = next.nodes.get_mut(&id).unwrap();
        node.transform.0[4] += dx;
        serde_json::to_value(&node.transform).unwrap()
    };
    let overrides = &mut next
        .nodes
        .get_mut(owner)
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .overrides;
    overrides
        .entry(key.into())
        .or_default()
        .insert("transform".into(), transform);
    next
}

fn switch_nested_variant(doc: &Document, owner: &str, key: &str, component_id: &str) -> Document {
    let mut next = doc.clone();
    let overrides = &mut next
        .nodes
        .get_mut(owner)
        .unwrap()
        .instance
        .as_mut()
        .unwrap()
        .overrides;
    overrides
        .entry(key.into())
        .or_default()
        .insert("swapComponent".into(), json!(component_id));
    next
}

fn drag_top_level(doc: &Document, id: &str, dx: f64) -> Document {
    let mut next = doc.clone();
    next.nodes.get_mut(id).unwrap().transform.0[4] += dx;
    next
}

struct Clock {
    samples: Vec<f64>,
}
impl Clock {
    fn time(&mut self, body: impl FnOnce()) -> f64 {
        let start = Instant::now();
        body();
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        self.samples.push(ms);
        ms
    }
    fn stats(&self) -> Value {
        let mut values = self.samples.clone();
        values.sort_by(f64::total_cmp);
        json!({
            "n": values.len(),
            "p50Ms": values[values.len()/2],
            "p95Ms": values[(values.len()-1)*95/100],
            "minMs": values[0],
            "maxMs": values[values.len()-1],
        })
    }
}

fn patch_json(before: &Document, after: &Document) -> (String, usize) {
    let patch = DocumentPatch::between(before, after).expect("patch");
    let encoded = serde_json::to_string(&patch).expect("encode");
    let bytes = encoded.len();
    (encoded, bytes)
}

fn derivation_frames(
    label: &str,
    base: &Document,
    fonts: &Fonts,
    frames: usize,
    edit: impl Fn(&Document, f64) -> Document,
) -> Value {
    let mut state = State::default();
    let initial = serde_json::to_string(base).unwrap();
    let opened: Value = serde_json::from_str(&state.full(&initial, fonts).expect("full")).unwrap();
    let mut receipt = opened["receipt"].as_u64().unwrap() as u32;
    let mut current = materialize(base, &opened);
    // One cold frame settles receipts and allocator shape. It is not a sample.
    {
        let next = edit(&current, 3.0);
        let (encoded, _) = patch_json(&current, &next);
        let reply: Value =
            serde_json::from_str(&state.patch(&encoded, receipt, fonts).expect(label)).unwrap();
        receipt = reply["receipt"].as_u64().unwrap() as u32;
        current = materialize(&next, &reply);
    }
    let mut interchange = Clock { samples: vec![] };
    let mut compute = Clock { samples: vec![] };
    let mut resolve_only = Clock { samples: vec![] };
    let mut layout_only = Clock { samples: vec![] };
    let mut reply_bytes = 0usize;
    let mut reply_nodes = 0usize;
    let mut patch_bytes = 0usize;
    let mut variant_ids = Vec::new();
    let mut parsed_pose = Value::Null;
    for frame in 0..frames {
        let dx = if frame % 2 == 0 { 5.25 } else { -5.25 };
        let next = edit(&current, dx);
        let (encoded, bytes) = {
            let start = Instant::now();
            let (encoded, bytes) = patch_json(&current, &next);
            let decoded: DocumentPatch = serde_json::from_str(&encoded).unwrap();
            black_box(decoded.nodes.len());
            interchange
                .samples
                .push(start.elapsed().as_secs_f64() * 1000.0);
            (encoded, bytes)
        };
        patch_bytes = bytes;
        let reply = {
            let encoded = encoded.clone();
            let start = Instant::now();
            let reply = state.patch(&encoded, receipt, fonts).expect(label);
            compute.samples.push(start.elapsed().as_secs_f64() * 1000.0);
            reply
        };
        let parsed: Value = serde_json::from_str(&reply).unwrap();
        reply_bytes = reply.len();
        reply_nodes = parsed["nodes"].as_object().unwrap().len();
        receipt = parsed["receipt"].as_u64().unwrap() as u32;
        assert_ne!(
            parsed["stats"]["pose"],
            Value::Bool(true),
            "{label} must not take the transform pose proof"
        );
        parsed_pose = parsed["stats"]["pose"].clone();
        // Direct stage split on the same candidate, outside the resident receipt.
        {
            let mut doc = next.clone();
            resolve_only.time(|| components::resolve(&mut doc).unwrap());
            let mut laid = doc.clone();
            layout_only.time(|| layout::resolve(&mut laid, fonts).unwrap());
        }
        if let Some(owner) = next
            .nodes
            .get("card-instance-0")
            .and_then(|n| n.instance.as_ref())
        {
            let swap = owner
                .overrides
                .get("action0")
                .and_then(|f| f.get("swapComponent"))
                .and_then(|v| v.as_str())
                .unwrap_or("button-default");
            variant_ids.push(swap.to_owned());
        }
        current = materialize(&next, &parsed);
    }
    json!({
        "label": label,
        "frames": frames,
        "patchBytes": patch_bytes,
        "replyBytes": reply_bytes,
        "replyNodes": reply_nodes,
        "pose": parsed_pose,
        "interchange": interchange.stats(),
        "statePatch": compute.stats(),
        "componentsResolveOnCandidate": resolve_only.stats(),
        "layoutResolveOnCandidate": layout_only.stats(),
        "generatedVariantComponentIds": variant_ids,
        "nodes": current.nodes.len(),
    })
}

fn redraw(label: &str, before: &Document, after: &Document, font: &[u8]) -> Value {
    let mut engine = Engine::new();
    engine.load_font(font).unwrap();
    engine
        .load_document(&serde_json::to_string(before).unwrap())
        .unwrap();
    let options: RenderOptions = serde_json::from_value(json!({
        "pageId":"page","width":240,"height":180,
        "view":{"x":0.125,"y":0.375,"zoom":1},"rasterProfile":"analytic"
    }))
    .unwrap();
    for _ in 0..2 {
        black_box(engine.compile_gpu(&options).unwrap());
    }
    let changed: Vec<(String, futureox_design_kernel::math::Transform)> = after
        .nodes
        .iter()
        .filter(|(id, node)| {
            before
                .nodes
                .get(*id)
                .is_some_and(|old| old.transform != node.transform)
        })
        .map(|(id, node)| (id.clone(), node.transform))
        .collect();
    let retained = if changed.is_empty() || changed.len() > 16 {
        false
    } else {
        engine
            .apply_interaction_transforms(&changed.iter().cloned().collect())
            .unwrap()
    };
    let patch = DocumentPatch::between(before, after).unwrap();
    let mut patch_ms = Clock { samples: vec![] };
    let mut compile_ms = Clock { samples: vec![] };
    let mut pixel_ms = Clock { samples: vec![] };
    let patch_json = serde_json::to_string(&patch).unwrap();
    // The engine consumes the patch. Rebuild a fresh engine per sample so each
    // frame starts from the same settled document. Setup is outside the window.
    let mut engines = Vec::new();
    for _ in 0..7 {
        let mut engine = Engine::new();
        engine.load_font(font).unwrap();
        engine
            .load_document(&serde_json::to_string(before).unwrap())
            .unwrap();
        black_box(engine.compile_gpu(&options).unwrap());
        engines.push(engine);
    }
    let mut damage = Value::Null;
    for engine in engines.iter_mut() {
        let patch: DocumentPatch = serde_json::from_str(&patch_json).unwrap();
        patch_ms.time(|| {
            damage = serde_json::to_value(engine.apply_document_patch_with_damage(&patch).unwrap())
                .unwrap();
        });
        compile_ms.time(|| {
            black_box(engine.compile_gpu(&options).unwrap());
        });
        pixel_ms.time(|| {
            black_box(engine.render(&options).unwrap());
        });
    }
    json!({
        "label": label,
        "changedTransforms": changed.len(),
        "interactionRetained": retained,
        "interactionTransformCount": changed.len(),
        "patchBytes": patch_json.len(),
        "damage": damage,
        "applyPatch": patch_ms.stats(),
        "compilePacket": compile_ms.stats(),
        "cpuPixels": pixel_ms.stats(),
        "cpuPixelsNote": "CPU analytic raster of 240x180, not hardware WebGPU, not a presented frame",
    })
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let frames: usize = env::var("NESTED_DRAG_FRAMES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8);
    let profile = env::var("NESTED_DRAG_PROFILE").ok().as_deref() == Some("1");
    let mut fonts = Fonts::new();
    let font = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
    ))?;
    fonts.load(&font)?;
    let mut authored = nested_variant_document(8, 8);
    let authored_bytes = serde_json::to_vec(&authored)?;
    resolve_all(&mut authored, &fonts);
    let resolved_bytes = serde_json::to_vec(&authored)?;
    let owner = "card-instance-0";
    let key = "action0";
    let nested_id = generated(&authored, owner, key).to_owned();
    let before_component = authored.nodes[&nested_id]
        .instance
        .as_ref()
        .unwrap()
        .component_id
        .clone();
    assert_eq!(before_component, "button-default");
    assert!(
        authored.nodes[&nested_id].instance_origin.is_some(),
        "drag target is a nested instance"
    );
    assert!(
        authored.nodes[owner].instance_origin.is_none(),
        "owner is the top-level instance, not the drag target"
    );

    if profile {
        let mut state = State::default();
        let opened: Value =
            serde_json::from_str(&state.full(&serde_json::to_string(&authored)?, &fonts)?)?;
        let mut receipt = opened["receipt"].as_u64().unwrap() as u32;
        let mut current = materialize(&authored, &opened);
        for i in 0..frames.max(40) {
            let next = drag_nested(&current, owner, key, if i % 2 == 0 { 4.0 } else { -4.0 });
            let (encoded, _) = patch_json(&current, &next);
            let reply = state.patch(&encoded, receipt, &fonts)?;
            let parsed: Value = serde_json::from_str(&reply)?;
            receipt = parsed["receipt"].as_u64().unwrap() as u32;
            current = materialize(&next, &parsed);
            black_box(reply.len());
        }
        let before = current;
        let mut resolved = drag_nested(&before, owner, key, 6.5);
        resolve_all(&mut resolved, &fonts);
        let mut engine = Engine::new();
        engine.load_font(&font)?;
        engine.load_document(&serde_json::to_string(&before)?)?;
        let options: RenderOptions =
            serde_json::from_value(json!({"pageId":"page","width":240,"height":180,
            "view":{"x":0.125,"y":0.375,"zoom":1},"rasterProfile":"analytic"}))
            .unwrap();
        black_box(engine.compile_gpu(&options)?);
        let forward = DocumentPatch::between(&before, &resolved)?;
        let backward = DocumentPatch::between(&resolved, &before)?;
        for _ in 0..frames.max(40) {
            black_box(engine.apply_document_patch_with_damage(&forward.clone())?);
            black_box(engine.compile_gpu(&options)?);
            black_box(engine.apply_document_patch_with_damage(&backward.clone())?);
            black_box(engine.compile_gpu(&options)?);
        }
        println!("{{\"profileFrames\":{}}}", frames.max(40));
        return Ok(());
    }

    let drag = derivation_frames(
        "nested-instance-transform",
        &authored,
        &fonts,
        frames,
        |doc, dx| drag_nested(doc, owner, key, dx),
    );
    let variant = derivation_frames(
        "nested-variant-swap",
        &authored,
        &fonts,
        frames,
        |doc, dx| {
            switch_nested_variant(
                doc,
                owner,
                key,
                if dx > 0.0 {
                    "button-hover"
                } else {
                    "button-default"
                },
            )
        },
    );
    let mut single = single_instance_document();
    resolve_all(&mut single, &fonts);
    let top = derivation_frames(
        "top-level-single-instance-transform",
        &single,
        &fonts,
        frames,
        |doc, dx| drag_top_level(doc, "solo-instance", dx),
    );

    let nested_after = drag_nested(&authored, owner, key, 11.5);
    let mut nested_resolved = nested_after.clone();
    resolve_all(&mut nested_resolved, &fonts);
    let variant_after = switch_nested_variant(&authored, owner, key, "button-hover");
    let mut variant_resolved = variant_after.clone();
    resolve_all(&mut variant_resolved, &fonts);
    let swapped = generated(&variant_resolved, owner, key);
    let swapped_component = variant_resolved.nodes[&swapped]
        .instance
        .as_ref()
        .unwrap()
        .component_id
        .clone();
    let redraw_nested = redraw(
        "nested-instance-transform",
        &authored,
        &nested_resolved,
        &font,
    );
    let redraw_variant = redraw("nested-variant-swap", &authored, &variant_resolved, &font);
    let single_after = drag_top_level(&single, "solo-instance", 11.5);
    let mut single_resolved = single_after.clone();
    resolve_all(&mut single_resolved, &fonts);
    let redraw_single = redraw(
        "top-level-single-instance-transform",
        &single,
        &single_resolved,
        &font,
    );

    let report = json!({
        "profile": if cfg!(debug_assertions) { "debug" } else { "release-assertions-off" },
        "buildNote": env::var("NESTED_DRAG_BUILD").unwrap_or_else(|_| "unspecified".into()),
        "arch": std::env::consts::ARCH,
        "os": std::env::consts::OS,
        "hardwareWebGPU": "NOT_RUN",
        "metal": "NOT_RUN",
        "electron": "NOT_RUN",
        "officialDesktop": "NOT_RUN",
        "dri": "NOT_PRESENT",
        "scope": "CPU isolated native. Nested component-instance drag and variant swap only. Images excluded. Top-level single instance is a control, not an optimization target.",
        "fixture": {
            "authoredSha256": hash(&authored_bytes),
            "resolvedSha256": hash(&resolved_bytes),
            "fontSha256": hash(&font),
            "resolvedNodes": authored.nodes.len(),
            "nestedTarget": nested_id,
            "nestedTargetIsInstance": true,
            "variantBefore": before_component,
            "variantAfterSwap": swapped_component,
        },
        "derivation": [drag, variant, top],
        "redraw": [redraw_nested, redraw_variant, redraw_single],
    });
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
