//! One resolution's bounded, exact operand memo. No quantization, fuzzy hash,
//! cross-document lifetime or changed Boolean tolerance is introduced.
use crate::{boolean::Operation, math::Transform, path::{Command, Path}, scene::Network};
use std::collections::HashMap;
#[derive(Default)]
pub(crate) struct Cache { entries: HashMap<Vec<u64>, Network>, bytes: usize, pub hits: usize }
impl Cache {
    pub fn key(inputs: &[(Path, Transform, bool)], op: Operation) -> Vec<u64> {
        let mut words=vec![match op { Operation::Union=>0,Operation::Subtract=>1,Operation::Intersect=>2,Operation::Exclude=>3 },inputs.len() as u64];
        for (path,m,rule) in inputs {
            words.extend(m.0.map(f64::to_bits)); words.push(*rule as u64);words.push(path.commands.len() as u64);
            for command in &path.commands {
                match *command {
                    Command::Move(p)=>{words.push(0);words.extend([p.x,p.y].map(f64::to_bits));},
                    Command::Line(p)=>{words.push(1);words.extend([p.x,p.y].map(f64::to_bits));},
                    Command::Quad(a,p)=>{words.push(2);words.extend([a.x,a.y,p.x,p.y].map(f64::to_bits));},
                    Command::Cubic(a,b,p)=>{words.push(3);words.extend([a.x,a.y,b.x,b.y,p.x,p.y].map(f64::to_bits));},
                    Command::Arc{center,radius,start,sweep}=>{words.push(4);words.extend([center.x,center.y,radius.x,radius.y,start,sweep].map(f64::to_bits));},
                    Command::SmoothCorner(c)=>{words.push(5);words.extend([c.center.x,c.center.y,c.radius,c.power].map(f64::to_bits));words.push(c.quadrant as u64);},
                    Command::Close=>words.push(6),
                }
            }
        }
        words
    }
    pub fn get(&mut self,key:&[u64])->Option<Network>{let result=self.entries.get(key)?.clone();self.hits+=1;Some(result)}
    pub fn insert(&mut self,key:Vec<u64>,value:&Network){
        // Charge owned geometry and strings, not JSON length (short numbers
        // can serialize to fewer bytes than their in-memory representation).
        let geometry = value.vertices.len()*std::mem::size_of::<crate::scene::Vertex>()
            + value.vertices.iter().map(|v|v.id.len()).sum::<usize>()
            + value.edges.len()*std::mem::size_of::<crate::scene::Edge>()
            + value.edges.iter().map(|e|e.id.len()+e.from.len()+e.to.len()).sum::<usize>()
            + value.filled_faces.as_ref().map_or(0,|faces|faces.len()*std::mem::size_of::<Vec<String>>()
                + faces.iter().map(|face|face.len()*std::mem::size_of::<String>()+face.iter().map(String::len).sum::<usize>()).sum::<usize>())
            + value.fill_rule.len();
        let size=key.capacity()*8+geometry+256;
        if self.entries.len()<1024 && size<=8*1024*1024usize-self.bytes {
            self.bytes+=size;self.entries.insert(key,value.clone());
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keys_preserve_order_fill_rules_phase_and_signed_zero(){
        let p=Path{commands:vec![Command::Move(crate::math::Point::new(0.,0.)),Command::Close]};
        let input=vec![(p,Transform::default(),true)];let key=Cache::key(&input,Operation::Union);
        let mut changed=input.clone();changed[0].1.0[4]=-0.;assert_ne!(key,Cache::key(&changed,Operation::Union));
        changed=input.clone();changed[0].2=false;assert_ne!(key,Cache::key(&changed,Operation::Union));
        assert_ne!(key,Cache::key(&input,Operation::Subtract));
    }
}
