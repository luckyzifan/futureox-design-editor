//! Hardware ledger tests: the four-bucket GPU memory ledger must be fed by
//! the compositor's real resource lifecycle. Gated exactly like `native.rs`
//! (`--features hardware-tests` on a GPU host); the ledger math itself is
//! unit-tested in `futureox-design-kernel`.
use base64::Engine as _;
use futureox_design_gpu::{Backends, NativeGpu};
use futureox_design_kernel::memory::GpuMemoryCategory;
use futureox_design_kernel::{Engine, RenderOptions};
use serde_json::json;

fn options() -> RenderOptions {
    serde_json::from_value(json!({"pageId":"p","width":96,"height":64,"transparent":true,
        "rasterProfile":"figma","view":{"x":0,"y":0,"zoom":1}}))
    .unwrap()
}

fn plain_document() -> String {
    json!({"schemaVersion":1,"id":"d","name":"ledger",
        "pages":[{"id":"p","name":"p","children":["a","b"],"background":"#ffffff"}],
        "nodes":{
            "a":{"id":"a","kind":"rectangle","width":64,"height":48,
                "fills":[{"kind":"solid","color":"#3777e8"}]},
            "b":{"id":"b","kind":"ellipse","width":40,"height":40,
                "transform":[1,0,0,1,12,4],
                "fills":[{"kind":"solid","color":"#c070e0","opacity":0.5}]}}})
    .to_string()
}

/// Two distinct tiny SDR PNGs (distinct bytes => distinct residency keys).
fn tiny_png(seed: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 4, 4);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        let mut rgba = Vec::with_capacity(4 * 4 * 4);
        for i in 0..4 * 4 {
            rgba.extend_from_slice(&[seed.wrapping_add(i as u8), 0x80, 0x40, 0xff]);
        }
        writer.write_image_data(&rgba).unwrap();
    }
    bytes
}

/// Two distinct image fills so the compositor keeps two device-resident
/// textures alive across composes (the LRU reclaims the less-recently used
/// one first; a single always-sampled image stays pinned).
fn image_document() -> String {
    let image = |bytes: &[u8]| {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    };
    let a = tiny_png(0x11);
    let b = tiny_png(0x77);
    json!({"schemaVersion":1,"id":"d","name":"images",
        "pages":[{"id":"p","name":"p","children":["a","b"],"background":"#ffffff"}],
        "nodes":{
            "a":{"id":"a","kind":"rectangle","width":40,"height":30,
                "fills":[{"kind":"image","color":"#ffffff","image":image(a.as_slice())}]},
            "b":{"id":"b","kind":"rectangle","width":24,"height":24,
                "transform":[1,0,0,1,40,8],
                "fills":[{"kind":"image","color":"#ffffff","image":image(b.as_slice())}]}}})
    .to_string()
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn ledger_counts_frame_lifecycle_and_returns_to_baseline() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    let mut engine = Engine::new();
    engine.load_document(&plain_document()).unwrap();
    // One shared ledger between the allocating device and the engine export.
    gpu.set_memory_ledger(engine.gpu_memory_ledger());

    let scene = engine.compile_gpu(&options()).unwrap();
    let _frame = gpu.render(&scene).unwrap();

    let usage = gpu.memory_ledger().usage();
    // A whole render ran through constructor/destructor pairs: nothing
    // frame-scoped may stay counted.
    assert_eq!(usage.texture_bytes, 0, "frame textures must free with the frame");
    assert_eq!(usage.buffer_bytes, 0, "uniform arena must free with the frame");
    assert_eq!(usage.fixed_array_bytes, 0, "arrays must free with the frame");
    assert_eq!(usage.blob_bytes, 0, "readback blob must free with the readback");
    // But the peaks prove the render happened: textures, uniform arena,
    // segment/instance arrays and the readback blob were all live at some
    // point, and the total high-water covers their simultaneous maximum.
    assert!(usage.peak_texture_bytes > 0);
    assert_eq!(
        usage.peak_buffer_bytes,
        4 * 1024 * 1024,
        "uniform arena peak is its full allocation"
    );
    assert!(usage.peak_fixed_array_bytes > 0);
    assert!(usage.peak_blob_bytes > 0);
    assert!(usage.peak_total_bytes > 0);
    assert!(!gpu.memory_ledger().needs_free());
    // The engine export observes the same shared instance.
    assert_eq!(
        engine.gpu_memory_breakdown().peak_total_bytes,
        usage.peak_total_bytes
    );
}

#[tokio::test]
#[cfg_attr(
    not(feature = "hardware-tests"),
    ignore = "run with --features hardware-tests on a GPU host"
)]
async fn needs_free_pressure_runs_the_existing_persistent_image_reclaim() {
    let mut gpu = NativeGpu::new(Backends::PRIMARY).await.unwrap();
    let mut engine = Engine::new();
    engine.load_document(&image_document()).unwrap();
    gpu.set_memory_ledger(engine.gpu_memory_ledger());
    let scene = engine.compile_gpu(&options()).unwrap();
    // Prime residency: two persistent textures uploaded and sampled.
    let first = gpu.render(&scene).unwrap();
    assert!(!first.rgba.is_empty());
    let resident = gpu.memory_ledger().usage().texture_bytes;
    assert!(resident > 0, "device-resident images count as live textures");
    assert_eq!(gpu.memory_ledger().usage().free_events, 0);

    // Feed the pressure decision: live bytes cross the limit, so
    // the next compose's Frame::new must run the existing persistent-image
    // LRU eviction — no second reclaim system. The injected bytes are a test
    // fixture driving the decision hook, not a reported resource.
    let ledger = gpu.memory_ledger().clone();
    ledger.alloc(GpuMemoryCategory::Texture, ledger.limit_bytes());
    assert!(ledger.needs_free());
    let second = gpu.render(&scene).unwrap();
    assert!(!second.rgba.is_empty());
    assert!(
        ledger.usage().free_events >= 1,
        "needs_free must reach the existing reclaim path (FREE_CACHED_DATA)"
    );
    assert!(engine.gpu_memory_breakdown().needs_free);
    // The reclaim is honest: the LRU entry was freed during Frame::new and
    // re-uploaded by this compose, so the same residency set returns with
    // identical live bytes — the injected pressure bytes unchanged.
    assert_eq!(
        ledger.usage().texture_bytes,
        ledger.limit_bytes() + resident
    );
    // Pressure visibility does not break subsequent renders.
    let third = gpu.render(&scene).unwrap();
    assert!(!third.rgba.is_empty());
    ledger.free(GpuMemoryCategory::Texture, ledger.limit_bytes());
    assert!(!ledger.needs_free());
    let events=ledger.usage().free_events;
    let fourth=gpu.render(&scene).unwrap();
    assert_eq!(third.rgba,fourth.rgba);
    assert_eq!(ledger.usage().free_events,events,"historical peak must not force another eviction");
}
