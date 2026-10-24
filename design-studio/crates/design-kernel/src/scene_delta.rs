//! Lossless, session-scoped transport of compiled scenes. Device coverage is
//! still compiled at the exact requested camera; only identical data is omitted.
use crate::gpu::GpuScene;
use std::collections::{BTreeMap, BTreeSet};

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
    retained: usize,
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
        if !reset {
            if let Some(bytes) = self.compile_changed_roots(engine, request)? {
                self.request = engine.static_scene_revision().map(|revision| (revision, request.to_owned()));
                return Ok(bytes);
            }
        }
        self.request = None;
        let scene = engine.compile_gpu_request(request)?;
        let bytes = self.encode(scene, reset)?;
        if self.previous.is_some() && request.len() <= 65536 {
            self.request = engine.static_scene_revision().map(|revision| (revision, request.to_owned()));
        }
        Ok(bytes)
    }
    /// Keep static islands and their geometry addresses resident. A changed
    /// island is compiled at the exact camera, then appended atomically. The
    /// existing 32 MiB retention bound forces periodic full compaction; no
    /// budget grows with gesture duration. Changed global extents/policy use
    /// the ordinary full compiler, including painter dependency experiments.
    fn compile_changed_roots(&mut self, engine: &mut crate::Engine, request: &str) -> Result<Option<Vec<u8>>, String> {
        let (Some(previous), Some((revision, prior_request)), Some(current), Some((base, next, ids))) =
            (&self.previous, &self.request, engine.static_scene_revision(), &engine.interaction_transform_revision)
            else { return Ok(None); };
        if prior_request != request || revision.0 != *base || current.0 != *next ||
            revision.1 != current.1 || revision.2 != current.2 {
            return Ok(None);
        }
        let input: serde_json::Value = serde_json::from_str(request).map_err(|e| e.to_string())?;
        if input.get("gpuPainterSupport").and_then(|v| v.as_bool()).unwrap_or(false) ||
            input.get("pixelPreview").is_some_and(|v| !v.is_null()) ||
            input.get("animation").is_some_and(|v| !v.is_null()) { return Ok(None); }
        let fields: serde_json::Value = serde_json::from_slice(&previous.fields).map_err(|e| e.to_string())?;
        if !fields["resolve"].is_null() || !fields["presentation"].is_null() { return Ok(None); }
        let Some(doc) = engine.doc.as_ref() else { return Ok(None); };
        let Some(page) = doc.pages.iter().find(|p| Some(p.id.as_str()) == input["pageId"].as_str()) else { return Ok(None); };
        // Roots are disjoint. Finding the affected islands uses the retained
        // scene's parent topology, built only after a full compile.
        let mut roots = BTreeSet::new();
        for id in ids {
            let mut at = id.as_str();
            while let Some(parent) = engine.render_parent(at) { at = parent; }
            if !page.children.iter().any(|root| root == at) { return Ok(None); }
            roots.insert(at.to_owned());
        }
        // A single-island scene has no static work to retain.
        if roots.len() == page.children.len() { return Ok(None); }
        let mut affected = BTreeSet::new();
        let mut stack: Vec<_> = roots.iter().cloned().collect();
        while let Some(id) = stack.pop() {
            let Some(node) = doc.nodes.get(&id) else { return Ok(None); };
            stack.extend(node.render_children().iter().cloned()); affected.insert(id);
        }
        let mut scene = engine.compile_gpu_request_roots(request, Some(&roots))?;
        let vertices = std::mem::take(&mut scene.vertices);
        let curves = std::mem::take(&mut scene.curves);
        let mut nodes = std::mem::take(&mut scene.nodes);
        let mut next_fields = serde_json::to_value(&scene).map_err(|e| e.to_string())?;
        let mut old_policy = fields.clone();
        old_policy.as_object_mut().unwrap().remove("colors");
        let colors = next_fields.as_object_mut().unwrap().remove("colors").unwrap();
        if old_policy != next_fields {
            return Ok(None);
        }
        let mut merged_fields = fields;
        let old_colors = merged_fields["colors"].as_object_mut().ok_or("Invalid retained colors")?;
        old_colors.extend(colors.as_object().ok_or("Invalid compiled colors")?.clone());
        let fields = serde_json::to_vec(&merged_fields).map_err(|e| e.to_string())?;
        let previous = self.previous.as_ref().unwrap();
        let nv = previous.vertices.len(); let nc = previous.curves.len();
        for node in nodes.values_mut() {
            let relocate = |path: &mut crate::gpu::GpuPath| {
                path.first += (nv / 2) as u32;
                if let Some(area) = &mut path.area { area.first += (nc / 4) as u32; }
                if let Some(analytic) = &mut path.analytic { analytic.first += (nc / 4) as u32; }
            };
            relocate(&mut node.fill);
            for stroke in &mut node.strokes { relocate(&mut stroke.path); }
        }
        let nodes: BTreeMap<_,_> = nodes.into_iter().map(|(id,node)|
            serde_json::to_vec(&node).map(|bytes| (id,bytes))).collect::<Result<_,_>>().map_err(|e| e.to_string())?;
        let removed: Vec<_> = affected.iter().filter(|id| previous.nodes.contains_key(*id) && !nodes.contains_key(*id)).cloned().collect();
        let mut retained = previous.retained - previous.fields.len() + fields.len() + (vertices.len()+curves.len())*4;
        for id in affected.iter() { if let Some(bytes) = previous.nodes.get(id) { retained -= id.len()+bytes.len()+64; } }
        retained += nodes.iter().map(|(id,bytes)| id.len()+bytes.len()+64).sum::<usize>();
        if retained > 32*1024*1024 {
            return Ok(None);
        }
        let sequence = self.sequence.checked_add(1).ok_or("Scene sequence exhausted")?;
        let spans = |start: usize, count: usize| Spans { length:start+count,
            spans: if count > 0 { vec![[start,count]] } else { vec![] }, copies: vec![] };
        // Serialize only changed node values. Static strings and program words
        // never pass through serde or a full-array comparison on this route.
        let mut metadata = format!("{{\"base\":{},\"sequence\":{sequence},\"fields\":", self.sequence).into_bytes();
        if previous.fields == fields { metadata.extend_from_slice(b"null"); } else { metadata.extend_from_slice(&fields); }
        metadata.extend_from_slice(b",\"nodes\":{");
        let mut first = true;
        for (id, bytes) in &nodes {
            if previous.nodes.get(id) == Some(bytes) { continue; }
            if !first { metadata.push(b','); } first=false;
            serde_json::to_writer(&mut metadata,id).map_err(|e|e.to_string())?;
            metadata.push(b':'); metadata.extend_from_slice(bytes);
        }
        metadata.extend_from_slice(b"},\"removed\":"); serde_json::to_writer(&mut metadata,&removed).map_err(|e|e.to_string())?;
        metadata.extend_from_slice(b",\"vertices\":"); serde_json::to_writer(&mut metadata,&spans(nv,vertices.len())).map_err(|e|e.to_string())?;
        metadata.extend_from_slice(b",\"curves\":"); serde_json::to_writer(&mut metadata,&spans(nc,curves.len())).map_err(|e|e.to_string())?;
        metadata.push(b'}');
        let mut bytes = b"FGPD".to_vec();
        for n in [1,metadata.len(),vertices.len(),curves.len(),0] { bytes.extend_from_slice(&(n as u32).to_le_bytes()); }
        bytes.extend_from_slice(&metadata); bytes.resize((bytes.len()+3)&!3,0);
        for v in vertices.iter().chain(&curves) { bytes.extend_from_slice(&v.to_le_bytes()); }
        let previous = self.previous.as_mut().unwrap();
        previous.fields=fields; previous.retained=retained;
        for id in removed { previous.nodes.remove(&id); }
        previous.nodes.extend(nodes); previous.vertices.extend(vertices); previous.curves.extend(curves);
        self.sequence=sequence;
        Ok(Some(bytes))
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
        self.previous = (retained <= 32*1024*1024).then_some(Snapshot { fields, nodes, vertices, curves, retained });
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
    fn transformed_islands_match_full_compile_without_serializing_static_nodes() {
        use serde_json::{json,Value};
        let mut doc=json!({"schemaVersion":16,"id":"d","name":"islands","colorManagement":{"documentSpace":"srgb","referenceWhiteNits":203,"peakLuminanceNits":1000},"pages":[{"id":"p","name":"p","background":"#ffffff","children":[]}],"nodes":{}});
        for i in 0..80 {
            let id=format!("n{i:03}");doc["pages"][0]["children"].as_array_mut().unwrap().push(json!(id));
            doc["nodes"][&id]=json!({"id":id,"kind":"rectangle","width":6,"height":5,"transform":[1,0,0,1,(i%10)*8,(i/10)*8],"fills":[{"kind":"linear","color":"#000000","angle":90,"stops":[{"offset":0,"color":"#112233"},{"offset":1,"color":"#5678ff"}]}]});
        }
        let mut engine=crate::Engine::new();engine.load_document(&doc.to_string()).unwrap();
        let mut delta=SceneDelta::default();
        let request=json!({"pageId":"p","width":96,"height":80,"view":{"x":0.125,"y":0.375,"zoom":1},"rasterProfile":"figmaSubpixel"}).to_string();
        delta.compile(&mut engine,&request,true).unwrap();
        let compare_node=|mut value:Value,curves:&[f32],vertices:&[f32]| {
            let path=|p:&mut Value| {
                let span=if p["area"].is_object(){let first=p["area"]["first"].as_u64().unwrap() as usize*4;let count=p["area"]["count"].as_u64().unwrap() as usize*4;p["area"]["first"]=json!(0);curves[first..first+count].iter().map(|v|v.to_bits()).collect::<Vec<_>>()}
                else{let first=p["first"].as_u64().unwrap() as usize*2;let count=p["count"].as_u64().unwrap() as usize*2;vertices[first..first+count].iter().map(|v|v.to_bits()).collect()};
                p["first"]=json!(0);p["exactWords"]=json!(span);
            };
            path(&mut value["fill"]);for stroke in value["strokes"].as_array_mut().unwrap(){path(&mut stroke["path"])}value
        };
        for (step,transform) in [[1.,0.,0.,1.,11.375,12.125],[0.8,0.6,-0.6,0.8,20.,20.],[1.,0.,0.,1.,200.,200.],[1.,0.,0.,1.,0.,0.]].into_iter().enumerate(){
            assert!(engine.apply_interaction_transforms(&[("n000".into(),crate::math::Transform(transform))].into_iter().collect()).unwrap());
            let packet=delta.compile(&mut engine,&request,false).unwrap();
            let length=u32::from_le_bytes(packet[8..12].try_into().unwrap()) as usize;
            let metadata:Value=serde_json::from_slice(&packet[24..24+length]).unwrap();
            assert!(metadata["nodes"].as_object().unwrap().len()<=1,"step {step}: static nodes serialized");
            if step==0 { assert_eq!(metadata["curves"]["copies"],json!([]));assert!(metadata["curves"]["spans"][0][0].as_u64().unwrap()>0); }
            let full=engine.compile_gpu_request(&request).unwrap();let retained=delta.previous.as_ref().unwrap();
            assert_eq!(full.nodes.len(),retained.nodes.len());
            for(id,node)in &full.nodes{
                let actual:Value=serde_json::from_slice(&retained.nodes[id]).unwrap();
                assert_eq!(compare_node(actual,&retained.curves,&retained.vertices),compare_node(serde_json::to_value(node).unwrap(),&full.curves,&full.vertices),"{id} step {step}");
            }
        }
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
