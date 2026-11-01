//! Frame-scoped immutable resources and exact binary scene transport.
//! Old FGPK JSON/image-table variants are replaced by one FGSC protocol.
use super::{frame_wire, GpuScene, Paint};
use serde::Serialize;
use std::{collections::{BTreeMap, HashMap, HashSet,hash_map::RandomState},hash::{BuildHasher,Hash,Hasher},sync::Arc};
/// Hash once at the immutable producer boundary. Map growth, LRU removal and
/// insertion then hash only this small descriptor. Equality still compares
/// every byte, including in the event of a digest collision.
#[derive(Clone,PartialEq,Eq)]
struct Key { kind:u8, digest:u64, data:Arc<[u8]> }
impl Hash for Key {
    fn hash<H:Hasher>(&self,state:&mut H){self.kind.hash(state);self.digest.hash(state);}
}
struct Entry { id:u32, age:u64, bytes:usize }
struct SemanticEntry { id:u32, key:Vec<u8>, charge:usize }
type StaticRequest=((u64,bool,bool),String);
fn source_request_key(revision:(u64,bool,bool),fields:&serde_json::Value)->Result<StaticRequest,String>{
    let object=fields.as_object().ok_or("Render options must be an object")?;
    let semantic=object.iter().filter(|(key,_)|key.as_str()!="frameResources").collect::<BTreeMap<_,_>>();
    Ok((revision,serde_json::to_string(&semantic).map_err(|e|e.to_string())?))
}
struct EncodedFrame {
    key:StaticRequest,
    prefix:Vec<u8>,
    resources:Vec<(u32,u8,Arc<[u8]>)>,
    charge:usize,
    sequence_offset:usize,
    sequence:u32,
    nodes:usize,
    authored_nodes:usize,
}
fn acknowledged_ranges(scope:&str,request:Option<&serde_json::Value>)->Result<Vec<(u32,u32)>,String>{
    let acknowledged=request.and_then(|r|r.get("frameResources"));
    if scope.is_empty()||acknowledged.and_then(|v|v.get("scope")).and_then(|v|v.as_str())!=Some(scope){return Ok(vec![])}
    let values=acknowledged.and_then(|v|v.get("ranges")).and_then(|v|v.as_array()).ok_or("Invalid frame resource acknowledgement")?;
    let mut ranges=Vec::with_capacity(values.len());let mut previous=0;
    for pair in values {
        let pair=pair.as_array().filter(|v|v.len()==2).ok_or("Invalid frame resource range")?;
        let a=pair[0].as_u64().filter(|n|*n>0&&*n<=u32::MAX as u64).ok_or("Invalid frame resource ID")? as u32;
        let b=pair[1].as_u64().filter(|n|*n<=u32::MAX as u64).ok_or("Invalid frame resource ID")? as u32;
        if a>b||a<=previous{return Err("Overlapping frame resource ranges".into())}previous=b;ranges.push((a,b));
    }
    Ok(ranges)
}
fn known(ranges:&[(u32,u32)],id:u32)->bool{
    let at=ranges.partition_point(|&(a,_)|a<=id);at>0&&id<=ranges[at-1].1
}
impl EncodedFrame {
    fn emit(&self,ranges:&[(u32,u32)])->Result<Vec<u8>,String>{
        crate::render_cancellation::checkpoint()?;
        let mut bytes=self.prefix.clone();
        for (id,kind,data) in &self.resources {
            crate::render_cancellation::checkpoint()?;
            if known(ranges,*id){continue}
            bytes.extend(id.to_le_bytes());bytes.push(*kind);
            bytes.extend(u32::try_from(data.len()).map_err(|_|"Frame resource too large")?.to_le_bytes());bytes.extend(data.as_ref());
        }
        let payload=u32::try_from(bytes.len()-self.prefix.len()).map_err(|_|"GPU frame too large")?;
        bytes[20..24].copy_from_slice(&payload.to_le_bytes());Ok(bytes)
    }
}
#[derive(Default)]
pub(crate) struct FrameSceneContext {
    scope:String, binding:String, entries:HashMap<Key,Entry>, ages:BTreeMap<u64,Key>, bytes:usize,
    next:u32, clock:u64, frame:u32, frame_key:Option<String>,
    resource_hasher:RandomState,
    semantics:HashMap<String,SemanticEntry>,image_semantics:HashMap<Arc<str>,u32>,semantic_bytes:usize,semantic_hits:u64,
    // Numeric addresses are private lookup hints backed by the strong Arc key
    // in image_semantics. They are never dereferenced or accepted from callers.
    image_allocations:HashMap<usize,u32>,image_transfer_keys:HashMap<u32,Key>,image_transfer_sources:HashMap<u32,u32>,
    image_allocation_hits:u64,image_transfer_hits:u64,
    cached:Option<EncodedFrame>,pending_request:Option<StaticRequest>,compilations:u64,reuses:u64,
    retention_limit:Option<usize>,
    // Native source revisits share the existing retention allowance. Entries
    // contain no document or GPU owner, only validated immutable wire data.
    source_history:std::collections::VecDeque<EncodedFrame>,
    source_history_bytes:usize,
    source_history_hits:u64,
    #[cfg(test)] limit_override:Option<usize>,
}
impl FrameSceneContext {
    fn limit(&self)->usize {
        let host=crate::capacity::memory_budget_bytes().min(usize::MAX as u64) as usize;
        #[cfg(test)] let host=self.limit_override.unwrap_or(host);
        self.retention_limit.map_or(host,|limit|limit.min(host))
    }
    /// Optional cache handoff, never a wire-scope reset. Already emitted IDs
    /// remain immutable in receivers; evicted resources get fresh IDs on reuse.
    pub(crate) fn limit_retention(&mut self,limit:Option<usize>){
        self.retention_limit=limit;
        let limit=self.limit();
        while self.bytes()>limit && !self.source_history.is_empty(){self.evict_source_frame();}
        if self.bytes()<=limit{return}
        self.cached=None;
        while self.bytes()>limit {
            let Some((_,key))=self.ages.pop_first()else{break};
            self.evict_transfer(&key);
        }
        if self.semantic_bytes>limit {
            self.semantics.clear();self.image_semantics.clear();self.image_allocations.clear();
            self.image_transfer_keys.clear();self.image_transfer_sources.clear();self.semantic_bytes=0;
        }
    }
    pub(crate) fn bytes(&self)->usize{self.bytes+self.semantic_bytes+self.cached.as_ref().map_or(0,|frame|frame.charge)+self.source_history_bytes}
    fn evict_source_frame(&mut self){if let Some(frame)=self.source_history.pop_front(){self.source_history_bytes-=frame.charge;}}
    pub(crate) fn clear_source_history(&mut self){self.source_history.clear();self.source_history_bytes=0;}
    pub(crate) fn reuse_source(&mut self,revision:(u64,bool,bool),request:&str)->Result<Option<(Vec<u8>,usize,usize)>,String>{
        crate::render_cancellation::checkpoint()?;
        let fields:serde_json::Value=serde_json::from_str(request).map_err(|e|e.to_string())?;
        let key=source_request_key(revision,&fields)?;
        let Some(index)=self.source_history.iter().position(|frame|frame.key==key)else{return Ok(None)};
        let ranges=acknowledged_ranges(&self.scope,Some(&fields))?;
        let frame=&mut self.source_history[index];
        // An older camera must publish a fresh monotonic sequence. Consecutive
        // identical requests keep the established byte-identical shortcut.
        if frame.sequence!=self.frame {
            self.frame=self.frame.checked_add(1).ok_or("Frame sequence exhausted")?;
            frame.prefix[frame.sequence_offset..frame.sequence_offset+8].copy_from_slice(&f64::from(self.frame).to_le_bytes());
            frame.sequence=self.frame;self.frame_key=None;
        }
        let bytes=frame.emit(&ranges)?;let nodes=frame.nodes;let authored=frame.authored_nodes;
        let frame=self.source_history.remove(index).unwrap();self.source_history.push_back(frame);
        self.source_history_hits+=1;Ok(Some((bytes,nodes,authored)))
    }
    pub(crate) fn retain_source(&mut self,revision:(u64,bool,bool),request:&str,authored_nodes:usize)->Result<(),String>{
        let fields:serde_json::Value=serde_json::from_str(request).map_err(|e|e.to_string())?;
        let key=source_request_key(revision,&fields)?;
        if key.1.len()>65536{return Ok(())}
        let Some(mut frame)=self.cached.take()else{return Ok(())};
        frame.authored_nodes=authored_nodes;
        // replace the projection-local epoch with the complete source lineage;
        // this method is called only after demand closure and successful encode.
        frame.charge=frame.charge.saturating_sub(frame.key.1.capacity()).saturating_add(key.1.capacity());frame.key=key;
        if frame.charge>self.limit(){return Ok(())}
        while self.source_history.len()>=32 || self.bytes().saturating_add(frame.charge)>self.limit(){
            if self.source_history.is_empty(){return Ok(())}self.evict_source_frame();
        }
        self.source_history_bytes+=frame.charge;self.source_history.push_back(frame);Ok(())
    }
    pub(crate) fn stats(&self)->serde_json::Value{
        serde_json::json!({"compilations":self.compilations,"sameRequestHits":self.reuses,"semanticHits":self.semantic_hits,"semanticBytes":self.semantic_bytes,"bytes":self.bytes(),"limit":self.limit(),"limitSource":"trusted-host-memory",
            "imageAllocationHits":self.image_allocation_hits,"imageTransferHits":self.image_transfer_hits,
            "sourceReplayHits":self.source_history_hits,"sourceReplayEntries":self.source_history.len(),"sourceReplayBytes":self.source_history_bytes})
    }
    fn reuse(&mut self,key:&StaticRequest,request:&serde_json::Value)->Result<Option<Vec<u8>>,String>{
        let Some(frame)=self.cached.as_ref().filter(|frame|&frame.key==key)else{return Ok(None)};
        let bytes=frame.emit(&acknowledged_ranges(&self.scope,Some(request))?)?;
        self.reuses+=1;Ok(Some(bytes))
    }
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
        // Unbound or oversized values cannot be cache hits or insertions.
        // They retain the original uncached path without scanning their bytes
        // solely to construct an index which will not be used.
        let digest=if !self.scope.is_empty()&&data.len()<=self.limit().saturating_sub(256){
            self.resource_hasher.hash_one((kind,data.as_slice()))
        }else{0};
        let data:Arc<[u8]>=data.into();let key=Key{kind,digest,data:data.clone()};
        self.clock=self.clock.checked_add(1).ok_or("Frame resource clock exhausted")?;
        if let Some((original,entry))=self.entries.get_key_value(&key){
            let original=original.clone();let id=entry.id;let age=entry.age;
            self.ages.remove(&age);self.entries.get_mut(&original).unwrap().age=self.clock;self.ages.insert(self.clock,original.clone());
            return Ok((id,original.data));
        }
        self.next=self.next.checked_add(1).ok_or("Frame resource ID exhausted")?;let id=self.next;
        let bytes=data.len().checked_add(256).ok_or("Frame resource size overflow")?;
        let limit=self.limit().saturating_sub(self.source_history_bytes).saturating_sub(self.semantic_bytes).saturating_sub(self.cached.as_ref().map_or(0,|frame|frame.charge));
        if !self.scope.is_empty()&&bytes<=limit{
            while self.bytes+bytes>limit {let Some((_,old))=self.ages.pop_first()else{break};self.evict_transfer(&old);}
            self.entries.insert(key.clone(),Entry{id,age:self.clock,bytes});self.ages.insert(self.clock,key);self.bytes+=bytes;
        }
        Ok((id,data))
    }
    fn evict_transfer(&mut self,key:&Key){
        if let Some(entry)=self.entries.remove(key){
            self.bytes-=entry.bytes;
            if let Some(source)=self.image_transfer_sources.remove(&entry.id){self.image_transfer_keys.remove(&source);}
        }
    }
    fn image_identity(&mut self,uri:&Arc<str>)->Result<(u32,bool),String>{
        let address=Arc::as_ptr(uri) as *const u8 as usize;
        if let Some(id)=self.image_allocations.get(&address){self.image_allocation_hits+=1;return Ok((*id,true))}
        if let Some(id)=self.image_semantics.get(uri){return Ok((*id,true))}
        self.next=self.next.checked_add(1).ok_or("Frame resource ID exhausted")?;
        let id=self.next;let charge=uri.len().saturating_add(256);
        let limit=self.limit().saturating_sub(self.source_history_bytes).saturating_sub(self.cached.as_ref().map_or(0,|f|f.charge));
        if !self.scope.is_empty()&&self.semantic_bytes.saturating_add(charge)<=limit{
            while self.bytes+self.semantic_bytes+charge>limit{
                let Some((_,old))=self.ages.pop_first()else{break};
                self.evict_transfer(&old);
            }
            self.semantic_bytes+=charge;self.image_semantics.insert(uri.clone(),id);self.image_allocations.insert(address,id);
            return Ok((id,true));
        }
        Ok((id,false))
    }
    fn intern_image(&mut self,source:u32,uri:&Arc<str>,retained:bool)->Result<(u32,Arc<[u8]>),String>{
        if let Some(key)=self.image_transfer_keys.get(&source).cloned(){
            if let Some(entry)=self.entries.get_mut(&key){
                self.clock=self.clock.checked_add(1).ok_or("Frame resource clock exhausted")?;
                let id=entry.id;let old=entry.age;entry.age=self.clock;
                self.ages.remove(&old);self.ages.insert(self.clock,key.clone());self.image_transfer_hits+=1;
                return Ok((id,key.data));
            }
            self.image_transfer_keys.remove(&source);
            self.image_transfer_sources.retain(|_,owner|*owner!=source);
        }
        let result=self.intern(1,uri.as_bytes().to_vec())?;
        if retained {if let Some(key)=self.ages.get(&self.clock).cloned(){
            if self.entries.get(&key).is_some_and(|entry|entry.id==result.0){
                self.image_transfer_keys.insert(source,key);self.image_transfer_sources.insert(result.0,source);
            }
        }}
        Ok(result)
    }
    /// Current immutable node semantics own their identity independently of
    /// transfer-cache LRU and relocatable program addresses. Exact bytes are
    /// retained under the SAME allowance, and a removed/oversized node never
    /// resurrects an identity from a digest alone.
    fn source_identity(&mut self,name:&str,key:Vec<u8>)->Result<u32,String>{
        if let Some(old)=self.semantics.get(name) {
            if old.key==key {self.semantic_hits+=1;return Ok(old.id)}
        }
        if let Some(old)=self.semantics.remove(name){self.semantic_bytes-=old.charge;}
        self.next=self.next.checked_add(1).ok_or("Frame resource ID exhausted")?;
        let id=self.next;
        let charge=key.capacity().saturating_add(name.len()).saturating_add(256);
        let limit=self.limit().saturating_sub(self.source_history_bytes).saturating_sub(self.cached.as_ref().map_or(0,|f|f.charge));
        if !self.scope.is_empty()&&self.semantic_bytes.saturating_add(charge)<=limit {
            while self.bytes+self.semantic_bytes+charge>limit {
                let Some((_,old))=self.ages.pop_first()else{break};
                self.evict_transfer(&old);
            }
            self.semantic_bytes+=charge;
            self.semantics.insert(name.to_owned(),SemanticEntry{id,key,charge});
        }
        Ok(id)
    }
    fn encode(&mut self,mut scene:GpuScene,request:Option<&serde_json::Value>,revision:u64)->Result<Vec<u8>,String>{
        let shared=request.and_then(|r|r.get("prepareViewport")).is_some();
        // Borrow semantic fields; a large ACK must never be cloned only to be
        // removed from the frame key immediately afterwards.
        let frame_key=request.and_then(|r|r.as_object()).into_iter().flat_map(|r|r.iter())
            .filter(|(key,_)|key.as_str()!="frameResources"&&(!shared||!["gpuViewport","width","height"].contains(&key.as_str())))
            .collect::<BTreeMap<_,_>>();
        let frame_key=serde_json::to_string(&(revision,frame_key)).map_err(|e|e.to_string())?;
        if self.frame_key.as_ref()!=Some(&frame_key){self.frame=self.frame.checked_add(1).ok_or("Frame sequence exhausted")?;self.frame_key=Some(frame_key);}
        let ranges=acknowledged_ranges(&self.scope,request)?;
        let mut cache_key=self.pending_request.take();let cache_limit=self.limit();
        let mut resources=Vec::new();let mut resource_charge=0usize;
        let mut payload=Vec::new();let mut included=HashSet::new();
        let mut record=|id:u32,kind:u8,data:&Arc<[u8]>|->Result<(),String>{
            if !included.insert(id){return Ok(())}
            if cache_key.is_some(){
                resource_charge=resource_charge.saturating_add(data.len()).saturating_add(256);
                if resource_charge<=cache_limit{resources.push((id,kind,data.clone()))}else{resources.clear();cache_key=None;}
            }
            if known(&ranges,id){return Ok(())}
            payload.extend(id.to_le_bytes());payload.push(kind);
            payload.extend(u32::try_from(data.len()).map_err(|_|"Frame resource too large")?.to_le_bytes());payload.extend(data.as_ref());Ok(())
        };
        self.semantics.retain(|name,entry|{
            if scene.nodes.contains_key(name){true}else{self.semantic_bytes-=entry.charge;false}
        });
        let plan=scene.scene_plan();
        let vertices=std::mem::take(&mut scene.vertices);let curves=std::mem::take(&mut scene.curves);
        let mut nodes=std::mem::take(&mut scene.nodes);let mut images=HashMap::<Arc<str>,(u32,u32)>::new();
        let mut image_addresses=HashMap::<usize,(u32,u32)>::new();
        let mut image_transports=HashMap::<u32,u32>::new();
        let mut node_resources=Vec::new();
        // A container's identity includes every compiled child, including
        // empty/cull transitions. Its own paint/program equality alone cannot
        // certify a retained subtree after a descendant edit.
        let order=plan.source_order.as_ref().map_err(Clone::clone)?;
        let mut source_ids=BTreeMap::<String,u32>::new();
        for name in order { let node=nodes.get_mut(name).unwrap();
            crate::render_cancellation::checkpoint()?;
            // Exact image identity retains each original URI once. Repeated
            // paints never embed another large URI in their semantic proof.
            {
                let mut image=|paint:&mut Paint|->Result<(),String>{
                    if let Some(uri)=paint.image.take(){
                        let address=Arc::as_ptr(&uri) as *const u8 as usize;
                        let (source,id)=if let Some(ids)=image_addresses.get(&address){*ids}else if let Some(ids)=images.get(&uri){*ids}else{
                            let (source,retained)=self.image_identity(&uri)?;
                            let (id,data)=self.intern_image(source,&uri,retained)?;record(id,1,&data)?;
                            images.insert(uri,(source,id));image_addresses.insert(address,(source,id));image_transports.insert(source,id);(source,id)
                        };let _=id;paint.image=Some(source.to_string().into());
                    }Ok(())
                };
                for p in &mut node.fills{image(&mut p.paint)?}for s in &mut node.strokes{image(&mut s.paint.paint)?}
                if let Some(replay)=&mut node.texture_replay{image(&mut replay.paint)?}
            }
            let canonical=frame_wire::encode_source(node)?;
            let transport=|paint:&mut Paint|{if let Some(source)=paint.image.as_ref(){
                let source=source.parse::<u32>().expect("private semantic image reference");
                paint.image=Some(image_transports[&source].to_string().into());
            }};
            for p in &mut node.fills{transport(&mut p.paint)}for s in &mut node.strokes{transport(&mut s.paint.paint)}
            if let Some(replay)=&mut node.texture_replay{transport(&mut replay.paint)}
            let mut source_key=Vec::with_capacity(canonical.len()+64);
            source_key.extend(u32::try_from(canonical.len()).map_err(|_|"Source identity too large")?.to_le_bytes());
            source_key.extend(canonical);
            for path in std::iter::once(&node.fill).chain(node.strokes.iter().map(|s|&s.path)) {
                let (data,first,count)=if let Some(area)=&path.area{(&curves,area.first as usize*4,area.count as usize*4)}
                    else if let Some(analytic)=&path.analytic{(&curves,analytic.first as usize*4,analytic.count as usize*16)}
                    else{(&vertices,path.first as usize*2,path.count as usize*2)};
                let values=data.get(first..first.checked_add(count).ok_or("Invalid program span")?).ok_or("Invalid program span")?;
                source_key.extend(u32::try_from(count).map_err(|_|"Invalid program span")?.to_le_bytes());
                for value in values{source_key.extend(value.to_le_bytes());}
            }
            let children=node.children.iter().map(|id|(id,source_ids.get(id).copied())).collect::<Vec<_>>();
            source_key.extend(frame_wire::encode(&children)?);
            let source_id=self.source_identity(name,source_key)?;
            source_ids.insert(name.clone(),source_id);
            #[derive(Serialize)]#[serde(rename_all="camelCase")]
            struct NodeResource<'a>{node:&'a super::GpuNode,source_identity:u32}
            let (id,data)=self.intern(2,frame_wire::encode(&NodeResource{node:&node,source_identity:source_id})?)?;
            record(id,2,&data)?;node_resources.push((name.clone(),id));
        }
        self.image_semantics.retain(|uri,source|{if image_transports.contains_key(source){true}else{
            self.semantic_bytes-=uri.len()+256;self.image_allocations.remove(&(Arc::as_ptr(uri) as *const u8 as usize));
            if let Some(key)=self.image_transfer_keys.remove(source){if let Some(entry)=self.entries.get(&key){self.image_transfer_sources.remove(&entry.id);}}
            false
        }});
        node_resources.sort_by(|a,b|a.0.cmp(&b.0));
        let compiled_nodes=node_resources.len();
        let (plan_id,data)=self.intern(3,frame_wire::encode(&plan)?)?;record(plan_id,3,&data)?;
        #[derive(Serialize)]#[serde(rename_all="camelCase")]
        struct Metadata<'a>{#[serde(flatten)]scene:&'a GpuScene,resource_scope:&'a str,frame_sequence:frame_wire::FrameSequence,node_resources:Vec<(String,u32)>,scene_plan:u32}
        let (metadata,sequence_offset)=frame_wire::encode_frame(&Metadata{scene:&scene,resource_scope:&self.scope,frame_sequence:frame_wire::FrameSequence(self.frame),node_resources,scene_plan:plan_id})?;
        let start=24usize.checked_add(metadata.len()).and_then(|n|n.checked_add(3)).map(|n|n&!3).ok_or("GPU frame too large")?;
        let total=vertices.len().checked_add(curves.len()).and_then(|n|n.checked_mul(4)).and_then(|n|n.checked_add(start))
            .and_then(|n|n.checked_add(payload.len())).ok_or("GPU frame too large")?;
        let mut bytes=Vec::with_capacity(total);bytes.extend(b"FGSC");
        for value in [1,metadata.len(),vertices.len(),curves.len(),payload.len()]{bytes.extend(u32::try_from(value).map_err(|_|"GPU frame too large")?.to_le_bytes());}
        bytes.extend(metadata);bytes.resize(start,0);for v in vertices.iter().chain(&curves){bytes.extend(v.to_le_bytes())}
        if let Some(key)=cache_key {
            let charge=resource_charge.saturating_add(bytes.len()).saturating_add(key.1.capacity()).saturating_add(256);
            if charge.saturating_add(self.semantic_bytes)<=cache_limit {
                while self.source_history_bytes.saturating_add(self.semantic_bytes).saturating_add(charge)>cache_limit && !self.source_history.is_empty(){self.evict_source_frame();}
                while self.bytes+self.semantic_bytes+self.source_history_bytes+charge>cache_limit {let Some((_,old))=self.ages.pop_first()else{break};self.evict_transfer(&old);}
                self.cached=Some(EncodedFrame{key,prefix:bytes.clone(),resources,charge,sequence_offset:24+sequence_offset,sequence:self.frame,nodes:compiled_nodes,authored_nodes:compiled_nodes});
            }
        }
        bytes.extend(payload);Ok(bytes)
    }
}
impl GpuScene {
    pub fn into_packet(self)->Result<Vec<u8>,String>{FrameSceneContext::default().encode(self,None,0)}
}
impl crate::Engine {
    pub(crate) fn invalidate_frame_scene_request(&mut self){
        self.frame_scene.cached=None;self.frame_scene.pending_request=None;self.frame_scene.frame_key=None;
    }
    pub fn bind_frame_scene_scope(&mut self,scope:&str)->Result<(),String>{
        if scope.len()>4096{return Err("Frame scope too large".into())}
        self.frame_scene.bind(scope);self.reserve_render_cache_bytes();Ok(())
    }
    pub fn compile_gpu_packet_request(&mut self,options:&str)->Result<Vec<u8>,String>{
        self.compile_gpu_packet_request_checked(options, |_|Ok(()))
    }
    pub(crate) fn compile_gpu_packet_request_checked(&mut self,options:&str,mut accept:impl FnMut(&GpuScene)->Result<(),String>)->Result<Vec<u8>,String>{
        crate::render_cancellation::checkpoint()?;
        let fields:serde_json::Value=serde_json::from_str(options).map_err(|e|e.to_string())?;
        let object=fields.as_object().ok_or("Render options must be an object")?;
        let semantic=object.iter().filter(|(key,_)|key.as_str()!="frameResources").collect::<BTreeMap<_,_>>();
        let request_key=if !self.frame_scene.scope.is_empty()&&fields.get("animation").is_none_or(serde_json::Value::is_null){
            let key=serde_json::to_string(&semantic).map_err(|e|e.to_string())?;
            (key.len()<=65536).then_some(key)
        }else{None};
        if let (Some(revision),Some(key))=(self.static_scene_revision(),request_key.as_ref()) {
            if let Some(bytes)=self.frame_scene.reuse(&(revision,key.clone()),&fields)?{return Ok(bytes)}
        }
        // Only the most recent successful exact request can short-circuit.
        // A different camera, invalidation or failure cannot revive an old
        // frame sequence, and no ACK dictionary participates in compilation.
        self.frame_scene.cached=None;
        self.frame_scene.compilations+=1;
        let compiler_fields=serde_json::Value::Object(semantic.into_iter().map(|(key,value)|(key.clone(),value.clone())).collect());
        let scene=self.compile_gpu_request_value(compiler_fields)?;
        accept(&scene)?;
        if self.frame_scene.scope.is_empty() { return scene.into_packet(); }
        self.frame_scene.pending_request=request_key.and_then(|key|self.static_scene_revision().map(|revision|(revision,key)));
        let result=self.frame_scene.encode(scene,Some(&fields),self.geo_revision);
        self.reserve_render_cache_bytes();result
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
    #[test]
    fn source_demand_recovers_after_full_overview_fills_transfer_cache() {
        let document:crate::scene::Document=serde_json::from_value(json!({"schemaVersion":20,"id":"source","name":"source",
            "pages":[{"id":"page","name":"page","background":"#ffffff","children":["stage"]}],"nodes":{
            "stage":{"id":"stage","kind":"frame","width":3000,"height":2000,"blend":"pass-through","children":["a","b"]},
            "a":{"id":"a","kind":"rectangle","width":100,"height":100,"transform":[1,0,0,1,500,500],"fills":[{"kind":"solid","color":"#ff0000"}]},
            "b":{"id":"b","kind":"rectangle","width":100,"height":100,"transform":[1,0,0,1,1500,500],"fills":[{"kind":"solid","color":"#0000ff"}]}
        }})).unwrap();
        let descriptor=crate::scene_store::Descriptor{generation:"source:1:0".into(),document_id:"source".into(),nodes:3,bytes:1,footer_hash:[0;32]};
        crate::capacity::with_source_storage_scope(true,||{
            let mut engine=crate::Engine::new();engine.load_source_document(document).unwrap();engine.bind_frame_scene_scope("overview-return").unwrap();
            let mut runtime=crate::source_compile::Runtime::default();
            let overview=json!({"pageId":"page","width":512,"height":512,"view":{"x":0,"y":0,"zoom":0.1},"rasterProfile":"figmaSubpixel","gpuViewport":{"x":0,"y":0,"w":512,"h":512}});
            runtime.compile(&mut engine,&descriptor,"stage","page",&overview.to_string()).unwrap();
            assert_eq!(runtime.stats["mode"],"complete");
            // A genuine retained transfer models the >64 MiB overview observed
            // in topology. It must not permanently disable local compilation.
            engine.frame_scene.intern(1,vec![7;65*1024*1024]).unwrap();
            assert!(engine.frame_scene.bytes()>64*1024*1024);
            let next=engine.frame_scene.next;
            let local=json!({"pageId":"page","width":64,"height":64,"view":{"x":-480,"y":-480,"zoom":1},"rasterProfile":"figmaSubpixel","gpuViewport":{"x":0,"y":0,"w":64,"h":64}});
            runtime.compile(&mut engine,&descriptor,"stage","page",&local.to_string()).unwrap();
            assert_eq!(runtime.stats["mode"],"demand","{}",runtime.stats);
            assert_eq!(runtime.stats["resolvedCompileNodes"],2);
            assert_eq!(engine.frame_scene.scope,"overview-return");
            assert!(engine.frame_scene.next>next,"eviction must not reuse wire IDs");
            assert!(engine.frame_scene.bytes()+runtime.stats["contextMarginBytes"].as_u64().unwrap() as usize<=64*1024*1024);
            runtime.compile(&mut engine,&descriptor,"stage","page",&local.to_string()).unwrap();
            assert_eq!(runtime.stats["projectionRebuilds"],1);
            assert_eq!(runtime.stats["projectionReuses"],1);
        });
    }
    #[test] fn identical_static_request_returns_before_scene_compilation(){
        let (mut engine,options)=fixture();engine.bind_frame_scene_scope("static-owner").unwrap();
        let first=engine.compile_gpu_packet_request(&options).unwrap();
        let before=engine.gpu_compile_cache_stats();
        let second=engine.compile_gpu_packet_request(&options).unwrap();
        let after=engine.gpu_compile_cache_stats();
        assert_eq!(first,second);
        assert_eq!(after["frameScene"]["compilations"],json!(1));
        assert_eq!(after["frameScene"]["sameRequestHits"],json!(1));
        assert_eq!(before["hits"],after["hits"]);assert_eq!(before["prepareReuses"],after["prepareReuses"]);
        assert!(engine.frame_scene.bytes()<=engine.frame_scene.limit());
    }
    #[test] fn static_cache_retargets_acks_and_retransmits_all_resources_for_a_new_receiver(){
        let (mut engine,options)=fixture();engine.bind_frame_scene_scope("ack-owner").unwrap();
        let first=engine.compile_gpu_packet_request(&options).unwrap();
        let mut request:serde_json::Value=serde_json::from_str(&options).unwrap();
        request["frameResources"]=json!({"scope":"ack-owner","ranges":[[1,u32::MAX]]});
        let second=engine.compile_gpu_packet_request(&request.to_string()).unwrap();
        assert_eq!(u32::from_le_bytes(second[20..24].try_into().unwrap()),0);
        let payload=u32::from_le_bytes(first[20..24].try_into().unwrap())as usize;assert!(payload>0);
        let mut prefix=first[..first.len()-payload].to_vec();prefix[20..24].fill(0);assert_eq!(second,prefix);
        request["frameResources"]=json!({"scope":"fresh-receiver","ranges":"not consulted"});
        assert_eq!(engine.compile_gpu_packet_request(&request.to_string()).unwrap(),first);
        assert_eq!(engine.frame_scene.compilations,1);assert_eq!(engine.frame_scene.reuses,2);
        request["frameResources"]=json!({"scope":"ack-owner","ranges":[[2,1]]});
        assert!(engine.compile_gpu_packet_request(&request.to_string()).is_err());
        assert_eq!(engine.frame_scene.reuses,2);
    }
    #[test] fn runtime_policy_camera_and_document_changes_revoke_the_static_compile_shortcut(){
        let (mut engine,options)=fixture();engine.bind_frame_scene_scope("invalidation").unwrap();
        engine.compile_gpu_packet_request(&options).unwrap();engine.compile_gpu_packet_request(&options).unwrap();
        engine.set_text_quantization(!engine.fonts.glyph_origin_quantization());
        engine.compile_gpu_packet_request(&options).unwrap();assert_eq!(engine.frame_scene.compilations,2);
        engine.set_image_mips(!engine.image_mips());
        engine.compile_gpu_packet_request(&options).unwrap();assert_eq!(engine.frame_scene.compilations,3);
        let mut camera:serde_json::Value=serde_json::from_str(&options).unwrap();camera["view"]["x"]=json!(0.25);
        engine.compile_gpu_packet_request(&camera.to_string()).unwrap();assert_eq!(engine.frame_scene.compilations,4);
        // Returning to an older request cannot publish a prior frame sequence.
        engine.compile_gpu_packet_request(&options).unwrap();assert_eq!(engine.frame_scene.compilations,5);
        engine.load_document(&json!({"schemaVersion":1,"id":"changed","name":"changed","pages":[{"id":"p","name":"p","background":"#123456","children":[]}],"nodes":{}}).to_string()).unwrap();
        engine.compile_gpu_packet_request(&options).unwrap();assert_eq!(engine.frame_scene.compilations,6);
    }
    #[test] fn an_insufficient_host_allowance_disables_retention_without_rejecting_the_scene(){
        let (mut engine,options)=fixture();engine.bind_frame_scene_scope("small-host").unwrap();engine.frame_scene.limit_override=Some(256);
        assert!(engine.compile_gpu_packet_request(&options).is_ok());assert!(engine.frame_scene.cached.is_none());
        assert!(engine.compile_gpu_packet_request(&options).is_ok());assert_eq!(engine.frame_scene.compilations,2);
        assert!(engine.frame_scene.bytes()<=256);
    }
    #[test] fn compiled_node_identity_includes_actual_program_words_not_just_addresses_or_hashes(){
        let (mut engine,options)=fixture();let mut context=FrameSceneContext::default();context.bind("producer");
        let first=engine.compile_gpu_request(&options).unwrap();
        let mut changed=engine.compile_gpu_request(&options).unwrap();
        let path=&changed.nodes["r"].fill;
        if let Some(index)=path.area.as_ref().map(|a|a.first as usize*4).or_else(||path.analytic.as_ref().map(|a|a.first as usize*4)) {
            changed.curves[index]=f32::from_bits(changed.curves[index].to_bits()^1);
        }else{let index=path.first as usize*2;changed.vertices[index]=f32::from_bits(changed.vertices[index].to_bits()^1);}
        context.encode(first,None,0).unwrap();assert_eq!(context.entries.keys().filter(|k|k.kind==2).count(),1);
        context.encode(changed,None,0).unwrap();assert_eq!(context.entries.keys().filter(|k|k.kind==2).count(),2);
    }
    #[test] fn revisions_keep_the_producer_and_new_engines_never_reuse_its_scope(){
        let receipt=|nonce:&str|json!({"sessionGeneration":"session","canvasOwner":"canvas","documentIncarnation":"document","lane":"canvas","nonce":nonce}).to_string();
        let mut context=FrameSceneContext::default();context.bind(&receipt("1"));let original=context.scope.clone();
        let first=context.intern(1,b"image".to_vec()).unwrap().0;
        context.bind(&receipt("2"));assert_eq!(context.scope,original);assert_eq!(context.intern(1,b"image".to_vec()).unwrap().0,first);
        let mut replacement=FrameSceneContext::default();replacement.bind(&receipt("2"));assert_ne!(replacement.scope,original);
    }
    #[test] fn semantic_identity_survives_transfer_eviction_but_not_changed_program_words(){
        let (mut engine,options)=fixture();
        let mut context=FrameSceneContext::default();context.bind("semantic-owner");
        context.limit_override=Some(64*1024);
        context.encode(engine.compile_gpu_request(&options).unwrap(),None,0).unwrap();
        let original=context.semantics["r"].id;
        let transport=context.entries.values().map(|e|e.id).collect::<HashSet<_>>();
        for i in 0..20 {context.intern(1,vec![i;8192]).unwrap();assert!(context.bytes()<=context.limit());}
        assert!(context.entries.values().all(|e|!transport.contains(&e.id)));
        context.encode(engine.compile_gpu_request(&options).unwrap(),None,0).unwrap();
        assert_eq!(context.semantics["r"].id,original);
        let mut changed=engine.compile_gpu_request(&options).unwrap();
        let path=&changed.nodes["r"].fill;
        if let Some(area)=&path.area {let i=area.first as usize*4;changed.curves[i]=f32::from_bits(changed.curves[i].to_bits()^1);}
        else {let i=path.first as usize*2;changed.vertices[i]=f32::from_bits(changed.vertices[i].to_bits()^1);}
        context.encode(changed,None,0).unwrap();
        assert_ne!(context.semantics["r"].id,original);
        assert!(context.bytes()<=context.limit());
    }
    #[test] fn cancelled_compilation_never_publishes_a_partial_packet_and_next_compile_recovers(){
        use std::{cell::Cell,rc::Rc};
        for stop in [0,1,3,5,8] {
            let (mut engine,options)=fixture();engine.bind_frame_scene_scope("cancelled-owner").unwrap();
            let calls=Rc::new(Cell::new(0));let counter=calls.clone();
            let result=crate::render_cancellation::with_probe(move || {let n=counter.get();counter.set(n+1);n>=stop},
                || engine.compile_gpu_packet_request(&options));
            if calls.get()>stop {assert_eq!(result.unwrap_err(),"PREVIEW_CANCELLED");}
            let recovered=engine.compile_gpu_packet_request(&options).unwrap();
            let (mut fresh,_)=fixture();fresh.bind_frame_scene_scope("fresh-owner").unwrap();
            let expected=fresh.compile_gpu_packet_request(&options).unwrap();
            // Private transport/source IDs differ, geometry remains exact.
            let geometry=|bytes:Vec<u8>|{let word=|at|u32::from_le_bytes(bytes[at..at+4].try_into().unwrap())as usize;
                let start=(24+word(8)+3)&!3;bytes[start..start+(word(12)+word(16))*4].to_vec()};
            assert_eq!(geometry(recovered),geometry(expected));
        }
    }
    #[test] fn image_semantics_survive_transport_eviction_without_embedding_uri_in_every_node_proof(){
        let (mut engine,options)=fixture();let mut context=FrameSceneContext::default();context.bind("image-semantic");
        let uri="x".repeat(16384);
        let scene=|engine:&mut crate::Engine|{let mut scene=engine.compile_gpu_request(&options).unwrap();
            scene.nodes.get_mut("r").unwrap().fills[0].paint.image=Some(uri.clone().into());scene};
        context.encode(scene(&mut engine),None,0).unwrap();
        let id=context.semantics["r"].id;
        assert!(context.semantics["r"].key.len()<uri.len());
        context.entries.clear();context.ages.clear();context.bytes=0;
        context.encode(scene(&mut engine),None,0).unwrap();
        assert_eq!(context.semantics["r"].id,id);assert_eq!(context.image_semantics.len(),1);
        context.encode(engine.compile_gpu_request(&options).unwrap(),None,0).unwrap();
        assert!(context.image_semantics.is_empty());assert!(context.bytes()<=context.limit());
    }
    #[test] fn immutable_image_owners_skip_rescans_but_transfer_eviction_revokes_the_shortcut(){
        let mut context=FrameSceneContext::default();context.bind("owned-image");context.limit_override=Some(64*1024);
        let uri:Arc<str>="x".repeat(8192).into();
        let (source,retained)=context.image_identity(&uri).unwrap();assert!(retained);
        let (transport,data)=context.intern_image(source,&uri,retained).unwrap();
        assert_eq!(context.image_identity(&uri).unwrap().0,source);
        let (again,shared)=context.intern_image(source,&uri,true).unwrap();
        assert_eq!(transport,again);assert!(Arc::ptr_eq(&data,&shared));
        assert_eq!(context.image_allocation_hits,1);assert_eq!(context.image_transfer_hits,1);
        // Equal content in an unowned allocation must not gain a pointer hint.
        let mut other:Arc<str>="x".repeat(8192).into();
        assert_eq!(context.image_identity(&other).unwrap().0,source);
        assert_eq!(context.image_allocations.len(),1);
        Arc::get_mut(&mut other).unwrap().make_ascii_uppercase();
        assert_ne!(context.image_identity(&other).unwrap().0,source);
        for i in 0..20{context.intern(2,vec![i;8192]).unwrap();assert!(context.bytes()<=context.limit());}
        assert!(!context.image_transfer_keys.contains_key(&source));
        let (next,restored)=context.intern_image(source,&uri,true).unwrap();
        assert_ne!(next,transport);assert_eq!(&*restored,&*data);
        context.bind("replacement-owner");assert!(context.image_allocations.is_empty());assert!(context.image_transfer_keys.is_empty());
    }
    #[test] fn resources_are_bounded_without_turning_a_large_resource_into_document_rejection(){
        let mut context=FrameSceneContext::default();context.bind("bounded");
        let limit=4*1024*1024;context.limit_override=Some(limit);
        let (id,_)=context.intern(1,vec![0;limit+1]).unwrap();assert!(id>0);assert_eq!(context.bytes,0);
        for i in 0..8 {context.intern(1,vec![i;1024*1024]).unwrap();assert!(context.bytes()<=limit);}
        assert!(context.entries.len()<40);
    }
    #[test] fn host_memory_policy_replaces_the_fixed_32_mib_resource_ceiling(){
        let mut context=FrameSceneContext::default();context.bind("host-capacity");
        assert_eq!(context.limit(),crate::capacity::memory_budget_bytes().min(usize::MAX as u64) as usize);
        assert!(context.limit()>33*1024*1024+256);
        let (id,data)=context.intern(1,vec![7;33*1024*1024]).unwrap();
        assert!(context.entries.values().any(|entry|entry.id==id));
        assert_eq!(context.bytes(),data.len()+256);assert!(context.bytes()<=context.limit());
    }
}

#[cfg(test)]mod cached_digest_tests{
    use super::*;
    #[derive(Default)]struct CountHasher(usize);
    impl Hasher for CountHasher{fn finish(&self)->u64{0}fn write(&mut self,bytes:&[u8]){self.0+=bytes.len();}}
    #[test]fn rehashing_is_fixed_size_and_colliding_digests_cannot_authorize_different_resource_bytes(){
        let key=|kind,data:Vec<u8>|Key{kind,digest:7,data:data.into()};
        let small=key(5,vec![0]);let large=key(5,vec![0;1024*1024]);
        let mut a=CountHasher::default();let mut b=CountHasher::default();small.hash(&mut a);large.hash(&mut b);
        assert_eq!(a.0,9);assert_eq!(b.0,9);
        let mut entries=HashMap::new();entries.insert(small,1);entries.insert(large.clone(),2);
        entries.insert(key(5,vec![1;1024*1024]),3);entries.insert(key(6,vec![0;1024*1024]),4);
        assert_eq!(entries.len(),4);assert_eq!(entries.get(&key(5,vec![0;1024*1024])),Some(&2));
        assert_eq!(entries.get(&large),Some(&2));
    }
    #[test]fn hits_and_eviction_keep_exact_resource_identity_under_the_configured_memory_limit(){
        let mut frame=FrameSceneContext::default();frame.bind("cache-proof");
        let limit=4*1024*1024;frame.limit_override=Some(limit);
        let original=frame.intern(5,vec![0;1024*1024]).unwrap().0;
        assert_eq!(frame.intern(5,vec![0;1024*1024]).unwrap().0,original);
        assert_ne!(frame.intern(6,vec![0;1024*1024]).unwrap().0,original);
        for i in 1..8{frame.intern(5,vec![i;1024*1024]).unwrap();assert!(frame.bytes()<=limit);}
        assert_ne!(frame.intern(5,vec![0;1024*1024]).unwrap().0,original);
    }
}
