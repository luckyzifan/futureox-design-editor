use futureox_design_kernel::Engine;
use serde_json::json;
#[test]
fn neutral_wrapper_scopes_preserve_world_transforms_and_original_source() {
 let doc=json!({"schemaVersion":1,"id":"scope","name":"scope","pages":[{"id":"p","name":"p","background":"#ffffff","children":["wrapper"]}],"nodes":{
 "wrapper":{"id":"wrapper","kind":"group","blend":"pass-through","width":60,"height":40,"transform":[0,2,-2,0,70,10],"children":["a","b"]},
 "a":{"id":"a","kind":"rectangle","width":15,"height":15,"transform":[1,0,0,1,3,5],"fills":[{"kind":"solid","color":"#123456"}]},
 "b":{"id":"b","kind":"rectangle","width":15,"height":15,"transform":[1,0,0,1,8,10],"fills":[{"kind":"solid","color":"#654321"}]}}});
 let options=json!({"pageId":"p","width":96,"height":96,"view":{"x":0,"y":0,"zoom":1},"transparent":true,"grid":false});
 let mut engine=Engine::new();engine.load_document(&doc.to_string()).unwrap();
 let original=engine.compile_gpu_request(&options.to_string()).unwrap();
 let mut scoped=options.clone();scoped["gpuRoots"]=json!(["a"]);
 let actual=engine.compile_gpu_request(&scoped.to_string()).unwrap();
 assert_eq!(actual.nodes["a"].matrix,original.nodes["a"].matrix);
 assert!(!actual.nodes.contains_key("b"));
 let again=engine.compile_gpu_request(&options.to_string()).unwrap();assert_eq!(serde_json::to_value(original).unwrap(),serde_json::to_value(again).unwrap());
 scoped["gpuRoots"]=json!(["wrapper","a"]);assert!(engine.compile_gpu_request(&scoped.to_string()).is_err());
 for field in ["clip","mask"] {let mut unsafe_doc=doc.clone();unsafe_doc["nodes"]["wrapper"][field]=json!(true);engine.load_document(&unsafe_doc.to_string()).unwrap();scoped["gpuRoots"]=json!(["a"]);assert!(engine.compile_gpu_request(&scoped.to_string()).is_err());}
}
