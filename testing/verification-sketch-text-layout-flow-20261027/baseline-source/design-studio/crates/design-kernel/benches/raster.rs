use futureox_design_kernel::{Engine, RenderOptions, View};
use serde_json::json;
use std::{hint::black_box, time::Instant};
fn main() {
    for count in [100, 1000, 10000] {
        let mut nodes = serde_json::Map::new();
        let mut roots = Vec::new();
        for i in 0..count {
            let id = format!("n{i}");
            roots.push(id.clone());
            nodes.insert(id.clone(),json!({"id":id,"kind":if i%3==0{"ellipse"}else{"rectangle"},"transform":[1,0,0,1,(i%100)*70,(i/100)*70],"width":60,"height":60,"fills":[{"kind":"solid","color":"#7865cb","opacity":1}],"radii":[8,8,8,8]}));
        }
        let doc = json!({"schemaVersion":1,"id":"bench","name":"bench","pages":[{"id":"p","name":"p","background":"#ffffff","children":roots}],"nodes":nodes});
        let mut engine = Engine::new();
        engine.load_document(&doc.to_string()).unwrap();
        let mut options = RenderOptions {
            page_id: "p".into(),
            width: 1280,
            height: 720,
            view: View {
                x: 0.,
                y: 0.,
                zoom: 1.,
            },
            transparent: false,
            grid: false,
            pixel_preview: None,
            animation: None,
            raster_profile: futureox_design_kernel::fidelity::RasterProfile::Analytic,
        };
        let mut samples = Vec::new();
        for i in 0..15 {
            options.view.x = -(i as f64);
            let start = Instant::now();
            black_box(engine.render(&options).unwrap());
            if i >= 3 {
                samples.push(start.elapsed().as_secs_f64() * 1000.);
            }
        }
        samples.sort_by(f64::total_cmp);
        println!(
            "{}",
            json!({"nodes":count,"p50Ms":samples[samples.len()/2],"p95Ms":samples[samples.len()-1],"stats":engine.stats(),"scope":"native software rasterization, 1280x720, pan frames, PNG encoding excluded"})
        );
    }
}
