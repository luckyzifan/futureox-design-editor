//! Exact compiled subtrees at a non-overlapping document frontier. Addresses
//! are rebound to the current packet using the original immutable programs.
use super::*;
use std::collections::HashSet;
struct Fragment {
    nodes: Vec<GpuNode>, programs: HashMap<u32, Arc<CachedProgram>>, bounds: Rect, bytes: usize,
}
#[derive(Default)]
pub(super) struct FragmentCache {
    entries: HashMap<String, Arc<Fragment>>,
    pub(super) policy: String,
    pub(super) bytes: usize,
    pub(super) hits: u64,
    pub(super) builds: u64,
}
impl FragmentCache {
    pub(super) fn clear(&mut self) { self.entries.clear(); self.bytes=0; }
    pub(super) fn invalidate_tree(&mut self,doc:&Document,ids:impl Iterator<Item=String>,parents:&HashMap<String,String>){
        let mut dirty=HashSet::new();let mut stack=ids.collect::<Vec<_>>();
        for id in &stack{let mut parent=parents.get(id);while let Some(id)=parent{dirty.insert(id.clone());parent=parents.get(id);}}
        while let Some(id)=stack.pop(){if let Some(node)=doc.nodes.get(&id){stack.extend(node.render_children().iter().cloned());}dirty.insert(id);}
        self.invalidate(&dirty);
    }
    pub(super) fn invalidate(&mut self, dirty:&HashSet<String>) {
        for id in dirty {if let Some(old)=self.entries.remove(id){self.bytes-=old.bytes;}}
    }
}
impl Compiler<'_> {
    pub(super) fn node(&mut self,id:&str,parent:Transform,requested:Option<Rect>)->Result<Rect,String>{
        crate::render_cancellation::checkpoint()?;
        if let Some(fragment)=self.fragments.entries.get(id).cloned() {
            for old in &fragment.nodes {
                crate::render_cancellation::checkpoint()?;
                let mut node=old.clone();
                for path in std::iter::once(&mut node.fill).chain(node.strokes.iter_mut().map(|s|&mut s.path)) {
                    if let Some(area)=&mut path.area {
                        *area=self.install_program(fragment.programs[&area.first].clone())?;
                    }
                }
                self.compiled_order.push(node.id.clone());self.nodes.insert(node.id.clone(),node);
            }
            self.fragments.hits+=1;
            return Ok(fragment.bounds)
        }
        let begin=self.compiled_order.len();
        let bounds=self.compile_node(id,parent,requested)?;
        if self.fragment_targets.contains(id) {
            let nodes=self.compiled_order[begin..].iter().map(|id|&self.nodes[id]).collect::<Vec<_>>();
            let needed=nodes.iter().flat_map(|n|std::iter::once(&n.fill).chain(n.strokes.iter().map(|s|&s.path)))
                .filter_map(|p|p.area.as_ref().map(|a|a.first)).collect::<HashSet<_>>();
            let programs=self.area_paths.iter().filter(|(_,area)|needed.contains(&area.first))
                .map(|(program,area)|(area.first,program.0.clone())).collect::<HashMap<_,_>>();
            let bytes=crate::editing::serialized_size(&nodes).map_err(|e|e.to_string())?.saturating_mul(8)
                .saturating_add(programs.values().map(|p|p.data.len()*4+512).sum::<usize>())
                .saturating_add(id.len()+512);
            // Shared with the pre-existing program budget, not a new allowance.
            if bytes<=ProgramCache::LIMIT/4 && self.fragments.bytes+bytes<=ProgramCache::LIMIT/4 {
                self.fragments.bytes+=bytes;self.fragments.builds+=1;
                self.fragments.entries.insert(id.into(),Arc::new(Fragment{nodes:nodes.into_iter().cloned().collect(),programs,bounds,bytes}));
            }
        }
        self.programs.reserve(self.fragments.bytes);
        Ok(bounds)
    }
}

#[cfg(test)] mod tests {
    use super::*;
    use serde_json::json;
    #[test] fn changed_nested_child_rebuilds_its_fragment_and_reuses_the_other_exactly(){
        let mut engine=Engine::new();
        let mut document=json!({"schemaVersion":1,"id":"d","name":"d","pages":[{"id":"p","name":"p","children":["root"],"background":"#ffffff"}],
            "nodes":{"root":{"id":"root","kind":"group","width":200,"height":100,"children":["a","b"]},
            "a":{"id":"a","kind":"ellipse","width":40,"height":30,"fills":[{"kind":"solid","color":"#ff0000"}]},
            "b":{"id":"b","kind":"rectangle","width":40,"height":30,"transform":[1,0,0,1,80,0],"fills":[{"kind":"linear","color":"#000000","stops":[{"offset":0,"color":"#000000"},{"offset":1,"color":"#ffffff"}]}]}}});
        engine.load_document(&document.to_string()).unwrap();
        let options=json!({"pageId":"p","width":200,"height":100,"view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figmaSubpixel"}).to_string();
        engine.compile_gpu_request(&options).unwrap();
        for x in [1.,2.,3.,4.] {
            assert!(engine.apply_interaction_transforms(&BTreeMap::from([("a".into(),Transform([1.,0.,0.,1.,x,0.]))])).unwrap());
            document["nodes"]["a"]["transform"]=json!([1,0,0,1,x,0]);
            let actual=engine.compile_gpu_request(&options).unwrap();
            let mut fresh=Engine::new();fresh.load_document(&document.to_string()).unwrap();
            let expected=fresh.compile_gpu_request(&options).unwrap();
            assert_eq!(serde_json::to_value(actual).unwrap(),serde_json::to_value(expected).unwrap());
        }
        assert!(engine.camera_prepare.as_ref().unwrap().fragments.hits>=3);
        let hits=engine.camera_prepare.as_ref().unwrap().fragments.hits;
        document["nodes"]["a"]["fills"][0]["color"]=json!("#00ff00");
        let patch=serde_json::from_value(json!({"nodes":{"a":document["nodes"]["a"].clone()},"fields":{}})).unwrap();
        engine.apply_document_patch(&patch).unwrap();
        let actual=engine.compile_gpu_request(&options).unwrap();
        let mut fresh=Engine::new();fresh.load_document(&document.to_string()).unwrap();
        assert_eq!(serde_json::to_value(actual).unwrap(),serde_json::to_value(fresh.compile_gpu_request(&options).unwrap()).unwrap());
        assert!(engine.camera_prepare.as_ref().unwrap().fragments.hits>hits);
        let cache=engine.camera_prepare.as_ref().unwrap();assert!(cache.programs.bytes+cache.fragments.bytes<=ProgramCache::LIMIT);
    }
}
