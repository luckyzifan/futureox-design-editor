//! Native preparation sessions. The desktop host owns transport and lifetime;
//! document/layout/geometry and image export use the same Engine as WASM.
use crate::{Engine, scene_delta::SceneDelta};
use serde_json::{Value, json};

#[derive(Default)]
struct Lane { engine: Engine, delta: SceneDelta, source: Option<String> }
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
        if method == "load_document" && index == 1 && self.lanes[0].source.as_deref() == Some(string(0)?)
            && self.lanes[0].engine.image_mips() == self.lanes[1].engine.image_mips() {
            if let Some(engine) = self.lanes[0].engine.snapshot_static_worker() {
                self.lanes[1].engine = engine; fork = true;
            }
        }
        let lane = &mut self.lanes[index];
        let engine = &mut lane.engine;
        let mut value = Value::Null; let mut bytes = Vec::new(); let mut encoding = None;
        match method {
            "warm_resources" => (),
            "initialize" => engine.set_image_mips(args.first().and_then(Value::as_bool).ok_or("Expected mip flag")?),
            "load_document" => {
                lane.source = None; lane.delta.clear();
                if !fork { engine.load_document(string(0)?)?; }
                lane.source = Some(string(0)?.to_owned());
            }
            "apply_document_patch_with_damage" => {
                lane.source = None;
                let patch = serde_json::from_str(string(0)?).map_err(|e|format!("Invalid patch: {e}"))?;
                value = json!(serde_json::to_string(&engine.apply_document_patch_with_damage(&patch)?).map_err(|e|e.to_string())?);
            }
            "apply_interaction_transforms" => {
                if index != 1 || string(0)?.len() > 65536 { return Err("Invalid interaction transforms".into()); }
                lane.source = None;
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
        Ok(Reply { metadata, bytes })
    }
}
