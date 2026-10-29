use futureox_design_kernel::{font::Fonts, scene::{Document,Node}, interop};
use serde_json::json;
fn loaded_fonts()->Fonts {let mut f=Fonts::new();f.load(include_bytes!("../../../../frontend/design-client/public/fonts/NotoSansSC.ttf")).unwrap();f}
fn third_height()->f64 {let f=ttf_parser::Face::parse(include_bytes!("../../../../frontend/design-client/public/fonts/NotoSansSC.ttf"),0).unwrap();((f.ascender() as f64-f.descender() as f64+f.line_gap() as f64)*20./f.units_per_em() as f64).clamp(24.,32.)}
fn node()->Node {serde_json::from_value(json!({"id":"t","kind":"text","text":"One\nTwo\nThree","fontSize":20,"width":200,"height":180,"textStyle":{"lineHeight":1.5,"wrap":true},"textRuns":[
 {"start":0,"end":4,"paragraph":{"align":"start","minimumLineHeight":30,"maximumLineHeight":30,"spacing":4,"indent":3}},
 {"start":4,"end":8,"paragraph":{"align":"center","minimumLineHeight":40,"maximumLineHeight":40,"spacing":6,"indent":0}},
 {"start":8,"end":13,"paragraph":{"align":"end","minimumLineHeight":24,"maximumLineHeight":32,"spacing":0,"indent":0}}]})).unwrap()}
#[test]fn paragraph_alignment_range_height_and_caret_share_geometry(){
 let fonts=loaded_fonts();let n=node();let l=fonts.node_layout(&n,Some(n.width)).unwrap();
 assert_eq!(l.lines.iter().map(|l|(l.y,l.height)).collect::<Vec<_>>(),vec![(0.,30.),(34.,40.),(80.,third_height())]);
 assert_eq!(l.glyphs[0].x,3.);
 for (i,start) in [0,4,8].iter().enumerate(){let g=l.glyphs.iter().find(|g|g.cluster==*start).unwrap(); if i>0 {assert!(g.x>40.)} let caret=fonts.caret_at(&n,*start).unwrap();assert_eq!(caret.y,l.lines[i].y);assert_eq!(fonts.hit_caret(&n,caret.x+0.01,caret.y+5.).unwrap(),*start);}
}
#[test]fn vertical_alignment_moves_paths_and_carets_but_not_measurement_and_keys_height(){
 let fonts=loaded_fonts(); let mut n=node();let top=fonts.node_layout(&n,Some(n.width)).unwrap();let cached=fonts.node_path_shared(&n).unwrap();
 n.text_style.as_mut().unwrap().vertical_align="bottom".into();let bottom=fonts.node_layout(&n,Some(n.width)).unwrap();assert_eq!(bottom.height,top.height);assert!((bottom.glyphs[0].y-top.glyphs[0].y-(100.-third_height())).abs()<1e-10);assert_eq!(fonts.caret_at(&n,0).unwrap().y,100.-third_height());assert_eq!(fonts.node_measure(&n,Some(n.width)).unwrap().lines[0].y,0.);assert_ne!(cached.svg_data(),fonts.node_path_shared(&n).unwrap().svg_data());
 n.height=200.;let p=fonts.node_path_shared(&n).unwrap();let fresh=loaded_fonts().node_path_shared(&n).unwrap();assert_eq!(p.svg_data(),fresh.svg_data());assert_eq!(fonts.caret_at(&n,0).unwrap().y,120.-third_height());
}
#[test]fn paragraph_and_vertical_schema_and_native_roundtrip(){
 let mut d:Document=serde_json::from_value(json!({"schemaVersion":20,"id":"d","name":"text","pages":[{"id":"p","name":"P","background":"#ffffff","children":["t"]}],"nodes":{}})).unwrap();let mut n=node();n.text_style.as_mut().unwrap().vertical_align="center".into();d.nodes.insert("t".into(),n.clone());d.validate().unwrap();
 d.schema_version=19;assert!(d.validate().unwrap_err().contains("20"));d.schema_version=20;
 let back=interop::import_sketch_report(&interop::export_sketch(&d).unwrap()).unwrap().document;
 assert_eq!(back.nodes["t"].text_runs.iter().map(|r|&r.paragraph).collect::<Vec<_>>(),n.text_runs.iter().map(|r|&r.paragraph).collect::<Vec<_>>());assert_eq!(back.nodes["t"].text_style.as_ref().unwrap().vertical_align,"center");
 let mut invalid=n;invalid.text_runs[0].paragraph.as_mut().unwrap().maximum_line_height=20.;assert!(Fonts::new().node_layout(&invalid,Some(200.)).is_err());
}

#[test]fn attributed_color_does_not_append_another_native_style_fill(){
 let mut d:Document=serde_json::from_value(json!({"schemaVersion":20,"id":"d","name":"fills","pages":[{"id":"p","name":"P","background":"#ffffff","children":["t"]}],"nodes":{}})).unwrap();let mut n=node();n.fills=serde_json::from_value(json!([{"kind":"solid","color":"#3366cc","opacity":0.5}])).unwrap();d.nodes.insert("t".into(),n);
 let back=interop::import_sketch_report(&interop::export_sketch(&d).unwrap()).unwrap().document;
 assert_eq!(back.nodes["t"].fills.len(),1);
 assert_eq!(back.nodes["t"].fills[0].opacity,0.5);
}
