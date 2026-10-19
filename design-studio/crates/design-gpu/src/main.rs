//! Local native renderer. Does not start a service or connect to the ecosystem.
#![forbid(unsafe_code)]
use base64::Engine as _;
use futureox_design_gpu::{Backends, NativeGpu, TiledFrameHost, TileCache, encode_png};
use futureox_design_kernel::tiled_renderer::RenderFeatureFlags;
use futureox_design_kernel::{
    Engine,
    blend::Pixel,
    color::{ColorOutput, ColorSpace, ToneMap},
};
use serde::Deserialize;
use serde_json::json;
use std::{path::PathBuf, time::Instant};

#[derive(Deserialize)]
struct Input {
    document: serde_json::Value,
    options: serde_json::Value,
}
struct Args {
    input: PathBuf,
    output: PathBuf,
    font: Option<PathBuf>,
    rgba: Option<PathBuf>,
    linear: Option<PathBuf>,
    color_output: Option<ColorOutput>,
    backend: String,
    compare: bool,
    repeat: usize,
    tile_cache: bool,
    image_mips: bool,
    /// CPU-tiled Sketch-parity path: the kernel tiled renderer rasterises
    /// tiles on worker threads (rasterize_concurrently) and the host
    /// assembles residency; repeated frames reuse tiles instead of paying
    /// the GPU rasteriser.
    cpu_tiled: bool,
    pan_step: Option<f64>,
    /// Interactive daemon mode (`--serve`, also implied by `--input -`): the
    /// Electron native render bridge drives the renderer over stdin/stdout
    /// JSON lines instead of a one-shot batch file.
    serve: bool,
}
fn args() -> Result<Args, String> {
    let mut input: Option<PathBuf> = None;
    let mut output = None;
    let mut font = None;
    let mut rgba = None;
    let mut linear = None;
    let mut color_space = None;
    let mut tone_map = None;
    let mut backend = "auto".to_owned();
    let mut compare = false;
    let mut repeat = 1;
    let mut tile_cache = true;
    let mut image_mips = false;
    let mut cpu_tiled = false;
    let mut pan_step: Option<f64> = None;
    let mut serve = false;
    let mut args = std::env::args().skip(1);
    while let Some(key) = args.next() {
        if key == "--help" || key == "-h" {
            println!(
                "design-render --input request.json --output result.png [--backend auto|metal|vulkan|dx12|cpu] [--font font.ttf] [--compare-cpu] [--rgba result.rgba] [--repeat 1..100] [--linear result.f32] [--color-output srgb|display-p3|rec2100-pq|rec2100-hlg] [--tone-map clip|reinhard|none] [--no-tile-cache] [--image-mips] [--cpu-tiled]\ndesign-render --serve [--backend auto|metal|vulkan|dx12|cpu] [--font font.ttf] [--cpu-tiled]\nInput JSON: {{\"document\": <design document>, \"options\": <RenderOptions>}}. Native GPU supports analytic, figma, figmaSubpixel and figmaSoftware. GPU errors are reported; CPU is an explicit backend. Repeated renders reuse the dirty tile cache (byte-identical, falls back to full frames on rejection); --image-mips enables level-selected image sampling on both engines. --cpu-tiled routes frames through the kernel's Sketch-parity CPU tiled renderer (bucket-snapped zooms assemble tile residency byte-identically; other conditions fall back to full frames and are reported).\nServe mode speaks stdin/stdout JSON lines (the Electron native render bridge protocol): {{\"cmd\":\"load\",\"document\":\"<json>\",\"font\":\"<base64, optional>\"}} -> {{\"type\":\"loaded\"}}, {{\"cmd\":\"frame\",\"options\":<RenderOptions>,\"damage\":null|[[x,y,w,h]...],\"pan\":0}} -> {{\"type\":\"frame\",\"width\":W,\"height\":H,\"rgba\":\"<base64>\",\"stats\":{{...,\"gpu_memory\":<four-bucket breakdown>}}}}, {{\"cmd\":\"stats\"}} -> {{\"type\":\"stats\",\"stats\":{{\"gpu_memory\":...}}}}, {{\"cmd\":\"stop\"}} exits; errors answer {{\"type\":\"error\",\"message\":\"...\"}} and keep the loop alive. The default serve backend is the native GPU (Metal on macOS) with the kernel's four-bucket memory ledger installed into the device; --backend cpu forces the CPU tiled host for debugging."
            );
            std::process::exit(0);
        }
        if key == "--compare-cpu" {
            compare = true;
            continue;
        }
        if key == "--no-tile-cache" {
            tile_cache = false;
            continue;
        }
        if key == "--image-mips" {
            image_mips = true;
            continue;
        }
        if key == "--cpu-tiled" {
            cpu_tiled = true;
            continue;
        }
        if key == "--serve" {
            serve = true;
            continue;
        }
        let value = args
            .next()
            .ok_or_else(|| format!("Missing value for {key}"))?;
        match key.as_str() {
            "--input" => input = Some(value.into()),
            "--output" => output = Some(value.into()),
            "--font" => font = Some(value.into()),
            "--rgba" => rgba = Some(value.into()),
            "--linear" => linear = Some(value.into()),
            "--color-output" => {
                color_space = Some(
                    serde_json::from_value::<ColorSpace>(json!(value))
                        .map_err(|_| "Invalid output color space")?,
                )
            }
            "--tone-map" => {
                tone_map = Some(
                    serde_json::from_value::<ToneMap>(json!(value))
                        .map_err(|_| "Invalid tone mapper")?,
                )
            }
            "--backend" => backend = value,
            "--repeat" => repeat = value.parse().map_err(|_| "Invalid repeat count")?,
            "--pan-step" => pan_step = Some(value.parse().map_err(|_| "Invalid pan step")?),
            _ => return Err(format!("Unknown option {key}")),
        }
    }
    if !(1..=100).contains(&repeat) {
        return Err("Repeat must be 1..100".into());
    }
    // `--input -` is the bridge's stdin marker; it implies serve mode.
    serve = serve || input.as_ref().is_some_and(|path| path.as_os_str() == "-");
    if serve {
        return Ok(Args{pan_step,input:PathBuf::new(),output:PathBuf::new(),font,rgba:None,linear:None,color_output:None,backend,compare:false,repeat:1,tile_cache,image_mips,cpu_tiled,serve:true});
    }
    let color_output = if color_space.is_some() || tone_map.is_some() {
        let space = color_space.unwrap_or_default();
        Some(ColorOutput {
            space,
            tone_map: tone_map.unwrap_or(if matches!(space, ColorSpace::Pq | ColorSpace::Hlg) {
                ToneMap::None
            } else {
                ToneMap::Clip
            }),
        })
    } else {
        None
    };
    Ok(Args{pan_step,input:input.ok_or("Required: --input request.json --output result.png [--backend auto|metal|vulkan|dx12|cpu] [--font font.ttf] [--compare-cpu] [--rgba result.rgba] [--repeat 1..100]")?,output:output.ok_or("Missing --output")?,font,rgba,linear,color_output,backend,compare,repeat,tile_cache,image_mips,cpu_tiled,serve:false})
}
async fn read(path: &PathBuf, limit: u64) -> Result<Vec<u8>, String> {
    let meta = tokio::fs::metadata(path).await.map_err(|e| e.to_string())?;
    if meta.len() > limit {
        return Err(format!("Input exceeds {limit} byte budget"));
    }
    let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("Input grew beyond byte budget".into());
    }
    Ok(bytes)
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), String> {
    let a = args()?;
    if a.serve {
        return serve(a).await;
    }
    let input = read(&a.input, 32 * 1024 * 1024).await?;
    let font = if let Some(path) = &a.font {
        Some(read(path, 32 * 1024 * 1024).await?)
    } else {
        None
    };
    let backends = match a.backend.as_str() {
        "auto" => Backends::PRIMARY,
        "metal" => Backends::METAL,
        "vulkan" => Backends::VULKAN,
        "dx12" => Backends::DX12,
        "cpu" => Backends::empty(),
        _ => return Err("Unknown backend".into()),
    };
    let mut gpu = if backends.is_empty() {
        None
    } else {
        Some(NativeGpu::new(backends).await?)
    };
    let compare = a.compare;
    let repeat = a.repeat;
    let output_color = a.color_output;
    let tile_cache = a.tile_cache;
    let image_mips = a.image_mips;
    let cpu_tiled = a.cpu_tiled;
    let pan_step = a.pan_step;
    // A single bounded blocking task owns GPU work and every conversion.
    let (png,rgba,linear,report,passed)=tokio::task::spawn_blocking(move||->Result<_,String>{
        let input:Input=serde_json::from_slice(&input).map_err(|e|e.to_string())?;
        let mut engine=Engine::new();if let Some(font)=font{engine.load_font(&font)?;}
        engine.load_document(&input.document.to_string())?;
        let output_color=output_color.or(input.options.get("colorOutput").cloned().map(serde_json::from_value::<ColorOutput>).transpose().map_err(|e|e.to_string())?);
        let mut options=engine.parse_options(input.options)?;
        let settings=engine.color_settings();
        if output_color.is_some()&&settings.is_none(){return Err("Color output requires a schema 3 managed document".into());}
        let mut timings=Vec::new();let mut frame_report=serde_json::Value::Null;let mut rgba=Vec::new();let mut linear:Option<Vec<f32>>=None;
        if image_mips{engine.set_image_mips(true);if let Some(gpu)=&mut gpu{gpu.set_image_mips(true);}}
        let cpu_tiled_used=cpu_tiled;
        let mut host=if cpu_tiled_used{
            engine.tiled_renderer_mut().set_flags(RenderFeatureFlags{rasterize_concurrently:true,..RenderFeatureFlags::default()});
            Some(TiledFrameHost::new())
        }else{None};
        let tile_cache_used=tile_cache&&gpu.is_some()&&!cpu_tiled_used;
        let mut tile_cache=if tile_cache_used{Some(TileCache::new())}else{None};
        let mut cached_tiles=0_usize;let mut rendered_tiles=0_usize;let mut tile_cache_bytes=0_usize;let mut tile_fallbacks=0_usize;let mut tile_fallback_reason=String::new();
        let start=Instant::now();let scene=if gpu.is_some(){Some(engine.compile_gpu(&options)?)}else{None};let compile_ms=start.elapsed().as_secs_f64()*1000.;
        for frame_index in 0..repeat{
            // An optional camera pan between repeats turns the loop into the
            // interactive benchmark: tiled hosts rasterise only the newly
            // exposed tile columns, plain paths re-render the full frame.
            if frame_index>0{
                if let Some(step)=pan_step{options.view.x+=step;}
            }
            let start=Instant::now();
            if let Some(host)=&mut host{
                let result=host.render(&mut engine,&options,None)?;
                frame_report=serde_json::to_value(&result).map_err(|e|e.to_string())?;rgba=result.rgba;linear=result.linear;
            }else if let Some(gpu)=&mut gpu{
                let scene=scene.as_ref().ok_or("Missing GPU scene")?;
                // The dirty tile cache composes only changed tiles and is
                // byte-identical to a full frame; any rejection (budget,
                // unsupported feature) permanently falls back this run.
                let result=if let Some(cache)=&mut tile_cache{
                    match cache.render(gpu,&mut engine,&options){
                        Ok(result)=>{let stats=&cache.stats;cached_tiles+=stats.tiles_cached;rendered_tiles+=stats.tiles_rendered;tile_cache_bytes=tile_cache_bytes.max(stats.cache_bytes);result}
                        Err(reason)=>{tile_fallbacks+=1;tile_fallback_reason=reason;tile_cache=None;gpu.render(scene)?}
                    }
                }else{gpu.render(scene)?};
                frame_report=serde_json::to_value(&result).map_err(|e|e.to_string())?;rgba=result.rgba;linear=result.linear;
            }else if let Some(settings)=settings{
                let pixels=engine.render_linear(&options)?;
                rgba=pixels.iter().flat_map(|p|settings.output(*p,Default::default()).map(|v|(v.clamp(0.,1.)*255.).round_ties_even() as u8)).collect();
                linear=Some(pixels.into_iter().flat_map(|p|p.0).collect());
            }else{rgba=engine.render(&options)?;}
            timings.push(start.elapsed().as_secs_f64()*1000.);
        }
        let parity=if compare&&gpu.is_some(){
            if let Some(linear)=&linear{
                let cpu:Vec<_>=engine.render_linear(&options)?.into_iter().flat_map(|p|p.0).collect();
                if cpu.len()!=linear.len(){return Err("CPU/GPU dimensions differ".into());}
                let mut max=0_f32;let mut violations=0;
                for (a,b) in cpu.iter().zip(linear){let error=(a-b).abs();max=max.max(error);if error>0.002+0.003*a.abs(){violations+=1;}}
                Some(json!({"kind":"fp16-numerical","maxAbsoluteError":max,"absoluteTolerance":0.002,"relativeTolerance":0.003,"violations":violations,"passed":violations==0}))
            }else{
                let cpu=engine.render(&options)?;if cpu.len()!=rgba.len(){return Err("CPU/GPU dimensions differ".into());}
                let max=cpu.iter().zip(&rgba).map(|(a,b)|a.abs_diff(*b)).max().unwrap_or(0);
                let different=cpu.chunks_exact(4).zip(rgba.chunks_exact(4)).filter(|(a,b)|a!=b).count();
                Some(json!({"kind":"rgba8-byte","maxChannelError":max,"differentPixels":different,"passed":max==0}))
            }
        }else{None};
        let passed=parity.as_ref().is_none_or(|p|p["passed"]==true);
        let png=if let (Some(settings),Some(linear))=(settings,&linear){
            let pixels:Vec<_>=linear.chunks_exact(4).map(|p|Pixel([p[0],p[1],p[2],p[3]])).collect();
            futureox_design_kernel::export::encode_color_png(options.width,options.height,&pixels,settings,output_color.unwrap_or_default())?
        }else{encode_png(options.width,options.height,&rgba)?};
        let report=json!({"backend":gpu.as_ref().map(|g|g.description()),"cpu":gpu.is_none(),"colorManagement":settings,"colorOutput":settings.map(|_|output_color.unwrap_or_default()),"compileMs":compile_ms,"frame":frame_report,"timingsMs":timings,"parity":parity,
            "imageMips":image_mips,
            "cpuTiled":{"enabled":cpu_tiled_used,"stats":host.as_ref().map(|h|serde_json::to_value(h.stats()).map_err(|e|e.to_string())).transpose()?},
            "tileCache":{"enabled":tile_cache_used,"cachedTiles":cached_tiles,"renderedTiles":rendered_tiles,"cacheBytes":tile_cache_bytes,"fallbacks":tile_fallbacks,"fallbackReason":if tile_fallbacks>0{json!(tile_fallback_reason)}else{serde_json::Value::Null}}});
        Ok((png,rgba,linear,report,passed))
    }).await.map_err(|e|e.to_string())??;
    tokio::fs::write(a.output, png)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(path) = a.rgba {
        tokio::fs::write(path, rgba)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(path) = a.linear {
        let values = linear.ok_or("Float output requires a managed document")?;
        let bytes: Vec<_> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        tokio::fs::write(path, bytes)
            .await
            .map_err(|e| e.to_string())?;
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    if !passed {
        return Err("Native GPU/CPU parity failed; diagnostic output was saved".into());
    }
    Ok(())
}


// ---------------------------------------------------------------------------
// Serve mode: stdin/stdout JSON-lines daemon driven by the Electron native
// render bridge (frontend/design-client/src/kernel/native-render-bridge.ts).
// ---------------------------------------------------------------------------

fn emit(out: &mut impl std::io::Write, value: serde_json::Value) -> Result<(), String> {
    let line = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    out.write_all(line.as_bytes())
        .and_then(|()| out.write_all(b"\n"))
        .and_then(|()| out.flush())
        .map_err(|e| e.to_string())
}

fn emit_error(out: &mut impl std::io::Write, message: impl Into<String>) -> Result<(), String> {
    emit(out, json!({"type":"error","message":message.into()}))
}

async fn serve(a: Args) -> Result<(), String> {
    let font = if let Some(path) = &a.font {
        Some(read(path, 32 * 1024 * 1024).await?)
    } else {
        None
    };
    let backends = match a.backend.as_str() {
        "auto" => Backends::PRIMARY,
        "metal" => Backends::METAL,
        "vulkan" => Backends::VULKAN,
        "dx12" => Backends::DX12,
        "cpu" => Backends::empty(),
        _ => return Err("Unknown backend".into()),
    };
    let gpu = if backends.is_empty() {
        None
    } else {
        Some(NativeGpu::new(backends).await?)
    };
    // A CPU backend renders through the Sketch-parity tiled host, keeping the
    // debugging counters the bridge protocol was shaped around.
    let cpu_tiled = a.cpu_tiled || gpu.is_none();
    // A single bounded blocking task owns the engine, the device and the
    // protocol loop, exactly like the batch mode's worker.
    tokio::task::spawn_blocking(move || serve_loop(gpu, font, cpu_tiled))
        .await
        .map_err(|e| e.to_string())?
}

fn serve_loop(
    mut gpu: Option<NativeGpu>,
    font: Option<Vec<u8>>,
    cpu_tiled: bool,
) -> Result<(), String> {
    use std::io::{BufRead, Write};
    let backend = gpu.as_ref().map(|g| g.description().backend.clone());
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut engine: Option<Engine> = None;
    let mut host: Option<TiledFrameHost> = None;
    let mut frames = 0_usize;
    let mut total_render_ms = 0_f64;
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(e) => {
                if emit_error(&mut out, format!("Stdin read failed: {e}")).is_err() {
                    break;
                }
                continue;
            }
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let message: serde_json::Value = match serde_json::from_str(line) {
            Ok(message) => message,
            Err(e) => {
                if emit_error(&mut out, format!("Invalid command line: {e}")).is_err() {
                    break;
                }
                continue;
            }
        };
        let result = match message.get("cmd").and_then(|cmd| cmd.as_str()) {
            Some("load") => serve_load(&message, &font, gpu.as_mut(), cpu_tiled, &mut engine, &mut host)
                .map(|()| json!({"type":"loaded"})),
            Some("frame") => serve_frame(
                &message,
                engine.as_mut(),
                host.as_mut(),
                gpu.as_mut(),
                backend.as_deref(),
                &mut frames,
                &mut total_render_ms,
            ),
            Some("stats") => match &engine {
                Some(engine) => serde_json::to_value(engine.gpu_memory_breakdown())
                    .map(|gpu_memory| json!({"type":"stats","stats":{"gpu_memory":gpu_memory}}))
                    .map_err(|e| e.to_string()),
                None => Err("Stats requested before a document was loaded".into()),
            },
            Some("stop") => break,
            _ => Err("Unknown command; expected load, frame, stats or stop".into()),
        };
        let written = match result {
            Ok(reply) => emit(&mut out, reply),
            Err(error) => emit_error(&mut out, error),
        };
        // A dead parent closes the pipe; leave quietly instead of spinning.
        if written.is_err() {
            break;
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn serve_load(
    message: &serde_json::Value,
    font: &Option<Vec<u8>>,
    gpu: Option<&mut NativeGpu>,
    cpu_tiled: bool,
    engine_slot: &mut Option<Engine>,
    host_slot: &mut Option<TiledFrameHost>,
) -> Result<(), String> {
    let document = message
        .get("document")
        .and_then(|document| document.as_str())
        .ok_or("Load command requires a document string")?;
    let mut engine = Engine::new();
    if let Some(font) = font {
        engine.load_font(font)?;
    }
    if let Some(extra) = message.get("font").and_then(|font| font.as_str()) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(extra)
            .map_err(|e| e.to_string())?;
        engine.load_font(&bytes)?;
    }
    engine.load_document(document)?;
    if cpu_tiled {
        engine.tiled_renderer_mut().set_flags(RenderFeatureFlags {
            rasterize_concurrently: true,
            ..RenderFeatureFlags::default()
        });
    }
    // Install the new engine's ledger into the allocating device before its
    // first compose, so every frame reports real four-bucket facts. Frames
    // already constructed keep the previous handle (documented on
    // NativeGpu::set_memory_ledger), which is exactly the reload semantics:
    // a fresh document starts a fresh ledger.
    if let Some(gpu) = gpu {
        gpu.set_memory_ledger(engine.gpu_memory_ledger());
    }
    *host_slot = if cpu_tiled {
        Some(TiledFrameHost::new())
    } else {
        None
    };
    *engine_slot = Some(engine);
    Ok(())
}

fn serve_frame(
    message: &serde_json::Value,
    engine: Option<&mut Engine>,
    mut host: Option<&mut TiledFrameHost>,
    gpu: Option<&mut NativeGpu>,
    backend: Option<&str>,
    frames: &mut usize,
    total_render_ms: &mut f64,
) -> Result<serde_json::Value, String> {
    let engine = engine.ok_or("Frame requested before a document was loaded")?;
    let options_value = message
        .get("options")
        .cloned()
        .ok_or("Frame command requires render options")?;
    let mut options = engine.parse_options(options_value)?;
    // The bridge's pan axis shifts the camera before this frame, matching the
    // batch interactive benchmark's pan_step semantics.
    if let Some(pan) = message.get("pan").and_then(|pan| pan.as_f64()) {
        options.view.x += pan;
    }
    let damage: Option<Vec<[f64; 4]>> = match message.get("damage") {
        Some(value) if !value.is_null() => {
            Some(serde_json::from_value(value.clone()).map_err(|e| e.to_string())?)
        }
        _ => None,
    };
    let frame = if let Some(host) = host.as_deref_mut() {
        host.render(engine, &options, damage.as_deref())?
    } else if let Some(gpu) = gpu {
        let scene = engine.compile_gpu(&options)?;
        gpu.render(&scene)?
    } else {
        let started = Instant::now();
        let rgba = engine.render(&options)?;
        futureox_design_gpu::RenderedFrame {
            width: options.width,
            height: options.height,
            rgba,
            linear: None,
            draw_calls: 0,
            submissions: 0,
            peak_texture_bytes: 0,
            render_ms: started.elapsed().as_secs_f64() * 1000.,
            encode_ms: 0.,
            readback_ms: 0.,
        }
    };
    *frames += 1;
    *total_render_ms += frame.render_ms;
    let gpu_memory =
        serde_json::to_value(engine.gpu_memory_breakdown()).map_err(|e| e.to_string())?;
    let mut stats = json!({
        "backend": backend.unwrap_or("cpu"),
        "render_ms": *total_render_ms,
        "last_render_ms": frame.render_ms,
        "draw_calls": frame.draw_calls,
        "submissions": frame.submissions,
        "peak_texture_bytes": frame.peak_texture_bytes,
        "gpu_memory": gpu_memory,
    });
    if let Some(host) = &host {
        let tiled = host.stats();
        stats["frames"] = json!(tiled.frames);
        stats["unchanged_frames"] = json!(tiled.unchanged_frames);
        stats["tiles_rasterised"] = json!(tiled.tiles_rasterised);
        stats["tiles_cached"] = json!(tiled.tiles_cached);
        stats["full_frames"] = json!(tiled.full_frames);
    } else {
        // The native GPU path composites a full frame per request; tile
        // counters stay at zero rather than pretending residency.
        stats["frames"] = json!(*frames);
        stats["unchanged_frames"] = json!(0);
        stats["tiles_rasterised"] = json!(0);
        stats["tiles_cached"] = json!(0);
        stats["full_frames"] = json!(*frames);
    }
    Ok(json!({
        "type":"frame",
        "width":frame.width,
        "height":frame.height,
        "rgba":base64::engine::general_purpose::STANDARD.encode(&frame.rgba),
        "stats":stats,
    }))
}
