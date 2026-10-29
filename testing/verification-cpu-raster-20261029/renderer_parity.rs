use serde_json::json;
use sha2::{Digest,Sha256};
fn main(){
    let mut cases=0;
    for managed in [false,true] {for profile in ["analytic","figma","figmaSubpixel"] {for case in 0..5 {
        let color=if managed {"color(srgb-linear 4 -0.2 0.5 / 0.8)"}else{"#397db5"};
        let mut doc=json!({"schemaVersion":4,"id":"d","name":"raster parity","pages":[{"id":"p","name":"p","background":"#ffffff","children":["background","group","lens"]}],"nodes":{
            "background":{"id":"background","kind":"rectangle","width":48,"height":40,"fills":[{"kind":"solid","color":"#124817"}]},
            "group":{"id":"group","kind":"rectangle","width":36.25,"height":30.75,"transform":[1,0,0,1,3.125,4.375],"clip":true,"opacity":0.7,"children":["mask","shape"],"fills":[{"kind":"solid","color":"#ffeedd","opacity":0.4}]},
            "mask":{"id":"mask","kind":"ellipse","width":31.125,"height":27.875,"mask":true,"fills":[{"kind":"solid","color":"#ffffff","opacity":0.7}]},
            "shape":{"id":"shape","kind":"ellipse","width":40.25,"height":26.75,"transform":[1,0.125,-0.25,1,-1.375,0.625],"fills":[{"kind":"solid","color":color},{"kind":"linear","color":"#ffffff","angle":31,"opacity":0.35,"stops":[{"offset":0,"color":"#000000"},{"offset":1,"color":"#dd2200"}]}],"strokes":[{"width":1.375,"align":"inside","paint":{"kind":"solid","color":"#123456","opacity":0.7}},{"width":2.25,"align":"outside","paint":{"kind":"solid","color":"#bd9911","opacity":0.6}}]},
            "lens":{"id":"lens","kind":"rectangle","width":23.125,"height":19.75,"transform":[1,0,0,1,7.375,9.625],"fills":[{"kind":"solid","color":"#ffffff","opacity":0.15}]}
        }});
        if managed{doc["colorManagement"]=json!({"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000});}
        match case {
            0=>{doc["nodes"]["mask"]["mask"]=json!(false);doc["nodes"]["mask"]["visible"]=json!(false);},
            1=>{doc["nodes"]["shape"]["blend"]=json!("multiply");},
            2=>{doc["nodes"]["group"]["effects"]=json!([{"kind":"shadow","radius":2,"x":1.25,"y":0.5,"color":"#000000","opacity":0.6}]);},
            3=>{doc["nodes"]["lens"]["effects"]=json!([{"kind":"background-blur","radius":2.5,"color":"#000000"}]);},
            _=>{doc["nodes"]["shape"]["effects"]=json!([{"kind":"blur","radius":1.5,"color":"#000000"}]);}
        }
        let opts=json!({"pageId":"p","width":48,"height":40,"view":{"x":0.125,"y":-0.25,"zoom":1},"transparent":true,"rasterProfile":profile});
        let mut old=baseline::Engine::new();let mut new=candidate::Engine::new();
        old.load_document(&doc.to_string()).unwrap();new.load_document(&doc.to_string()).unwrap();
        let old_opts:baseline::RenderOptions=serde_json::from_value(opts.clone()).unwrap();let new_opts:candidate::RenderOptions=serde_json::from_value(opts).unwrap();
        let a=old.render(&old_opts).unwrap();let b=new.render(&new_opts).unwrap();assert_eq!(a,b,"RGBA managed={managed} profile={profile} case={case}");
        let mut sha=Sha256::new();
        let float_equal = if managed {
            let a=old.render_linear(&old_opts).unwrap();let b=new.render_linear(&new_opts).unwrap();
            let a:Vec<_>=a.iter().flat_map(|p|p.0.map(f32::to_bits)).collect();let b:Vec<_>=b.iter().flat_map(|p|p.0.map(f32::to_bits)).collect();assert_eq!(a,b,"float managed={managed} profile={profile} case={case}");
            for bits in b {sha.update(bits.to_le_bytes());}
            Some(true)
        } else { sha.update(&b); None };
        println!("{}",json!({"case":case,"managed":managed,"profile":profile,"rgbaEqual":true,"floatBitsEqual":float_equal,"sha256":format!("{:x}",sha.finalize())}));cases+=1;
    }}}
    eprintln!("{cases} paired full renderer cases passed (30 RGBA; 15 managed f32)");
}
