//! Copy to the instrumented kernel's examples/cpu_frame_probe.rs for A and B.
use futureox_design_kernel::{Engine, RenderOptions, color::{ColorOutput, ColorSpace, ToneMap}};
use std::{fs, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let a: Vec<_> = std::env::args().collect();
    if a[1] == "import" {
        let imported = futureox_design_kernel::interop::import_sketch_report(&fs::read(&a[2])?)?;
        fs::write(&a[3], serde_json::to_vec(&imported.document)?)?;
        return Ok(());
    }
    let mut engine = Engine::new();
    if a[4] != "-" { engine.load_font(&fs::read(&a[4])?)?; }
    engine.load_document(&fs::read_to_string(&a[2])?)?;
    let opts: RenderOptions = serde_json::from_slice(&fs::read(&a[3])?)?;
    if a[1] == "measure" {
        let mut rows = Vec::new();
        for _ in 0..3 {
            futureox_design_kernel::cpu_ab_probe::reset();
            let start = Instant::now();
            let pixels = engine.render_linear(&opts)?;
            let wall = start.elapsed().as_secs_f64() * 1000.;
            let (prep, tiles, plans, hits) = futureox_design_kernel::cpu_ab_probe::read();
            std::hint::black_box(&pixels);
            rows.push(serde_json::json!({"frameMs":wall,"prepMs":prep,"tiles":tiles,"framePlans":plans,
                "geometryHits":hits,"compositorPeakBytes":engine.compositing_ledger().scene_peak_bytes}));
        }
        println!("{}",serde_json::to_string(&rows)?);
    } else {
        let pixels = engine.render_linear(&opts)?;
        let raw: Vec<_> = pixels.iter().flat_map(|p|p.0.into_iter().flat_map(|f| f.to_bits().to_le_bytes())).collect();
        fs::write(format!("{}.f32", a[5]), raw)?;
        if a[1] == "hdr" {
            let png = engine.render_color_png(&opts, ColorOutput {space: ColorSpace::Pq,tone_map: ToneMap::None})?;
            fs::write(format!("{}.png", a[5]), &png)?;
            let mut reader = png::Decoder::new(std::io::Cursor::new(png)).read_info()?;
            assert_eq!(reader.info().bit_depth, png::BitDepth::Sixteen);
            let mut samples = vec![0; reader.output_buffer_size().unwrap()];
            let info = reader.next_frame(&mut samples)?;
            fs::write(format!("{}.rgba16", a[5]), &samples[..info.buffer_size()])?;
        }
    }
    Ok(())
}
