//! Same-host native release comparison for the constrained Hug measurement path.
use futureox_design_kernel::{font::Fonts, layout, scene::Document};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{hint::black_box, time::Instant};

fn digest(bytes: &[u8]) -> String {
    (Sha256::digest(bytes)).iter().map(|b| format!("{b:02x}")).collect::<String>()
}
fn main() {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
    ))
    .unwrap();
    let mut fonts = Fonts::new();
    fonts.load(&bytes).unwrap();
    let mut results = Vec::new();
    for repetitions in [4, 32] {
        let natural_limit = repetitions as f64 * 200.;
        let limit = if repetitions == 4 { 65. } else { 503.125 };
        for kind in [
            "constrained-positive",
            "constrained-zero",
            "constrained-negative",
            "no-wrap",
            "fixed-height",
            "unconstrained",
            "min-expanded",
            "fixed-width",
        ] {
            let node = json!({"id":"t","kind":"text","text":"中文AB e\u{0301} ".repeat(repetitions),"fontSize":20,"width":limit,"height":30,
                "textStyle":{"wrap":kind!="no-wrap","paragraphIndent": match kind {"constrained-zero"=>0.,"constrained-negative"=>-12.375,_=>25.}},
                "sizing":{"width":if kind=="fixed-width" {"fixed"} else {"hug"},"height":if kind=="fixed-height" {"fixed"}else{"hug"},"minWidth":if kind=="min-expanded" {natural_limit}else{0.01},"maxWidth":if matches!(kind,"min-expanded"|"unconstrained") {natural_limit}else{limit}}});
            let doc:Document=serde_json::from_value(json!({"schemaVersion":4,"id":"d","name":"limits","pages":[{"id":"p","name":"p","background":"#ffffff","children":["t"]}],"nodes":{"t":node}})).unwrap();
            doc.validate().unwrap();
            let run = || {
                let mut d = doc.clone();
                layout::resolve(&mut d, &fonts).unwrap();
                black_box(d)
            };
            let output = run();
            for _ in 0..5 {
                run();
            }
            let mut samples = Vec::new();
            for _ in 0..31 {
                let start = Instant::now();
                for _ in 0..4 {
                    run();
                }
                samples.push(start.elapsed().as_secs_f64() * 1000. / 4.);
            }
            samples.sort_by(f64::total_cmp);
            let text_layout = fonts.node_layout(&doc.nodes["t"], Some(limit)).unwrap();
            results.push(json!({"kind":kind,"utf16Length":doc.nodes["t"].text.encode_utf16().count(),"p50Ms":samples[15],"p95Ms":samples[29],"samples":samples,"batch":4,"outputSha256":digest(&serde_json::to_vec(&output).unwrap()),"fixedTextLayoutSha256":digest(&serde_json::to_vec(&text_layout).unwrap()),"resolvedWidth":output.nodes["t"].width,"resolvedHeight":output.nodes["t"].height}));
        }
    }
    println!("{}",serde_json::to_string_pretty(&json!({"fontSha256":digest(&bytes),"profile":if cfg!(debug_assertions) {"debug"}else{"release"},"warmups":5,"samples":31,"results":results,"note":"Native clone+resolve, no JSON parse in timing; serial shared CPU, batch-mean quantiles, no RSS or browser/FPS claim."})).unwrap());
}
