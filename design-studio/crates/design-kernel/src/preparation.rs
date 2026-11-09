//! Native preparation sessions. The desktop host owns transport and lifetime;
//! document/layout/geometry and image export use the same Engine as WASM.
use crate::Engine;
use serde_json::{Value, json};
#[cfg(not(target_arch = "wasm32"))]
mod source_snapshot;
#[cfg(not(target_arch = "wasm32"))]
mod source_hit;

#[derive(Default)]
struct Lane {
    engine: Engine, source: Option<String>, reusable: bool, receipt: Option<StateReceipt>, source_storage: bool,
    #[cfg(not(target_arch = "wasm32"))]
    source_access: Option<source_snapshot::Access>,
}
pub struct Preparation {
    lanes: [Lane; 2],
    owner: String,
    sequence: u64,
    operation: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateReceipt {
    protocol: u8, session_generation: String, canvas_owner: String,
    document_incarnation: String, lane: String, synchronized_revision: String,
    resource_epoch: String, nonce: String,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeriveRequest {
    operation_id: u64, base_receipt: StateReceipt, target: String,
    expected_target: Option<StateReceipt>, delta: Vec<Value>,
}
fn session_owner() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    format!("{}-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}
pub struct Reply { pub metadata: Value, pub bytes: Vec<u8> }
impl Preparation {
    /// Native acquisition boundary for the next renderer stage. This returns
    /// authored records with explicit cold identities, never a partial Engine
    /// or an edit/export baseline. Uses only the host-admitted lane descriptor.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn source_viewport_demand(&mut self, lane: &str, camera: crate::math::Transform, viewport: crate::math::Rect, cancel: &std::sync::atomic::AtomicBool) -> Result<crate::scene_demand::LoadedDemand,String> {
        let index=match lane {"canvas"=>0,"interaction"=>1,_=>return Err("Invalid preparation lane".into())};
        let lane=&mut self.lanes[index];
        if lane.receipt.is_none() {return Err("Unsynchronized source demand lane".into());}
        lane.source_access.as_mut().ok_or("No immutable source demand owner")?.viewport(&mut lane.engine,camera,viewport,cancel)
    }
    pub fn new(font: &[u8]) -> Result<Self, String> {
        let mut canvas = Lane::default(); canvas.engine.load_font(font)?;
        let mut interaction = Lane::default(); interaction.engine.fonts = canvas.engine.fonts.clone();
        Ok(Self { lanes: [canvas, interaction], owner: session_owner(), sequence: 0, operation: 0 })
    }
    fn mint(&mut self, index: usize, previous: Option<StateReceipt>, new_document: bool) -> StateReceipt {
        self.sequence = self.sequence.checked_add(1).expect("preparation receipt exhausted");
        let serial = self.sequence.to_string();
        let receipt = StateReceipt { protocol: 1, session_generation: self.owner.clone(),
            canvas_owner: self.owner.clone(), document_incarnation: if new_document { serial.clone() }
                else { previous.as_ref().map(|r| r.document_incarnation.clone()).unwrap_or_else(|| serial.clone()) },
            lane: if index == 0 { "canvas" } else { "interaction" }.into(),
            synchronized_revision: serial.clone(), resource_epoch: serial.clone(), nonce: serial };
        self.lanes[index].engine.bind_frame_scene_scope(&serde_json::to_string(&receipt).expect("owned receipt" )).expect("owned scope");
        self.lanes[index].receipt = Some(receipt.clone()); receipt
    }
    fn derive(&mut self, index: usize, args: &[Value]) -> Result<Reply, String> {
        if index != 1 || args.len() != 1 || serde_json::to_vec(&args[0]).map_err(|e|e.to_string())?.len() > 8192 {
            return Err("DERIVE_SCHEMA".into());
        }
        if !args[0].as_object().is_some_and(|o| o.len() == 5 && o.contains_key("expectedTarget")) {
            return Err("DERIVE_SCHEMA".into());
        }
        if self.sequence == u64::MAX { return Err("PREPARATION_SESSION_EXHAUSTED".into()); }
        let request: DeriveRequest = serde_json::from_value(args[0].clone()).map_err(|_|"DERIVE_SCHEMA")?;
        if request.operation_id == 0 || request.operation_id > 9_007_199_254_740_991 || request.target != "interaction" || !request.delta.is_empty() {
            return Err("DERIVE_SCHEMA".into());
        }
        // Single-session high-watermark: never replay an uncertain operation.
        if request.operation_id <= self.operation { return Err("DERIVE_RETRY_REJECTED".into()); }
        self.operation = request.operation_id;
        if self.lanes[0].receipt.as_ref() != Some(&request.base_receipt) { return Err("STALE_BASE".into()); }
        if self.lanes[1].receipt != request.expected_target { return Err("STALE_TARGET".into()); }
        if self.lanes[0].engine.image_mips() != self.lanes[1].engine.image_mips() { return Err("RESOURCE_POLICY_MISMATCH".into()); }
        #[cfg(not(target_arch="wasm32"))]
        let lazy_fork=self.lanes[0].source_access.as_ref().is_some_and(source_snapshot::Access::can_fork_lazy);
        #[cfg(target_arch="wasm32")]
        let lazy_fork=false;
        #[cfg(not(target_arch="wasm32"))]
        if !lazy_fork {let lane=&mut self.lanes[0];if let Some(source)=&mut lane.source_access {source.ensure_complete(&mut lane.engine,&std::sync::atomic::AtomicBool::new(false))?;}}
        let candidate = if lazy_fork {self.lanes[0].engine.snapshot_worker()} else {self.lanes[0].engine.snapshot_static_worker().ok_or("DERIVE_UNSUPPORTED_STATE")?};
        let mut settings=candidate.color_settings();
        #[cfg(not(target_arch="wasm32"))]
        if lazy_fork {settings=self.lanes[0].source_access.as_ref().unwrap().settings();}
        let settings = serde_json::to_string(&settings).map_err(|e|e.to_string())?;
        // All fallible work precedes publication. Immutable resources remain Arc-owned.
        self.lanes[1] = Lane { engine: candidate, reusable: true, source_storage:self.lanes[0].source_storage,
            #[cfg(not(target_arch = "wasm32"))]
            source_access:self.lanes[0].source_access.clone(),
            ..Lane::default() };
        let receipt = self.mint(1, Some(request.base_receipt), false);
        Ok(Reply { metadata: json!({"stateReceipt":receipt,"settings":settings,"documentFork":true}), bytes: Vec::new() })
    }
    #[cfg(not(target_arch="wasm32"))]
    pub fn render_with_bitmaps(&mut self,lane:&str,method:&str,args:&[Value],directory:crate::source_bitmap_pixels::Directory)->Result<Reply,String>{
        if !matches!(method,"render_linear"|"render_png"|"render_color_png"|"render_region_png"|"render_cpu_frame"){return Err("Invalid source bitmap render request".into());}
        let index=match lane {"canvas"=>0,"interaction"=>1,_=>return Err("Invalid preparation lane".into())};
        let access=crate::source_bitmap_pixels::Access::new(directory);
        self.lanes[index].engine.set_source_bitmaps(Some(access.clone()));
        let result=self.request(lane,method,args);
        self.lanes[index].engine.set_source_bitmaps(None);
        access.check()?;result
    }
    pub fn request(&mut self, lane: &str, method: &str, args: &[Value]) -> Result<Reply, String> {
        let index=match lane{"canvas"=>0,"interaction"=>1,_=>return Err("Invalid preparation lane".into())};
        let source=method=="load_source_snapshot"||method=="derive_document_v1"&&self.lanes[0].source_storage||method!="load_document"&&self.lanes[index].source_storage;
        crate::capacity::with_source_storage_scope(source,||self.request_scoped(lane,method,args))
    }
    fn request_scoped(&mut self, lane: &str, method: &str, args: &[Value]) -> Result<Reply, String> {
        let index = match lane { "canvas" => 0, "interaction" => 1, _ => return Err("Invalid preparation lane".into()) };
        if method == "preparation_capabilities_v1" {
            return Ok(Reply { metadata: json!({"value":{"protocol":1,"emptyDeltaDerivation":true,"guardedPatchReceiptV1":true,"nativeSourceSnapshot":cfg!(not(target_arch="wasm32"))}}), bytes: Vec::new() });
        }
        if method == "derive_document_v1" { return self.derive(index, args); }
        if method == "apply_document_patch_with_damage" && args.len() > 1 {
            if args.len() != 2 || !args[1].as_object().is_some_and(|o| o.len() == 1 && o.contains_key("expectedBaseReceipt")) {
                return Err("PATCH_GUARD_SCHEMA".into());
            }
            let expected: StateReceipt = serde_json::from_value(args[1]["expectedBaseReceipt"].clone())
                .map_err(|_| "PATCH_GUARD_SCHEMA")?;
            if expected.protocol != 1 { return Err("PATCH_GUARD_SCHEMA".into()); }
            if self.lanes[index].receipt.as_ref() != Some(&expected) { return Err("STALE_BASE".into()); }
            if self.sequence == u64::MAX { return Err("PREPARATION_SESSION_EXHAUSTED".into()); }
        }
        let source_load = method == "load_source_snapshot";
        let mutation = source_load || matches!(method, "initialize" | "load_document" | "apply_document_patch_with_damage" | "apply_interaction_transforms");
        #[cfg(not(target_arch="wasm32"))]
        if matches!(method,"initialize"|"apply_document_patch_with_damage"|"apply_interaction_transforms"|
            "render_region_png"|"render_cpu_frame"|"render_linear"|"render_png"|"render_color_png") {
            let lane=&mut self.lanes[index];
            if let Some(source)=&mut lane.source_access {source.ensure_complete(&mut lane.engine,&std::sync::atomic::AtomicBool::new(false))?;}
        }
        // Failed legacy mutation cannot leave a receipt claiming synchronization.
        let previous = if mutation { self.lanes[index].receipt.take() } else { None };
        #[cfg(not(target_arch = "wasm32"))]
        if mutation && !source_load && method!="load_document" && self.lanes[index].source_access.take().is_some() {
            self.lanes[index].engine.invalidate_frame_scene_request();
            self.lanes[index].engine.frame_scene.limit_retention(None);
        }
        let string = |index: usize| -> Result<&str,String> {
            let value = args.get(index).and_then(Value::as_str).ok_or("Expected string argument")?;
            crate::capacity::check_document_bytes(value.len())?;
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
                lane.source = None; lane.reusable = false;
                if !fork { engine.load_document(string(0)?)?; }
                #[cfg(not(target_arch="wasm32"))]
                if lane.source_access.take().is_some() {engine.invalidate_frame_scene_request();engine.frame_scene.limit_retention(None);}
                lane.source = Some(string(0)?.to_owned()); lane.reusable = true; lane.source_storage=false;
            }
            #[cfg(not(target_arch = "wasm32"))]
            "load_source_snapshot" => {
                if args.len()!=1 { return Err("Invalid source snapshot request".into()); }
                let (document,access)=source_snapshot::read(&args[0])?;
                value=access.summary();
                lane.source=None; lane.reusable=false;
                if let Some(document)=document {engine.load_source_document(document)?;} else {*engine=engine.cold_source_shell(access.settings())?;}
                engine.invalidate_frame_scene_request();engine.frame_scene.limit_retention(None);
                lane.reusable=true;lane.source_storage=true;
                lane.source_access=Some(access);
            }
            "apply_document_patch_with_damage" => {
                lane.source = None; lane.reusable = false;
                let patch = serde_json::from_str(string(0)?).map_err(|e|format!("Invalid patch: {e}"))?;
                value = json!(serde_json::to_string(&engine.apply_document_patch_with_damage(&patch)?).map_err(|e|e.to_string())?);
                lane.reusable = true;
            }
            "interaction_pose_damage" => {
                if index != 1 || string(0)?.len() > 65536 { return Err("Invalid interaction transforms".into()); }
                let transforms = serde_json::from_str(string(0)?).map_err(|e| format!("Invalid transforms: {e}"))?;
                let damage = engine.interaction_pose_damage(&transforms)?;
                value = json!(serde_json::to_string(&damage).map_err(|e| e.to_string())?);
            }
            "apply_interaction_transforms" => {
                if index != 1 || string(0)?.len() > 65536 { return Err("Invalid interaction transforms".into()); }
                lane.source = None; lane.reusable = false;
                let transforms = serde_json::from_str(string(0)?).map_err(|e|format!("Invalid transforms: {e}"))?;
                value = json!(engine.apply_interaction_transforms(&transforms)?);
            }
            #[cfg(not(target_arch="wasm32"))]
            "source_hit" => {
                if index!=0 || args.len()!=1 {return Err("Invalid source hit request".into())}
                let q:source_hit::Query=serde_json::from_value(args[0].clone()).map_err(|_|"Invalid source hit query")?;
                if let Some(access)=lane.source_access.as_ref() {
                    if let Some(owner)=access.pick_engine(engine) {
                        if let (Some(doc),Some(authored))=(owner.doc.as_deref(),owner.authored_document()) {
                            value=source_hit::pick(doc,authored,&q)?;
                        }
                    }
                }
            }
            "compile_gpu_packet" => {
                #[cfg(not(target_arch = "wasm32"))]
                {bytes=if let Some(access)=lane.source_access.as_mut(){access.compile(engine,string(0)?)?}else{engine.compile_gpu_packet_request(string(0)?)?};}
                #[cfg(target_arch = "wasm32")]
                {bytes=engine.compile_gpu_packet_request(string(0)?)?;}
                encoding = Some("u8");
            }
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
            "stats" => {
                let mut stats=None;
                #[cfg(not(target_arch="wasm32"))]
                if let Some(source)=&lane.source_access {stats=source.stats_json();}
                value=json!(match stats {Some(stats)=>stats,None=>serde_json::to_string(engine.stats()).map_err(|e|e.to_string())?});
            },
            "gpu_memory_breakdown" => value = json!(serde_json::to_string(&engine.gpu_memory_breakdown()).map_err(|e|e.to_string())?),
            _ => return Err("Unsupported native preparation method".into()),
        }
        if bytes.len() > 128*1024*1024 { return Err("Preparation response exceeds 128 MiB".into()); }
        let settings = (source_load || matches!(method,"initialize"|"load_document"|"apply_document_patch_with_damage"))
            .then(|| {
                let mut settings=engine.color_settings();
                #[cfg(not(target_arch="wasm32"))]
                if let Some(source)=lane.source_access.as_ref().filter(|s|s.is_lazy()) {settings=source.settings();}
                serde_json::to_string(&settings).expect("validated color settings")
            });
        let mut metadata = json!({"value":value,"encoding":encoding,"documentFork":fork});
        if let Some(settings) = settings { metadata["settings"] = json!(settings); }
        if method.starts_with("compile_gpu") {
            metadata["compileStats"] = engine.gpu_compile_cache_stats();
            #[cfg(not(target_arch = "wasm32"))]
            if let Some(access)=&lane.source_access {
                let mut stats=access.compile_stats();
                if let Some(cache)=stats.as_object_mut().and_then(|s|s.remove("cache")){metadata["compileStats"]=cache;}
                metadata["compileStats"]["sourceDemand"]=stats;
            }
        }
        if let Some(mode) = cpu_frame_mode { metadata["cpuFrameMode"] = json!(mode); }
        if mutation {
            let receipt = if method == "load_document" || source_load || previous.is_some() {
                Some(self.mint(index, previous, method == "load_document" || source_load))
            } else { None };
            metadata["stateReceipt"] = json!(receipt);
        }
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
        && (0.001..=crate::renderer::MAX_CANVAS_SAMPLE_SCALE).contains(&options.view.zoom)
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
        return Ok((engine.render_exact(options)?, "exact"));
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
#[path="../tests/support/frame_scene.rs"]
mod frame_scene;
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
        let mut session = Preparation { lanes: [Lane::default(), Lane::default()], owner: session_owner(), sequence: 0, operation: 0 };
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

    fn derive_request(session: &Preparation, operation: u64) -> Value {
        json!({"operationId":operation,"baseReceipt":session.lanes[0].receipt,
            "target":"interaction","expectedTarget":session.lanes[1].receipt,"delta":[]})
    }

    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn native_source_snapshot_checks_identity_and_bytes_before_replacing_pixels() {
        let mut source=document();source["nodes"]["r"]["kind"]=json!("frame");
        let path=std::env::temp_dir().join(format!("native-source-snapshot-{}.scene",session_owner()));
        let doc:crate::scene::Document=serde_json::from_value(source.clone()).unwrap();
        let store=crate::scene_store::write(&path,"test:0",&doc,&[],&std::sync::atomic::AtomicBool::new(false)).unwrap();
        let descriptor=json!({"path":path,"store":store,"documentId":"cpu-preparation","pageId":"p","stageId":"r","nodes":1});
        let mut actual=session();let mut expected=session();
        expected.request("canvas","load_document",&[json!(source.to_string())]).unwrap();
        let reply=actual.request("canvas","load_source_snapshot",&[descriptor.clone()]).unwrap();
        assert!(reply.metadata["stateReceipt"].is_object());
        assert_eq!(reply.metadata["settings"],"null");
        let pixels=exact(&mut expected,&options());assert_eq!(exact(&mut actual,&options()),pixels);
        for (key,value) in [("store",json!({})),("documentId",json!("foreign")),("pageId",json!("foreign")),("stageId",json!("foreign")),("nodes",json!(2)),("unexpected",json!(true))] {
            let mut invalid=descriptor.clone();invalid[key]=value;
            assert!(actual.request("canvas","load_source_snapshot",&[invalid]).is_err(),"{key}");
            assert_eq!(exact(&mut actual,&options()),pixels,"{key}");
        }
        let mut bytes=std::fs::read(&path).unwrap();
        let offset=bytes.windows(7).position(|w|w==b"#ff0000").unwrap();bytes[offset+1]=b'0';
        std::fs::write(&path,bytes).unwrap();
        assert!(actual.request("canvas","load_source_snapshot",&[descriptor]).err().unwrap().contains("content changed"));
        assert_eq!(exact(&mut actual,&options()),pixels);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn source_demand_uses_admitted_lane_and_is_revoked_by_document_replacement() {
        use crate::{math::{Transform,Rect},scene_demand::Lookup};
        let mut source=document();
        let mut cold=source["nodes"]["r"].clone();cold["id"]=json!("cold");cold["transform"]=json!([1,0,0,1,10000,0]);
        source["nodes"]["cold"]=cold;
        source["nodes"]["stage"]=json!({"id":"stage","kind":"frame","width":20000,"height":20000,"blend":"pass-through","children":["r","cold"]});
        source["pages"][0]["children"]=json!(["stage"]);
        let document:crate::scene::Document=serde_json::from_value(source.clone()).unwrap();
        let path=std::env::temp_dir().join(format!("native-source-demand-{}.scene",session_owner()));
        let cancel=std::sync::atomic::AtomicBool::new(false);
        let store=crate::scene_store::write(&path,"test:0",&document,&[],&cancel).unwrap();
        let descriptor=json!({"path":path,"store":store,"documentId":"cpu-preparation","pageId":"p","stageId":"stage","nodes":3});
        let mut actual=session();
        actual.request("canvas","load_source_snapshot",&[descriptor]).unwrap();
        let before=exact(&mut actual,&options());
        let loaded=actual.source_viewport_demand("canvas",Transform::default(),Rect::new(0,0,64,64),&cancel).unwrap();
        assert!(matches!(loaded.lookup("r"),Lookup::Loaded(_)));
        assert!(matches!(loaded.lookup("cold"),Lookup::Cold));
        assert_eq!(loaded.reads().metadata_reads,0);
        assert_eq!(before,exact(&mut actual,&options()));
        let request=derive_request(&actual,1);
        actual.request("interaction","derive_document_v1",&[request]).unwrap();
        assert!(actual.source_viewport_demand("interaction",Transform::default(),Rect::new(0,0,64,64),&cancel).is_ok());
        actual.request("canvas","load_document",&[json!(source.to_string())]).unwrap();
        assert!(actual.source_viewport_demand("canvas",Transform::default(),Rect::new(0,0,64,64),&cancel).is_err());
        assert!(actual.source_viewport_demand("foreign",Transform::default(),Rect::new(0,0,64,64),&cancel).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn native_compile_entry_projects_and_source_patch_revokes_projection_cache() {
        let mut source=document();source["nodes"]["r"]["transform"]=json!([1,0,0,1,500,500]);
        let mut cold=source["nodes"]["r"].clone();cold["id"]=json!("cold");cold["transform"]=json!([1,0,0,1,10000,500]);source["nodes"]["cold"]=cold;
        source["nodes"]["stage"]=json!({"id":"stage","kind":"frame","width":20000,"height":20000,"blend":"pass-through","children":["r","cold"]});
        source["pages"][0]["children"]=json!(["stage"]);
        let doc:crate::scene::Document=serde_json::from_value(source.clone()).unwrap();
        let path=std::env::temp_dir().join(format!("native-compile-demand-{}.scene",session_owner()));
        let store=crate::scene_store::write(&path,"test:0",&doc,&[],&std::sync::atomic::AtomicBool::new(false)).unwrap();
        let descriptor=json!({"path":path,"store":store,"documentId":"cpu-preparation","pageId":"p","stageId":"stage","nodes":3});
        let mut actual=session();actual.request("canvas","load_source_snapshot",&[descriptor]).unwrap();
        let mut query=json!({"pageId":"p","width":64,"height":64,"view":{"x":-480,"y":-480,"zoom":1},"rasterProfile":"figmaSubpixel","gpuViewport":{"x":0,"y":0,"w":64,"h":64}});
        for x in [-480,-9980,-480]{query["view"]["x"]=json!(x);let reply=actual.request("canvas","compile_gpu_packet",&[json!(query.to_string())]).unwrap();
            assert!(matches!(reply.metadata["compileStats"]["sourceDemand"]["mode"].as_str(),Some("demand" | "demand-replay")));
            assert_eq!(reply.metadata["compileStats"]["sourceDemand"]["resolvedCompileNodes"],2);
        }
        source["nodes"]["r"]["fills"][0]["color"]=json!("#0000ff");
        actual.request("canvas","apply_document_patch_with_damage",&[json!(json!({"nodes":{"r":source["nodes"]["r"]}}).to_string())]).unwrap();
        let reply=actual.request("canvas","compile_gpu_packet",&[json!(query.to_string())]).unwrap();
        assert!(reply.metadata["compileStats"].get("sourceDemand").is_none());
        let mut expected=session();expected.request("canvas","load_document",&[json!(source.to_string())]).unwrap();
        let reference=expected.request("canvas","compile_gpu_packet",&[json!(query.to_string())]).unwrap();
        frame_scene::assert_equivalent(&reply.bytes,&reference.bytes);
        assert_eq!(actual.lanes[0].engine.authored_document().unwrap().nodes.len(),3);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn guarded_patch_rejects_stale_malformed_retry_and_resource_receipts_without_retiring_state() {
        let mut session = session();
        let initial = session.lanes[0].receipt.clone().unwrap();
        let mut changed = document()["nodes"]["r"].clone(); changed["width"] = json!(24);
        let patch = json!({"nodes":{"r":changed},"fields":{}}).to_string();
        let guard = json!({"expectedBaseReceipt":initial});
        session.request("canvas", "apply_document_patch_with_damage", &[json!(patch), guard.clone()]).unwrap();
        let current = session.lanes[0].receipt.clone();
        // Lost ACK cannot turn a retry into another applied operation.
        assert_eq!(session.request("canvas", "apply_document_patch_with_damage", &[json!(patch), guard]).err().unwrap(), "STALE_BASE");
        assert_eq!(session.lanes[0].receipt, current);
        for malformed in [Value::Null, json!({}), json!({"expectedBaseReceipt":null}), json!({"expectedBaseReceipt":current,"extra":1})] {
            assert!(session.request("canvas", "apply_document_patch_with_damage", &[json!(patch), malformed]).err().unwrap().contains("SCHEMA"));
            assert_eq!(session.lanes[0].receipt, current);
        }
        session.request("canvas", "initialize", &[json!(true)]).unwrap();
        let resource = session.lanes[0].receipt.clone();
        assert_eq!(session.request("canvas", "apply_document_patch_with_damage", &[json!(patch), json!({"expectedBaseReceipt":current})]).err().unwrap(), "STALE_BASE");
        assert_eq!(session.lanes[0].receipt, resource);
        session.request("canvas", "load_document", &[json!(document().to_string())]).unwrap();
        let reset = session.lanes[0].receipt.clone();
        assert!(session.request("canvas", "apply_document_patch_with_damage", &[json!(patch), json!({"expectedBaseReceipt":resource})]).is_err());
        assert_eq!(session.lanes[0].receipt, reset);
        assert!(session.request("canvas", "apply_document_patch_with_damage", &[json!("invalid"), json!({"expectedBaseReceipt":reset})]).is_err());
        assert!(session.lanes[0].receipt.is_none());
    }

    #[test]
    fn guarded_patch_edit_undo_redo_derive_matches_fresh_packets_and_pixels() {
        let mut session = session();
        let original = document(); let mut edited = original.clone();
        edited["nodes"]["r"]["transform"][4] = json!(14);
        edited["nodes"]["r"]["unknownAuthoredField"] = json!({"retained":"host"});
        for (i, target) in [&edited, &original, &edited].iter().enumerate() {
            let guard = json!({"expectedBaseReceipt":session.lanes[0].receipt});
            let patch = json!({"nodes":{"r":target["nodes"]["r"]},"fields":{}}).to_string();
            session.request("canvas", "apply_document_patch_with_damage", &[json!(patch), guard]).unwrap();
            let request = derive_request(&session, i as u64 + 1);
            session.request("interaction", "derive_document_v1", &[request]).unwrap();
            let mut fresh = Preparation { lanes: [Lane::default(), Lane::default()], owner: session_owner(), sequence: 0, operation: 0 };
            fresh.request("interaction", "load_document", &[json!(target.to_string())]).unwrap();
            for method in ["compile_gpu_packet", "render_png"] {
                let actual=session.request("interaction",method,&[json!(options().to_string())]).unwrap().bytes;
                let expected=fresh.request("interaction",method,&[json!(options().to_string())]).unwrap().bytes;
                if method=="compile_gpu_packet"{assert_ne!(frame_scene::scope(&actual),frame_scene::scope(&expected));frame_scene::assert_equivalent(&actual,&expected)}
                else{assert_eq!(actual,expected)}
            }
        }
    }

    #[test]
    fn derivation_receipts_cas_retry_and_reset_are_fail_closed() {
        let mut session = session();
        let request = derive_request(&session, 1);
        let first = session.request("interaction", "derive_document_v1", &[request.clone()]).unwrap();
        assert_eq!(first.metadata["documentFork"], true);
        let target = session.lanes[1].receipt.clone();
        assert!(session.request("interaction", "derive_document_v1", &[request.clone()]).err().unwrap().contains("RETRY"));
        let mut stale_target = request.clone(); stale_target["operationId"] = json!(2);
        assert!(session.request("interaction", "derive_document_v1", &[stale_target]).err().unwrap().contains("STALE_TARGET"));
        assert_eq!(target, session.lanes[1].receipt);
        let mut old_source = derive_request(&session, 3);
        session.request("canvas", "load_document", &[json!(document().to_string())]).unwrap();
        assert!(session.request("interaction", "derive_document_v1", &[old_source.clone()]).err().unwrap().contains("STALE_BASE"));
        old_source["operationId"] = json!(4);
        let mut other = Preparation { lanes: [Lane::default(), Lane::default()], owner: session_owner(), sequence: 0, operation: 0 };
        assert!(other.request("interaction", "derive_document_v1", &[old_source]).is_err());
        assert_eq!(target, session.lanes[1].receipt);
    }

    #[test]
    fn derivation_resource_and_mutation_failures_preserve_target_pixels() {
        let mut session = session();
        let request = derive_request(&session, 1);
        session.request("interaction", "derive_document_v1", &[request]).unwrap();
        let target = session.lanes[1].receipt.clone();
        let opts = options().to_string();
        let before = session.request("interaction", "render_png", &[json!(opts)]).unwrap().bytes;
        let request = derive_request(&session, 2);
        session.request("canvas", "initialize", &[json!(true)]).unwrap();
        assert!(session.request("interaction", "derive_document_v1", &[request]).is_err());
        let request = derive_request(&session, 3);
        assert!(session.request("interaction", "derive_document_v1", &[request]).err().unwrap().contains("RESOURCE_POLICY"));
        assert!(session.request("canvas", "load_document", &[json!("invalid")]).is_err());
        assert!(session.lanes[0].receipt.is_none());
        assert_eq!(target, session.lanes[1].receipt);
        assert_eq!(before, session.request("interaction", "render_png", &[json!(opts)]).unwrap().bytes);
    }

    #[test]
    fn derivation_exhaustion_and_missing_cas_preserve_target() {
        let mut session = session();
        let mut request = derive_request(&session, 1);
        request.as_object_mut().unwrap().remove("expectedTarget");
        assert!(session.request("interaction", "derive_document_v1", &[request]).is_err());
        let request = derive_request(&session, 2);
        session.sequence = u64::MAX;
        assert!(session.request("interaction", "derive_document_v1", &[request]).err().unwrap().contains("EXHAUSTED"));
        assert!(session.lanes[1].receipt.is_none());
    }

    #[test]
    fn derivation_rejects_animation_and_nonempty_delta_without_publishing() {
        let mut session = session();
        let request = derive_request(&session, 1);
        session.request("interaction", "derive_document_v1", &[request]).unwrap();
        let target = session.lanes[1].receipt.clone();
        let mut animated = document();
        let node: crate::scene::Node = serde_json::from_value(animated["nodes"]["r"].clone()).unwrap();
        let pose = crate::animation::Pose::from(&node);
        animated["animations"] = json!([{"id":"a","name":"a","pageId":"p","durationMs":100,
            "tracks":[{"nodeId":"r","keyframes":[{"timeMs":0,"value":pose}]}]}]);
        session.request("canvas", "load_document", &[json!(animated.to_string())]).unwrap();
        let request = derive_request(&session, 2);
        assert!(session.request("interaction", "derive_document_v1", &[request]).err().unwrap().contains("UNSUPPORTED_STATE"));
        let mut request = derive_request(&session, 3); request["delta"] = json!([{"putNode":{}}]);
        assert!(session.request("interaction", "derive_document_v1", &[request]).is_err());
        assert_eq!(target, session.lanes[1].receipt);
    }

    #[test]
    fn derivation_shares_image_resources_surviving_source_disposal() {
        use base64::Engine as _;
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 2, 2);
            encoder.set_color(png::ColorType::Rgba); encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().unwrap().write_image_data(&[200u8, 40, 20, 255].repeat(4)).unwrap();
        }
        let uri = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
        let mut doc = document();
        doc["nodes"]["r"]["fills"] = json!([{"kind":"image","image":uri,"color":"#000000"}]);
        let mut derived = session();
        derived.request("canvas", "load_document", &[json!(doc.to_string())]).unwrap();
        let source_image = derived.lanes[0].engine.image_data(&uri).unwrap();
        let request = derive_request(&derived, 1);
        derived.request("interaction", "derive_document_v1", &[request]).unwrap();
        assert!(std::sync::Arc::ptr_eq(&source_image, &derived.lanes[1].engine.image_data(&uri).unwrap()));
        derived.lanes[0] = Lane::default(); drop(source_image);
        let mut fresh = session();
        fresh.request("interaction", "load_document", &[json!(doc.to_string())]).unwrap();
        for method in ["compile_gpu_packet", "render_png"] {
            let args = [json!(options().to_string())];
            let actual=derived.request("interaction",method,&args).unwrap().bytes;
            let expected=fresh.request("interaction",method,&args).unwrap().bytes;
            if method=="compile_gpu_packet"{assert_ne!(frame_scene::scope(&actual),frame_scene::scope(&expected));frame_scene::assert_equivalent(&actual,&expected)}
            else{assert_eq!(actual,expected)}
        }
    }

    #[test]
    fn derivation_packet_and_pixels_match_fresh_load_after_source_disposal() {
        let mut derived = session();
        let request = derive_request(&derived, 1);
        derived.request("interaction", "derive_document_v1", &[request]).unwrap();
        derived.lanes[0] = Lane::default();
        let mut fresh = session();
        fresh.request("interaction", "load_document", &[json!(document().to_string())]).unwrap();
        for method in ["compile_gpu_packet", "render_png"] {
            let args = [json!(options().to_string())];
            let actual=derived.request("interaction",method,&args).unwrap().bytes;
            let expected=fresh.request("interaction",method,&args).unwrap().bytes;
            if method=="compile_gpu_packet"{assert_ne!(frame_scene::scope(&actual),frame_scene::scope(&expected));frame_scene::assert_equivalent(&actual,&expected)}
            else{assert_eq!(actual,expected)}
        }
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
        let interaction=session.request("interaction","compile_gpu_packet",&[json!(&request)]).unwrap().bytes;
        assert_ne!(frame_scene::scope(&canvas),frame_scene::scope(&interaction));frame_scene::assert_equivalent(&canvas,&interaction);
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
