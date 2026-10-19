//! Engine-side GPU memory ledger export (Figma
//! `getRendererMemoryBreakdown`/`getRendererGpuMemory` shape). The kernel
//! allocates no GPU memory itself, so these tests pin two properties: the
//! export never invents numbers (zeros until a host feeds the shared
//! ledger), and once fed it reports the four buckets, peaks and the
//! `needs_free` pressure flag faithfully.
use super::*;
use crate::memory::{GpuMemoryCategory, GpuMemoryLedger, DEFAULT_GPU_MEMORY_LIMIT_BYTES};
use serde_json::json;

#[test]
fn fresh_engine_exports_zero_facts_never_estimates() {
    let mut engine = Engine::new();
    let breakdown = engine.gpu_memory_breakdown();
    assert_eq!(breakdown.texture_bytes, 0);
    assert_eq!(breakdown.buffer_bytes, 0);
    assert_eq!(breakdown.fixed_array_bytes, 0);
    assert_eq!(breakdown.blob_bytes, 0);
    assert_eq!(breakdown.peak_total_bytes, 0);
    assert_eq!(breakdown.total_bytes, 0);
    assert!(!breakdown.needs_free);
    assert_eq!(breakdown.free_events, 0);
    assert_eq!(breakdown.rejections, 0);
    assert_eq!(breakdown.limit_bytes, DEFAULT_GPU_MEMORY_LIMIT_BYTES);
    // A CPU render never touches the GPU ledger: still zero afterwards.
    engine.load_document(
        &json!({"schemaVersion":4,"id":"d","name":"ledger",
            "pages":[{"id":"p","name":"p","children":["a"],"background":"#ffffff"}],
            "nodes":{"a":{"id":"a","kind":"rectangle","width":8,"height":8,
                "fills":[{"kind":"solid","color":"#3777e8"}]}}})
            .to_string(),
    )
    .unwrap();
    let options: RenderOptions = serde_json::from_value(json!({
        "pageId":"p","width":8,"height":8,"rasterProfile":"analytic",
        "view":{"x":0,"y":0,"zoom":1}}))
    .unwrap();
    engine.render(&options).unwrap();
    assert_eq!(engine.gpu_memory_breakdown().total_bytes, 0);
}

#[test]
fn shared_ledger_handle_feeds_the_engine_export() {
    let engine = Engine::new();
    let ledger = engine.gpu_memory_ledger();
    ledger.alloc(GpuMemoryCategory::Texture, 1 << 20);
    ledger.alloc(GpuMemoryCategory::Buffer, 4096);
    ledger.alloc(GpuMemoryCategory::FixedArray, 1024);
    ledger.alloc(GpuMemoryCategory::Blob, 512);
    let breakdown = engine.gpu_memory_breakdown();
    assert_eq!(breakdown.texture_bytes, 1 << 20);
    assert_eq!(breakdown.buffer_bytes, 4096);
    assert_eq!(breakdown.fixed_array_bytes, 1024);
    assert_eq!(breakdown.blob_bytes, 512);
    assert_eq!(breakdown.total_bytes, (1 << 20) + 4096 + 1024 + 512);
    assert_eq!(breakdown.peak_total_bytes, breakdown.total_bytes);
    // Figma telemetry axes ride along in the same export.
    assert_eq!(breakdown.figma_axes.textures_memory, 1 << 20);
    assert_eq!(breakdown.figma_axes.vertex_buffers_memory, 1024);
    assert_eq!(breakdown.figma_axes.uniform_buffers_memory, 4096);
    assert_eq!(breakdown.figma_axes.render_buffers_memory, 512);
    assert_eq!(
        breakdown.figma_axes.total_gpu_memory,
        breakdown.total_bytes
    );
    assert!(!breakdown.needs_free);
    // Historical pressure stays observable in peak telemetry; current pressure
    // clears after reclamation so subsequent frames can keep warm resources.
    ledger.alloc(GpuMemoryCategory::Texture, DEFAULT_GPU_MEMORY_LIMIT_BYTES);
    assert!(engine.gpu_memory_breakdown().needs_free);
    ledger.free(GpuMemoryCategory::Texture, DEFAULT_GPU_MEMORY_LIMIT_BYTES);
    ledger.free(GpuMemoryCategory::Texture, 1 << 20);
    ledger.free(GpuMemoryCategory::Buffer, 4096);
    ledger.free(GpuMemoryCategory::FixedArray, 1024);
    ledger.free(GpuMemoryCategory::Blob, 512);
    let breakdown = engine.gpu_memory_breakdown();
    assert_eq!(breakdown.total_bytes, 0);
    assert_eq!(breakdown.peak_total_bytes, DEFAULT_GPU_MEMORY_LIMIT_BYTES + (1 << 20) + 5632);
    assert!(!breakdown.needs_free);
    ledger.note_free_event();
    assert_eq!(engine.gpu_memory_breakdown().free_events, 1);
}

#[test]
fn breakdown_json_uses_figma_camel_case_axes() {
    let engine = Engine::new();
    engine
        .gpu_memory_ledger()
        .alloc(GpuMemoryCategory::Texture, 64);
    let json = serde_json::to_string(&engine.gpu_memory_breakdown()).unwrap();
    for key in [
        "\"textureBytes\"",
        "\"bufferBytes\"",
        "\"fixedArrayBytes\"",
        "\"blobBytes\"",
        "\"peakTotalBytes\"",
        "\"needsFree\"",
        "\"freeEvents\"",
        "\"texturesMemory\"",
        "\"vertexBuffersMemory\"",
        "\"renderBuffersMemory\"",
        "\"uniformBuffersMemory\"",
        "\"totalGpuMemory\"",
    ] {
        assert!(json.contains(key), "missing {key} in {json}");
    }
}

#[test]
fn worker_snapshots_share_the_owner_ledger_state() {
    let mut engine = Engine::new();
    engine
        .load_document(
            &json!({"schemaVersion":4,"id":"d","name":"worker",
                "pages":[{"id":"p","name":"p","children":["a"],"background":"#ffffff"}],
                "nodes":{"a":{"id":"a","kind":"rectangle","width":4,"height":4,
                    "fills":[{"kind":"solid","color":"#000000"}]}}})
            .to_string(),
        )
        .unwrap();
    let worker = engine.snapshot_worker();
    worker
        .gpu_memory_ledger()
        .alloc(GpuMemoryCategory::FixedArray, 128);
    assert_eq!(engine.gpu_memory_breakdown().fixed_array_bytes, 128);
    assert_eq!(
        engine.gpu_memory_breakdown().peak_fixed_array_bytes,
        128,
        "one ledger, no split GPU accounting across engine clones"
    );
}

#[test]
fn independent_engines_keep_independent_ledgers() {
    let a = Engine::new();
    let b = Engine::new();
    let shared = GpuMemoryLedger::new(256);
    shared.alloc(GpuMemoryCategory::Blob, 32);
    assert_eq!(a.gpu_memory_breakdown().total_bytes, 0);
    assert_eq!(b.gpu_memory_breakdown().total_bytes, 0);
}
