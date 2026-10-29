//! Revision-owned, camera-independent support for ordinary foreground islands.
//! Unknown optical/mask/stroke subtrees retain ordinary traversal. These bounds
//! only reject work; device geometry and every pixel still use the old compiler.
use crate::{font::Fonts,math::{Point,Rect,Transform},path::{Command,Path},scene::{Document,Node}};
use std::collections::HashMap;

const LIMIT:usize=64*1024*1024;
#[derive(Clone,Copy,Debug)]
enum Bounds {Unknown,Empty,Box([f64;4])}
impl Bounds {
    fn union(self,other:Self)->Self {match(self,other){
        (Self::Unknown,_)|(_,Self::Unknown)=>Self::Unknown,
        (Self::Empty,b)|(b,Self::Empty)=>b,
        (Self::Box(a),Self::Box(b))=>Self::Box([a[0].min(b[0]),a[1].min(b[1]),a[2].max(b[2]),a[3].max(b[3])]),
    }}
}
#[derive(Clone,Copy,Debug)]
struct Entry {bounds:Bounds,magnitude:[f64;2],linear:f64,translation:f64,depth:u32,max_depth:u32,own_halo:f64,path_halo:f64}
fn add(a:f64,b:f64)->f64 {if a==0. {b}else if b==0. {a}else{(a+b).next_up()}}
fn mul(a:f64,b:f64)->f64 {if a==0.||b==0. {0.}else{(a*b).next_up()}}
fn absolute_concat(a:Transform,b:Transform)->Transform {
    let a=a.0;let b=b.0.map(f64::abs);
    Transform([add(mul(a[0],b[0]),mul(a[2],b[1])),add(mul(a[1],b[0]),mul(a[3],b[1])),
        add(mul(a[0],b[2]),mul(a[2],b[3])),add(mul(a[1],b[2]),mul(a[3],b[3])),
        add(add(mul(a[0],b[4]),mul(a[2],b[5])),a[4]),add(add(mul(a[1],b[4]),mul(a[3],b[5])),a[5])])
}
fn gamma(depth:u32)->f64 {
    // More than four times the operations on any affine-composition path.
    // EPSILON is twice the binary64 unit roundoff. The directed positive
    // magnitude chain also encloses reassociation/cancellation amplification.
    let error=(f64::from(depth)+2.)*16.*f64::EPSILON;
    (error/(1.-error)).next_up()
}
fn path_bounds(path:&Path)->Bounds {
    let mut bound:Option<[f64;4]>=None;
    let mut push=|p:Point|{
        if !p.finite()||p.x.abs()>1e8||p.y.abs()>1e8 {return false}
        if let Some(b)=&mut bound {b[0]=b[0].min(p.x);b[1]=b[1].min(p.y);b[2]=b[2].max(p.x);b[3]=b[3].max(p.y)}
        else{bound=Some([p.x,p.y,p.x,p.y])}true
    };
    for c in &path.commands {
        let points=match *c {
            Command::Move(p)|Command::Line(p)=>[Some(p),None,None,None],
            Command::Quad(a,b)=>[Some(a),Some(b),None,None],
            Command::Cubic(a,b,c)=>[Some(a),Some(b),Some(c),None],
            Command::Arc{center:c,radius:r,..}=>[Some(c-r),Some(c+r),Some(Point::new(c.x-r.x,c.y+r.y)),Some(Point::new(c.x+r.x,c.y-r.y))],
            Command::SmoothCorner(c)=>{let r=Point::new(c.radius,c.radius);[Some(c.center-r),Some(c.center+r),Some(Point::new(c.center.x-r.x,c.center.y+r.y)),Some(Point::new(c.center.x+r.x,c.center.y-r.y))]},
            Command::Close=>continue,
        };
        for p in points.into_iter().flatten(){if !push(p){return Bounds::Unknown}}
    }
    bound.map_or(Bounds::Empty,Bounds::Box)
}
fn local_bounds(n:&Node,fonts:&Fonts)->Bounds {
    if n.mask||n.effects.iter().any(|e|e.visible&&(!matches!(e.kind.as_str(),"blur"|"shadow"|"inner-shadow")||e.gradient_blur.is_some()||e.glass.is_some()||e.texture.is_some()))||n.strokes.iter().any(|s|s.visible&&s.width>0.)||n.vector_brush.is_some()||n.path_offset!=0. {return Bounds::Unknown}
    if n.kind=="text" {return fonts.node_path_shared(n).map_or(Bounds::Unknown,|p|path_bounds(&p))}
    if let Some(p)=&n.derived_path{return path_bounds(p)}
    if let Some(r)=crate::geometry_support::leaf_control_bounds(n,Transform::default()) {
        let b=[f64::from(r.x),f64::from(r.y),f64::from(r.right()),f64::from(r.bottom())];
        return if b.iter().all(|v|v.abs()<=1e8){Bounds::Box(b)}else{Bounds::Unknown};
    }
    // Plain empty containers do not need a pair of allocated paths.
    if n.kind=="group"&&n.network.is_none()&&n.vector_geometry.is_none(){return Bounds::Empty}
    n.paths().map_or(Bounds::Unknown,|(a,b)|path_bounds(&a).union(path_bounds(&b)))
}
fn world_entry(n:&Node,m:Transform,absolute:Transform,depth:u32,fonts:&Fonts)->Entry {
    let mut entry=Entry{bounds:Bounds::Unknown,magnitude:[0.;2],linear:absolute.0[..4].iter().copied().fold(0.,f64::max),
        translation:absolute.0[4].max(absolute.0[5]),depth,max_depth:depth,own_halo:0.,path_halo:0.};
    if depth>4096||m.0.iter().chain(absolute.0.iter()).any(|v|!v.is_finite()||v.abs()>1e12){return entry}
    let a=absolute.0;
    let frobenius=add(add(mul(a[0],a[0]),mul(a[1],a[1])),add(mul(a[2],a[2]),mul(a[3],a[3]))).sqrt().next_up();
    // Preparation clamps tiny device scales to 1e-6. A world floor of 1e-3
    // encloses that clamp for every admitted camera scale >= 1e-3.
    entry.own_halo=n.effect_outset(mul(frobenius,1.+gamma(depth)).max(0.001)).next_up();
    entry.path_halo=entry.own_halo;
    if !entry.own_halo.is_finite(){return entry}
    entry.bounds=match local_bounds(n,fonts){
        Bounds::Box(b)=>{
            let x=b[0].abs().max(b[2].abs());let y=b[1].abs().max(b[3].abs());let a=absolute.0;
            entry.magnitude=[add(add(mul(a[0],x),mul(a[2],y)),a[4]),add(add(mul(a[1],x),mul(a[3],y)),a[5])];
            let mut r=[f64::INFINITY,f64::INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY];
            for p in [Point::new(b[0],b[1]),Point::new(b[0],b[3]),Point::new(b[2],b[1]),Point::new(b[2],b[3])]{
                let p=m.point(p);r[0]=r[0].min(p.x);r[1]=r[1].min(p.y);r[2]=r[2].max(p.x);r[3]=r[3].max(p.y);
            }
            let ex=mul(gamma(depth),entry.magnitude[0]);let ey=mul(gamma(depth),entry.magnitude[1]);
            r=[(r[0]-ex).next_down(),(r[1]-ey).next_down(),(r[2]+ex).next_up(),(r[3]+ey).next_up()];
            if r.iter().any(|v|!v.is_finite()||v.abs()>1e12){Bounds::Unknown}else{Bounds::Box(r)}
        },other=>other,
    };entry
}
pub(crate) struct WorldSupport {entries:HashMap<String,Entry>,bytes:usize}
impl WorldSupport {
    /// Remember a declined optional allocation for this exact revision/page.
    /// A new camera must not rebuild the same over-budget index on every tile.
    pub(crate) fn disabled()->Self{Self{entries:HashMap::new(),bytes:0}}
    pub(crate) fn build(doc:&Document,roots:&[String],fonts:&Fonts,budget:usize)->Result<Option<Self>,String>{
        let limit=LIMIT.min(budget);
        let mut entries=HashMap::<String,Entry>::new();let mut key_bytes=0usize;
        let frame_bytes=std::mem::size_of::<(&str,Transform,Transform,u32,bool)>();
        if roots.len().saturating_mul(frame_bytes)>limit/2{return Ok(None)}
        let mut stack=roots.iter().rev().map(|id|(id.as_str(),Transform::default(),Transform::default(),0_u32,false)).collect::<Vec<_>>();
        while let Some((id,parent,absolute,depth,finish))=stack.pop(){
            crate::render_cancellation::checkpoint()?;
            let n=&doc.nodes[id];
            if finish {
                let mut entry=entries[id];
                let mut child_halo=0_f64;
                for child in n.render_children(){if let Some(c)=entries.get(child){
                    entry.bounds=entry.bounds.union(c.bounds);entry.max_depth=entry.max_depth.max(c.max_depth);
                    for axis in 0..2{entry.magnitude[axis]=entry.magnitude[axis].max(c.magnitude[axis])}
                    entry.linear=entry.linear.max(c.linear);entry.translation=entry.translation.max(c.translation);
                    child_halo=child_halo.max(c.path_halo);
                }}
                entry.path_halo=add(entry.own_halo,child_halo);
                if let Bounds::Box(b)=entry.bounds {let h=entry.own_halo;
                    entry.bounds=Bounds::Box([(b[0]-h).next_down(),(b[1]-h).next_down(),(b[2]+h).next_up(),(b[3]+h).next_up()]);
                    entry.magnitude[0]=add(entry.magnitude[0],h);entry.magnitude[1]=add(entry.magnitude[1],h);
                }
                entries.insert(id.to_owned(),entry);continue;
            }
            let matrix=parent.concat(n.transform);let absolute=absolute_concat(absolute,n.transform);
            let entry=if n.visible {world_entry(n,matrix,absolute,depth,fonts)}else{Entry{bounds:Bounds::Empty,magnitude:[0.;2],linear:0.,translation:0.,depth,max_depth:depth,own_halo:0.,path_halo:0.}};
            let projected=(entries.len()+1).saturating_mul(2*(std::mem::size_of::<(String,Entry)>()+32))
                .saturating_add(key_bytes).saturating_add(id.len()).saturating_add(stack.capacity()*frame_bytes);
            if projected>limit{return Ok(None)}
            key_bytes=key_bytes.saturating_add(id.len());entries.insert(id.to_owned(),entry);
            let bytes=entries.capacity().saturating_mul(std::mem::size_of::<(String,Entry)>()+32).saturating_add(key_bytes);
            if bytes.saturating_add(stack.capacity()*frame_bytes)>limit{return Ok(None)}
            if !n.visible{continue}
            if stack.len().saturating_add(n.render_children().len()+1).saturating_mul(frame_bytes*2).saturating_add(bytes)>limit{return Ok(None)}
            stack.push((id,matrix,absolute,depth,true));
            for child in n.render_children().iter().rev(){stack.push((child,matrix,absolute,depth.saturating_add(1),false))}
        }
        let bytes=entries.capacity().saturating_mul(std::mem::size_of::<(String,Entry)>()+32).saturating_add(key_bytes);
        Ok(Some(Self{entries,bytes}))
    }
    pub(crate) fn bytes(&self)->usize{self.bytes}
    pub(crate) fn culls(&self,id:&str,camera:Transform,guard:Rect)->bool{
        let Some(entry)=self.entries.get(id)else{return false};let m=camera.0;
        if m[1]!=0.||m[2]!=0.||m[0]!=m[3]||!(0.001..=128.).contains(&m[0])||!m[4].is_finite()||!m[5].is_finite(){return false}
        let roundoff=gamma(entry.max_depth);
        let transform=mul(add(mul(m[0],entry.translation),m[4].abs().max(m[5].abs())),1.+roundoff)
            .max(mul(mul(m[0],entry.linear),1.+roundoff));
        if !transform.is_finite()||transform>1e12{return false}
        if mul(m[0],entry.path_halo)>16_000_000. {return false}
        let Bounds::Box(b)=entry.bounds else{return matches!(entry.bounds,Bounds::Empty)};
        let padding=4.*f64::from(entry.max_depth.saturating_sub(entry.depth)+1)+1.;
        let ex=add(mul(roundoff,add(mul(m[0],entry.magnitude[0]),m[4].abs())),padding);
        let ey=add(mul(roundoff,add(mul(m[0],entry.magnitude[1]),m[5].abs())),padding);
        let x0=(m[0]*b[0]+m[4]-ex).next_down();let x1=(m[0]*b[2]+m[4]+ex).next_up();
        let y0=(m[0]*b[1]+m[5]-ey).next_down();let y1=(m[0]*b[3]+m[5]+ey).next_up();
        x1<f64::from(guard.x)||y1<f64::from(guard.y)||x0>f64::from(guard.right())||y0>f64::from(guard.bottom())
    }
}
pub(crate) struct Cache {pub(crate) revision:u64,pub(crate) page:String,pub(crate) quantized:bool,pub(crate) index:std::sync::Arc<WorldSupport>}
impl Clone for Cache {fn clone(&self)->Self {Self{revision:self.revision,page:self.page.clone(),quantized:self.quantized,index:self.index.clone()}}}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn document()->Document {serde_json::from_value(json!({"schemaVersion":16,"id":"d","name":"world",
        "pages":[{"id":"p","name":"p","children":["root"],"background":"#ffffff"}],"nodes":{
            "root":{"id":"root","kind":"group","width":1,"height":1,"children":["leaf"]},
            "leaf":{"id":"leaf","kind":"rectangle","width":20,"height":10,"transform":[1,0,0,1,10000,10000],"fills":[{"kind":"solid","color":"#abcdef"}]}
        }})).unwrap()}
    #[test]
    fn stable_world_bounds_follow_new_cameras_without_reusing_device_samples(){
        let d=document();let f=Fonts::new();let index=WorldSupport::build(&d,&d.pages[0].children,&f,LIMIT).unwrap().unwrap();
        assert!(index.culls("root",Transform::default(),Rect::new(0,0,64,64)));
        for scale in [0.001,0.125,1.,9.5,64.,128.] {
            let camera=Transform([scale,0.,0.,scale,-10000.*scale+0.25,-10000.*scale+0.375]);
            assert!(!index.culls("root",camera,Rect::new(0,0,64,64)));
        }
        assert!(index.bytes()<=LIMIT);
        assert!(WorldSupport::build(&d,&d.pages[0].children,&f,1).unwrap().is_none());
    }
    #[test]
    fn unknown_effects_masks_and_strokes_cannot_certify_a_whole_island(){
        for mode in 0..3 {
            let mut d=document();let n=d.nodes.get_mut("leaf").unwrap();
            match mode {0=>n.mask=true,1=>n.effects=serde_json::from_value(json!([{"kind":"background-blur","radius":1,"color":"#000000"}])).unwrap(),
                _=>n.strokes=serde_json::from_value(json!([{"width":1,"paint":{"kind":"solid","color":"#000000"}}])).unwrap()}
            let index=WorldSupport::build(&d,&d.pages[0].children,&Fonts::new(),LIMIT).unwrap().unwrap();
            assert!(!index.culls("root",Transform::default(),Rect::new(0,0,64,64)));
        }
    }
    #[test]
    fn foreground_shadow_support_keeps_offscreen_casters_that_reach_the_view(){
        let mut d=document();let n=d.nodes.get_mut("leaf").unwrap();n.transform=Transform([1.,0.,0.,1.,-64.,10.]);
        n.effects=serde_json::from_value(json!([{"kind":"shadow","radius":16,"x":100,"color":"#000000"}])).unwrap();
        let index=WorldSupport::build(&d,&d.pages[0].children,&Fonts::new(),LIMIT).unwrap().unwrap();
        assert!(!index.culls("root",Transform::default(),Rect::new(0,0,64,64)));
        assert!(index.culls("root",Transform([1.,0.,0.,1.,-10000.,0.]),Rect::new(0,0,64,64)));
    }
    #[test]
    fn alternating_large_translations_and_affine_rounding_cannot_hide_visible_controls(){
        for depth in [1,8,32,128] {
            let mut d=document();d.nodes.get_mut("leaf").unwrap().transform=Transform::default();
            let mut world=Transform::default();let mut id="root".to_owned();
            for i in 0..depth {
                let child=format!("g{i}");let shift=if i%2==0{1000000.125}else{-1000000.125};
                let matrix=Transform([1.,0.,0.0000001,1.,shift,shift*0.5]);
                let n:Node=serde_json::from_value(json!({"id":child,"kind":"group","width":1,"height":1,"transform":matrix,"children":["leaf"]})).unwrap();
                d.nodes.get_mut(&id).unwrap().children=vec![child.clone()];d.nodes.insert(child.clone(),n);id=child;world=world.concat(matrix);
            }
            let index=WorldSupport::build(&d,&d.pages[0].children,&Fonts::new(),LIMIT).unwrap().unwrap();
            for scale in [0.125,1.,9.5,64.] {
                let camera=Transform([scale,0.,0.,scale,-world.0[4]*scale+0.375,-world.0[5]*scale+0.125]);
                let mut actual=camera;
                let mut cursor="root";
                loop{let n=&d.nodes[cursor];actual=actual.concat(n.transform);if cursor=="leaf"{break}cursor=&n.children[0];}
                let p=actual.point(Point::new(10.,5.));let guard=Rect::new(p.x.floor() as i32-2,p.y.floor() as i32-2,5,5);
                assert!(!index.culls("root",camera,guard),"depth {depth}, scale {scale}");
            }
        }
    }
    #[test]
    fn production_packets_match_unculled_reference_after_zoom_masks_effects_and_mutation(){
        for mode in 0..3 {
            let mut d=document();
            let mut near=d.nodes["leaf"].clone();near.id="near".into();near.transform=Transform::default();
            if mode==1 {near.effects=serde_json::from_value(json!([{"kind":"shadow","radius":4,"x":3,"y":-1,"color":"#000000"}])).unwrap()}
            if mode==2 {near.mask=true;}
            d.nodes.get_mut("root").unwrap().children.push("near".into());d.nodes.insert("near".into(),near);
            let mut actual=crate::Engine::new();actual.load_document(&serde_json::to_string(&d).unwrap()).unwrap();
            for zoom in [1.,2.,0.125,4.,1.] {
                let mut reference=crate::Engine::new();reference.load_document(&serde_json::to_string(&d).unwrap()).unwrap();reference.resolve_layout().unwrap();
                reference.world_support=Some(Cache{revision:reference.geo_revision,page:"p".into(),quantized:false,index:std::sync::Arc::new(WorldSupport{entries:HashMap::new(),bytes:0})});
                let options:crate::RenderOptions=serde_json::from_value(json!({"pageId":"p","width":64,"height":64,"view":{"x":0.25,"y":0.375,"zoom":zoom},"rasterProfile":"figmaSubpixel"})).unwrap();
                assert_eq!(serde_json::to_value(actual.compile_gpu(&options).unwrap()).unwrap(),serde_json::to_value(reference.compile_gpu(&options).unwrap()).unwrap(),"mode {mode} zoom {zoom}");
            }
            d.nodes.get_mut("leaf").unwrap().transform=Transform([1.,0.,0.,1.,30.,10.]);
            actual.load_document(&serde_json::to_string(&d).unwrap()).unwrap();assert!(actual.world_support.is_none());
            let options:crate::RenderOptions=serde_json::from_value(json!({"pageId":"p","width":64,"height":64,"view":{"x":0,"y":0,"zoom":1},"rasterProfile":"figmaSubpixel"})).unwrap();
            let mut fresh=crate::Engine::new();fresh.load_document(&serde_json::to_string(&d).unwrap()).unwrap();
            assert_eq!(serde_json::to_value(actual.compile_gpu(&options).unwrap()).unwrap(),serde_json::to_value(fresh.compile_gpu(&options).unwrap()).unwrap());
        }
    }
}
