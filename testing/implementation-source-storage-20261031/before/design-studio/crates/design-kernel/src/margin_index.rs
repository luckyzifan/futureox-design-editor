//! Exact camera-dependent margin evaluation over the paths that can contribute.
//! No affine operations are collapsed/reassociated. Empty/invisible branches
//! contribute the same zero to the original per-parent max; effect values are
//! read from the revision-owned document rather than copied into another model.
use crate::{math::Transform,scene::{Document,Node}};
const ROOT:u32=u32::MAX;
struct Step {parent:u32,transform:Transform,effect_node:Option<Box<str>>,zero_child:bool}
struct Walk<'a>{id:&'a str,node:&'a Node,child:usize,entered:bool,emitted:Option<u32>,zero_child:bool}
impl<'a> Walk<'a>{fn new(id:&'a str,node:&'a Node)->Self{Self{id,node,child:0,entered:false,emitted:None,zero_child:false}}}
pub(crate) struct MarginIndex {steps:Vec<Step>,root_zero:bool,bytes:usize}
impl MarginIndex {
    const SCRATCH:usize=std::mem::size_of::<Transform>()+std::mem::size_of::<Option<i32>>()+std::mem::size_of::<i32>();
    pub(crate) fn build(doc:&Document,roots:&[String],budget:usize)->Result<Option<Self>,String>{
        let limit=budget.min(64*1024*1024);let mut steps:Vec<Step>=Vec::new();let mut stack:Vec<Walk<'_>>=Vec::new();let mut keys=0usize;let mut root_zero=roots.is_empty();
        let overhead=std::mem::size_of::<Self>()+256;
        if limit<overhead{return Ok(None)}
        for root in roots {
            let node=&doc.nodes[root];if !node.visible{root_zero=true;continue}
            if overhead+std::mem::size_of::<Walk<'_>>()*2>limit{return Ok(None)}
            stack.push(Walk::new(root,node));
            while !stack.is_empty(){
                crate::render_cancellation::checkpoint()?;
                let top=stack.last_mut().unwrap();
                if !top.entered {
                    top.entered=true;
                    if top.node.effects.iter().any(|e|e.visible){
                        for depth in 0..stack.len(){
                            if stack[depth].emitted.is_some(){continue}
                            let frame=&stack[depth];let own=frame.node.effects.iter().any(|e|e.visible);
                            let key=if own{frame.id.len()+32}else{0};let count=steps.len()+1;
                            // Reserve transient Vec growth and later evaluation scratch
                            // before allocating. No cache-specific allowance is raised.
                            let projected=overhead.saturating_add(count.saturating_mul(3*std::mem::size_of::<Step>()+Self::SCRATCH))
                                .saturating_add(keys).saturating_add(key).saturating_add(stack.capacity()*std::mem::size_of::<Walk<'_>>());
                            if projected>limit||count>=u32::MAX as usize||steps.try_reserve(1).is_err(){return Ok(None)}
                            let parent=depth.checked_sub(1).and_then(|i|stack[i].emitted).unwrap_or(ROOT);
                            let index=steps.len() as u32;
                            steps.push(Step{parent,transform:frame.node.transform,effect_node:own.then(||frame.id.into()),zero_child:false});
                            keys+=key;stack[depth].emitted=Some(index);
                        }
                    }
                }
                let top=stack.last_mut().unwrap();
                if top.child<top.node.children.len(){
                    let id=top.node.children[top.child].as_str();top.child+=1;let node=&doc.nodes[id];
                    if !node.visible{top.zero_child=true;continue}
                    let projected=overhead.saturating_add(steps.capacity()*std::mem::size_of::<Step>())
                        .saturating_add(steps.len()*Self::SCRATCH).saturating_add(keys)
                        .saturating_add((stack.len()+1).saturating_mul(2*std::mem::size_of::<Walk<'_>>()));
                    if projected>limit||stack.try_reserve(1).is_err(){return Ok(None)}
                    stack.push(Walk::new(id,node));
                }else{
                    let completed=stack.pop().unwrap();
                    if let Some(index)=completed.emitted{steps[index as usize].zero_child=completed.zero_child}
                    else if let Some(parent)=stack.last_mut(){parent.zero_child=true}else{root_zero=true}
                }
            }
        }
        let bytes=overhead+steps.capacity()*std::mem::size_of::<Step>()+steps.len()*Self::SCRATCH+keys;
        if bytes>limit{return Ok(None)}
        Ok(Some(Self{steps,root_zero,bytes}))
    }
    pub(crate) fn bytes(&self)->usize{self.bytes}
    pub(crate) fn nodes(&self)->usize{self.steps.len()}
    pub(crate) fn padding(&self,doc:&Document,camera:Transform)->Result<Option<i32>,String>{
        let mut matrices:Vec<Transform>=Vec::new();let mut own:Vec<i32>=Vec::new();let mut children:Vec<Option<i32>>=Vec::new();
        if matrices.try_reserve_exact(self.steps.len()).is_err()||own.try_reserve_exact(self.steps.len()).is_err()||children.try_reserve_exact(self.steps.len()).is_err(){return Ok(None)}
        for step in &self.steps {
            crate::render_cancellation::checkpoint()?;
            let parent=if step.parent==ROOT{camera}else{matrices[step.parent as usize]};
            let matrix=parent.concat(step.transform);matrices.push(matrix);
            own.push(step.effect_node.as_deref().map_or(0,|id|crate::geometry_snapshot::effect_halo(&doc.nodes[id],matrix)));
            children.push(step.zero_child.then_some(0));
        }
        let mut result=self.root_zero.then_some(0);
        for i in (0..self.steps.len()).rev(){
            let value=own[i].saturating_add(children[i].unwrap_or(0));let parent=self.steps[i].parent;
            let target=if parent==ROOT{&mut result}else{&mut children[parent as usize]};
            *target=Some(target.map_or(value,|old|old.max(value)));
        }
        Ok(Some(result.unwrap_or(0)))
    }
}

#[cfg(test)] mod tests {
    use super::*;use serde_json::json;
    fn original(doc:&Document,id:&str,parent:Transform)->i32{
        let n=&doc.nodes[id];if !n.visible{return 0}let m=parent.concat(n.transform);
        crate::geometry_snapshot::effect_halo(n,m).saturating_add(n.children.iter().map(|id|original(doc,id,m)).max().unwrap_or(0))
    }
    #[test] fn sparse_effect_program_preserves_exact_composition_and_ignores_empty_branches(){
        let mut doc:Document=serde_json::from_value(json!({"schemaVersion":20,"id":"d","name":"m","pages":[{"id":"p","name":"p","background":"#ffffff","children":["root"]}],"nodes":{
            "root":{"id":"root","kind":"group","width":1,"height":1,"children":["branch","hidden"]},
            "branch":{"id":"branch","kind":"group","width":1,"height":1,"transform":[1.25,0.125,-0.375,0.75,1234.5,-928.125],"children":["leaf"]},
            "leaf":{"id":"leaf","kind":"rectangle","width":20,"height":20,"transform":[0.5,-0.2,0.125,1.3,-1234.125,928.375],"effects":[{"kind":"shadow","radius":3.75,"x":-2.25,"color":"#000000"},{"kind":"gaussian-blur","radius":1.125,"color":"#000000"}]},
            "hidden":{"id":"hidden","kind":"rectangle","visible":false,"width":1,"height":1,"effects":[{"kind":"blur","radius":1000,"color":"#000000"}]}
        }})).unwrap();
        for i in 0..2000{let id=format!("empty{i}");let node=serde_json::from_value(json!({"id":id,"kind":"rectangle","width":1,"height":1})).unwrap();doc.nodes.get_mut("root").unwrap().children.push(id.clone());doc.nodes.insert(id,node);}
        let index=MarginIndex::build(&doc,&doc.pages[0].children,1024*1024).unwrap().unwrap();assert_eq!(index.nodes(),3);
        for scale in [0.001,0.125,1.,1.25,9.5,19.,32.,64.,128.]{
            let camera=Transform([scale,0.,0.,scale,0.25,-0.375]);
            assert_eq!(index.padding(&doc,camera).unwrap().unwrap(),original(&doc,"root",camera));
        }
        assert!(index.bytes()<=1024*1024);assert!(MarginIndex::build(&doc,&doc.pages[0].children,1).unwrap().is_none());
    }
    #[test] fn zero_effect_pages_need_no_per_camera_node_walk(){
        let doc:Document=serde_json::from_value(json!({"schemaVersion":1,"id":"d","name":"d","pages":[{"id":"p","name":"p","background":"#ffffff","children":["r"]}],"nodes":{"r":{"id":"r","kind":"rectangle","width":10,"height":10}}})).unwrap();
        let index=MarginIndex::build(&doc,&doc.pages[0].children,4096).unwrap().unwrap();assert_eq!(index.nodes(),0);assert_eq!(index.padding(&doc,Transform::default()).unwrap(),Some(0));
    }
}
