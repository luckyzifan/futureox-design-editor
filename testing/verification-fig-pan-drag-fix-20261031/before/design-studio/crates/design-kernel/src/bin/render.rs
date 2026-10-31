use futureox_design_kernel::{Engine, RenderOptions, View};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 3 {
        return Err(
            "Usage: render DOCUMENT.forma FONT.ttf OUTPUT.png [WIDTH HEIGHT ZOOM X Y]".into(),
        );
    }
    let mut engine = Engine::new();
    engine.load_font(&std::fs::read(&args[1])?)?;
    let json = std::fs::read_to_string(&args[0])?;
    let doc: serde_json::Value = serde_json::from_str(&json)?;
    engine.load_document(&json)?;
    let number = |i: usize, default: f64| {
        args.get(i)
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(default)
    };
    let options = RenderOptions {
        page_id: doc["pages"][0]["id"].as_str().ok_or("Missing page")?.into(),
        width: number(3, 1280.) as u32,
        height: number(4, 900.) as u32,
        view: View {
            zoom: number(5, 1.),
            x: number(6, 0.),
            y: number(7, 0.),
        },
        transparent: false,
        grid: true,
        pixel_preview: None,
        animation: None,
        raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard: false,
    };
    let started = std::time::Instant::now();
    let bytes = engine.render_png(&options)?;
    std::fs::write(&args[2], bytes)?;
    println!(
        "render_ms={:.3} {}",
        started.elapsed().as_secs_f64() * 1000.,
        serde_json::to_string(engine.stats())?
    );
    Ok(())
}
