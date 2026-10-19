use futureox_design_kernel::{
    font::{Fonts, expand_rich_text},
    scene::Document,
};
use serde_json::json;
use std::time::Instant;
fn main() {
    let mut f = Fonts::new();
    f.load(
        &std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
        .unwrap(),
    )
    .unwrap();
    let mut d:Document=serde_json::from_value(json!({"schemaVersion":4,"id":"d","name":"text","pages":[{"id":"p","name":"Page","background":"#ffffff","children":["t"]}],"nodes":{"t":{"id":"t","kind":"text","width":300,"height":100,"text":"中文 Mixed text","fontSize":28,"textRuns":[{"start":0,"end":2,"color":"#cc2233","underline":true},{"start":3,"end":8,"fontSize":36,"strikethrough":true}]}}})).unwrap();
    let t = Instant::now();
    expand_rich_text(&mut d, &f).unwrap();
    println!(
        "rich text expansion {:.3} ms",
        t.elapsed().as_secs_f64() * 1000.
    );
    let t = Instant::now();
    let mut commands = 0;
    for _ in 0..10 {
        for n in d.nodes.values() {
            commands += n.paths().unwrap().0.commands.len();
        }
    }
    println!(
        "10 derived path builds {:.3} ms; {commands} commands",
        t.elapsed().as_secs_f64() * 1000.
    );
}
