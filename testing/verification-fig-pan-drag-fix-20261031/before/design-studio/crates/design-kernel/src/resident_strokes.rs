//! Bounded local-space stroke geometry. Camera translation never enters this
//! key. Scale-sensitive tessellation tolerances remain bit-exact; the caller
//! applies the original binary64 device transform in its original order.
use crate::{math::Transform,path::Contour,scene::Stroke};
use std::{collections::{HashMap,VecDeque},sync::Arc};

#[derive(Clone,Hash,PartialEq,Eq)]
struct Key { owner:usize, flat:u64, expansion:u64, style:Arc<[u8]> }
#[derive(Clone)]
struct Entry { _owner:crate::path::SharedPaths, key:Key, contours:Arc<Vec<Contour>>, bytes:usize, stamp:u64 }
#[derive(Clone,Default)]
pub(crate) struct ResidentStrokes {
    entries:HashMap<Key,Entry>, order:VecDeque<(Key,u64)>, stamp:u64,
    bytes:usize,hits:u64,builds:u64,
}
impl ResidentStrokes {
    const LIMIT:usize=16*1024*1024;
    pub(crate) fn stats(&self)->serde_json::Value {serde_json::json!({"bytes":self.bytes,"entries":self.entries.len(),"hits":self.hits,"builds":self.builds})}
    pub(crate) fn clear(&mut self){self.entries.clear();self.order.clear();self.bytes=0;}
    pub(crate) fn get(&mut self,paths:&crate::path::SharedPaths,stroke:&Stroke,flat:f64,expansion:f64)->Result<Arc<Vec<Contour>>,String>{
        // Exhaustive destructuring requires revisiting this proof when Stroke
        // gains a field. Material/id/visibility do not enter stroke::expand.
        let Stroke {paint:_,id:_,visible:_,width,align,cap,join,dash,dash_offset,width_profile,start_marker,end_marker}=stroke;
        let style=serde_json::to_vec(&(width.to_bits(),align,cap,join,dash,dash_offset.to_bits(),start_marker,end_marker,
            width_profile.iter().map(|p|[p.position.to_bits(),p.left.to_bits(),p.right.to_bits()]).collect::<Vec<_>>())).map_err(|e|e.to_string())?;
        let key=Key{owner:Arc::as_ptr(paths) as usize,flat:flat.to_bits(),expansion:expansion.to_bits(),style:style.into()};
        if self.stamp==u64::MAX {self.clear();self.stamp=0;} self.stamp+=1;
        if let Some(entry)=self.entries.get_mut(&key){
            self.hits+=1;entry.stamp=self.stamp;let value=entry.contours.clone();
            // Touches share the admitted style allocation; a long dash array
            // must not be cloned into every lazy LRU record.
            self.order.push_back((entry.key.clone(),self.stamp));
            self.compact_order();return Ok(value);
        }
        self.builds+=1;
        let local=paths.pair().1.flatten(Transform::default(),flat)?;
        let contours=Arc::new(crate::stroke::expand(&local,stroke,expansion,0.)?);
        let bytes=contours.capacity()*std::mem::size_of::<Contour>()+
            contours.iter().map(|c|c.points.capacity()*std::mem::size_of::<crate::math::Point>()).sum::<usize>()+
            (paths.pair().0.commands.capacity()+paths.pair().1.commands.capacity())*std::mem::size_of::<crate::path::Command>()+
            key.style.len()+512;
        if bytes>Self::LIMIT{return Ok(contours);}
        while self.bytes+bytes>Self::LIMIT || self.entries.len()>=4096 {
            let Some((old,stamp))=self.order.pop_front() else {break;};
            if self.entries.get(&old).is_some_and(|e|e.stamp==stamp){self.bytes-=self.entries.remove(&old).unwrap().bytes;}
        }
        self.bytes+=bytes;self.order.push_back((key.clone(),self.stamp));
        self.entries.insert(key.clone(),Entry{_owner:paths.clone(),key,contours:contours.clone(),bytes,stamp:self.stamp});
        self.compact_order();Ok(contours)
    }
    fn compact_order(&mut self){
        // Lazy LRU touches are bounded. Compaction is amortized O(1) per hit,
        // rather than a full-cache victim scan on every allocation.
        if self.order.len()>self.entries.len()*2+256 {
            self.order.retain(|(key,stamp)|self.entries.get(key).is_some_and(|e|e.stamp==*stamp));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path::Path;
    fn words(cs:&[Contour])->Vec<u64>{cs.iter().flat_map(|c|std::iter::once(u64::from(c.closed)).chain(c.points.iter().flat_map(|p|[p.x.to_bits(),p.y.to_bits()]))).collect()}
    #[test]
    fn residency_preserves_exact_geometry_and_all_geometry_dependencies() {
        let p=Path::ellipse(80.,48.);let owner=Arc::new(crate::path::LocalPaths::Owned((p.clone(),p)));
        let mut s:Stroke=serde_json::from_value(serde_json::json!({"paint":{"kind":"solid","color":"#113355"},"width":3.,"cap":"round","join":"round","dash":"4 2"})).unwrap();
        let mut cache=ResidentStrokes::default();
        for step in 0..8 {
            if step==2{s.paint.color="#ff0000".into();}
            if step==3{s.width=4.;}
            if step==4{s.dash_offset=0.375;}
            if step==5{s.width_profile=vec![crate::stroke::WidthPoint{position:0.,left:0.5,right:1.},crate::stroke::WidthPoint{position:1.,left:0.5,right:1.}];}
            let tolerance=if step==7 {0.0625}else{0.125};
            let actual=cache.get(&owner,&s,tolerance,tolerance).unwrap();
            let original=crate::stroke::expand(&owner.pair().1.flatten(Transform::default(),tolerance).unwrap(),&s,tolerance,0.).unwrap();
            assert_eq!(words(&actual),words(&original));
        }
        assert_eq!(cache.hits,3);assert_eq!(cache.builds,5);
        for _ in 0..1000{cache.get(&owner,&s,0.0625,0.0625).unwrap();}
        assert!(cache.order.len()<=cache.entries.len()*2+256);assert!(cache.bytes<=ResidentStrokes::LIMIT);
        for (key,_) in &cache.order {
            if let Some(entry)=cache.entries.get(key) {
                assert!(Arc::ptr_eq(&key.style,&entry.key.style));
            }
        }
        let other=Arc::new(crate::path::LocalPaths::Owned((owner.pair().0.clone(),owner.pair().1.clone())));
        cache.get(&other,&s,0.0625,0.0625).unwrap();assert_eq!(cache.builds,6);
    }
}
