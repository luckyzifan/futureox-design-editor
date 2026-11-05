//! A zero-edge inner shadow reads outside its output but only writes where
//! the original fill has coverage. Exercise the production patch transaction.
use futureox_design_kernel::{editing::DocumentPatch, scene::Document, Engine, RenderOptions};
use serde_json::json;

#[test]
fn rotated_inner_shadows_damage_the_drawn_path_and_preserve_fresh_pixels() {
    let mut doc: Document = serde_json::from_value(json!({
        "schemaVersion":16,"id":"d","name":"shadow","pages":[{"id":"p","name":"p","children":["path"],"background":"#ffffff"}],
        "nodes":{"path":{"id":"path","kind":"vector","width":80,"height":80,"transform":[1,0,0,1,12,14],
            "fills":[{"kind":"solid","color":"#a070e0"}],
            "vectorGeometry":{"fillRule":"nonzero","fill":[{"move":[2.,3.]},{"line":[25.,5.]},{"line":[15.,31.]},"close"]},
            "effects":[{"kind":"inner-shadow","visible":true,"radius":12.,"x":2.,"y":4.,"color":"#000000","opacity":0.8},
                       {"kind":"inner-shadow","visible":true,"radius":8.,"x":-3.,"y":-2.,"color":"#ffffff","opacity":0.4}]}}
    })).unwrap();
    let opts:RenderOptions=serde_json::from_value(json!({"pageId":"p","width":96,"height":96,"view":{"x":0,"y":0,"zoom":1},"grid":false,"transparent":false})).unwrap();
    let mut engine=Engine::new();engine.load_document(&serde_json::to_string(&doc).unwrap()).unwrap();
    engine.compile_gpu(&opts).unwrap();
    let before=engine.render(&opts).unwrap();
    let mut next=doc.clone();
    next.nodes.get_mut("path").unwrap().transform.0=[0.,1.,-1.,0.,61.,20.];
    let patch=DocumentPatch::between(&doc,&next).unwrap();
    let damage=engine.apply_document_patch_with_damage(&patch).unwrap();
    assert!(!damage.full);
    let rects=damage.rects.unwrap();assert_eq!(rects.len(),2);
    assert!(rects.iter().all(|b|b[2]<=33. && b[3]<=33.),"{rects:?}");
    let after=engine.render(&opts).unwrap();
    let mut fresh=Engine::new();fresh.load_document(&serde_json::to_string(&next).unwrap()).unwrap();
    assert_eq!(after,fresh.render(&opts).unwrap());
    let mut changed=0;
    for (pixel,(a,b)) in before.chunks_exact(4).zip(after.chunks_exact(4)).enumerate() {
        if a==b {continue}
        changed+=1;
        let (x,y)=((pixel%96) as f64+0.5,(pixel/96) as f64+0.5);
        assert!(rects.iter().any(|r|x>=r[0]&&x<=r[0]+r[2]&&y>=r[1]&&y<=r[1]+r[3]));
    }
    assert!(changed>0);
    doc.nodes.get_mut("path").unwrap().effects[0].kind="shadow".into();
    let mut other=Engine::new();other.load_document(&serde_json::to_string(&doc).unwrap()).unwrap();
    other.compile_gpu(&opts).unwrap();
    let mut shifted=doc.clone();shifted.nodes.get_mut("path").unwrap().transform.0[4]+=7.;
    let wider=other.apply_document_patch_with_damage(&DocumentPatch::between(&doc,&shifted).unwrap()).unwrap();
    assert!(wider.full||wider.bounds.unwrap()[2]>50.);
}
