//! Same-host release baseline. Timings exclude fixture construction and hashing.
//! Compare packet/pixel hashes across binaries before accepting speed changes.
use futureox_design_kernel::{Engine, font::Fonts, math::Transform, renderer::RenderOptions, scene::Node, tiled_renderer::TileRasterSource};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{hint::black_box, time::Instant};

fn measure(mut f: impl FnMut(), samples: usize, batch: usize) -> Value {
    for _ in 0..5 { f(); }
    let mut times = Vec::new();
    for _ in 0..samples {
        let start = Instant::now();
        for _ in 0..batch { f(); }
        times.push(start.elapsed().as_secs_f64()*1000./batch as f64);
    }
    times.sort_by(f64::total_cmp);
    json!({"p50Ms":times[times.len()/2],"p95Ms":times[(times.len()*95/100).min(times.len()-1)],"samples":times,"batch":batch})
}
fn hash(bytes: &[u8]) -> String { (Sha256::digest(bytes)).iter().map(|b| format!("{b:02x}")).collect::<String>() }
fn fixture(count: usize) -> String {
    let mut nodes=serde_json::Map::new(); let mut children=Vec::new();
    for i in 0..count {
        let id=format!("node-{i:05}"); children.push(id.clone());
        nodes.insert(id.clone(),json!({"id":id,"kind":"rectangle","name":format!("Layer {i}"),
            "width":5,"height":5,"transform":[1,0,0,1,(i%100)*8,(i/100)*8],
            "fills":[{"kind":"solid","color":"#527acc"}],
            "strokes":[{"width":0.5,"paint":{"kind":"solid","color":"#203040"}}]}));
    }
    json!({"schemaVersion":1,"id":"benchmark","name":"Hot paths","pages":[{"id":"p","name":"Page","children":children,"background":"#ffffff"}],"nodes":nodes}).to_string()
}
fn main() -> Result<(),Box<dyn std::error::Error>> {
    let mut rows=Vec::new();
    for count in [1000,10000] {
        let document=fixture(count); let mut engine=Engine::new(); engine.load_document(&document)?;
        let options:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":96,"height":96,"view":{"x":0,"y":0,"zoom":1},"grid":false}))?;
        engine.compile_gpu(&options)?;
        let worker=measure(|| {black_box(engine.spawn_worker().unwrap());},31,4);
        let compile=measure(|| {black_box(engine.compile_gpu(&options).unwrap());},31,2);
        let packet=measure(|| {black_box(engine.compile_gpu(&options).unwrap().into_packet().unwrap());},31,2);
        let bytes=engine.compile_gpu(&options)?.into_packet()?;
        let mut phase=0;
        let transform=measure(|| {
            phase+=1;
            let changes=[("node-00000".to_owned(),Transform([1.,0.,0.,1.,(phase%2) as f64,0.]))].into_iter().collect();
            assert!(engine.apply_interaction_transforms(&changes).unwrap());
        },31,8);
        let pixels=engine.render_device_rect(&options,0,0,96,96)?;
        rows.push(json!({"nodes":count,"fixtureSha256":hash(document.as_bytes()),"spawnWorker":worker,"compile":compile,"packet":packet,"transform":transform,"packetSha256":hash(&bytes),"pixelSha256":hash(&pixels),"packetBytes":bytes.len()}));
    }
    let font=std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"),"/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"))?;
    let mut fonts=Fonts::new(); fonts.load(&font)?;
    let node:Node=serde_json::from_value(json!({"id":"t","kind":"text","width":1200,"height":100,"fontSize":20,"text":"中文 AB é ".repeat(32),"textStyle":{"wrap":true,"features":["kern"]}}))?;
    let expected=fonts.node_path_shared(&node)?;
    let text_cache=measure(|| {black_box(fonts.node_path_shared(&node).unwrap());},31,32);
    let text_measure=measure(|| {black_box(fonts.node_measure(&node,Some(node.width)).unwrap());},31,4);
    println!("{}",serde_json::to_string_pretty(&json!({"profile":if cfg!(debug_assertions){"debug"}else{"release"},"arch":std::env::consts::ARCH,"warmups":5,"rows":rows,"text":{"fontSha256":hash(&font),"pathCommands":expected.commands.len(),"cache":text_cache,"measure":text_measure},"scope":"Native CPU timings, no GPU/present claim; samples are batch averages"}))?);
    Ok(())
}
