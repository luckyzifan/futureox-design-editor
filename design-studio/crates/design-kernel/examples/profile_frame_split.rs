//! Native wall-time split for the production pan, zoom and pose entries.
//! GPU encode/present and the TypeScript pointer path are separate.
use futureox_design_kernel::frame_split_profile::{self, MeasureConfig};
use std::env;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let nodes = env::var("FRAME_SPLIT_NODES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(300);
    let samples = env::var("FRAME_SPLIT_SAMPLES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(7);
    let report = frame_split_profile::measure(MeasureConfig {
        nodes,
        samples,
        ..MeasureConfig::default()
    })?;
    if let Ok(path) = env::var("FRAME_SPLIT_PACKET") {
        let bytes = frame_split_profile::sample_packet(nodes.max(2), 256)?;
        std::fs::write(&path, bytes)?;
    }
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
