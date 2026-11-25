//! Frame-scoped immutable resources and exact binary scene transport.
//! Old FGPK JSON/image-table variants are replaced by one FGSC protocol.
//! Pose requests may wrap that packet in an FGSZ LZ4 envelope. The decoded
//! scene stays the FGSC payload; compression never changes geometry.
use super::{frame_wire, GpuPath, GpuScene, Paint};
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
    Ok((revision, packet_request_key(&semantic, fields)?))
}
fn packet_request_key(
    fields: &BTreeMap<&String, &serde_json::Value>,
    request: &serde_json::Value,
) -> Result<String, String> {
    // The receiver must advertise the layout of any cached packet again.
    // Acknowledgement ranges themselves never enter an identity or key.
    serde_json::to_string(&(curve_programs_requested(Some(request)), fields)).map_err(|e| e.to_string())
}
fn curve_programs_requested(request: Option<&serde_json::Value>) -> bool {
    request.and_then(|value| value.get("frameResources"))
        .and_then(|value| value.get("curvePrograms"))
        .and_then(serde_json::Value::as_bool) == Some(true)
}

const CURVE_RESOURCE: u8 = 4;
const MAX_CURVE_WORDS: usize = 8_000_000;
const MAX_CURVE_SPANS: usize = 8192;
const CURVE_CHUNK_WORDS: usize = 8192;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CurveResources {
    words: usize,
    ids: Vec<u32>,
}

fn curve_range(path: &GpuPath) -> Option<Option<(usize, usize)>> {
    let (first, count, stride) = if let Some(area) = &path.area {
        (area.first, area.count, 4)
    } else if let Some(analytic) = &path.analytic {
        (analytic.first, analytic.count, 16)
    } else {
        return Some(None);
    };
    if count == 0 { return Some(None); }
    let start = (first as usize).checked_mul(4)?;
    let len = (count as usize).checked_mul(stride)?;
    Some(Some((start, start.checked_add(len)?)))
}

/// Preserve program boundaries when preceding programs grow or disappear.
/// Gaps and overlapping references still encode every arena word exactly once.
fn curve_spans(scene: &GpuScene) -> Option<Vec<std::ops::Range<usize>>> {
    let words = scene.curves.len();
    if !(16_384..=MAX_CURVE_WORDS).contains(&words) { return None; }
    let mut edges = vec![0, words];
    for node in scene.nodes.values() {
        let paths = std::iter::once(&node.fill)
            .chain(node.strokes.iter().map(|stroke| &stroke.path))
            .chain(node.source_filter_field.iter().flat_map(|field| field.channels().map(|mesh| &mesh.path)));
        for path in paths {
            if let Some((start, end)) = curve_range(path)? {
                if end > words || edges.len() >= MAX_CURVE_SPANS * 2 { return None; }
                edges.extend([start, end]);
            }
        }
    }
    edges.sort_unstable();
    edges.dedup();
    let mut spans = Vec::with_capacity(edges.len());
    for pair in edges.windows(2) {
        for start in (pair[0]..pair[1]).step_by(CURVE_CHUNK_WORDS) {
            if spans.len() == MAX_CURVE_SPANS { return None; }
            spans.push(start..(start + CURVE_CHUNK_WORDS).min(pair[1]));
        }
    }
    Some(spans)
}
struct EncodedFrame {
    key:StaticRequest,
    prefix:Vec<u8>,
    resources:Vec<(u32,u8,Arc<[u8]>)>,
    resource_bounds: Option<(u32, u32)>,
    resource_wire_bytes: usize,
    charge:usize,
    sequence_offset:usize,
    sequence:u32,
    nodes:usize,
    authored_nodes:usize,
    resolved_nodes:usize,
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

fn append_geometry(bytes: &mut Vec<u8>, words: &[f32]) {
    #[cfg(target_endian = "little")]
    bytes.extend_from_slice(bytemuck::cast_slice(words));
    #[cfg(target_endian = "big")]
    for word in words { bytes.extend_from_slice(&word.to_le_bytes()); }
}

fn curve_span(path: &GpuPath) -> Option<(usize, usize)> {
    if let Some(area) = &path.area {
        Some((area.first as usize * 4, area.count as usize * 4))
    } else {
        path.analytic.as_ref().map(|analytic| (analytic.first as usize * 4, analytic.count as usize * 16))
    }
}

fn path_meshes(node: &super::GpuNode) -> impl Iterator<Item = &GpuPath> {
    std::iter::once(&node.fill).chain(node.strokes.iter().map(|stroke| &stroke.path))
        .chain(node.source_filter_field.iter().flat_map(|field| field.channels().map(|mesh| &mesh.path)))
}

/// Only a complete partition can replace the packed curve buffer. Program
/// boundaries remain stable when a preceding rotated path changes length.
fn curve_partition(scene: &GpuScene) -> Option<Vec<(usize, usize)>> {
    if scene.curves.is_empty() { return None; }
    let mut spans: Vec<_> = scene.nodes.values().flat_map(path_meshes)
        .filter_map(curve_span).filter(|&(_, count)| count != 0).collect();
    spans.sort_unstable();
    spans.dedup();
    let mut end = 0;
    for &(first, count) in &spans {
        if first != end { return None; }
        end = first.checked_add(count)?;
    }
    (end == scene.curves.len()).then_some(spans)
}

fn curve_resources_requested(request: Option<&serde_json::Value>) -> bool {
    request.and_then(|value| value.get("frameResources"))
        .and_then(|value| value.get("curvePrograms")).and_then(serde_json::Value::as_bool) == Some(true)
}

fn scene_lz4_requested(request: Option<&serde_json::Value>) -> bool {
    request.and_then(|value| value.get("frameResources"))
        .and_then(|value| value.get("sceneLz4")).and_then(serde_json::Value::as_bool) == Some(true)
}

#[cfg(not(target_arch = "wasm32"))]
fn packet_clock() -> Option<std::time::Instant> { Some(std::time::Instant::now()) }
#[cfg(target_arch = "wasm32")]
fn packet_clock() -> Option<std::time::Instant> { None }
fn packet_millis(start: Option<std::time::Instant>) -> f64 {
    start.map(|start| start.elapsed().as_secs_f64() * 1000.).unwrap_or(0.)
}

struct FgscInfo { geometry_bytes: usize, inline_curve_bytes: usize, curve_sent_bytes: usize }

fn inspect_fgsc(packet: &[u8]) -> Option<FgscInfo> {
    if packet.len() < 24 || &packet[..4] != b"FGSC" { return None }
    let meta = u32::from_le_bytes(packet[8..12].try_into().ok()?) as usize;
    let nv = u32::from_le_bytes(packet[12..16].try_into().ok()?) as usize;
    let nc = u32::from_le_bytes(packet[16..20].try_into().ok()?) as usize;
    let payload = u32::from_le_bytes(packet[20..24].try_into().ok()?) as usize;
    let start = 24usize.checked_add(meta)?.checked_add(3)? & !3;
    let inline = nc.checked_mul(4)?;
    let geometry = nv.checked_mul(4)?.checked_add(inline)?;
    let mut at = start.checked_add(geometry)?;
    if at.checked_add(payload)? != packet.len() { return None }
    let mut curve_sent = 0usize;
    while at < packet.len() {
        if packet.len() - at < 9 { return None }
        let kind = packet[at + 4];
        let len = u32::from_le_bytes(packet[at + 5..at + 9].try_into().ok()?) as usize;
        at = at.checked_add(9)?.checked_add(len)?;
        if at > packet.len() { return None }
        if kind == 4 { curve_sent = curve_sent.saturating_add(len); }
    }
    (at == packet.len()).then_some(FgscInfo { geometry_bytes: geometry, inline_curve_bytes: inline, curve_sent_bytes: curve_sent })
}

/// Lossless envelope around one FGSC packet. Kept only when the wire shrinks.
/// The 8-byte header is `FGSZ`, little-endian version 1, then lz4_flex's
/// size-prepended block. Callers that do not ask, and packets that do not
/// shrink, stay plain FGSC.
fn compress_scene_packet(packet: Vec<u8>) -> Result<Vec<u8>, String> {
    const LIMIT: usize = 128 * 1024 * 1024;
    if packet.len() < 64 || packet.len() > LIMIT || !packet.starts_with(b"FGSC") { return Ok(packet) }
    crate::render_cancellation::checkpoint()?;
    let compressed = lz4_flex::compress_prepend_size(&packet);
    if compressed.len().saturating_add(8) >= packet.len() { return Ok(packet) }
    let mut out = Vec::with_capacity(8 + compressed.len());
    out.extend_from_slice(b"FGSZ");
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&compressed);
    crate::render_cancellation::checkpoint()?;
    Ok(out)
}

fn append_resource(bytes: &mut Vec<u8>, id: u32, kind: u8, data: &[u8]) -> Result<(), String> {
    let length = u32::try_from(data.len()).map_err(|_| "Frame resource too large")?;
    bytes.extend_from_slice(&id.to_le_bytes());
    bytes.push(kind);
    bytes.extend_from_slice(&length.to_le_bytes());
    bytes.extend_from_slice(data);
    Ok(())
}
impl EncodedFrame {
    fn emit(&self,ranges:&[(u32,u32)])->Result<Vec<u8>,String>{
        crate::render_cancellation::checkpoint()?;
        // A cached prefix always has a zero payload header. One covering ACK
        // range certifies every entry, even when its IDs were minted out of order.
        if self.resource_bounds.is_none_or(|(lo, hi)| {
            let at = ranges.partition_point(|&(start, _)| start <= lo);
            at > 0 && hi <= ranges[at - 1].1
        }) {
            let bytes = self.prefix.clone();
            crate::render_cancellation::checkpoint()?;
            return Ok(bytes);
        }
        let mut payload_len = self.resource_wire_bytes;
        if !ranges.is_empty() {
            for (id, _, data) in &self.resources {
                crate::render_cancellation::checkpoint()?;
                if known(ranges, *id) { payload_len -= 9 + data.len(); }
            }
        }
        let payload = u32::try_from(payload_len).map_err(|_| "GPU frame too large")?;
        let mut bytes = Vec::with_capacity(self.prefix.len().checked_add(payload_len).ok_or("GPU frame too large")?);
        bytes.extend_from_slice(&self.prefix);
        bytes[20..24].copy_from_slice(&payload.to_le_bytes());
        if payload != 0 {
            for (id,kind,data) in &self.resources {
                crate::render_cancellation::checkpoint()?;
                if known(ranges,*id){continue}
                append_resource(&mut bytes, *id, *kind, data)?;
            }
        }
        crate::render_cancellation::checkpoint()?;
        Ok(bytes)
    }
}
#[derive(Default)]
pub(crate) struct FrameSceneContext {
    scope:String, binding:String, entries:HashMap<Key,Entry>, ages:BTreeMap<u64,Key>, bytes:usize,
    // Only transferable resources occupy the receiver's acknowledgement
    // ranges. Node/image comparison IDs live in their own scope-local space.
    next:u32, next_semantic:u32, clock:u64, frame:u32, frame_key:Option<String>,
    resource_hasher:RandomState,
    semantics:HashMap<String,SemanticEntry>,image_semantics:HashMap<Arc<str>,u32>,semantic_bytes:usize,semantic_hits:u64,
    // Numeric addresses are private lookup hints backed by the strong Arc key
    // in image_semantics. They are never dereferenced or accepted from callers.
    image_allocations:HashMap<usize,u32>,image_transfer_keys:HashMap<u32,Key>,image_transfer_sources:HashMap<u32,u32>,
curve_transfer_keys: HashMap<u32, Key>,
    clipped_pose_transport: bool,
    image_allocation_hits:u64,image_transfer_hits:u64,
    cached:Option<EncodedFrame>,pending_request:Option<StaticRequest>,compilations:u64,reuses:u64,
    retention_limit:Option<usize>,
    // Native source revisits share the existing retention allowance. Entries
    // contain no document or GPU owner, only validated immutable wire data.
    source_history:std::collections::VecDeque<EncodedFrame>,
    source_history_bytes:usize,
    source_history_hits:u64,
    // Logical curve bytes of the scene that filled the static cache. Inline
    // poses leave this in place so a later drag can still account for blocks
    // the receiver has already confirmed.
    curve_word_bytes: usize,
    packet_compile_ms: f64,
    packet_encode_ms: f64,
    packet_scene_bytes: u64,
    packet_wire_bytes: u64,
    packet_geometry_bytes: u64,
    packet_wire_geometry_bytes: u64,
    packet_inline_curve_bytes: u64,
    packet_curve_sent_bytes: u64,
    packet_curve_omitted_bytes: u64,
    #[cfg(test)] limit_override:Option<usize>,
}
impl FrameSceneContext {
    pub(crate) fn clipped_pose_transport(&self) -> bool { self.clipped_pose_transport }
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
    pub(crate) fn reuse_source(&mut self,revision:(u64,bool,bool),request:&str)->Result<Option<(Vec<u8>,usize,usize,usize)>,String>{
        crate::render_cancellation::checkpoint()?;
        if self.source_history.is_empty() { return Ok(None); }
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
        let bytes = frame.emit(&ranges)?;
        let (compiled, authored, resolved) = (frame.nodes, frame.authored_nodes, frame.resolved_nodes);
        let frame=self.source_history.remove(index).unwrap();self.source_history.push_back(frame);
        self.source_history_hits+=1;Ok(Some((bytes,compiled,authored,resolved)))
    }
    pub(crate) fn cached_scene_nodes(&self) -> Option<usize> {
        self.cached.as_ref().map(|frame| frame.nodes)
    }
    pub(crate) fn retain_source(&mut self,revision:(u64,bool,bool),authored_nodes:usize,resolved_nodes:usize){
        let Some(mut frame)=self.cached.take()else{return};
        frame.authored_nodes=authored_nodes;
        frame.resolved_nodes=resolved_nodes;
        // replace the projection-local epoch with the complete source lineage;
        // this method is called only after demand closure and successful encode.
        frame.key.0=revision;
        if frame.charge>self.limit(){return}
        while self.source_history.len()>=32 || self.bytes().saturating_add(frame.charge)>self.limit(){
            if self.source_history.is_empty(){return}self.evict_source_frame();
        }
        self.source_history_bytes+=frame.charge;self.source_history.push_back(frame);
    }
    pub(crate) fn stats(&self)->serde_json::Value{
        serde_json::json!({"compilations":self.compilations,"sameRequestHits":self.reuses,"semanticHits":self.semantic_hits,"semanticBytes":self.semantic_bytes,"bytes":self.bytes(),"limit":self.limit(),"limitSource":"trusted-host-memory",
            "imageAllocationHits":self.image_allocation_hits,"imageTransferHits":self.image_transfer_hits,
            "sourceReplayHits":self.source_history_hits,"sourceReplayEntries":self.source_history.len(),"sourceReplayBytes":self.source_history_bytes,
            "packet":{"compileMs":self.packet_compile_ms,"encodeMs":self.packet_encode_ms,"sceneBytes":self.packet_scene_bytes,"wireBytes":self.packet_wire_bytes,
                "geometryBytes":self.packet_geometry_bytes,"wireGeometryBytes":self.packet_wire_geometry_bytes,"inlineCurveBytes":self.packet_inline_curve_bytes,
                "curveSentBytes":self.packet_curve_sent_bytes,"curveOmittedBytes":self.packet_curve_omitted_bytes}})
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
    fn reuse_transfer(&mut self, key: &Key) -> Result<Option<(u32, Arc<[u8]>)>, String> {
        let Some(entry) = self.entries.get_mut(key) else { return Ok(None); };
        self.clock = self.clock.checked_add(1).ok_or("Frame resource clock exhausted")?;
        self.ages.remove(&entry.age);
        entry.age = self.clock;
        self.ages.insert(self.clock, key.clone());
        Ok(Some((entry.id, key.data.clone())))
    }
    fn intern_curve(&mut self, words: &[f32], previous_id: Option<u32>) -> Result<(u32, Arc<[u8]>), String> {
        // The previous slot suggests an existing allocation. Match every
        // original f32 byte before reusing its immutable wire identity.
        #[cfg(target_endian = "little")]
        {
            let bytes: &[u8] = bytemuck::cast_slice(words);
            if let Some(key) = previous_id.and_then(|id| self.curve_transfer_keys.get(&id)).filter(|key| &*key.data == bytes).cloned() &&
                let Some(entry) = self.reuse_transfer(&key)? {
                return Ok(entry);
            }
        }
        #[cfg(target_endian = "big")]
        let _ = previous_id;
        let mut data = Vec::with_capacity(words.len() * 4);
        append_geometry(&mut data, words);
        self.intern(4, data)
    }
    fn intern(&mut self,kind:u8,data:Vec<u8>)->Result<(u32,Arc<[u8]>),String>{
        // Unbound or oversized values cannot be cache hits or insertions.
        // They retain the original uncached path without scanning their bytes
        // solely to construct an index which will not be used.
        let digest=if !self.scope.is_empty()&&data.len()<=self.limit().saturating_sub(256){
            self.resource_hasher.hash_one((kind,data.as_slice()))
        }else{0};
        let data:Arc<[u8]>=data.into();let key=Key{kind,digest,data:data.clone()};
        if let Some(original)=self.entries.get_key_value(&key).map(|(key,_)|key.clone()){
            if let Some(found)=self.reuse_transfer(&original)? { return Ok(found); }
        }
        self.clock=self.clock.checked_add(1).ok_or("Frame resource clock exhausted")?;
        self.next=self.next.checked_add(1).ok_or("Frame resource ID exhausted")?;let id=self.next;
        let bytes=data.len().checked_add(256).ok_or("Frame resource size overflow")?;
        let limit=self.limit().saturating_sub(self.source_history_bytes).saturating_sub(self.semantic_bytes).saturating_sub(self.cached.as_ref().map_or(0,|frame|frame.charge));
        if !self.scope.is_empty()&&bytes<=limit{
            while self.bytes+bytes>limit {let Some((_,old))=self.ages.pop_first()else{break};self.evict_transfer(&old);}
if kind == CURVE_RESOURCE { self.curve_transfer_keys.insert(id, key.clone()); }
            self.entries.insert(key.clone(),Entry{id,age:self.clock,bytes});self.ages.insert(self.clock,key);self.bytes+=bytes;
        }
        Ok((id,data))
    }
    fn evict_transfer(&mut self,key:&Key){
        if let Some(entry)=self.entries.remove(key){
            self.bytes-=entry.bytes;
if key.kind == CURVE_RESOURCE { self.curve_transfer_keys.remove(&entry.id); }
            if let Some(source)=self.image_transfer_sources.remove(&entry.id){self.image_transfer_keys.remove(&source);}
        }
    }
    fn image_identity(&mut self,uri:&Arc<str>)->Result<(u32,bool),String>{
        let address=Arc::as_ptr(uri) as *const u8 as usize;
        if let Some(id)=self.image_allocations.get(&address){self.image_allocation_hits+=1;return Ok((*id,true))}
        if let Some(id)=self.image_semantics.get(uri){return Ok((*id,true))}
        self.next_semantic=self.next_semantic.checked_add(1).ok_or("Frame semantic ID exhausted")?;
        let id=self.next_semantic;let charge=uri.len().saturating_add(256);
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
        self.next_semantic=self.next_semantic.checked_add(1).ok_or("Frame semantic ID exhausted")?;
        let id=self.next_semantic;
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
    fn encode(&mut self,scene:GpuScene,request:Option<&serde_json::Value>,revision:u64)->Result<Vec<u8>,String>{
        self.encode_with_curves(scene, request, revision, &[])
    }
    fn encode_with_curves(&mut self,mut scene:GpuScene,request:Option<&serde_json::Value>,revision:u64,
        previous_curves:&[u32])->Result<Vec<u8>,String>{
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
        let mut pending_resources=Vec::new();let mut payload_len=0usize;let mut included=HashSet::new();
        let mut record=|id:u32,kind:u8,data:&Arc<[u8]>|->Result<(),String>{
            if !included.insert(id){return Ok(())}
            if cache_key.is_some(){
                resource_charge=resource_charge.saturating_add(data.len()).saturating_add(256);
                if resource_charge<=cache_limit{resources.push((id,kind,data.clone()))}else{resources.clear();cache_key=None;}
            }
            if known(&ranges,id){return Ok(())}
            payload_len=payload_len.checked_add(9).and_then(|n|n.checked_add(data.len())).ok_or("GPU frame too large")?;
            pending_resources.push((id,kind,Arc::clone(data)));
            Ok(())
        };
        self.semantics.retain(|name,entry|{
            if scene.nodes.contains_key(name){true}else{self.semantic_bytes-=entry.charge;false}
        });
        let plan=scene.scene_plan();
let curve_spans = if !self.scope.is_empty() && curve_resources_requested(request) { curve_partition(&scene) } else { None };
        // Scene drop would see empty buffers after these takes. Recycle the
        // allocations the encoder still owns, including when encoding fails.
        let vertices=super::scratch::RecycledF32::vertices(std::mem::take(&mut scene.vertices));
        let curves=super::scratch::RecycledF32::curves(std::mem::take(&mut scene.curves));
        self.curve_word_bytes = curves.len().saturating_mul(4);
        let mut nodes=std::mem::take(&mut scene.nodes);
        #[derive(Serialize)]
        #[serde(rename_all="camelCase")]
        struct CurveResources { words: usize, ids: Vec<u32> }
        let mut curve_ids = HashMap::new();
        let curve_resources = if let Some(spans) = curve_spans {
            let mut ids = Vec::with_capacity(spans.len());
            for (slot, (first, count)) in spans.into_iter().enumerate() {
                crate::render_cancellation::checkpoint()?;
                let (id, data) = self.intern_curve(&curves[first..first + count], previous_curves.get(slot).copied())?;
                record(id, CURVE_RESOURCE, &data)?;
                ids.push(id);
                curve_ids.insert((first, count), id);
            }
            Some(CurveResources { words: curves.len(), ids })
        } else { None };
        // Encoded replies own their bytes. The producer only needs to retain
        // programs from the current pose for a later acknowledgement. An inline
        // release does not register blocks and must not drop programs the next
        // drag can still reuse.
        if curve_resources.is_some() {
            let active_curves: HashSet<_> = curve_ids.values().copied().collect();
            let obsolete: Vec<_> = self.curve_transfer_keys.iter()
                .filter(|(id, _)| !active_curves.contains(id)).map(|(_, key)| key.clone()).collect();
            for key in obsolete {
                if let Some(entry) = self.entries.get(&key) { self.ages.remove(&entry.age); }
                self.evict_transfer(&key);
            }
        }
        // Admitted image identities already own and compare the complete URI.
        // Only an over-budget image needs a second, packet-local content table.
        let mut unretained_images=HashMap::<Arc<str>,(u32,u32)>::new();
        let mut image_addresses=HashMap::<usize,(u32,u32)>::new();
        let mut image_transports=HashMap::<u32,u32>::new();
        let mut node_resources=Vec::new();
        // A container's identity includes every compiled child, including
        // empty/cull transitions. Its own paint/program equality alone cannot
        // certify a retained subtree after a descendant edit.
        let order=plan.source_order.as_ref().map_err(Clone::clone)?;
        let mut source_ids=BTreeMap::<String,u32>::new();
        let mut wire = frame_wire::Batch::new();
        for name in order { let node=nodes.get_mut(name).unwrap();
            crate::render_cancellation::checkpoint()?;
            // Exact image identity retains each original URI once. Repeated
            // paints never embed another large URI in their semantic proof.
            {
                let mut image=|paint:&mut Paint|->Result<(),String>{
                    if let Some(uri)=paint.image.take(){
                        let address=Arc::as_ptr(&uri) as *const u8 as usize;
                        let local=|| if unretained_images.is_empty(){None}else{unretained_images.get(&uri)};
                        let (source,_)=if let Some(ids)=image_addresses.get(&address).or_else(local){*ids}else{
                            let (source,retained)=self.image_identity(&uri)?;
                            let id=if let Some(id)=image_transports.get(&source){*id}else{
                                let (id,data)=self.intern_image(source,&uri,retained)?;record(id,1,&data)?;
                                image_transports.insert(source,id);id
                            };
                            // Never memoize a bare address for an equal but
                            // separately allocated URI: its last owner can
                            // disappear when this paint is replaced below.
                            if !retained {
                                unretained_images.insert(uri,(source,id));image_addresses.insert(address,(source,id));
                            } else if self.image_allocations.contains_key(&address) {
                                image_addresses.insert(address,(source,id));
                            }
                            (source,id)
                        };paint.image=Some(source.to_string().into());
                    }Ok(())
                };
                for p in &mut node.fills{image(&mut p.paint)?}for s in &mut node.strokes{image(&mut s.paint.paint)?}
                if let Some(replay)=&mut node.texture_replay{image(&mut replay.paint)?}
            }
            let canonical=wire.encode_source(node)?;
            let transport=|paint:&mut Paint|{if let Some(source)=paint.image.as_ref(){
                let source=source.parse::<u32>().expect("private semantic image reference");
                paint.image=Some(image_transports[&source].to_string().into());
            }};
            for p in &mut node.fills{transport(&mut p.paint)}for s in &mut node.strokes{transport(&mut s.paint.paint)}
            if let Some(replay)=&mut node.texture_replay{transport(&mut replay.paint)}
            let mut source_key=Vec::with_capacity(canonical.len()+64);
            source_key.extend(u32::try_from(canonical.len()).map_err(|_|"Source identity too large")?.to_le_bytes());
            source_key.extend(canonical);
            for path in path_meshes(node) {
                let (data,first,count)=if let Some(area)=&path.area{(&curves,area.first as usize*4,area.count as usize*4)}
                    else if let Some(analytic)=&path.analytic{(&curves,analytic.first as usize*4,analytic.count as usize*16)}
                    else{(&vertices,path.first as usize*2,path.count as usize*2)};
                let values=data.get(first..first.checked_add(count).ok_or("Invalid program span")?).ok_or("Invalid program span")?;
                source_key.extend(u32::try_from(count).map_err(|_|"Invalid program span")?.to_le_bytes());
                let retained_id = curve_span(path).and_then(|span| curve_ids.get(&span).copied());
                if let Some(id) = retained_id {
                    // IDs are scope-local and intern against every original
                    // word. An eviction assigns a fresh ID, never a false hit.
                    source_key.push(1);
                    source_key.extend(id.to_le_bytes());
                } else {
                    source_key.push(0);
                    append_geometry(&mut source_key,values);
                }
            }
            let children=node.children.iter().map(|id|(id,source_ids.get(id).copied())).collect::<Vec<_>>();
            source_key.extend(wire.encode(&children)?);
            let source_id=self.source_identity(name,source_key)?;
            source_ids.insert(name.clone(),source_id);
            #[derive(Serialize)]#[serde(rename_all="camelCase")]
            struct NodeResource<'a>{node:&'a super::GpuNode,source_identity:u32}
            let (id,data)=self.intern(2,wire.encode(&NodeResource{node:&node,source_identity:source_id})?)?;
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
struct Metadata<'a>{#[serde(flatten)]scene:&'a GpuScene,resource_scope:&'a str,frame_sequence:frame_wire::FrameSequence,node_resources:Vec<(String,u32)>,scene_plan:u32,
            #[serde(skip_serializing_if="Option::is_none")] curve_resources:Option<&'a CurveResources>}
        let (metadata,sequence_offset)=frame_wire::encode_frame(&Metadata{scene:&scene,resource_scope:&self.scope,frame_sequence:frame_wire::FrameSequence(self.frame),node_resources,scene_plan:plan_id,curve_resources:curve_resources.as_ref()})?;
        let start=24usize.checked_add(metadata.len()).and_then(|n|n.checked_add(3)).map(|n|n&!3).ok_or("GPU frame too large")?;
        let inline_curves = if curve_resources.is_some() { &[][..] } else { curves.as_slice() };
        let total=vertices.len().checked_add(inline_curves.len()).and_then(|n|n.checked_mul(4)).and_then(|n|n.checked_add(start))
            .and_then(|n|n.checked_add(payload_len)).ok_or("GPU frame too large")?;
        let mut bytes=Vec::with_capacity(total);bytes.extend(b"FGSC");
        for value in [1,metadata.len(),vertices.len(),inline_curves.len(),payload_len]{bytes.extend(u32::try_from(value).map_err(|_|"GPU frame too large")?.to_le_bytes());}
        bytes.extend(metadata);bytes.resize(start,0);
        append_geometry(&mut bytes,&vertices);
        append_geometry(&mut bytes,inline_curves);
        let prefix_len = bytes.len();
        for (id, kind, data) in pending_resources {
            crate::render_cancellation::checkpoint()?;
            append_resource(&mut bytes, id, kind, &data)?;
        }
        crate::render_cancellation::checkpoint()?;
                if let Some(key)=cache_key {
            let charge=resource_charge.saturating_add(prefix_len).saturating_add(key.1.capacity()).saturating_add(256);
            if charge.saturating_add(self.semantic_bytes)<=cache_limit {
                while self.source_history_bytes.saturating_add(self.semantic_bytes).saturating_add(charge)>cache_limit && !self.source_history.is_empty(){self.evict_source_frame();}
                while self.bytes+self.semantic_bytes+self.source_history_bytes+charge>cache_limit {let Some((_,old))=self.ages.pop_first()else{break};self.evict_transfer(&old);}
                let mut prefix = bytes[..prefix_len].to_vec();
                prefix[20..24].fill(0);
                let (mut min_id, mut max_id) = (u32::MAX, 0);
                let mut resource_wire_bytes = 0;
                for (id, _, data) in &resources {
                    min_id = min_id.min(*id);
                    max_id = max_id.max(*id);
                    resource_wire_bytes += 9 + data.len();
                }
                let resource_bounds = (!resources.is_empty()).then_some((min_id, max_id));
                self.cached=Some(EncodedFrame{key,prefix,resources,resource_bounds,resource_wire_bytes,charge,sequence_offset:24+sequence_offset,sequence:self.frame,nodes:compiled_nodes,authored_nodes:0,resolved_nodes:0});
            }
        }
        Ok(bytes)
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
    fn deliver_scene_packet(&mut self, fields:&serde_json::Value, raw:Vec<u8>, compile_ms:f64, encode_ms:f64)->Result<Vec<u8>,String>{
        let scene_bytes = raw.len() as u64;
        let info = inspect_fgsc(&raw);
        let compress_started = packet_clock();
        let bytes = if scene_lz4_requested(Some(fields)) { compress_scene_packet(raw)? } else { raw };
        let encode_ms = encode_ms + packet_millis(compress_started);
        let info = info.unwrap_or(FgscInfo { geometry_bytes: 0, inline_curve_bytes: 0, curve_sent_bytes: 0 });
        let logical = if self.frame_scene.curve_word_bytes == 0 { info.inline_curve_bytes } else { self.frame_scene.curve_word_bytes };
        let vertex = info.geometry_bytes.saturating_sub(info.inline_curve_bytes);
        self.frame_scene.packet_compile_ms = compile_ms;
        self.frame_scene.packet_encode_ms = encode_ms;
        self.frame_scene.packet_scene_bytes = scene_bytes;
        self.frame_scene.packet_wire_bytes = bytes.len() as u64;
        self.frame_scene.packet_geometry_bytes = vertex.saturating_add(logical) as u64;
        self.frame_scene.packet_wire_geometry_bytes = vertex.saturating_add(info.inline_curve_bytes).saturating_add(info.curve_sent_bytes) as u64;
        self.frame_scene.packet_inline_curve_bytes = info.inline_curve_bytes as u64;
        self.frame_scene.packet_curve_sent_bytes = info.curve_sent_bytes as u64;
        self.frame_scene.packet_curve_omitted_bytes = logical.saturating_sub(info.inline_curve_bytes).saturating_sub(info.curve_sent_bytes) as u64;
        Ok(bytes)
    }
    pub(crate) fn compile_gpu_packet_request_checked(&mut self,options:&str,mut accept:impl FnMut(&GpuScene)->Result<(),String>)->Result<Vec<u8>,String>{
        crate::render_cancellation::checkpoint()?;
        let fields:serde_json::Value=serde_json::from_str(options).map_err(|e|e.to_string())?;
        let object=fields.as_object().ok_or("Render options must be an object")?;
        let semantic=object.iter().filter(|(key,_)|key.as_str()!="frameResources").collect::<BTreeMap<_,_>>();
        let clipped_pose_transport = !self.frame_scene.scope.is_empty() && fields.get("captureViewport").is_some() &&
            fields.get("rasterProfile").and_then(serde_json::Value::as_str) == Some("analytic") &&
            fields.get("frameResources").and_then(|value| value.get("clippedPoseTransport"))
                .and_then(serde_json::Value::as_bool) == Some(true);
        // Release can cancel a superseded packet for the same clipped lane.
        // Keep its established index eligibility until the lane's contract
        // changes, so that cancellation cannot force a whole-page rebuild.
        self.frame_scene.clipped_pose_transport &= clipped_pose_transport;
        let request_key=if !self.frame_scene.scope.is_empty()&&fields.get("animation").is_none_or(serde_json::Value::is_null){
let key=packet_request_key(&semantic,&fields)?;
            (key.len()<=65536).then_some(key)
        }else{None};
        if let (Some(revision),Some(key))=(self.static_scene_revision(),request_key.as_ref()) {
            if let Some(bytes)=self.frame_scene.reuse(&(revision,key.clone()),&fields)?{
                self.frame_scene.clipped_pose_transport = clipped_pose_transport;
                return self.deliver_scene_packet(&fields, bytes, 0., 0.);
            }
        }
        // Only the most recent successful exact request can short-circuit.
        // A different camera, invalidation or failure cannot revive an old
        // frame sequence, and no ACK dictionary participates in compilation.
        let previous = self.frame_scene.cached.take();
        let previous_curves: Vec<_> = if curve_resources_requested(Some(&fields)) {
            previous.iter().flat_map(|frame| frame.resources.iter().take_while(|(_,kind,_)| *kind == 4))
                .map(|(id,_,_)| *id).collect()
        } else { Vec::new() };
        drop(previous);
        self.frame_scene.compilations+=1;
        let dense=match fields.get("gpuDensePaint"){
            None=>false, Some(serde_json::Value::Bool(value))=>*value,
            _=>return Err("Invalid dense source paint option".into()),
        };
        let compiler_fields=serde_json::Value::Object(semantic.into_iter().filter(|(k,_)|k.as_str()!="gpuDensePaint").map(|(key,value)|(key.clone(),value.clone())).collect());
        let compile_started = packet_clock();
        let mut scene=self.compile_gpu_request_value(compiler_fields)?;
        accept(&scene)?;
        if dense && scene.color_management.is_some_and(|s|s.document_space==crate::color::ColorSpace::Srgb)
            && scene.resolve.is_none() && scene.presentation.is_none() {
            super::dense_coverage::pack(&mut scene)?;
            super::dense_paint::compile(&mut scene)?;
        }
        let compile_ms = packet_millis(compile_started);
        let encode_started = packet_clock();
        if self.frame_scene.scope.is_empty() {
            let raw = scene.into_packet()?;
            return self.deliver_scene_packet(&fields, raw, compile_ms, packet_millis(encode_started));
        }
        self.frame_scene.pending_request=request_key.and_then(|key|self.static_scene_revision().map(|revision|(revision,key)));
let encoded=self.frame_scene.encode_with_curves(scene,Some(&fields),self.geo_revision,&previous_curves);
        if encoded.is_ok() {
            self.frame_scene.clipped_pose_transport = clipped_pose_transport;
        }
        self.reserve_render_cache_bytes();
        let raw=encoded?;
        self.deliver_scene_packet(&fields, raw, compile_ms, packet_millis(encode_started))
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
    fn canceled_clipped_packet_preserves_index_eligibility_for_the_terminal_pose() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let (mut engine, options) = fixture();
        engine.bind_frame_scene_scope("clipped-pose").unwrap();
        let mut request: serde_json::Value = serde_json::from_str(&options).unwrap();
        request["rasterProfile"] = json!("analytic");
        request["captureViewport"] = json!({"x":0,"y":0,"w":64,"h":64});
        request["frameResources"] = json!({"clippedPoseTransport":true});
        engine.compile_gpu_packet_request(&request.to_string()).unwrap();
        assert!(engine.frame_scene.clipped_pose_transport());

        let canceled = Arc::new(AtomicBool::new(false));
        let probe = Arc::clone(&canceled);
        request["view"]["x"] = json!(1.125);
        let result = crate::render_cancellation::with_probe(move || probe.load(Ordering::Relaxed), || {
            engine.compile_gpu_packet_request_checked(&request.to_string(), |_| {
                canceled.store(true, Ordering::Relaxed);
                Ok(())
            })
        });
        assert_eq!(result.unwrap_err(), "PREVIEW_CANCELLED");
        assert!(engine.frame_scene.clipped_pose_transport());

        request["frameResources"] = json!({});
        engine.compile_gpu_packet_request(&request.to_string()).unwrap();
        assert!(!engine.frame_scene.clipped_pose_transport());
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
            assert_eq!(runtime.stats["residentAuthoredNodes"], 2);
            assert_eq!(runtime.stats["compiledSceneNodes"], 2);
            let resolved = runtime.stats["resolvedCompileNodes"].clone();
            assert_eq!(engine.frame_scene.scope,"overview-return");
            assert!(engine.frame_scene.next>next,"eviction must not reuse wire IDs");
            assert!(engine.frame_scene.bytes()+runtime.stats["contextMarginBytes"].as_u64().unwrap() as usize<=64*1024*1024);
            runtime.compile(&mut engine,&descriptor,"stage","page",&local.to_string()).unwrap();
            assert_eq!(runtime.stats["projectionRebuilds"],1);
            assert_eq!(runtime.stats["projectionReuses"],1);
            assert_eq!(runtime.stats["residentAuthoredNodes"], 2);
            assert_eq!(runtime.stats["compiledSceneNodes"], 2);
            assert_eq!(runtime.stats["resolvedCompileNodes"], resolved);
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
    #[test]
    fn partial_ack_replays_exact_records_and_full_ack_checks_cancellation_before_return() {
        let (mut engine, options) = fixture();
        engine.bind_frame_scene_scope("partial").unwrap();
        let first = engine.compile_gpu_packet_request(&options).unwrap();
        let frame = engine.frame_scene.cached.as_ref().unwrap();
        let payload = u32::from_le_bytes(first[20..24].try_into().unwrap()) as usize;
        let start = first.len() - payload;
        let id = u32::from_le_bytes(first[start..start + 4].try_into().unwrap());
        let length = u32::from_le_bytes(first[start + 5..start + 9].try_into().unwrap()) as usize;
        let partial = frame.emit(&[(id, id)]).unwrap();
        assert_eq!(&partial[start..], &first[start + 9 + length..]);
        assert!(!partial[start..].is_empty());
        assert_eq!(u32::from_le_bytes(partial[20..24].try_into().unwrap()) as usize, partial.len() - start);

        let seen = std::cell::Cell::new(false);
        let cancelled = crate::render_cancellation::with_probe(move || seen.replace(true),
            || frame.emit(&[(1, u32::MAX)]));
        assert_eq!(cancelled.unwrap_err(), "PREVIEW_CANCELLED");
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
    #[test]
    fn semantic_ids_do_not_fragment_transfer_acknowledgements(){
        let mut frame=FrameSceneContext::default();frame.bind("dense-test");
        let mut ids=Vec::new();
        for i in 0..32u8{
            frame.source_identity(&format!("n{i}"),vec![i]).unwrap();
            ids.push(frame.intern(2,vec![i]).unwrap().0);
        }
        assert_eq!(ids,(1..=32).collect::<Vec<_>>());
        let first=frame.source_identity("n1",vec![1]).unwrap();
        assert_ne!(first,frame.source_identity("n1",vec![0,1]).unwrap());
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
    #[test] fn equal_image_allocations_emit_one_resource_even_when_neither_can_be_retained(){
        for limit in [0, 4*1024*1024] {
            let (mut engine,options)=fixture();
            let mut scene=engine.compile_gpu_request_value(serde_json::from_str(&options).unwrap()).unwrap();
            let node=scene.nodes.get_mut("r").unwrap();
            let a:Arc<str>=Arc::from("test:image-a");
            let same:Arc<str>=Arc::from(a.as_ref());
            assert!(!Arc::ptr_eq(&a,&same));
            let paint=node.fills[0].clone();
            node.fills=[a.clone(),same.clone(),a,same,Arc::from("test:image-b")].into_iter().map(|uri|{
                let mut p=paint.clone();p.paint.image=Some(uri);p
            }).collect();
            let mut ctx=FrameSceneContext::default();ctx.bind("owner");ctx.limit_override=Some(limit);
            let bytes=ctx.encode(scene,None,1).unwrap();
            let word=|i|u32::from_le_bytes(bytes[i..i+4].try_into().unwrap()) as usize;
            let mut ptr=(24+word(8)+3)&!3;ptr+=4*(word(12)+word(16));
            let mut images=Vec::new();
            while ptr<bytes.len(){let n=word(ptr+5);if bytes[ptr+4]==1{images.push(&bytes[ptr+9..ptr+9+n])}ptr+=9+n;}
            assert_eq!(images,[b"test:image-a".as_slice(),b"test:image-b".as_slice()]);
            assert!(ctx.bytes()<=limit);
        }
    }
    #[test] fn resources_are_bounded_without_turning_a_large_resource_into_document_rejection(){
        let mut context=FrameSceneContext::default();context.bind("bounded");
        let limit=4*1024*1024;context.limit_override=Some(limit);
        let (id,_)=context.intern(1,vec![0;limit+1]).unwrap();assert!(id>0);assert_eq!(context.bytes,0);
        for i in 0..8 {context.intern(1,vec![i;1024*1024]).unwrap();assert!(context.bytes()<=limit);}
        assert!(context.entries.len()<40);
    }
    fn open_packet(packet: &[u8]) -> Vec<u8> {
        if packet.starts_with(b"FGSZ") {
            assert_eq!(u32::from_le_bytes(packet[4..8].try_into().unwrap()), 1);
            lz4_flex::decompress_size_prepended(&packet[8..]).unwrap()
        } else { packet.to_vec() }
    }
    fn word_at(packet: &[u8], at: usize) -> usize { u32::from_le_bytes(packet[at..at+4].try_into().unwrap()) as usize }
    fn geometry_section(packet: &[u8]) -> Vec<u8> {
        let packet = open_packet(packet);
        assert_eq!(&packet[..4], b"FGSC");
        let start = (24 + word_at(&packet, 8) + 3) & !3;
        let end = start + (word_at(&packet, 12) + word_at(&packet, 16)) * 4;
        assert_eq!(end + word_at(&packet, 20), packet.len());
        packet[start..end].to_vec()
    }
    fn curve_programs(packet: &[u8]) -> Vec<u8> {
        let packet = open_packet(packet);
        let mut at = (24 + word_at(&packet, 8) + 3) & !3;
        at += (word_at(&packet, 12) + word_at(&packet, 16)) * 4;
        let mut curves = Vec::new();
        while at < packet.len() {
            let kind = packet[at + 4];
            let len = word_at(&packet, at + 5);
            at += 9;
            if kind == 4 { curves.extend_from_slice(&packet[at..at + len]); }
            at += len;
        }
        curves
    }
    fn max_resource_id(packet: &[u8]) -> u32 {
        let packet = open_packet(packet);
        let mut at = (24 + word_at(&packet, 8) + 3) & !3;
        at += (word_at(&packet, 12) + word_at(&packet, 16)) * 4;
        let mut max = 0u32;
        while at < packet.len() {
            max = max.max(u32::from_le_bytes(packet[at..at + 4].try_into().unwrap()));
            at += 9 + word_at(&packet, at + 5);
        }
        max
    }
    fn pose_request(options: &serde_json::Value, lz4: bool, curves: bool, ack: Option<u32>) -> String {
        let mut request = options.clone();
        let mut resources = json!({"scope":"pose-packet","ranges":[]});
        if lz4 { resources["sceneLz4"] = json!(true); }
        if curves { resources["curvePrograms"] = json!(true); }
        if let Some(end) = ack { resources["ranges"] = json!([[1, end]]); }
        request["frameResources"] = resources;
        request.to_string()
    }
    #[test]
    fn clipped_board_pose_reuses_confirmed_curves_and_lz4_keeps_exact_geometry() {
        let mut nodes = serde_json::Map::new();
        let mut boards = Vec::new();
        for board_index in 0..3 {
            let board = format!("board-{board_index}");
            boards.push(board.clone());
            let mut children = Vec::new();
            for index in 0..16 {
                let id = format!("shape-{board_index}-{index}");
                children.push(id.clone());
                nodes.insert(id.clone(), json!({"id":id,"kind":"ellipse","width":28,"height":16,
                    "transform":[1,0,0,1,(index%4)*34,(index/4)*30],
                    "fills":[{"kind":"solid","color":"#2244bb"}],
                    "strokes":[{"width":1.25,"paint":{"kind":"solid","color":"#102030"}}]}));
            }
            nodes.insert(board.clone(), json!({"id":board,"kind":"frame","width":150,"height":140,"clip":true,
                "blend":"pass-through","transform":[1,0,0,1,board_index*100,36],"children":children}));
        }
        let doc = json!({"schemaVersion":20,"id":"boards","name":"boards",
            "pages":[{"id":"p","name":"p","background":"#ffffff","children":boards}],"nodes":nodes});
        let options = json!({"pageId":"p","width":180,"height":120,"view":{"x":0.25,"y":0.125,"zoom":0.8},
            "rasterProfile":"figmaSubpixel","gpuViewport":{"x":0,"y":0,"w":180,"h":120}});
        let mut engine = crate::Engine::new();
        engine.load_document(&doc.to_string()).unwrap();
        engine.bind_frame_scene_scope("pose-packet").unwrap();
        let parsed = engine.parse_options(options.clone()).unwrap();
        let png_before = engine.render_png(&parsed).unwrap();
        let raw = engine.compile_gpu_packet_request(&pose_request(&options, false, false, None)).unwrap();
        let compressed = engine.compile_gpu_packet_request(&pose_request(&options, true, false, None)).unwrap();
        assert!(compressed.starts_with(b"FGSZ"), "inline pose should shrink, raw {}", raw.len());
        assert!(compressed.len() < raw.len());
        assert_eq!(open_packet(&compressed), raw);
        assert_eq!(engine.frame_scene.compilations, 1, "lz4 is a transport of the cached scene");
        let curves = engine.compile_gpu_packet_request(&pose_request(&options, true, true, None)).unwrap();
        let curve_packet = open_packet(&curves);
        assert_eq!(word_at(&curve_packet, 16), 0, "confirmed blocks replace inline curves");
        let inline_geometry = geometry_section(&raw);
        let curve_geometry = geometry_section(&curves);
        let vertices = word_at(&curve_packet, 12) * 4;
        assert_eq!(&curve_geometry[..vertices], &inline_geometry[..vertices]);
        assert_eq!(curve_programs(&curves), &inline_geometry[vertices..]);
        let ack = max_resource_id(&curves);
        assert!(engine.apply_interaction_transforms(&[("board-0".into(), crate::math::Transform([1.,0.,0.,1.,0.4,36.35]))].into()).unwrap());
        let png_hold = engine.render_png(&parsed).unwrap();
        assert_ne!(png_hold, png_before, "fractional board drag must reach the pixels");
        let mut baked = doc.clone();
        baked["nodes"]["board-0"]["transform"] = json!([1.0,0.0,0.0,1.0,0.4,36.35]);
        let mut fresh = crate::Engine::new();
        fresh.load_document(&baked.to_string()).unwrap();
        fresh.bind_frame_scene_scope("fresh-pose").unwrap();
        assert_eq!(fresh.render_png(&fresh.parse_options(options.clone()).unwrap()).unwrap(), png_hold);
        let posed = engine.compile_gpu_packet_request(&pose_request(&options, false, false, None)).unwrap();
        assert_eq!(geometry_section(&posed), geometry_section(&fresh.compile_gpu_packet_request(&options.to_string()).unwrap()));
        let release = engine.compile_gpu_packet_request(&pose_request(&options, true, false, None)).unwrap();
        assert!(release.starts_with(b"FGSZ"));
        assert_eq!(open_packet(&release), posed, "release compresses inline curves without changing them");
        let dragged = engine.compile_gpu_packet_request(&pose_request(&options, true, true, Some(ack))).unwrap();
        let packet = engine.gpu_compile_cache_stats()["frameScene"]["packet"].clone();
        assert!(packet["curveOmittedBytes"].as_u64().unwrap() > 0, "{packet}");
        assert!(packet["wireBytes"].as_u64().unwrap() < packet["sceneBytes"].as_u64().unwrap(), "{packet}");
        assert!(dragged.len() * 2 < posed.len(), "acked drag {} should be well under inline {}", dragged.len(), posed.len());
        assert_eq!(fresh.render_png(&fresh.parse_options(options.clone()).unwrap()).unwrap(), png_hold);
        assert!(engine.apply_interaction_transforms(&[("board-0".into(), crate::math::Transform([1.,0.,0.,1.,0.,36.]))].into()).unwrap());
        assert_eq!(engine.render_png(&parsed).unwrap(), png_before, "undo restores the held pixels");
        eprintln!("pose-packet raw={} lz4={} curves={} release={} acked_drag={} omitted={} generated_geometry={}",
            raw.len(), compressed.len(), curves.len(), release.len(), dragged.len(),
            packet["curveOmittedBytes"], packet["geometryBytes"]);
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
    #[test]
    fn curve_slot_hints_require_the_original_bits_and_a_live_resource() {
        let mut frame=FrameSceneContext::default();
        frame.bind("curve-slot");
        let words = [1.0, 0.0, 2.0, 3.0];
        let original = frame.intern_curve(&words, None).unwrap().0;
        let mut different = words;
        different[1] = -0.0;
        let changed = frame.intern_curve(&different, Some(original)).unwrap().0;
        assert_ne!(original, changed);
        assert_eq!(frame.intern_curve(&words, Some(changed)).unwrap().0, original);
        let key = frame.curve_transfer_keys[&original].clone();
        frame.ages.remove(&frame.entries[&key].age);
        frame.evict_transfer(&key);
        assert_ne!(frame.intern_curve(&words, Some(original)).unwrap().0, original);
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
