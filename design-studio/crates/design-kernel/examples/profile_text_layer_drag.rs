//! Native CPU timings for single-line and multi-line text-layer drags.
//! Hardware WebGPU, macOS, Metal, Electron and the packaged desktop app are
//! not measured here.
fn main() {
    let font = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
    ))
    .expect("bundled font");
    let repeats = std::env::var("TEXT_DRAG_REPEATS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(7);
    let report = futureox_design_kernel::text_drag_profile::measure(
        &font,
        &futureox_design_kernel::text_drag_profile::TextDragMeasure {
            repeats,
            case_id: std::env::var("TEXT_DRAG_CASE").ok(),
            stages: std::env::var("TEXT_DRAG_STAGES").ok().as_deref() != Some("0"),
        },
    )
    .expect("text drag profile");
    println!("{}", serde_json::to_string_pretty(&report).expect("report"));
}
