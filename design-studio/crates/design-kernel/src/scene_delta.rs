//! Lossless, session-scoped transport of compiled scenes. Device coverage is
//! still compiled at the exact requested camera; only identical data is omitted.
use crate::gpu::GpuScene;
use std::collections::BTreeMap;

#[derive(Default)]
pub(crate) struct SceneDelta {
    sequence: u32,
    previous: Option<Snapshot>,
    request: Option<((u64, bool, bool), String)>,
}
struct Snapshot {
    fields: Vec<u8>,
    nodes: BTreeMap<String, Vec<u8>>,
    vertices: Vec<f32>,
    curves: Vec<f32>,
}
#[derive(serde::Serialize)]
struct Spans { length: usize, spans: Vec<[usize; 2]>, copies: Vec<[usize; 3]> }
fn changed_words(old: &[f32], next: &[f32], payload: &mut Vec<u8>) -> Spans {
    let mut spans = Vec::new();
    let mut prefix = 0;
    while prefix < old.len().min(next.len()) && old[prefix].to_bits() == next[prefix].to_bits() { prefix += 1; }
    let mut tail = 0;
    while tail < old.len().min(next.len())-prefix && old[old.len()-tail-1].to_bits() == next[next.len()-tail-1].to_bits() { tail += 1; }
    let copies = if tail > 0 && old.len() != next.len() { vec![[next.len()-tail, old.len()-tail, tail]] } else { vec![] };
    let limit = next.len()-tail;
    let mut i = prefix;
    while i < limit {
        if old.get(i).is_some_and(|v| v.to_bits() == next[i].to_bits()) { i += 1; continue; }
        let start = i; let mut last = i+1; i += 1;
        // Nearby changed words form one upload. Thousands of tiny JSON spans
        // cost more than copying a few unchanged exact words between them.
        while i < limit {
            if !old.get(i).is_some_and(|v| v.to_bits() == next[i].to_bits()) { last=i+1; }
            else if i-last >= 16 { break; }
            i += 1;
        }
        spans.push([start, last-start]);
        for value in &next[start..last] { payload.extend_from_slice(&value.to_le_bytes()); }
    }
    Spans { length: next.len(), spans, copies }
}
impl SceneDelta {
    pub(crate) fn clear(&mut self) { self.previous = None; self.request = None; }
    /// A full request and static document lineage prove an unchanged compiled
    /// scene. Emit the same empty delta without rebuilding/serializing nodes.
    /// Animation and oversized request envelopes deliberately use normal encode.
    pub(crate) fn compile(&mut self, engine: &mut crate::Engine, request: &str, reset: bool) -> Result<Vec<u8>, String> {
        if !reset && self.previous.is_some() && self.request.as_ref().is_some_and(|(revision, previous)|
            previous == request && Some(*revision) == engine.static_scene_revision()) {
            let sequence = self.sequence.checked_add(1).ok_or("Scene sequence exhausted")?;
            let previous = self.previous.as_ref().unwrap();
            let metadata = format!("{{\"base\":{},\"sequence\":{sequence},\"fields\":null,\"nodes\":{{}},\"removed\":[],\"vertices\":{{\"length\":{},\"spans\":[],\"copies\":[]}},\"curves\":{{\"length\":{},\"spans\":[],\"copies\":[]}}}}",self.sequence,previous.vertices.len(),previous.curves.len());
            let mut bytes = b"FGPD".to_vec();
            for n in [1, metadata.len(), 0, 0, 0] { bytes.extend_from_slice(&(n as u32).to_le_bytes()); }
            bytes.extend_from_slice(metadata.as_bytes()); bytes.resize((bytes.len()+3)&!3,0);
            self.sequence = sequence;
            return Ok(bytes);
        }
        self.request = None;
        let scene = engine.compile_gpu_request(request)?;
        let bytes = self.encode(scene, reset)?;
        if self.previous.is_some() && request.len() <= 65536 {
            self.request = engine.static_scene_revision().map(|revision| (revision, request.to_owned()));
        }
        Ok(bytes)
    }
    pub(crate) fn encode(&mut self, mut scene: GpuScene, reset: bool) -> Result<Vec<u8>, String> {
        self.request = None;
        let sequence = self.sequence.checked_add(1).ok_or("Scene sequence exhausted")?;
        let old = if reset { None } else { self.previous.as_ref() };
        let base = if old.is_some() { self.sequence } else { 0 };
        let vertices = std::mem::take(&mut scene.vertices);
        let curves = std::mem::take(&mut scene.curves);
        let nodes = std::mem::take(&mut scene.nodes).into_iter().map(|(id, n)|
            serde_json::to_vec(&n).map(|bytes| (id, bytes))).collect::<Result<BTreeMap<_,_>,_>>()
            .map_err(|e| e.to_string())?;
        let fields = serde_json::to_vec(&scene).map_err(|e| e.to_string())?;
        let mut vertex_bytes = Vec::new(); let mut curve_bytes = Vec::new();
        let vertex_spans = changed_words(old.map_or(&[], |s| &s.vertices), &vertices, &mut vertex_bytes);
        let curve_spans = changed_words(old.map_or(&[], |s| &s.curves), &curves, &mut curve_bytes);
        let removed: Vec<_> = old.into_iter().flat_map(|s| s.nodes.keys()).filter(|id| !nodes.contains_key(*id)).collect();
        let mut metadata = format!("{{\"base\":{base},\"sequence\":{sequence},\"fields\":").into_bytes();
        if old.is_some_and(|s| s.fields == fields) { metadata.extend_from_slice(b"null"); }
        else { metadata.extend_from_slice(&fields); }
        metadata.extend_from_slice(b",\"nodes\":{");
        let mut first = true;
        for (id, bytes) in &nodes {
            if old.and_then(|s| s.nodes.get(id)) == Some(bytes) { continue; }
            if !first { metadata.push(b','); } first = false;
            serde_json::to_writer(&mut metadata, id).map_err(|e| e.to_string())?;
            metadata.push(b':'); metadata.extend_from_slice(bytes);
        }
        metadata.extend_from_slice(b"},\"removed\":");
        serde_json::to_writer(&mut metadata, &removed).map_err(|e| e.to_string())?;
        metadata.extend_from_slice(b",\"vertices\":");
        serde_json::to_writer(&mut metadata, &vertex_spans).map_err(|e| e.to_string())?;
        metadata.extend_from_slice(b",\"curves\":");
        serde_json::to_writer(&mut metadata, &curve_spans).map_err(|e| e.to_string())?;
        metadata.push(b'}');
        let mut bytes = b"FGPD".to_vec();
        for n in [1, metadata.len(), vertex_bytes.len()/4, curve_bytes.len()/4, 0] {
            bytes.extend_from_slice(&u32::try_from(n).map_err(|_| "Scene delta too large")?.to_le_bytes());
        }
        bytes.extend_from_slice(&metadata); bytes.resize((bytes.len()+3)&!3, 0);
        bytes.extend_from_slice(&vertex_bytes); bytes.extend_from_slice(&curve_bytes);
        // A single interaction session may retain at most 32 MiB. Larger
        // captures remain correct full installs, never silently lower density.
        let retained = fields.len() + nodes.iter().map(|(id, b)| id.len()+b.len()+64).sum::<usize>()
            + (vertices.len()+curves.len())*4;
        self.previous = (retained <= 32*1024*1024).then_some(Snapshot { fields, nodes, vertices, curves });
        self.sequence = sequence;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn static_request_reuse_is_byte_exact_and_invalidated_by_edits_camera_reset_and_failure() {
        let doc=serde_json::json!({"schemaVersion":1,"id":"d","name":"scene","pages":[{"id":"p","name":"Page","background":"#ffffff","children":["r"]}],
            "nodes":{"r":{"id":"r","kind":"rectangle","width":20,"height":20,"fills":[{"kind":"solid","color":"#527acc"}]}}});
        let mut engine=crate::Engine::new();engine.load_document(&doc.to_string()).unwrap();
        let mut cached=SceneDelta::default();let mut oracle=SceneDelta::default();
        let request=serde_json::json!({"pageId":"p","width":32,"height":32,"view":{"x":0,"y":0,"zoom":1}}).to_string();
        for i in 0..9 {
            if i==3 { engine.apply_interaction_transforms(&[("r".into(),crate::math::Transform([1.,0.,0.,1.,7.375,0.]))].into_iter().collect()).unwrap(); }
            if i==5 { assert!(cached.compile(&mut engine,"{}",false).is_err()); }
            if i==7 { cached.clear();oracle.clear(); }
            let input=if i==4 { request.replace("\"zoom\":1","\"zoom\":0.5") } else { request.clone() };
            let actual=cached.compile(&mut engine,&input,i==0||i==6).unwrap();
            let expected=oracle.encode(engine.compile_gpu_request(&input).unwrap(),i==0||i==6).unwrap();
            assert_eq!(actual,expected,"step {i}");
        }
        engine.load_document(&doc.to_string()).unwrap();
        assert_eq!(cached.compile(&mut engine,&request,false).unwrap(),oracle.encode(engine.compile_gpu_request(&request).unwrap(),false).unwrap());
    }
    #[test]
    fn relocated_static_tail_is_copied_without_reencoding() {
        let old=[1.,2.,3.,4.,5.]; let next=[1.,7.,8.,3.,4.,5.];
        let mut bytes=Vec::new(); let spans=changed_words(&old,&next,&mut bytes);
        assert_eq!(spans.copies,vec![[3,2,3]]);
        assert_eq!(spans.spans,vec![[1,2]]);
        assert_eq!(bytes.len(),8);
    }
    #[test]
    fn word_deltas_preserve_signed_zero_nan_payloads_and_growth() {
        let old = [0., 2., f32::from_bits(0x7fc00001), 4.];
        let next = [-0., 2., f32::from_bits(0x7fc00002), 4., 5.];
        let mut bytes=Vec::new(); let s=changed_words(&old,&next,&mut bytes);
        assert_eq!(s.spans,vec![[0,5]]);
        let mut result=old.to_vec(); result.resize(next.len(),0.); let mut p=0;
        for [offset,count] in s.spans { for x in &mut result[offset..offset+count] {
            *x=f32::from_le_bytes(bytes[p..p+4].try_into().unwrap()); p+=4;
        }}
        assert!(result.iter().zip(next).all(|(a,b)|a.to_bits()==b.to_bits()));
        assert!(changed_words(&next,&next[..2],&mut Vec::new()).spans.is_empty());
    }
}
