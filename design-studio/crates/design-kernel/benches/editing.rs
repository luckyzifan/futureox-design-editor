use futureox_design_kernel::{
    editing::{DocumentEditor, DocumentPatch},
    scene::Document,
};
use std::{collections::BTreeMap, time::Instant};
fn main() {
    for count in [1000, 10000] {
        let nodes: BTreeMap<_, _> = (0..count)
            .map(|i| {
                let id = i.to_string();
                (
                    id.clone(),
                    serde_json::json!({"id":id,"kind":"rectangle","width":100,"height":100}),
                )
            })
            .collect();
        let doc:Document=serde_json::from_value(serde_json::json!({"schemaVersion":2,"id":"bench","name":"bench","nodes":nodes,"pages":[{"id":"page","name":"Page","background":"#ffffff","children":(0..count).map(|i|i.to_string()).collect::<Vec<_>>()}]})).unwrap();
        let mut editor = DocumentEditor::new(doc).unwrap();
        let mut samples = Vec::new();
        for i in 0..12 {
            let mut n = editor.document().nodes["0"].clone();
            n.opacity = if i % 2 == 0 { 0.5 } else { 1. };
            let p = DocumentPatch {
                nodes: BTreeMap::from([("0".into(), Some(n))]),
                fields: Default::default(),
            };
            let t = Instant::now();
            editor.apply(editor.revision(), p).unwrap();
            if i >= 2 {
                samples.push(t.elapsed().as_secs_f64() * 1000.)
            }
        }
        samples.sort_by(f64::total_cmp);
        println!(
            "nodes={count} Rust atomic apply+validate+history median_ms={:.3}",
            samples[5]
        );
    }
}
