
use futureox_design_kernel::render_instruction::{
    ColorSpaceId, InstructionOptions, RenderInstruction,
};
use futureox_design_kernel::render_telemetry::RenderingTelemetry;
use futureox_design_kernel::tiled_renderer::{
    PresentDecision, RenderFeatureFlags, TileRasterSource, TileRasterizer, TiledRenderer,
    UpdateStatus,
};
use futureox_design_kernel::tile_stack::{exact_bucket_scale, TILE_SIZE};
use futureox_design_kernel::{Engine, RenderOptions, View};
use std::sync::Arc;
use serde_json::json;

fn doc() -> String {
    json!({
        "schemaVersion": 1,
        "id": "d",
        "name": "tiled",
        "pages": [{"id": "p", "name": "p", "children": ["r"], "background": "#ffffff"}],
        "nodes": {"r": {
            "id": "r",
            "kind": "rectangle",
            "transform": [1, 0, 0, 1, 16., 16.],
            "width": 640.,
            "height": 640.,
            "fills": [{"kind": "solid", "color": "#3366aa"}]
        }}
    })
    .to_string()
}

fn frame(view: View, width: u32, height: u32) -> RenderOptions {
    RenderOptions {
        page_id: "p".into(),
        width,
        height,
        view,
        transparent: false,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard: false,
    }
}

fn instruction(engine: &Engine, viewport: [f64; 4], zoom: f64) -> RenderInstruction {
    RenderInstruction {
        page_id: "p".into(),
        viewport,
        zoom,
        level_scale: exact_bucket_scale(zoom),
        backing_scale: 1.,
        content_revision: engine.content_revision(),
        options: InstructionOptions::new(false, false, "analytic"),
        color_space: ColorSpaceId::of(&engine.color_settings()),
    }
}

/// A counting raster source: real engine rasterisation plus call accounting
/// shared with spawned workers, so parallel rasterisation counts too.
struct CountingSource {
    engine: Engine,
    rasterized: Arc<std::sync::atomic::AtomicUsize>,
    prepared: usize,
}

impl CountingSource {
    fn new(engine: Engine) -> Self {
        CountingSource {
            engine,
            rasterized: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            prepared: 0,
        }
    }

    fn rasterized(&self) -> usize {
        self.rasterized.load(std::sync::atomic::Ordering::Relaxed)
    }
}

impl TileRasterizer for CountingSource {
    fn rasterize_tile(
        &mut self,
        request: &futureox_design_kernel::tiled_renderer::TileRequest,
    ) -> Result<Vec<u8>, String> {
        self.rasterized
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.engine.rasterize_tile(request)
    }
}

impl TileRasterSource for CountingSource {
    fn content_revision(&self) -> u64 {
        self.engine.content_revision()
    }

    fn prepare(&mut self, options: &RenderOptions) -> Result<(), String> {
        self.prepared += 1;
        self.engine.prepare(options)
    }

    fn spawn_worker(&self) -> Option<Box<dyn TileRasterizer + Send>> {
        struct CountingWorker {
            inner: Box<dyn TileRasterizer + Send>,
            rasterized: Arc<std::sync::atomic::AtomicUsize>,
        }
        impl TileRasterizer for CountingWorker {
            fn rasterize_tile(
                &mut self,
                request: &futureox_design_kernel::tiled_renderer::TileRequest,
            ) -> Result<Vec<u8>, String> {
                self.rasterized
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                self.inner.rasterize_tile(request)
            }
        }
        self.engine.spawn_worker().map(|inner| {
            Box::new(CountingWorker {
                inner,
                rasterized: Arc::clone(&self.rasterized),
            }) as Box<dyn TileRasterizer + Send>
        })
    }
}

#[test]
fn equal_instruction_rasterises_nothing() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let mut source = CountingSource::new(engine);
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 1024, 1024);
    let first = instruction(&source.engine, [0., 0., 1024., 1024.], 1.);
    let mut renderer = TiledRenderer::default();
    let status = renderer
        .update_with_instruction(&mut source, &options, &first, None)
        .expect("first update");
    assert_eq!(status, UpdateStatus::Completed);
    assert!(source.rasterized() > 0, "cold frame rasterises its tiles");
    let cold_tiles = source.rasterized();

    // Identical instruction: no queue, no raster, no prepare.
    let status = renderer
        .update_with_instruction(&mut source, &options, &first, None)
        .expect("repeat update");
    assert_eq!(status, UpdateStatus::NoChange);
    assert_eq!(source.rasterized(), cold_tiles);
    assert_eq!(source.prepared, 1, "prepare runs once for the cold frame");

    // Present decision agrees, and composited frames advance telemetry
    // without touching rasterisation spans.
    renderer.note_composited(&first);
    renderer.note_composited(&first);
    let report = renderer.telemetry().report_statistics();
    assert_eq!(report.frame_count, 2);
    assert_eq!(report.rasterisation_count as usize, cold_tiles);
    assert_eq!(
        renderer.wait_for_content_render_semaphore(&first, false, false),
        PresentDecision::PresentComposited
    );
}

#[test]
fn page_and_raster_options_rebuild_tiles_at_the_same_revision() {
    let mut value: serde_json::Value = serde_json::from_str(&doc()).unwrap();
    value["pages"].as_array_mut().unwrap().push(json!({
        "id": "other", "name": "Other", "children": [], "background": "#cc3322"
    }));
    let mut engine = Engine::new();
    engine.load_document(&value.to_string()).unwrap();
    let mut options = frame(View { x: 0., y: 0., zoom: 1. }, 128, 96);
    let original = engine.render_tiled_frame(&options, None).unwrap().rgba;
    options.page_id = "other".into();
    let other = engine.render_tiled_frame(&options, Some(&[])).unwrap();
    assert_ne!(original, other.rgba);
    assert_eq!(other.rgba, engine.render_unretained(&options).unwrap());
    options.transparent = true;
    let clear = engine.render_tiled_frame(&options, Some(&[])).unwrap();
    assert!(clear.rgba.iter().all(|&channel| channel == 0));
    options.page_id = "p".into();
    options.transparent = false;
    assert_eq!(engine.render_tiled_frame(&options, None).unwrap().rgba, original);
}

#[test]
fn explicit_sequential_render_flags_survive_native_frame_requests() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).unwrap();
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 48, 48);
    let flags = RenderFeatureFlags::default();
    engine.tiled_renderer_mut().set_flags(flags);
    engine.render_tiled_frame(&options, None).unwrap();
    assert_eq!(engine.tiled_renderer().unwrap().flags(), &flags);
}

#[test]
fn pan_rasterises_only_newly_exposed_tiles() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let mut source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    let left = frame(View { x: 0., y: 0., zoom: 1. }, 512, 512);
    let first = instruction(&source.engine, [0., 0., 512., 512.], 1.);
    renderer
        .update_with_instruction(&mut source, &left, &first, None)
        .expect("cold frame");
    assert_eq!(source.rasterized(), 1, "512px viewport covers one tile");

    // Pan right by exactly one tile: the resident tile stays, one new tile
    // rasterises.
    let right = frame(View { x: -512., y: 0., zoom: 1. }, 512, 512);
    let panned = instruction(&source.engine, [512., 0., 512., 512.], 1.);
    let status = renderer
        .update_with_instruction(&mut source, &right, &panned, None)
        .expect("pan update");
    assert_eq!(status, UpdateStatus::Completed);
    assert_eq!(source.rasterized(), 2, "pan rasterises only the exposed tile");
    assert!(renderer.level(3).is_some());
    assert_eq!(
        renderer.level(3).expect("level one").tile_count(),
        2,
        "both tiles stay resident"
    );
}

#[test]
fn damage_rasterises_only_dirty_tiles() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let mut source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 1024, 512);
    let first = instruction(&source.engine, [0., 0., 1024., 512.], 1.);
    renderer
        .update_with_instruction(&mut source, &options, &first, None)
        .expect("cold frame");
    assert_eq!(source.rasterized(), 2);

    // Edit: the engine installs a new document revision; damage covers only
    // the right half of the canvas.
    source
        .engine
        .load_document(
            &json!({
                "schemaVersion": 1,
                "id": "d",
                "name": "tiled",
                "pages": [{"id": "p", "name": "p", "children": ["r"], "background": "#ffffff"}],
                "nodes": {"r": {
                    "id": "r",
                    "kind": "rectangle",
                    "transform": [1, 0, 0, 1, 560., 16.],
                    "width": 320.,
                    "height": 320.,
                    "fills": [{"kind": "solid", "color": "#aa6633"}]
                }}
            })
            .to_string(),
        )
        .expect("patched document");
    let edited = instruction(&source.engine, [0., 0., 1024., 512.], 1.);
    let damage = [[520., 0., 400., 512.]];
    let status = renderer
        .update_with_instruction(&mut source, &options, &edited, Some(&damage))
        .expect("damage update");
    assert_eq!(status, UpdateStatus::Completed);
    assert_eq!(
        source.rasterized(), 3,
        "only the dirty right-hand tile re-rasterises"
    );
}

#[test]
fn panning_after_an_offscreen_edit_does_not_promote_stale_pixels() {
    let original = json!({
        "schemaVersion": 1, "id": "d", "name": "two tiles",
        "pages": [{"id":"p", "name":"p", "children":["r"], "background":"#ffffff"}],
        "nodes": {"r":{"id":"r", "kind":"rectangle", "width":80, "height":64,
            "transform":[1,0,0,1,580,16], "fills":[{"kind":"solid","color":"#3366aa"}]}}
    });
    let mut engine = Engine::new();
    engine.load_document(&original.to_string()).unwrap();
    let mut source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    let panned = frame(View { x: -512., y: 0., zoom: 1. }, 512, 512);
    let home = frame(View { x: 0., y: 0., zoom: 1. }, 512, 512);
    let right = [512., 0., 512., 512.];
    let left = [0., 0., 512., 512.];
    let first = instruction(&source.engine, right, 1.);
    renderer.update_with_instruction(&mut source, &panned, &first, None).unwrap();

    let mut edited = original;
    edited["nodes"]["r"]["fills"][0]["color"] = json!("#da4014");
    source.engine.load_document(&edited.to_string()).unwrap();
    let after_edit = instruction(&source.engine, left, 1.);
    let damage = [[580., 16., 80., 64.]];
    renderer.update_with_instruction(&mut source, &home, &after_edit, Some(&damage)).unwrap();

    let after_pan = instruction(&source.engine, right, 1.);
    renderer.update_with_instruction(&mut source, &panned, &after_pan, None).unwrap();
    let tile = renderer.level(3).unwrap().tile(&[1, 0]).unwrap();
    let expected = source.engine.render_unretained(&panned).unwrap();
    assert!(tile.surface.bytes() == expected, "returning pixels must match the new fill");
    assert_eq!(source.rasterized(), 3);
}

#[test]
fn returning_to_a_completed_camera_after_cancelled_zoom_recovers_its_tiles() {
    use futureox_design_kernel::render_cancellation::with_probe;
    let mut engine = Engine::new();
    engine.load_document(&doc()).unwrap();
    let mut source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    renderer.set_clear_other_levels(true);
    let home = frame(View { x: 0., y: 0., zoom: 1. }, 512, 512);
    let detail = frame(View { x: 0., y: 0., zoom: 2. }, 512, 512);
    let home_plan = instruction(&source.engine, [0., 0., 512., 512.], 1.);
    let detail_plan = instruction(&source.engine, [0., 0., 256., 256.], 2.);
    renderer.update_with_instruction(&mut source, &home, &home_plan, None).unwrap();
    let checks = std::cell::Cell::new(0);
    let cancel = with_probe(move || {
        let count = checks.get();
        checks.set(count + 1);
        count > 0
    }, || renderer.update_with_instruction(&mut source, &detail, &detail_plan, None));
    assert_eq!(cancel.unwrap_err(), "PREVIEW_CANCELLED");
    renderer.update_with_instruction(&mut source, &home, &home_plan, None).unwrap();
    let tile = renderer.level(3).unwrap().tile(&[0, 0]).expect("return viewport has pixels");
    let expected = source.engine.render_unretained(&home).unwrap();
    assert!(tile.surface.bytes() == expected, "the completed viewport remains intact");
}

#[test]
fn promotion_does_not_relabel_tiles_from_another_scale() {
    use futureox_design_kernel::raster_surface::RasterSurface;
    use futureox_design_kernel::tile_level::TileMipLevel;
    use futureox_design_kernel::tiled_renderer::CacheManager;

    let mut cache = CacheManager::new(1024);
    let mut zoomed_out = TileMipLevel::new(1.);
    zoomed_out.commit_tile([0, 0], RasterSurface::new(1, 1), 7);
    let mut zoomed_in = TileMipLevel::new(2.);
    zoomed_in.commit_tile([1, 0], RasterSurface::new(1, 1), 7);
    cache.promote_level(&zoomed_out, 7);
    assert!(cache.lookup([0, 0], 7, 1.).is_some());
    cache.promote_level(&zoomed_in, 7);
    assert!(cache.lookup([0, 0], 7, 2.).is_none());
    assert!(cache.lookup([1, 0], 7, 2.).is_some());
}

#[test]
fn zoom_bucket_switch_records_previous_level() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let mut source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    let zoomed_out = frame(View { x: 0., y: 0., zoom: 1. }, 512, 512);
    let first = instruction(&source.engine, [0., 0., 512., 512.], 1.);
    renderer
        .update_with_instruction(&mut source, &zoomed_out, &first, None)
        .expect("cold frame");
    assert!(renderer.previous_level().is_none());

    // Zoom in across a bucket boundary (1 -> 2): the new level owns content,
    // the previous level stays recorded for upscaled display.
    let zoomed_in = frame(View { x: 0., y: 0., zoom: 1.4 }, 512, 512);
    let second = instruction(&source.engine, [0., 0., 512., 512.], 1.4);
    assert_eq!(second.level_scale, 2., "1.4 rasterises at bucket 2");
    renderer
        .update_with_instruction(&mut source, &zoomed_in, &second, None)
        .expect("zoom update");
    assert_eq!(renderer.previous_level(), Some(3), "level one stays previous");
    assert!(renderer.level(4).is_some(), "level two exists");
    // Zoom inside the new bucket: no ZOOM_BUCKET change, no re-raster.
    let same_bucket = frame(View { x: 0., y: 0., zoom: 1.6 }, 512, 512);
    let third = instruction(&source.engine, [0., 0., 512., 512.], 1.6);
    let tiles_before = source.rasterized();
    let status = renderer
        .update_with_instruction(&mut source, &same_bucket, &third, None)
        .expect("in-bucket zoom");
    assert_eq!(status, UpdateStatus::NoChange);
    assert_eq!(source.rasterized(), tiles_before);
}

#[test]
fn parallel_rasterisation_matches_sequential_bytes() {
    let mut sequential_engine = Engine::new();
    sequential_engine.load_document(&doc()).expect("document");
    let mut parallel_engine = Engine::new();
    parallel_engine.load_document(&doc()).expect("document");

    let viewport = [0., 0., 2048., 1024.];
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 2048, 1024);

    let mut sequential_source = CountingSource::new(sequential_engine);
    let mut sequential = TiledRenderer::new(RenderFeatureFlags {
        rasterize_concurrently: false,
        ..RenderFeatureFlags::default()
    });
    let sequential_instruction = instruction(&sequential_source.engine, viewport, 1.);
    sequential
        .update_with_instruction(&mut sequential_source, &options, &sequential_instruction, None)
        .expect("sequential update");

    let mut parallel_source = CountingSource::new(parallel_engine);
    let mut parallel = TiledRenderer::new(RenderFeatureFlags {
        rasterize_concurrently: true,
        worker_limit: Some(4),
        ..RenderFeatureFlags::default()
    });
    let parallel_instruction = instruction(&parallel_source.engine, viewport, 1.);
    parallel
        .update_with_instruction(&mut parallel_source, &options, &parallel_instruction, None)
        .expect("parallel update");

    assert_eq!(sequential_source.rasterized(), 8, "2048x1024 covers 8 tiles");
    assert_eq!(parallel_source.rasterized(), 8);
    let level = 3;
    let sequential_level = sequential.level(level).expect("sequential level");
    let parallel_level = parallel.level(level).expect("parallel level");
    for address in sequential_level.resident_addresses() {
        let a = sequential_level
            .tile(&address)
            .expect("sequential tile")
            .surface
            .bytes();
        let b = parallel_level
            .tile(&address)
            .expect("parallel tile")
            .surface
            .bytes();
        assert_eq!(a, b, "tile {address:?} bytes must be scheduling-independent");
    }
}

#[test]
fn tile_bytes_equal_direct_device_rect_render() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let mut source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 512, 512);
    let first = instruction(&source.engine, [0., 0., 512., 512.], 1.);
    renderer
        .update_with_instruction(&mut source, &options, &first, None)
        .expect("cold frame");
    let tile = renderer
        .level(3)
        .and_then(|level| level.tile(&[0, 0]))
        .expect("resident tile");
    let direct = source
        .engine
        .render_device_rect(&options, 0, 0, 512, 512)
        .expect("direct render");
    assert_eq!(tile.surface.bytes(), direct.as_slice());
    assert_eq!(tile.surface.bytes().len(), 512 * 512 * 4);
}

/// The camera-contract regression test: a panned camera (non-zero view) over
/// non-origin tile addresses must assemble the same bytes as a full render.
/// The historical sign errors — instruction viewport, per-tile camera, and
/// the assembly translation — each cancel or hide at view = 0, which is why
/// every earlier equality test sat at the origin.
#[test]
fn panned_tiled_frame_assembly_equals_full_render() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let options = frame(View { x: -512., y: -256., zoom: 1. }, 1024, 768);
    let full = engine.render_unretained(&options).expect("full render");
    let assembled = engine
        .render_tiled_frame(&options, None)
        .expect("tiled frame");
    assert_eq!(assembled.level_scale, 1.);
    assert!(
        engine
            .tiled_renderer()
            .and_then(|r| r.level(3))
            .is_some_and(|level| level.tile(&[1, 0]).is_some() || level.tile(&[2, 0]).is_some()),
        "the pan must reach non-origin addresses"
    );
    assert_eq!(
        assembled.rgba, full,
        "panned tiled assembly must equal the full render"
    );
    // A mid-tile pan (view not a tile multiple) clips every tile at the
    // viewport edge — the case whose missing source-column offset once
    // shifted the whole blit.
    let mid = frame(View { x: -576., y: -288., zoom: 1. }, 1024, 768);
    let mid_full = engine.render_unretained(&mid).expect("mid-tile full render");
    let mid_assembled = engine
        .render_tiled_frame(&mid, None)
        .expect("mid-tile tiled frame");
    assert_eq!(
        mid_assembled.rgba, mid_full,
        "mid-tile pan assembly must equal the full render"
    );
}

/// An off-bucket zoom (0.9, bucket 1.0) assembles from residency instead of
/// taking a full-frame path, and an in-bucket zoom change re-identifies the
/// resident tiles so nothing re-rasterises — the drawTiles tier of fidelity.
#[test]
fn off_bucket_zoom_assembles_from_residency() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let options = frame(View { x: 0., y: 0., zoom: 0.9 }, 512, 384);
    let cold = engine.render_tiled_frame(&options, None).expect("cold frame");
    assert_eq!(cold.level_scale, 1., "0.9 rasterises at bucket 1.0");
    assert_eq!(cold.rgba.len(), 512 * 384 * 4);
    let cold_rasterised = cold.telemetry.rasterisation_count as usize;
    assert!(cold_rasterised > 0, "the cold frame rasterises its tiles");
    // Zoom out inside the same bucket: the viewport shrinks onto residency.
    let zoomed = frame(View { x: 0., y: 0., zoom: 0.85 }, 512, 384);
    let warm = engine
        .render_tiled_frame(&zoomed, None)
        .expect("in-bucket frame");
    assert_eq!(warm.level_scale, 1.);
    assert_eq!(
        warm.telemetry.rasterisation_count as usize, cold_rasterised,
        "an in-bucket zoom change must not re-rasterise a single tile"
    );
}

/// The resampled assembly stays close to a direct render at the same zoom:
/// constant regions reproduce exactly and only the neighbourhood of content
/// edges moves — never a wholesale pixel drift.
#[test]
fn off_bucket_assembly_stays_close_to_direct_render() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let options = frame(View { x: 0., y: 0., zoom: 0.9 }, 512, 384);
    let direct = engine.render_unretained(&options).expect("direct render");
    let assembled = engine
        .render_tiled_frame(&options, None)
        .expect("assembled frame");
    assert_eq!(assembled.rgba.len(), direct.len());
    let mut differing = 0usize;
    let mut strongly_differing = 0usize;
    for (a, b) in assembled.rgba.chunks_exact(4).zip(direct.chunks_exact(4)) {
        let delta = a
            .iter()
            .zip(b.iter())
            .map(|(x, y)| x.abs_diff(*y))
            .max()
            .unwrap_or(0);
        if delta > 0 {
            differing += 1;
        }
        if delta > 60 {
            strongly_differing += 1;
        }
    }
    let total = 512 * 384;
    assert!(
        (differing as f64 / total as f64) < 0.06,
        "constant regions must reproduce exactly ({differing}/{total} differ)"
    );
    assert!(
        (strongly_differing as f64 / total as f64) < 0.01,
        "only content-edge neighbourhoods may move strongly ({strongly_differing}/{total})"
    );
    // Deep-interior probe points: solid fill and page background are exact.
    for (x, y) in [(200usize, 200usize), (60usize, 60usize), (400usize, 300usize)] {
        let i = (y * 512 + x) * 4;
        assert_eq!(
            &assembled.rgba[i..i + 4],
            &direct[i..i + 4],
            "interior pixel ({x},{y}) must be byte-exact"
        );
    }
}

/// Returning to the bucket scale after an off-bucket zoom lands back on the
/// byte-exact blit — the resample tier never contaminates the parity contract.
#[test]
fn bucket_zoom_after_off_bucket_is_byte_exact() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let off_bucket = frame(View { x: -64., y: -32., zoom: 0.9 }, 512, 384);
    engine
        .render_tiled_frame(&off_bucket, None)
        .expect("off-bucket frame");
    let snapped = frame(View { x: -64., y: -32., zoom: 1. }, 512, 384);
    let assembled = engine
        .render_tiled_frame(&snapped, None)
        .expect("snapped frame");
    let direct = engine.render_unretained(&snapped).expect("direct render");
    assert_eq!(assembled.rgba, direct, "snapped zoom must stay byte-exact");
}

/// Residency outside the current viewport must not ride along in the payload:
/// hosts blit every listed tile at its world position, so history tiles would
/// ghost over the canvas forever.
#[test]
fn tiled_payload_lists_only_viewport_tiles() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    // Fill residency around the origin first.
    let origin = frame(View { x: 0., y: 0., zoom: 1. }, 1024, 1024);
    engine.update_tiled_frame(&origin, None).expect("origin frame");
    // Pan far away: the origin tiles stay resident but must not be listed.
    let panned = frame(View { x: -4096., y: -4096., zoom: 1. }, 512, 512);
    let frame = engine.update_tiled_frame(&panned, None).expect("panned frame");
    assert!(
        frame.tiles.iter().all(|t| t.world[0] >= 3584. && t.world[1] >= 3584.),
        "payload stays inside the panned viewport"
    );
    assert!(
        engine.tiled_renderer().expect("renderer").resident_tile_count() > frame.tiles.len(),
        "origin residency survives for a pan back"
    );
}

#[test]
fn stale_source_revision_is_rejected() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let mut source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 512, 512);
    let mut stale = instruction(&source.engine, [0., 0., 512., 512.], 1.);
    stale.content_revision += 1;
    let error = renderer
        .update_with_instruction(&mut source, &options, &stale, None)
        .expect_err("mismatched revision");
    assert!(error.contains("revision"), "error names the mismatch: {error}");
}

#[test]
fn first_frame_presents_composited_even_without_sync_request() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    let pending = instruction(&source.engine, [0., 0., 512., 512.], 1.);
    // Nothing rendered yet and no composited frame exists: the semaphore
    // forces composited presentation (`forceSyncFirstFrame`).
    assert_eq!(
        renderer.wait_for_content_render_semaphore(&pending, false, false),
        PresentDecision::PresentComposited
    );
    // A mid-raster camera change on a later frame may fall back to the
    // previous level when nobody waits synchronously.
    renderer.note_composited(&pending);
    let mut next = pending.clone();
    next.viewport = [0., 512., 512., 512.];
    let _ = next.viewport; // still unrendered content
    assert_eq!(
        renderer.wait_for_content_render_semaphore(&next, false, false),
        PresentDecision::PresentPreviousLevel
    );
    assert_eq!(
        renderer.wait_for_content_render_semaphore(&next, true, false),
        PresentDecision::PresentComposited,
        "synchronous waits must complete"
    );
    assert_eq!(
        renderer.wait_for_content_render_semaphore(&next, false, true),
        PresentDecision::PresentComposited,
        "user focus must not present stale content"
    );
}

#[test]
fn telemetry_separates_rasterisation_from_frames() {
    let mut telemetry = RenderingTelemetry::new(16);
    for _ in 0..3 {
        telemetry.begin_rasterisation_with_pixel_count(512 * 512);
        telemetry.end_rasterisation();
    }
    telemetry.count_frame();
    telemetry.count_frame();
    let report = telemetry.report_statistics();
    assert_eq!(report.rasterisation_count, 3);
    assert_eq!(report.frame_count, 2);
}

#[test]
fn remove_all_tiles_clears_residency_everywhere() {
    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let mut source = CountingSource::new(engine);
    let mut renderer = TiledRenderer::default();
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 1024, 1024);
    let first = instruction(&source.engine, [0., 0., 1024., 1024.], 1.);
    renderer
        .update_with_instruction(&mut source, &options, &first, None)
        .expect("cold frame");
    assert_eq!(renderer.resident_tile_count(), 4);
    renderer.remove_all_tiles_and_clear_dirty_regions();
    assert_eq!(renderer.resident_tile_count(), 0);
    assert_eq!(renderer.caches().entry_count(), 0);
    let replay = renderer.update_with_instruction(&mut source, &options, &first, None).unwrap();
    assert_eq!(replay, UpdateStatus::Completed);
    assert_eq!(renderer.resident_tile_count(), 4);
    assert_eq!(
        TILE_SIZE, 512,
        "tile geometry matches the kernel-wide tile stack"
    );
}



/// Managed (colour-managed) documents must serve the tiled path with tiles
/// byte-identical to the full managed render: `render_device_rect` routes
/// through the linear pipeline and the document settings, exactly what
/// `Engine::render` composes. This is the contract the real-Sketch journey
/// (117-class sRGB documents) depends on.
#[test]
fn managed_document_tiles_are_byte_identical_to_full_render() {
    let mut doc_value: serde_json::Value = serde_json::from_str(&doc()).unwrap();
    doc_value["schemaVersion"] = 3.into();
    doc_value["colorManagement"] = serde_json::json!({
        "documentSpace": "srgb", "referenceWhiteNits": 203, "peakLuminanceNits": 1000
    });
    let mut engine = Engine::new();
    engine
        .load_document(&doc_value.to_string())
        .expect("managed document");
    assert!(engine.color_settings().is_some());
    let options = frame(View { x: -128., y: -64., zoom: 1. }, 1024, 768);
    let full = engine.render_unretained(&options).expect("full managed render");
    let assembled = engine
        .render_tiled_frame(&options, None)
        .expect("managed tiled frame");
    assert_eq!(assembled.rgba, full, "managed tiles must equal the full render");
    // And one pan keeps the parity at mid-tile offsets.
    let pan = frame(View { x: -576., y: -288., zoom: 1. }, 1024, 768);
    let pan_full = engine.render_unretained(&pan).expect("panned full render");
    let pan_assembled = engine.render_tiled_frame(&pan, None).expect("panned tiles");
    assert_eq!(pan_assembled.rgba, pan_full);
}

/// A zoom-out that is cancelled after the first tile keeps that tile. The
/// same camera then rasterises only what is still missing, and those bytes
/// match a run that was never cancelled.
#[test]
fn cancelled_batch_keeps_finished_tiles() {
    use futureox_design_kernel::render_cancellation::with_probe;
    use futureox_design_kernel::tiled_renderer::TileRequest;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct CancelAfterFirst {
        inner: CountingSource,
        cancel: Arc<AtomicBool>,
    }
    impl TileRasterizer for CancelAfterFirst {
        fn rasterize_tile(&mut self, request: &TileRequest) -> Result<Vec<u8>, String> {
            let bytes = self.inner.rasterize_tile(request)?;
            self.cancel.store(true, Ordering::Release);
            Ok(bytes)
        }
    }
    impl TileRasterSource for CancelAfterFirst {
        fn content_revision(&self) -> u64 {
            self.inner.content_revision()
        }
        fn prepare(&mut self, options: &RenderOptions) -> Result<(), String> {
            self.inner.prepare(options)
        }
        fn spawn_worker(&self) -> Option<Box<dyn TileRasterizer + Send>> {
            None
        }
    }

    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let inner = CountingSource::new(engine);
    let viewport = [0., 0., 1024., 512.];
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 1024, 512);
    let first = instruction(&inner.engine, viewport, 1.);
    let cancel = Arc::new(AtomicBool::new(false));
    let probe = Arc::clone(&cancel);
    let mut source = CancelAfterFirst { inner, cancel };
    let mut renderer = TiledRenderer::default();
    let error = with_probe(
        move || probe.load(Ordering::Acquire),
        || renderer.update_with_instruction(&mut source, &options, &first, None),
    )
    .expect_err("the second tile must observe the cancellation");
    assert_eq!(error, "PREVIEW_CANCELLED");
    assert_eq!(source.inner.rasterized(), 1, "only the finished tile ran");
    assert_eq!(renderer.resident_tile_count(), 1);

    let status = renderer
        .update_with_instruction(&mut source, &options, &first, None)
        .expect("resume");
    assert_eq!(status, UpdateStatus::Completed);
    assert_eq!(source.inner.rasterized(), 2, "the resident tile is not drawn again");

    let mut reference_engine = Engine::new();
    reference_engine.load_document(&doc()).expect("reference");
    reference_engine
        .render_tiled_frame(&options, None)
        .expect("reference frame");
    let reference = reference_engine.tiled_renderer().expect("reference residency");
    for address in [[0, 0], [1, 0]] {
        let actual = renderer
            .level(3)
            .and_then(|level| level.tile(&address))
            .expect("resumed tile")
            .surface
            .bytes();
        let expected = reference
            .level(3)
            .and_then(|level| level.tile(&address))
            .expect("reference tile")
            .surface
            .bytes();
        assert_eq!(actual, expected, "address {address:?}");
    }
}

/// Parallel workers do not share the caller's probe. The tile that trips the
/// probe stays resident. The others stop instead of finishing the batch.
#[test]
fn parallel_cancel_keeps_one_finished_tile() {
    use futureox_design_kernel::render_cancellation::{checkpoint, with_probe};
    use futureox_design_kernel::tiled_renderer::TileRequest;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;

    struct Pool {
        cancel: Arc<AtomicBool>,
        finished: Arc<AtomicUsize>,
        ordinal: Arc<AtomicUsize>,
        slow: Arc<AtomicBool>,
        revision: u64,
    }
    struct Worker {
        cancel: Arc<AtomicBool>,
        finished: Arc<AtomicUsize>,
        ordinal: Arc<AtomicUsize>,
        slow: Arc<AtomicBool>,
    }
    fn blank() -> Vec<u8> { vec![7u8; TILE_SIZE as usize * TILE_SIZE as usize * 4] }
    impl TileRasterizer for Worker {
        fn rasterize_tile(&mut self, _request: &TileRequest) -> Result<Vec<u8>, String> {
            let n = self.ordinal.fetch_add(1, Ordering::AcqRel);
            if self.slow.load(Ordering::Acquire) && n == 0 {
                self.finished.fetch_add(1, Ordering::Release);
                self.cancel.store(true, Ordering::Release);
                return Ok(blank());
            }
            if !self.slow.load(Ordering::Acquire) {
                self.finished.fetch_add(1, Ordering::Release);
                return Ok(blank());
            }
            for _ in 0..400 {
                checkpoint()?;
                thread::sleep(Duration::from_millis(5));
            }
            self.finished.fetch_add(1, Ordering::Release);
            Ok(blank())
        }
    }
    impl TileRasterizer for Pool {
        fn rasterize_tile(&mut self, request: &TileRequest) -> Result<Vec<u8>, String> {
            Worker {
                cancel: Arc::clone(&self.cancel), finished: Arc::clone(&self.finished),
                ordinal: Arc::clone(&self.ordinal), slow: Arc::clone(&self.slow),
            }.rasterize_tile(request)
        }
    }
    impl TileRasterSource for Pool {
        fn content_revision(&self) -> u64 { self.revision }
        fn prepare(&mut self, _options: &RenderOptions) -> Result<(), String> { Ok(()) }
        fn spawn_worker(&self) -> Option<Box<dyn TileRasterizer + Send>> {
            Some(Box::new(Worker {
                cancel: Arc::clone(&self.cancel), finished: Arc::clone(&self.finished),
                ordinal: Arc::clone(&self.ordinal), slow: Arc::clone(&self.slow),
            }))
        }
    }

    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 2048, 1024);
    let planned = instruction(&engine, [0., 0., 2048., 1024.], 1.);
    let cancel = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicUsize::new(0));
    let slow = Arc::new(AtomicBool::new(true));
    let mut source = Pool {
        cancel: Arc::clone(&cancel), finished: Arc::clone(&finished),
        ordinal: Arc::new(AtomicUsize::new(0)), slow: Arc::clone(&slow),
        revision: engine.content_revision(),
    };
    let mut renderer = TiledRenderer::new(RenderFeatureFlags {
        rasterize_concurrently: true, ..RenderFeatureFlags::default()
    });
    let probe = Arc::clone(&cancel);
    let error = with_probe(move || probe.load(Ordering::Acquire), || {
        renderer.update_with_instruction(&mut source, &options, &planned, None)
    }).expect_err("the batch must stop when the probe fires");
    assert_eq!(error, "PREVIEW_CANCELLED");
    assert_eq!(finished.load(Ordering::Acquire), 1);
    assert_eq!(renderer.resident_tile_count(), 1);
    slow.store(false, Ordering::Release);
    let status = renderer.update_with_instruction(&mut source, &options, &planned, None).expect("resume");
    assert_eq!(status, UpdateStatus::Completed);
    assert!(renderer.resident_tile_count() > 1);
    assert!(finished.load(Ordering::Acquire) > 1);
}

/// The center tile becomes resident while the other workers are still
/// drawing. Three workers stay in the pool. Final bytes follow the address,
/// and the batch wall stays near the slow tile rather than the sum.
#[test]
fn parallel_center_tile_is_resident_before_the_slow_edges() {
    use futureox_design_kernel::tiled_renderer::TileRequest;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    struct Pool {
        busy: Arc<AtomicUsize>,
        revision: u64,
    }
    struct Worker {
        busy: Arc<AtomicUsize>,
    }
    fn paint(address: [i32; 2]) -> Vec<u8> {
        let mut pixels = vec![0u8; TILE_SIZE as usize * TILE_SIZE as usize * 4];
        pixels[0] = address[0] as u8;
        pixels[1] = address[1] as u8;
        pixels
    }
    impl TileRasterizer for Worker {
        fn rasterize_tile(&mut self, request: &TileRequest) -> Result<Vec<u8>, String> {
            self.busy.fetch_add(1, Ordering::AcqRel);
            let wait = if request.address == [1, 0] { 40 } else { 220 };
            std::thread::sleep(Duration::from_millis(wait));
            self.busy.fetch_sub(1, Ordering::AcqRel);
            Ok(paint(request.address))
        }
    }
    impl TileRasterizer for Pool {
        fn rasterize_tile(&mut self, request: &TileRequest) -> Result<Vec<u8>, String> {
            Worker {
                busy: Arc::clone(&self.busy),
            }
            .rasterize_tile(request)
        }
    }
    impl TileRasterSource for Pool {
        fn content_revision(&self) -> u64 {
            self.revision
        }
        fn prepare(&mut self, _options: &RenderOptions) -> Result<(), String> {
            Ok(())
        }
        fn spawn_worker(&self) -> Option<Box<dyn TileRasterizer + Send>> {
            Some(Box::new(Worker {
                busy: Arc::clone(&self.busy),
            }))
        }
    }

    let mut engine = Engine::new();
    engine.load_document(&doc()).expect("document");
    let busy = Arc::new(AtomicUsize::new(0));
    let center_at = Arc::new(std::sync::Mutex::new(None));
    let others_busy = Arc::new(AtomicUsize::new(0));
    let started = Instant::now();
    let mut renderer = TiledRenderer::new(RenderFeatureFlags {
        rasterize_concurrently: true,
        single_threaded_content_rendering: false,
        worker_limit: Some(3),
    });
    let probe_busy = Arc::clone(&busy);
    let probe_at = Arc::clone(&center_at);
    let probe_others = Arc::clone(&others_busy);
    renderer.set_commit_probe(Some(Box::new(move |address| {
        if address == [1, 0] {
            *probe_at.lock().expect("center time") = Some(started.elapsed());
            // The center worker has already left. The two edge workers are
            // still inside their sleep when this region is published.
            if probe_busy.load(Ordering::Acquire) >= 2 {
                probe_others.fetch_add(1, Ordering::Release);
            }
        }
    })));
    let mut source = Pool {
        busy,
        revision: engine.content_revision(),
    };
    let options = frame(
        View {
            x: 0.,
            y: 0.,
            zoom: 1.,
        },
        1536,
        512,
    );
    let planned = instruction(&engine, [0., 0., 1536., 512.], 1.);
    let status = renderer
        .update_with_instruction(&mut source, &options, &planned, None)
        .expect("parallel batch");
    let wall = started.elapsed();
    assert_eq!(status, UpdateStatus::Completed);
    assert_eq!(renderer.resident_tile_count(), 3);
    let center_elapsed = center_at
        .lock()
        .expect("center time")
        .expect("center tile committed");
    eprintln!(
        "parallel zoom batch: center resident {:.1} ms, batch wall {:.1} ms, workers 3, edges still inside rasterise {}",
        center_elapsed.as_secs_f64() * 1_000.0,
        wall.as_secs_f64() * 1_000.0,
        others_busy.load(Ordering::Acquire) > 0
    );
    assert!(
        center_elapsed + Duration::from_millis(80) < wall,
        "center {:.1} ms, batch {:.1} ms",
        center_elapsed.as_secs_f64() * 1_000.0,
        wall.as_secs_f64() * 1_000.0
    );
    assert!(
        others_busy.load(Ordering::Acquire) > 0,
        "the other workers were still rasterising"
    );
    assert!(
        wall < Duration::from_millis(400),
        "three workers must overlap the 220 ms edges"
    );
    let level =
        futureox_design_kernel::tiled_renderer::level_index_for_scale(exact_bucket_scale(1.));
    for address in [[0, 0], [1, 0], [2, 0]] {
        let actual = renderer
            .level(level)
            .and_then(|level| level.tile(&address))
            .expect("tile")
            .surface
            .bytes();
        assert_eq!(&actual[..2], &[address[0] as u8, address[1] as u8]);
    }
}

/// Stage split for one multi-tile zoom on this machine. The numbers are the
/// run's own clock, not a frame-time promise. Parallel and sequential pixels
/// stay equal, and the worker snapshot is reported beside one tile.
#[test]
fn continuous_zoom_stage_costs_keep_parallel_pixels() {
    use futureox_design_kernel::tiled_renderer::{TileRasterSource, TileRequest};
    use std::time::Instant;

    let mut nodes = serde_json::Map::new();
    let mut children = Vec::new();
    for index in 0..48 {
        let id = format!("r{index}");
        children.push(id.clone());
        nodes.insert(id.clone(), json!({
            "id": id, "kind": "rectangle",
            "transform": [1.0, 0.0, 0.0, 1.0, (index % 8) as f64 * 40.0, (index / 8) as f64 * 30.0],
            "width": 28.0, "height": 18.0,
            "fills": [{"kind": "solid", "color": "#224466"}],
            "strokes": [{"align": "center", "width": 1.0, "paint": {"kind": "solid", "color": "#000000"}}],
        }));
    }
    let document = json!({
        "schemaVersion": 1, "id": "zoom-stages", "name": "zoom-stages",
        "pages": [{"id": "p", "name": "p", "children": children, "background": "#ffffff"}],
        "nodes": nodes,
    })
    .to_string();
    let options = frame(
        View {
            x: -80.,
            y: -40.,
            zoom: 4.,
        },
        1024,
        512,
    );
    let mut parallel_engine = Engine::new();
    parallel_engine.load_document(&document).expect("document");
    let handoff_started = Instant::now();
    let mut worker = TileRasterSource::spawn_worker(&parallel_engine).expect("snapshot");
    let handoff_ms = handoff_started.elapsed().as_secs_f64() * 1_000.0;
    let tile_request = TileRequest {
        level: 0,
        address: [0, 0],
        world: [20.0, 10.0, 128.0, 128.0],
        options: frame(
            View {
                x: -80.,
                y: -40.,
                zoom: 4.,
            },
            TILE_SIZE as u32,
            TILE_SIZE as u32,
        ),
        pixel_count: TILE_SIZE as u64 * TILE_SIZE as u64,
        clip: None,
    };
    let tile_started = Instant::now();
    let tile_bytes = worker.rasterize_tile(&tile_request).expect("one tile");
    let tile_ms = tile_started.elapsed().as_secs_f64() * 1_000.0;
    drop(worker);
    parallel_engine
        .tiled_renderer_mut()
        .set_flags(RenderFeatureFlags {
            rasterize_concurrently: true,
            single_threaded_content_rendering: false,
            worker_limit: Some(3),
        });
    let parallel_started = Instant::now();
    let parallel_frame = parallel_engine
        .render_tiled_frame(&options, None)
        .expect("parallel frame");
    let parallel_ms = parallel_started.elapsed().as_secs_f64() * 1_000.0;

    let mut sequential_engine = Engine::new();
    sequential_engine
        .load_document(&document)
        .expect("document");
    sequential_engine
        .tiled_renderer_mut()
        .set_flags(RenderFeatureFlags {
            rasterize_concurrently: false,
            single_threaded_content_rendering: true,
            worker_limit: Some(1),
        });
    let sequential_started = Instant::now();
    let sequential_frame = sequential_engine
        .render_tiled_frame(&options, None)
        .expect("sequential frame");
    let sequential_ms = sequential_started.elapsed().as_secs_f64() * 1_000.0;
    eprintln!(
        "continuous zoom stages, 48 stroked rects, 1024x512 at zoom 4, analytic CPU: snapshot {handoff_ms:.3} ms, one 512 tile {tile_ms:.3} ms ({} bytes), parallel 3 workers {parallel_ms:.3} ms, single thread {sequential_ms:.3} ms, tiles {}",
        tile_bytes.len(),
        parallel_frame.visible_tiles
    );
    assert_eq!(parallel_frame.rgba, sequential_frame.rgba);
    assert!(parallel_frame.visible_tiles >= 2);
    if sequential_ms > 30.0 {
        assert!(
            parallel_ms < sequential_ms,
            "parallel {parallel_ms:.3} ms should stay under the single-thread {sequential_ms:.3} ms"
        );
    }
}

/// Integer bucket cameras on the display entry reuse world tiles. The
/// unretained renderer is the oracle, including after a fill edit.
#[test]
fn integer_bucket_display_matches_unretained_and_skips_a_full_repaint() {
    use futureox_design_kernel::editing::DocumentPatch;
    use futureox_design_kernel::fidelity::RasterProfile;
    use futureox_design_kernel::scene::Document;

    let mut retained = Engine::new();
    let mut oracle = Engine::new();
    retained.load_document(&doc()).unwrap();
    oracle.load_document(&doc()).unwrap();
    let views = [
        View { x: -16., y: -8., zoom: 1. },
        View { x: -40., y: -8., zoom: 1. },
        View { x: -40., y: -32., zoom: 1. },
    ];
    let mut cold = 0u64;
    let mut previous = 0u64;
    for (index, view) in views.into_iter().enumerate() {
        let options = frame(view, 640, 480);
        assert_eq!(
            retained.render(&options).unwrap(),
            oracle.render_unretained(&options).unwrap(),
            "pan {index}"
        );
        let rasters = retained
            .tiled_renderer()
            .unwrap()
            .telemetry()
            .report_statistics()
            .rasterisation_count;
        if index == 0 {
            assert!(rasters >= 1, "the cold frame must rasterise");
            cold = rasters;
        } else {
            assert!(
                rasters - previous < cold,
                "pan {index} rasterised {} tiles after a cold frame of {cold}",
                rasters - previous
            );
        }
        previous = rasters;
    }

    for zoom in [0.5, 2.0] {
        let options = frame(View { x: -8., y: -4., zoom }, 320, 240);
        let mut shown = Engine::new();
        let mut full = Engine::new();
        shown.load_document(&doc()).unwrap();
        full.load_document(&doc()).unwrap();
        assert_eq!(
            shown.render(&options).unwrap(),
            full.render_unretained(&options).unwrap(),
            "zoom {zoom}"
        );
    }

    let mut fractional = frame(View { x: -16.5, y: 0., zoom: 1. }, 128, 96);
    let mut skipped = Engine::new();
    let mut full = Engine::new();
    skipped.load_document(&doc()).unwrap();
    full.load_document(&doc()).unwrap();
    assert_eq!(skipped.render(&fractional).unwrap(), full.render_unretained(&fractional).unwrap());
    assert!(skipped.tiled_renderer().is_none(), "a fractional camera must not open residency");
    fractional.view = View { x: -16., y: 0., zoom: 1. };
    fractional.checkerboard = true;
    let mut skipped = Engine::new();
    let mut full = Engine::new();
    skipped.load_document(&doc()).unwrap();
    full.load_document(&doc()).unwrap();
    assert_eq!(skipped.render(&fractional).unwrap(), full.render_unretained(&fractional).unwrap());
    assert!(skipped.tiled_renderer().is_none(), "a checkerboard is screen-anchored");

    let mut grid = frame(View { x: -24., y: -8., zoom: 1. }, 160, 120);
    grid.grid = true;
    grid.transparent = true;
    let mut shown = Engine::new();
    let mut full = Engine::new();
    shown.load_document(&doc()).unwrap();
    full.load_document(&doc()).unwrap();
    assert_eq!(shown.render(&grid).unwrap(), full.render_unretained(&grid).unwrap());

    for profile in [RasterProfile::Figma, RasterProfile::FigmaSubpixel] {
        let mut options = frame(View { x: -24., y: -8., zoom: 1. }, 160, 120);
        options.raster_profile = profile;
        let mut shown = Engine::new();
        let mut full = Engine::new();
        shown.load_document(&doc()).unwrap();
        full.load_document(&doc()).unwrap();
        assert_eq!(
            shown.render(&options).unwrap(),
            full.render_unretained(&options).unwrap(),
            "{}",
            profile.tag()
        );
    }

    let before: Document = serde_json::from_str(&doc()).unwrap();
    let mut after_value: serde_json::Value = serde_json::from_str(&doc()).unwrap();
    after_value["nodes"]["r"]["fills"][0]["color"] = json!("#da4014");
    let after: Document = serde_json::from_value(after_value).unwrap();
    let mut edited = Engine::new();
    edited.load_document(&serde_json::to_string(&before).unwrap()).unwrap();
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 256, 192);
    edited.render(&options).unwrap();
    edited
        .apply_document_patch(&DocumentPatch::between(&before, &after).unwrap())
        .unwrap();
    let mut fresh = Engine::new();
    fresh.load_document(&serde_json::to_string(&after).unwrap()).unwrap();
    assert_eq!(edited.render(&options).unwrap(), fresh.render_unretained(&options).unwrap());
}

fn populated(board_x: f64, mark_x: f64) -> futureox_design_kernel::scene::Document {
    let mut nodes = serde_json::Map::new();
    let mut roots = vec!["board".to_string(), "mark".to_string()];
    for i in 0..48 {
        let id = format!("n{i}");
        roots.push(id.clone());
        nodes.insert(id.clone(), json!({
            "id": id, "kind": "rectangle",
            "transform": [1, 0, 0, 1, (i % 12) * 70, (i / 12) * 80],
            "width": 36, "height": 24,
            "fills": [{"kind": "solid", "color": "#7865cb"}]
        }));
    }
    nodes.insert("board".into(), json!({
        "id": "board", "kind": "frame", "clip": true,
        "transform": [1, 0, 0, 1, board_x, 420.],
        "width": 160, "height": 80,
        "fills": [{"kind": "solid", "color": "#dce7ee"}],
        "children": ["label"]
    }));
    nodes.insert("label".into(), json!({
        "id": "label", "kind": "rectangle",
        "transform": [1, 0, 0, 1, 12, 18],
        "width": 90, "height": 16,
        "fills": [{"kind": "solid", "color": "#203040"}]
    }));
    nodes.insert("mark".into(), json!({
        "id": "mark", "kind": "rectangle",
        "transform": [1, 0, 0, 1, mark_x, 36.],
        "width": 48, "height": 32,
        "fills": [{"kind": "solid", "color": "#c4554a"}],
        "effects": [{"kind": "shadow", "x": 6., "y": 4., "radius": 8., "color": "#000000", "opacity": 0.45}]
    }));
    serde_json::from_value(json!({
        "schemaVersion": 1, "id": "partial", "name": "partial",
        "pages": [{"id": "p", "name": "p", "background": "#ffffff", "children": roots}],
        "nodes": nodes
    })).unwrap()
}

fn fresh_rgba(doc: &futureox_design_kernel::scene::Document, options: &RenderOptions) -> Vec<u8> {
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(doc).unwrap()).unwrap();
    engine.render(options).unwrap()
}

/// A resident tile keeps the pixels outside a bounded edit and matches a
/// renderer that never reused those pixels. The repainted device area stays
/// inside one tile.
#[test]
fn partial_shadow_edit_matches_fresh_pixels_inside_one_tile() {
    use futureox_design_kernel::editing::DocumentPatch;
    let before = populated(480., 40.);
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(&before).unwrap()).unwrap();
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 1024, 768);
    let cold = engine.render_tiled_frame(&options, None).unwrap();
    assert_eq!(cold.rgba, fresh_rgba(&before, &options));
    let before_px = cold.telemetry.rasterisation_pixel_count;
    let mut after = before.clone();
    after.nodes.get_mut("mark").unwrap().transform.0[4] += 9.;
    let patch = DocumentPatch::between(&before, &after).unwrap();
    let damage = engine.apply_document_patch_with_damage(&patch).unwrap();
    assert!(!damage.full, "shadow move should stay bounded: {:?}", damage.reason);
    let rects = damage.rects.clone().unwrap();
    let updated = engine.render_tiled_frame(&options, Some(&rects)).unwrap();
    assert_eq!(updated.rgba, fresh_rgba(&after, &options));
    let delta = updated.telemetry.rasterisation_pixel_count.saturating_sub(before_px);
    assert!(delta > 0 && delta < (TILE_SIZE as u64) * (TILE_SIZE as u64), "repaint pixels {delta}");
}

/// Moving a clipped frame that straddles a tile boundary must keep the same
/// pixels as a fresh render. Bounded damage repaints the intersection only.
#[test]
fn clipped_frame_translation_matches_fresh_pixels() {
    use futureox_design_kernel::editing::DocumentPatch;
    let before = populated(480., 40.);
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(&before).unwrap()).unwrap();
    let options = frame(View { x: 0., y: 0., zoom: 1. }, 1024, 768);
    let cold = engine.render_tiled_frame(&options, None).unwrap();
    assert_eq!(cold.rgba, fresh_rgba(&before, &options));
    let before_px = cold.telemetry.rasterisation_pixel_count;
    let mut after = before.clone();
    after.nodes.get_mut("board").unwrap().transform.0[4] += 18.5;
    after.nodes.get_mut("board").unwrap().transform.0[5] += 7.25;
    let patch = DocumentPatch::between(&before, &after).unwrap();
    let damage = engine.apply_document_patch_with_damage(&patch).unwrap();
    let rects = damage.rects.clone().unwrap_or_default();
    let updated = engine
        .render_tiled_frame(&options, if damage.full { None } else { Some(&rects) })
        .unwrap();
    assert_eq!(updated.rgba, fresh_rgba(&after, &options), "full={}", damage.full);
    if !damage.full {
        let delta = updated.telemetry.rasterisation_pixel_count.saturating_sub(before_px);
        assert!(
            delta > 0 && delta < 2 * (TILE_SIZE as u64) * (TILE_SIZE as u64),
            "repaint pixels {delta}"
        );
    }
}
