//! Native preparation sessions. The desktop host owns transport and lifetime;
//! document/layout/geometry and image export use the same Engine as WASM.
use crate::{Engine, scene_delta::SceneDelta};
use serde_json::{Value, json};

#[derive(Default)]
struct Lane { engine: Engine, delta: SceneDelta, source: Option<String>, reusable: bool }
pub struct Preparation {
    lanes: [Lane; 2],
}
pub struct Reply { pub metadata: Value, pub bytes: Vec<u8> }
impl Preparation {
    pub fn new(font: &[u8]) -> Result<Self, String> {
        let mut canvas = Lane::default(); canvas.engine.load_font(font)?;
        let mut interaction = Lane::default(); interaction.engine.fonts = canvas.engine.fonts.clone();
        Ok(Self { lanes: [canvas, interaction] })
    }
    pub fn request(&mut self, lane: &str, method: &str, args: &[Value]) -> Result<Reply, String> {
        let index = match lane { "canvas" => 0, "interaction" => 1, _ => return Err("Invalid preparation lane".into()) };
        let string = |index: usize| -> Result<&str,String> {
            let value = args.get(index).and_then(Value::as_str).ok_or("Expected string argument")?;
            if value.len() > 32*1024*1024 { return Err("Preparation argument exceeds 32 MiB".into()); }
            Ok(value)
        };
        let mut fork = false;
        if method == "load_document" && index == 1 && self.lanes[0].reusable
            && self.lanes[0].engine.image_mips() == self.lanes[1].engine.image_mips() {
            let json = string(0)?;
            let engine = if self.lanes[0].source.as_deref() == Some(json) {
                self.lanes[0].engine.snapshot_static_worker()
            } else if self.lanes[0].source.is_none() {
                self.lanes[0].engine.snapshot_static_worker_matching(json)
            } else { None };
            if let Some(engine) = engine {
                // Cache the exact host spelling only after canonical equality
                // proved the authoritative current source. Later camera/selection
                // forks of this revision avoid reparsing it.
                if self.lanes[0].source.is_none() { self.lanes[0].source = Some(json.to_owned()); }
                self.lanes[1].engine = engine; fork = true;
            }
        }
        let lane = &mut self.lanes[index];
        let engine = &mut lane.engine;
        let mut value = Value::Null; let mut bytes = Vec::new(); let mut encoding = None;
        let mut cpu_frame_mode = None;
        match method {
            "warm_resources" => (),
            "initialize" => engine.set_image_mips(args.first().and_then(Value::as_bool).ok_or("Expected mip flag")?),
            "load_document" => {
                lane.source = None; lane.reusable = false; lane.delta.clear();
                if !fork { engine.load_document(string(0)?)?; }
                lane.source = Some(string(0)?.to_owned()); lane.reusable = true;
            }
            "apply_document_patch_with_damage" => {
                lane.source = None; lane.reusable = false;
                let patch = serde_json::from_str(string(0)?).map_err(|e|format!("Invalid patch: {e}"))?;
                value = json!(serde_json::to_string(&engine.apply_document_patch_with_damage(&patch)?).map_err(|e|e.to_string())?);
                lane.reusable = true;
            }
            "apply_interaction_transforms" => {
                if index != 1 || string(0)?.len() > 65536 { return Err("Invalid interaction transforms".into()); }
                lane.source = None; lane.reusable = false;
                let transforms = serde_json::from_str(string(0)?).map_err(|e|format!("Invalid transforms: {e}"))?;
                value = json!(engine.apply_interaction_transforms(&transforms)?);
            }
            "compile_gpu_packet" | "compile_gpu_scene_update" => {
                bytes = if method == "compile_gpu_packet" { engine.compile_gpu_request(string(0)?)?.into_packet()? }
                    else { lane.delta.compile(engine,string(0)?,args.get(1).and_then(Value::as_bool).ok_or("Expected reset flag")?)? };
                encoding = Some("u8");
            }
            "clear_gpu_scene_session" => lane.delta.clear(),
            "render_region_png" => {
                let request = serde_json::from_str(string(0)?).map_err(|e|e.to_string())?;
                bytes = engine.render_region_png(&request)?; encoding = Some("u8");
            }
            "render_cpu_frame" | "render_linear" | "render_png" | "render_color_png" => {
                let options = engine.parse_options(serde_json::from_str(string(0)?).map_err(|e|e.to_string())?)?;
                encoding = Some("u8");
                bytes = match method {
                    "render_cpu_frame" => {
                        let (frame, mode) = render_cpu_frame(engine, &options, args.get(1))?;
                        cpu_frame_mode = Some(mode);
                        frame
                    }
                    "render_linear" => {
                        encoding = Some("f32");
                        engine.render_linear(&options)?.into_iter().flat_map(|p|p.0.into_iter().flat_map(f32::to_le_bytes)).collect()
                    }
                    "render_png" => engine.render_png(&options)?,
                    "render_color_png" => engine.render_color_png(&options,serde_json::from_str(string(1)?).map_err(|e|e.to_string())?)?,
                    _ => engine.render(&options)?,
                };
            }
            "stats" => value = json!(serde_json::to_string(engine.stats()).map_err(|e|e.to_string())?),
            "gpu_memory_breakdown" => value = json!(serde_json::to_string(&engine.gpu_memory_breakdown()).map_err(|e|e.to_string())?),
            _ => return Err("Unsupported native preparation method".into()),
        }
        if bytes.len() > 128*1024*1024 { return Err("Preparation response exceeds 128 MiB".into()); }
        let settings = matches!(method,"initialize"|"load_document"|"apply_document_patch_with_damage")
            .then(|| serde_json::to_string(&engine.color_settings()).expect("validated color settings"));
        let mut metadata = json!({"value":value,"encoding":encoding,"documentFork":fork});
        if let Some(settings) = settings { metadata["settings"] = json!(settings); }
        if method.starts_with("compile_gpu") { metadata["compileStats"] = engine.gpu_compile_cache_stats(); }
        if let Some(mode) = cpu_frame_mode { metadata["cpuFrameMode"] = json!(mode); }
        Ok(Reply { metadata, bytes })
    }
}

#[derive(serde::Deserialize)]
struct CpuFrameDamage {
    full: bool,
    bounds: Option<[f64; 4]>,
    rects: Option<Vec<[f64; 4]>>,
}

fn render_cpu_frame(
    engine: &mut Engine,
    options: &crate::RenderOptions,
    damage: Option<&Value>,
) -> Result<(Vec<u8>, &'static str), String> {
    // Reuse only exact-aligned analytic frames. Resampling tile pixels is not
    // an exact replacement for rasterising at the requested camera. This is
    // intentionally stricter than the older WASM route for animation/chrome.
    let aligned = options.raster_profile == crate::fidelity::RasterProfile::Analytic
        && options.width > 0 && options.height > 0
        && options.width <= 8192 && options.height <= 8192
        && u64::from(options.width) * u64::from(options.height) <= 8_388_608
        && (0.001..=128.).contains(&options.view.zoom)
        && options.view.zoom == crate::tile_stack::exact_bucket_scale(options.view.zoom)
        && options.view.x.fract() == 0.
        && options.view.y.fract() == 0.
        && options.pixel_preview.is_none()
        && options.animation.is_none()
        && !options.checkerboard
        && engine.color_settings().is_none();
    if !aligned {
        // Any intervening exact frame breaks the incremental-damage chain.
        // Never later restamp old tiles using just the most recent edit.
        if engine.tiled_renderer().is_some() {
            *engine.tiled_renderer_mut() = Default::default();
        }
        return Ok((engine.render(options)?, "exact"));
    }
    engine.prepare_frame(options)?;
    let instruction = engine.render_instruction_for(options)?;
    let previous = engine.tiled_renderer().and_then(|r| r.rendered_instruction());
    let same_domain = previous.is_some_and(|p| {
        p.page_id == instruction.page_id
            && p.options == instruction.options
            && p.color_space == instruction.color_space
    });
    let next_revision = previous.is_some_and(|p| {
        p.content_revision.checked_add(1) == Some(instruction.content_revision)
    });
    let damage: Option<CpuFrameDamage> = damage
        .filter(|v| !v.is_null())
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()
        .map_err(|e| format!("Invalid CPU frame damage: {e}"))?;
    let rects = damage.filter(|d| !d.full).map(|d| {
        d.rects.unwrap_or_else(|| d.bounds.into_iter().collect())
    });
    if rects.as_ref().is_some_and(|rects| rects.iter().any(|r| {
        r.iter().any(|v| !v.is_finite()) || r[2] < 0. || r[3] < 0.
    })) {
        return Err("Invalid CPU frame damage bounds".into());
    }
    if !same_domain {
        // Page/options changes need fresh residency even at the same content
        // revision; a paint certificate only describes document edits.
        *engine.tiled_renderer_mut() = Default::default();
    }
    let bounded = if same_domain && next_revision { rects.as_deref() } else { None };
    Ok((engine.render_tiled_frame(options, bounded)?.rgba, "tiled-exact-aligned"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document() -> Value {
        json!({"schemaVersion":1,"id":"cpu-preparation","name":"cpu preparation",
            "pages":[
                {"id":"p","name":"p","children":["r"],"background":"#ffffff"},
                {"id":"q","name":"q","children":[],"background":"#000000"}
            ],"nodes":{"r":{"id":"r","kind":"rectangle","width":16,"height":16,
                "transform":[1,0,0,1,8,8],"fills":[{"kind":"solid","color":"#ff0000"}]}}})
    }

    fn session() -> Preparation {
        // Geometry-only fixtures do not require a system or bundled font.
        let mut session = Preparation { lanes: [Lane::default(), Lane::default()] };
        session.request("canvas", "load_document", &[json!(document().to_string())]).unwrap();
        session
    }

    fn options() -> Value {
        json!({"pageId":"p","width":576,"height":32,
            "view":{"x":0,"y":0,"zoom":1},"rasterProfile":"analytic"})
    }

    fn frame(session: &mut Preparation, options: &Value, damage: Value) -> Reply {
        session.request("canvas", "render_cpu_frame", &[json!(options.to_string()), damage]).unwrap()
    }

    fn exact(session: &mut Preparation, options: &Value) -> Vec<u8> {
        let engine = &mut session.lanes[0].engine;
        let parsed = engine.parse_options(options.clone()).unwrap();
        engine.render(&parsed).unwrap()
    }

    #[test]
    fn native_cpu_frame_uses_bounded_damage_and_matches_exact_pixels() {
        let mut session = session();
        let options = options();
        let first = frame(&mut session, &options, Value::Null);
        assert_eq!(first.metadata["cpuFrameMode"], "tiled-exact-aligned");
        assert_eq!(first.bytes, exact(&mut session, &options));
        assert_eq!(session.lanes[0].engine.tiled_renderer().unwrap().last_committed().len(), 2);

        let before: crate::scene::Document = serde_json::from_value(document()).unwrap();
        let mut after = before.clone();
        after.nodes.get_mut("r").unwrap().transform.0[4] = 40.;
        let patch = crate::editing::DocumentPatch::between(&before, &after).unwrap();
        let reply = session.request("canvas", "apply_document_patch_with_damage", &[json!(serde_json::to_string(&patch).unwrap())]).unwrap();
        let damage: Value = serde_json::from_str(reply.metadata["value"].as_str().unwrap()).unwrap();
        assert_eq!(damage["full"], false);
        let next = frame(&mut session, &options, damage);
        assert_eq!(next.bytes, exact(&mut session, &options));
        assert_eq!(session.lanes[0].engine.tiled_renderer().unwrap().last_committed(), &[[0, 0]]);
    }

    #[test]
    fn native_cpu_page_and_option_changes_reset_same_revision_residency() {
        let mut session = session();
        let mut options = options();
        let first = frame(&mut session, &options, Value::Null);
        options["pageId"] = json!("q");
        let other = frame(&mut session, &options, json!({"full":false,"rects":[]}));
        assert_ne!(first.bytes, other.bytes);
        assert_eq!(other.bytes, exact(&mut session, &options));
        options["transparent"] = json!(true);
        let transparent = frame(&mut session, &options, json!({"full":false,"rects":[]}));
        assert!(transparent.bytes.iter().all(|b| *b == 0));
    }

    #[test]
    fn native_cpu_fractional_frames_keep_exact_coverage_and_break_damage_chain() {
        let mut session = session();
        let mut options = options();
        frame(&mut session, &options, Value::Null);
        options["view"]["x"] = json!(0.375);
        let fractional = frame(&mut session, &options, Value::Null);
        assert_eq!(fractional.metadata["cpuFrameMode"], "exact");
        assert_eq!(fractional.bytes, exact(&mut session, &options));
        assert!(session.lanes[0].engine.tiled_renderer().unwrap().rendered_instruction().is_none());
        options["view"]["x"] = json!(0);
        let aligned = frame(&mut session, &options, json!({"full":false,"rects":[]}));
        assert_eq!(aligned.bytes, exact(&mut session, &options));
        assert_eq!(session.lanes[0].engine.tiled_renderer().unwrap().last_committed().len(), 2);
    }

    #[test]
    fn native_cpu_rejects_invalid_damage_bounds() {
        let mut session = session();
        let error = session.request("canvas", "render_cpu_frame", &[
            json!(options().to_string()), json!({"full":false,"bounds":[0,0,-1,16]})
        ]).err().expect("invalid bounds must fail");
        assert_eq!(error, "Invalid CPU frame damage bounds");
    }

    #[test]
    fn native_cpu_revision_gaps_repaint_without_trusting_the_latest_damage_only() {
        let mut session = session();
        let options = options();
        frame(&mut session, &options, Value::Null);
        let mut before: crate::scene::Document = serde_json::from_value(document()).unwrap();
        let mut last_damage = Value::Null;
        // The first edit changes tile 1. The last edit changes only tile 0.
        // Applying just the last certificate to the original frame would
        // incorrectly restamp the old background in tile 1.
        for (id, x) in [("new", 530.), ("r", 40.)] {
            let mut after = before.clone();
            if id == "new" {
                let mut node = after.nodes["r"].clone();
                node.id = id.into();
                node.transform.0[4] = x;
                after.nodes.insert(id.into(), node);
                after.pages[0].children.push(id.into());
            } else {
                after.nodes.get_mut(id).unwrap().transform.0[4] = x;
            }
            let patch = crate::editing::DocumentPatch::between(&before, &after).unwrap();
            let reply = session.request("canvas", "apply_document_patch_with_damage", &[
                json!(serde_json::to_string(&patch).unwrap())
            ]).unwrap();
            last_damage = serde_json::from_str(reply.metadata["value"].as_str().unwrap()).unwrap();
            before = after;
        }
        assert_eq!(last_damage["full"], false);
        let updated = frame(&mut session, &options, last_damage);
        assert_eq!(updated.bytes, exact(&mut session, &options));
        assert_eq!(session.lanes[0].engine.tiled_renderer().unwrap().last_committed().len(), 2);
    }

    #[test]
    fn patched_canvas_renews_full_content_fork_and_isolates_resources() {
        let mut session = session();
        let before: crate::scene::Document = serde_json::from_value(document()).unwrap();
        let mut after = before.clone();
        after.nodes.get_mut("r").unwrap().transform.0[4] = 12.;
        let patch = crate::editing::DocumentPatch::between(&before, &after).unwrap();
        session.request("canvas", "apply_document_patch_with_damage", &[json!(serde_json::to_string(&patch).unwrap())]).unwrap();
        let input = serde_json::to_string(&after).unwrap();
        let reply = session.request("interaction", "load_document", &[json!(&input)]).unwrap();
        assert_eq!(reply.metadata["documentFork"], true);
        let request = options().to_string();
        let canvas = session.request("canvas", "compile_gpu_packet", &[json!(&request)]).unwrap().bytes;
        assert_eq!(canvas, session.request("interaction", "compile_gpu_packet", &[json!(&request)]).unwrap().bytes);
        session.request("interaction", "apply_interaction_transforms", &[json!(r#"{"r":[1,0,0,1,18,8]}"#)]).unwrap();
        assert_eq!(canvas, session.request("canvas", "compile_gpu_packet", &[json!(&request)]).unwrap().bytes);
        assert_eq!(session.request("interaction", "load_document", &[json!(serde_json::to_string(&before).unwrap())]).unwrap().metadata["documentFork"], false);
        session.request("interaction", "initialize", &[json!(true)]).unwrap();
        assert_eq!(session.request("interaction", "load_document", &[json!(&input)]).unwrap().metadata["documentFork"], false);
    }

    #[test]
    fn failed_canvas_patch_revokes_native_fork_certificate() {
        let mut session = session();
        assert!(session.request("canvas", "apply_document_patch_with_damage", &[json!("invalid")]).is_err());
        assert_eq!(session.request("interaction", "load_document", &[json!(document().to_string())]).unwrap().metadata["documentFork"], false);
    }

    #[test]
    fn native_renewal_compares_float_bits_and_ordered_document_fields() {
        let mut engine = Engine::new();
        let source = document();
        engine.load_document(&source.to_string()).unwrap();
        assert!(engine.snapshot_static_worker_matching(&source.to_string()).is_some());
        let mut different = source.clone();
        different["nodes"]["r"]["transform"][1] = json!(-0.0);
        assert!(engine.snapshot_static_worker_matching(&different.to_string()).is_none());
        different = source.clone();
        different["pages"].as_array_mut().unwrap().reverse();
        assert!(engine.snapshot_static_worker_matching(&different.to_string()).is_none());
        different = source.clone();
        different["nodes"]["r"]["fills"][0]["color"] = json!("#00ff00");
        assert!(engine.snapshot_static_worker_matching(&different.to_string()).is_none());
    }

}
