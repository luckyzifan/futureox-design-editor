//! Frame-scoped immutable resources and exact binary scene transport.
//! Old FGPK JSON/image-table variants are replaced by one FGSC protocol.
use super::{frame_wire, GpuScene, Paint};
use serde::Serialize;
use std::{collections::{BTreeMap, HashMap, HashSet},sync::Arc};
const LIMIT:usize=32*1024*1024;
type Key=(u8,Arc<[u8]>);
struct Entry { id:u32, age:u64, bytes:usize }
#[derive(Default)]
pub(crate) struct FrameSceneContext {
    scope:String, binding:String, entries:HashMap<Key,Entry>, ages:BTreeMap<u64,Key>, bytes:usize,
    next:u32, clock:u64, frame:u32, frame_key:Option<String>,
}
impl FrameSceneContext {
    pub(crate) fn bytes(&self)->usize{self.bytes}
    pub(crate) fn bind(&mut self,scope:&str){
        // Ordinary revisions keep immutable resource IDs. A freshly forked
        // engine starts empty and adopts the unique receipt nonce as its scope.
        let binding=serde_json::from_str::<serde_json::Value>(scope).ok().and_then(|v| {
            let values=["sessionGeneration","canvasOwner","documentIncarnation","lane"].iter()
                .map(|k|v.get(k).and_then(|v|v.as_str()).map(str::to_owned)).collect::<Option<Vec<_>>>()?;
            serde_json::to_string(&values).ok()
        }).unwrap_or_else(||scope.to_owned());
        if self.scope.is_empty()||self.binding!=binding{*self=Self{scope:scope.into(),binding,..Self::default()}}
    }
    fn intern(&mut self,kind:u8,data:Vec<u8>)->Result<(u32,Arc<[u8]>),String>{
        let data:Arc<[u8]>=data.into();let key=(kind,data.clone());
        self.clock=self.clock.checked_add(1).ok_or("Frame resource clock exhausted")?;
        if let Some(entry)=self.entries.get_mut(&key){
            self.ages.remove(&entry.age);entry.age=self.clock;self.ages.insert(entry.age,key);
            return Ok((entry.id,data));
        }
        self.next=self.next.checked_add(1).ok_or("Frame resource ID exhausted")?;let id=self.next;
        let bytes=data.len().checked_add(256).ok_or("Frame resource size overflow")?;
        if !self.scope.is_empty()&&bytes<=LIMIT{
            while self.bytes+bytes>LIMIT {let Some((_,old))=self.ages.pop_first()else{break};if let Some(entry)=self.entries.remove(&old){self.bytes-=entry.bytes;}}
            self.entries.insert(key.clone(),Entry{id,age:self.clock,bytes});self.ages.insert(self.clock,key);self.bytes+=bytes;
        }
        Ok((id,data))
    }
    fn encode(&mut self,mut scene:GpuScene,request:Option<&serde_json::Value>,revision:u64)->Result<Vec<u8>,String>{
        let mut frame_key=request.cloned().unwrap_or_else(||serde_json::json!({}));
        if let Some(fields)=frame_key.as_object_mut(){
            fields.remove("frameResources");
            if fields.contains_key("prepareViewport"){for key in ["gpuViewport","width","height"]{fields.remove(key);}}
        }
        let frame_key=serde_json::to_string(&(revision,frame_key)).map_err(|e|e.to_string())?;
        if self.frame_key.as_ref()!=Some(&frame_key){self.frame=self.frame.checked_add(1).ok_or("Frame sequence exhausted")?;self.frame_key=Some(frame_key);}
        let acknowledged=request.and_then(|r|r.get("frameResources"));
        let matches=!self.scope.is_empty()&&acknowledged.and_then(|v|v.get("scope")).and_then(|v|v.as_str())==Some(&self.scope);
        let mut ranges=Vec::new();
        if matches {
            let values=acknowledged.and_then(|v|v.get("ranges")).and_then(|v|v.as_array()).ok_or("Invalid frame resource acknowledgement")?;
            let mut previous=0;
            for pair in values {
                let pair=pair.as_array().filter(|v|v.len()==2).ok_or("Invalid frame resource range")?;
                let a=pair[0].as_u64().filter(|n|*n>0&&*n<=u32::MAX as u64).ok_or("Invalid frame resource ID")? as u32;
                let b=pair[1].as_u64().filter(|n|*n<=u32::MAX as u64).ok_or("Invalid frame resource ID")? as u32;
                if a> b||a<=previous{return Err("Overlapping frame resource ranges".into())}previous=b;ranges.push((a,b));
            }
        }
        let known=|id:u32|{let at=ranges.partition_point(|&(a,_)|a<=id);at>0&&id<=ranges[at-1].1};
        let mut payload=Vec::new();let mut included=HashSet::new();
        let mut record=|id:u32,kind:u8,data:&[u8]|->Result<(),String>{
            if !included.insert(id)||known(id){return Ok(())}
            payload.extend(id.to_le_bytes());payload.push(kind);
            payload.extend(u32::try_from(data.len()).map_err(|_|"Frame resource too large")?.to_le_bytes());payload.extend(data);Ok(())
        };
        let plan=scene.scene_plan();
        let vertices=std::mem::take(&mut scene.vertices);let curves=std::mem::take(&mut scene.curves);
        let mut nodes=std::mem::take(&mut scene.nodes);let mut images=HashMap::<String,u32>::new();
        let mut image=|paint:&mut Paint|->Result<(),String>{
            if let Some(uri)=paint.image.take(){
                let id=if let Some(id)=images.get(&uri){*id}else{
                    let (id,data)=self.intern(1,uri.as_bytes().to_vec())?;record(id,1,&data)?;images.insert(uri,id);id
                };paint.image=Some(id.to_string());
            }Ok(())
        };
        for node in nodes.values_mut(){
            for p in &mut node.fills{image(&mut p.paint)?}for s in &mut node.strokes{image(&mut s.paint.paint)?}
            if let Some(replay)=&mut node.texture_replay{image(&mut replay.paint)?}
        }
        let mut node_resources=Vec::new();
        // A container's identity includes every compiled child, including
        // empty/cull transitions. Its own paint/program equality alone cannot
        // certify a retained subtree after a descendant edit.
        let mut states=HashMap::<String,u8>::new();let mut order=Vec::new();
        for root in nodes.keys() {
            let mut pending=vec![(root.clone(),false)];
            while let Some((id,exit))=pending.pop(){
                if exit{states.insert(id.clone(),2);order.push(id);continue;}
                match states.get(&id){Some(2)=>continue,Some(1)=>return Err("Cyclic compiled scene".into()),_=>{}}
                let Some(node)=nodes.get(&id)else{continue};states.insert(id.clone(),1);pending.push((id,true));
                for child in node.children.iter().rev(){if nodes.contains_key(child){pending.push((child.clone(),false));}}
            }
        }
        let mut source_ids=BTreeMap::<String,u32>::new();
        for name in order { let node=&nodes[&name];
            let mut geometry=Vec::new();
            for path in std::iter::once(&node.fill).chain(node.strokes.iter().map(|s|&s.path)) {
                let (data,first,count)=if let Some(area)=&path.area{(&curves,area.first as usize*4,area.count as usize*4)}
                    else if let Some(analytic)=&path.analytic{(&curves,analytic.first as usize*4,analytic.count as usize*16)}
                    else{(&vertices,path.first as usize*2,path.count as usize*2)};
                let values=data.get(first..first.checked_add(count).ok_or("Invalid program span")?).ok_or("Invalid program span")?;
                let words=values.iter().flat_map(|v|v.to_le_bytes()).collect();
                // Private producer IDs certify exact words; only the ID needs
                // transmission because those words already occupy the frame.
                geometry.push(self.intern(5,words)?.0);
            }
            let canonical=frame_wire::encode_source(node)?;
            let children=node.children.iter().map(|id|(id,source_ids.get(id).copied())).collect::<Vec<_>>();
            let mut source_key=Vec::with_capacity(canonical.len()+64);
            source_key.extend(u32::try_from(canonical.len()).map_err(|_|"Source identity too large")?.to_le_bytes());
            source_key.extend(canonical);source_key.extend(frame_wire::encode(&(geometry,children))?);
            let source_id=self.intern(6,source_key)?.0;
            source_ids.insert(name.clone(),source_id);
            #[derive(Serialize)]#[serde(rename_all="camelCase")]
            struct NodeResource<'a>{node:&'a super::GpuNode,source_identity:u32}
            let (id,data)=self.intern(2,frame_wire::encode(&NodeResource{node:&node,source_identity:source_id})?)?;
            record(id,2,&data)?;node_resources.push((name,id));
        }
        node_resources.sort_by(|a,b|a.0.cmp(&b.0));
        let (plan_id,data)=self.intern(3,frame_wire::encode(&plan)?)?;record(plan_id,3,&data)?;
        #[derive(Serialize)]#[serde(rename_all="camelCase")]
        struct Metadata<'a>{#[serde(flatten)]scene:&'a GpuScene,resource_scope:&'a str,frame_sequence:u32,node_resources:Vec<(String,u32)>,scene_plan:u32}
        let metadata=frame_wire::encode(&Metadata{scene:&scene,resource_scope:&self.scope,frame_sequence:self.frame,node_resources,scene_plan:plan_id})?;
        let start=24usize.checked_add(metadata.len()).and_then(|n|n.checked_add(3)).map(|n|n&!3).ok_or("GPU frame too large")?;
        let total=vertices.len().checked_add(curves.len()).and_then(|n|n.checked_mul(4)).and_then(|n|n.checked_add(start))
            .and_then(|n|n.checked_add(payload.len())).ok_or("GPU frame too large")?;
        let mut bytes=Vec::with_capacity(total);bytes.extend(b"FGSC");
        for value in [1,metadata.len(),vertices.len(),curves.len(),payload.len()]{bytes.extend(u32::try_from(value).map_err(|_|"GPU frame too large")?.to_le_bytes());}
        bytes.extend(metadata);bytes.resize(start,0);for v in vertices.iter().chain(&curves){bytes.extend(v.to_le_bytes())}bytes.extend(payload);Ok(bytes)
    }
}
impl GpuScene {
    pub fn into_packet(self)->Result<Vec<u8>,String>{FrameSceneContext::default().encode(self,None,0)}
}
impl crate::Engine {
    pub fn bind_frame_scene_scope(&mut self,scope:&str)->Result<(),String>{
        if scope.len()>4096{return Err("Frame scope too large".into())}
        self.frame_scene.bind(scope);self.camera_residency.reserve_frame_resources(self.frame_scene.bytes());Ok(())
    }
    pub fn compile_gpu_packet_request(&mut self,options:&str)->Result<Vec<u8>,String>{
        let fields:serde_json::Value=serde_json::from_str(options).map_err(|e|e.to_string())?;
        let scene=self.compile_gpu_request(options)?;
        if self.frame_scene.scope.is_empty() { return scene.into_packet(); }
        let result=self.frame_scene.encode(scene,Some(&fields),self.geo_revision);
        self.camera_residency.reserve_frame_resources(self.frame_scene.bytes());result
    }
}

#[cfg(test)] mod tests {
    use super::*;
    use serde_json::json;
    fn fixture()->(crate::Engine,String){
        let mut engine=crate::Engine::new();
        engine.load_document(&json!({"schemaVersion":1,"id":"d","name":"d","pages":[{"id":"p","name":"p","background":"#ffffff","children":["r"]}],
            "nodes":{"r":{"id":"r","kind":"ellipse","width":30,"height":20,"fills":[{"kind":"solid","color":"#123456"}]}}}).to_string()).unwrap();
        let options=json!({"pageId":"p","width":64,"height":64,"view":{"x":0.125,"y":0.375,"zoom":1.3},"rasterProfile":"figmaSubpixel"}).to_string();
        (engine,options)
    }
    #[test] fn compiled_node_identity_includes_actual_program_words_not_just_addresses_or_hashes(){
        let (mut engine,options)=fixture();let mut context=FrameSceneContext::default();context.bind("producer");
        let first=engine.compile_gpu_request(&options).unwrap();
        let mut changed=engine.compile_gpu_request(&options).unwrap();
        let path=&changed.nodes["r"].fill;
        if let Some(index)=path.area.as_ref().map(|a|a.first as usize*4).or_else(||path.analytic.as_ref().map(|a|a.first as usize*4)) {
            changed.curves[index]=f32::from_bits(changed.curves[index].to_bits()^1);
        }else{let index=path.first as usize*2;changed.vertices[index]=f32::from_bits(changed.vertices[index].to_bits()^1);}
        context.encode(first,None,0).unwrap();assert_eq!(context.entries.keys().filter(|(k,_)|*k==2).count(),1);
        context.encode(changed,None,0).unwrap();assert_eq!(context.entries.keys().filter(|(k,_)|*k==2).count(),2);
    }
    #[test] fn revisions_keep_the_producer_and_new_engines_never_reuse_its_scope(){
        let receipt=|nonce:&str|json!({"sessionGeneration":"session","canvasOwner":"canvas","documentIncarnation":"document","lane":"canvas","nonce":nonce}).to_string();
        let mut context=FrameSceneContext::default();context.bind(&receipt("1"));let original=context.scope.clone();
        let first=context.intern(1,b"image".to_vec()).unwrap().0;
        context.bind(&receipt("2"));assert_eq!(context.scope,original);assert_eq!(context.intern(1,b"image".to_vec()).unwrap().0,first);
        let mut replacement=FrameSceneContext::default();replacement.bind(&receipt("2"));assert_ne!(replacement.scope,original);
    }
    #[test] fn resources_are_bounded_without_turning_a_large_resource_into_document_rejection(){
        let mut context=FrameSceneContext::default();context.bind("bounded");
        let (id,_)=context.intern(1,vec![0;LIMIT+1]).unwrap();assert!(id>0);assert_eq!(context.bytes,0);
        for i in 0..40 {context.intern(1,vec![i;1024*1024]).unwrap();assert!(context.bytes<=LIMIT);}
        assert!(context.entries.len()<40);
    }
}
