//! Serializable f64 render geometry, independent of the point-editing graph.
//! This is a facet of the existing Node, not a second scene or renderer. Source
//! curves are retained exactly; tessellation remains in the existing pipeline.
use crate::{
    math::Point,
    path::{Command, Path},
    scene::{Edge, Network, Vertex},
};
use serde::{Deserialize, Serialize};

pub const MAX_COMMANDS: usize = 131_072;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Curve {
    Move([f64; 2]),
    Line([f64; 2]),
    Quad([f64; 4]),
    Cubic([f64; 6]),
    Close,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VectorGeometry {
    pub fill_rule: String,
    pub fill: Vec<Curve>,
    /// None shares the fill curves; Some(empty) explicitly has no stroke.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<Vec<Curve>>,
}
fn point(p: [f64; 2]) -> Point {
    Point::new(p[0], p[1])
}
pub(crate) fn encode(path: &Path) -> Result<Vec<Curve>, String> {
    path.commands.iter().map(|command| Ok(match *command {
        Command::Move(p) => Curve::Move([p.x,p.y]),
        Command::Line(p) => Curve::Line([p.x,p.y]),
        Command::Quad(c,p) => Curve::Quad([c.x,c.y,p.x,p.y]),
        Command::Cubic(a,b,p) => Curve::Cubic([a.x,a.y,b.x,b.y,p.x,p.y]),
        Command::Close => Curve::Close,
        _ => return Err("Native arcs retain their parametric authoring; no implicit curve approximation".into()),
    })).collect()
}
fn decode(curves: &[Curve]) -> Path {
    Path {
        commands: curves
            .iter()
            .map(|curve| match *curve {
                Curve::Move(p) => Command::Move(point(p)),
                Curve::Line(p) => Command::Line(point(p)),
                Curve::Quad(p) => Command::Quad(point([p[0], p[1]]), point([p[2], p[3]])),
                Curve::Cubic(p) => Command::Cubic(
                    point([p[0], p[1]]),
                    point([p[2], p[3]]),
                    point([p[4], p[5]]),
                ),
                Curve::Close => Command::Close,
            })
            .collect(),
    }
}
impl VectorGeometry {
    /// Sketch contours already have an authored traversal. Preserve it directly
    /// instead of constructing face topology just to rediscover this ordering.
    pub fn ordered_network(network: &Network, closed: bool) -> Result<Self, String> {
        let count = network.vertices.len();
        if count > MAX_COMMANDS - 2
            || network.edges.len()
                != if closed {
                    count
                } else {
                    count.saturating_sub(1)
                }
        {
            return Err("Invalid ordered contour".into());
        }
        let mut path = Path::default();
        if let Some(first) = network.vertices.first() {
            path.commands.push(Command::Move(first.point()));
        }
        for (i, edge) in network.edges.iter().enumerate() {
            let from = &network.vertices[i];
            let to = &network.vertices[(i + 1) % count];
            if edge.from != from.id || edge.to != to.id {
                return Err("Contour traversal changed".into());
            }
            path.commands
                .push(if edge.c1.is_some() || edge.c2.is_some() {
                    Command::Cubic(
                        edge.c1.unwrap_or(from.point()),
                        edge.c2.unwrap_or(to.point()),
                        to.point(),
                    )
                } else {
                    Command::Line(to.point())
                });
        }
        if closed && count > 0 {
            path.commands.push(Command::Close);
        }
        let empty = Path::default();
        Self::from_paths(
            if closed { &path } else { &empty },
            &path,
            &network.fill_rule,
        )
    }
    pub fn from_paths(fill: &Path, stroke: &Path, rule: &str) -> Result<Self, String> {
        let fill = encode(fill)?;
        let line = encode(stroke)?;
        let value = Self {
            fill_rule: rule.into(),
            stroke: if fill == line { None } else { Some(line) },
            fill,
        };
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.fill_rule.as_str(), "evenodd" | "nonzero")
            || self
                .fill
                .len()
                .saturating_add(self.stroke.as_ref().map_or(0, Vec::len))
                > MAX_COMMANDS
        {
            return Err(
                "Vector render geometry exceeds its command allowance or has an invalid fill rule"
                    .into(),
            );
        }
        for (curves, fill) in [
            (&self.fill, true),
            (self.stroke.as_ref().unwrap_or(&self.fill), false),
        ] {
            let mut open = false;
            for curve in curves {
                let coords: &[f64] = match curve {
                    Curve::Move(p) => {
                        if fill && open {
                            return Err("Fill contours must close explicitly".into());
                        }
                        open = true;
                        p
                    }
                    Curve::Line(p) => p,
                    Curve::Quad(p) => p,
                    Curve::Cubic(p) => p,
                    Curve::Close => &[],
                };
                if !open || coords.iter().any(|v| !v.is_finite() || v.abs() > 1e7) {
                    return Err("Invalid vector render curve".into());
                }
                if matches!(curve, Curve::Close) {
                    open = false;
                }
            }
            if fill && open {
                return Err("Fill contours must close explicitly".into());
            }
        }
        Ok(())
    }
    pub fn paths(&self) -> Result<(Path, Path), String> {
        self.validate()?;
        Ok((
            decode(&self.fill),
            decode(self.stroke.as_ref().unwrap_or(&self.fill)),
        ))
    }
    pub fn scale(&mut self, sx: f64, sy: f64) {
        for curve in self.fill.iter_mut().chain(self.stroke.iter_mut().flatten()) {
            let values: &mut [f64] = match curve {
                Curve::Move(p) | Curve::Line(p) => p,
                Curve::Quad(p) => p,
                Curve::Cubic(p) => p,
                Curve::Close => continue,
            };
            for pair in values.chunks_exact_mut(2) {
                pair[0] *= sx;
                pair[1] *= sy;
            }
        }
    }
    /// Materialize only for explicit point editing or a bounded format encoder.
    /// No command is flattened or rounded. Independent fill/stroke topology must
    /// remain in its original representation instead of fabricating editable faces.
    pub fn network(&self, limit: usize) -> Result<Network, String> {
        self.validate()?;
        let curves = self.stroke.as_ref().unwrap_or(&self.fill);
        let mut network = Network {
            vertices: Vec::new(),
            edges: Vec::new(),
            fill_rule: self.fill_rule.clone(),
            filled_faces: None,
        };
        let mut start: Option<usize> = None;
        let mut at: Option<usize> = None;
        let mut closed = Vec::new();
        let mut contour = Vec::new();
        let add_vertex = |network: &mut Network, p: Point| {
            let index = network.vertices.len();
            network.vertices.push(Vertex {
                id: format!("v{index}"),
                x: p.x,
                y: p.y,
            });
            index
        };
        for curve in curves {
            if network.vertices.len() > limit || network.edges.len() > limit * 2 {
                return Err("Point editing working set exceeded; retain render geometry and edit a smaller source object".into());
            }
            match *curve {
                Curve::Move(p) => {
                    contour.clear();
                    contour.push(curve.clone());
                    let index = add_vertex(&mut network, point(p));
                    start = Some(index);
                    at = Some(index);
                }
                Curve::Close => {
                    let from = at.ok_or("Missing contour start")?;
                    let to = start.unwrap();
                    if from != to {
                        network.edges.push(Edge {
                            id: format!("e{}", network.edges.len()),
                            from: format!("v{from}"),
                            to: format!("v{to}"),
                            c1: None,
                            c2: None,
                        });
                    }
                    contour.push(Curve::Close);
                    closed.append(&mut contour);
                    at = None;
                }
                _ => {
                    contour.push(curve.clone());
                    let from = at.ok_or("Missing contour start")?;
                    let a = network.vertices[from].point();
                    let (end, c1, c2) = match *curve {
                        Curve::Line(p) => (point(p), None, None),
                        Curve::Cubic(p) => (
                            point([p[4], p[5]]),
                            Some(point([p[0], p[1]])),
                            Some(point([p[2], p[3]])),
                        ),
                        Curve::Quad(p) => {
                            let c = point([p[0], p[1]]);
                            let end = point([p[2], p[3]]);
                            (
                                end,
                                Some(a + (c - a) * (2. / 3.)),
                                Some(end + (c - end) * (2. / 3.)),
                            )
                        }
                        _ => unreachable!(),
                    };
                    let first = &network.vertices[start.unwrap()];
                    let to = if end.x.to_bits() == first.x.to_bits()
                        && end.y.to_bits() == first.y.to_bits()
                    {
                        start.unwrap()
                    } else {
                        add_vertex(&mut network, end)
                    };
                    network.edges.push(Edge {
                        id: format!("e{}", network.edges.len()),
                        from: format!("v{from}"),
                        to: format!("v{to}"),
                        c1,
                        c2,
                    });
                    at = Some(to);
                }
            }
        }
        if network.vertices.len() > limit || network.edges.len() > limit * 2 {
            return Err("Point editing working set exceeded".into());
        }
        if self.fill != closed {
            return Err("Independent fill geometry requires its own source editing session".into());
        }
        Ok(network)
    }
}

/// Exact immutable geometry identity. Hashing is only an index; comparison
/// retains every binary64 bit (including signed zero), curve order and the
/// distinction between absent and explicitly empty stroke geometry.
#[derive(Clone)]
pub(crate) struct GeometryKey(pub(crate) std::sync::Arc<VectorGeometry>);
fn curve_words(curve:&Curve)->(u8,&[f64]) {
    match curve {Curve::Move(p)=>(0,p),Curve::Line(p)=>(1,p),Curve::Quad(p)=>(2,p),Curve::Cubic(p)=>(3,p),Curve::Close=>(4,&[])}
}
impl std::hash::Hash for GeometryKey {
    fn hash<H:std::hash::Hasher>(&self,state:&mut H){
        self.0.fill_rule.hash(state);
        for curves in [Some(&self.0.fill),self.0.stroke.as_ref()] {
            curves.is_some().hash(state);
            if let Some(curves)=curves {
                curves.len().hash(state);
                for curve in curves {let (kind,words)=curve_words(curve);kind.hash(state);for word in words {word.to_bits().hash(state)}}
            }
        }
    }
}
impl PartialEq for GeometryKey {
    fn eq(&self,other:&Self)->bool {
        if std::sync::Arc::ptr_eq(&self.0,&other.0){return true}
        let same=|a:&[Curve],b:&[Curve]|a.len()==b.len()&&a.iter().zip(b).all(|(a,b)|{
            let (ka,a)=curve_words(a);let(kb,b)=curve_words(b);ka==kb&&a.iter().zip(b).all(|(a,b)|a.to_bits()==b.to_bits())
        });
        self.0.fill_rule==other.0.fill_rule&&same(&self.0.fill,&other.0.fill)&&match (&self.0.stroke,&other.0.stroke){
            (None,None)=>true,(Some(a),Some(b))=>same(a,b),_=>false,
        }
    }
}
impl Eq for GeometryKey {}

/// A build-local pool. Node retains the immutable source; ordinary edits use
/// Arc::make_mut and detach only the geometry being edited.
#[derive(Default)]
pub struct GeometryPool { values:std::collections::HashSet<GeometryKey> }
impl GeometryPool {
    pub fn intern(&mut self,value:&mut std::sync::Arc<VectorGeometry>){
        let key=GeometryKey(value.clone());
        if let Some(known)=self.values.get(&key){*value=known.0.clone()}else{self.values.insert(key);}
    }
}

#[cfg(test)] mod sharing_tests {
    use super::*;
    use std::sync::Arc;
    fn geometry()->VectorGeometry {VectorGeometry{fill_rule:"nonzero".into(),fill:vec![Curve::Move([-0.,1.]),Curve::Line([10.,0.]),Curve::Line([10.,10.]),Curve::Close],stroke:None}}
    #[test] fn immutable_curves_share_and_a_resize_detaches_only_the_edited_value(){
        let mut a=Arc::new(geometry());let mut b=Arc::new(geometry());let mut pool=GeometryPool::default();
        pool.intern(&mut a);pool.intern(&mut b);assert!(Arc::ptr_eq(&a,&b));
        let before=serde_json::to_vec(&a).unwrap();Arc::make_mut(&mut b).scale(2.,3.);
        assert!(!Arc::ptr_eq(&a,&b));assert_eq!(serde_json::to_vec(&a).unwrap(),before);assert_ne!(serde_json::to_vec(&b).unwrap(),before);
    }
    #[test] fn sharing_never_collapses_signed_zero_or_explicit_empty_strokes(){
        let mut a=Arc::new(geometry());let mut positive=geometry();positive.fill[0]=Curve::Move([0.,1.]);
        let mut positive=Arc::new(positive);let mut empty=geometry();empty.stroke=Some(vec![]);let mut empty=Arc::new(empty);
        let mut pool=GeometryPool::default();for value in [&mut a,&mut positive,&mut empty]{pool.intern(value)}
        assert!(!Arc::ptr_eq(&a,&positive));assert!(!Arc::ptr_eq(&a,&empty));
        assert_ne!(GeometryKey(a.clone())==GeometryKey(positive.clone()),true);
    }
}

#[cfg(not(target_arch="wasm32"))]
pub(crate) mod packed {
    use super::{Curve,VectorGeometry,MAX_COMMANDS,curve_words};
    use base64::Engine as _;
    use serde::{Serialize,Deserialize};
    const MAX_BYTES:usize=4+MAX_COMMANDS*49;
    #[derive(Serialize,Deserialize)]
    #[serde(rename_all="camelCase",deny_unknown_fields)]
    pub(crate) struct PackedGeometry {fill_rule:String,fill:String,stroke:Option<String>}
    fn encode(curves:&[Curve])->Result<String,String>{
        if curves.len()>MAX_COMMANDS{return Err("Packed geometry command budget exceeded".into())}
        let mut bytes=Vec::new();bytes.try_reserve_exact(4+curves.len()*17).map_err(|e|e.to_string())?;
        bytes.extend_from_slice(&(curves.len() as u32).to_le_bytes());
        for curve in curves {let (kind,words)=curve_words(curve);bytes.push(kind);
            for word in words {if !word.is_finite(){return Err("Nonfinite packed geometry".into())}bytes.extend_from_slice(&word.to_le_bytes());}
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }
    fn decode(text:&str)->Result<Vec<Curve>,String>{
        if text.len()>(MAX_BYTES+2)/3*4{return Err("Packed geometry byte budget exceeded".into())}
        let bytes=base64::engine::general_purpose::STANDARD.decode(text).map_err(|_|"Invalid packed geometry bytes")?;
        let count=u32::from_le_bytes(bytes.get(..4).ok_or("Missing packed geometry length")?.try_into().unwrap()) as usize;
        if count>MAX_COMMANDS||count>bytes.len().saturating_sub(4){return Err("Invalid packed geometry count".into())}
        let mut curves=Vec::new();curves.try_reserve_exact(count).map_err(|e|e.to_string())?;let mut at=4;
        for _ in 0..count {
            let kind=*bytes.get(at).ok_or("Truncated packed geometry")?;at+=1;
            let words=match kind{0|1=>2,2=>4,3=>6,4=>0,_=>return Err("Unknown packed curve kind".into())};
            let mut coordinates=[0.;6];
            for value in coordinates.iter_mut().take(words){
                *value=f64::from_le_bytes(bytes.get(at..at+8).ok_or("Truncated packed curve coordinates")?.try_into().unwrap());at+=8;
                if !value.is_finite(){return Err("Nonfinite packed geometry".into())}
            }
            curves.push(match kind{0=>Curve::Move(coordinates[..2].try_into().unwrap()),1=>Curve::Line(coordinates[..2].try_into().unwrap()),
                2=>Curve::Quad(coordinates[..4].try_into().unwrap()),3=>Curve::Cubic(coordinates),_=>Curve::Close});
        }
        if at!=bytes.len(){return Err("Trailing packed geometry data".into())}Ok(curves)
    }
    impl PackedGeometry {
        pub(crate) fn new(geometry:&VectorGeometry)->Result<Self,String>{
            Ok(Self{fill_rule:geometry.fill_rule.clone(),fill:encode(&geometry.fill)?,stroke:geometry.stroke.as_ref().map(|s|encode(s)).transpose()?})
        }
        pub(crate) fn unpack(self)->Result<VectorGeometry,String>{
            let geometry=VectorGeometry{fill_rule:self.fill_rule,fill:decode(&self.fill)?,stroke:self.stroke.as_deref().map(decode).transpose()?};
            if geometry.fill.len().saturating_add(geometry.stroke.as_ref().map_or(0,Vec::len))>MAX_COMMANDS{return Err("Packed geometry command budget exceeded".into())}Ok(geometry)
        }
    }
    #[cfg(test)] mod tests {
        use super::*;
        #[test]fn binary_curves_keep_every_f64_bit_and_stroke_presence(){
            for stroke in [None,Some(vec![]),Some(vec![Curve::Move([-0.,-1e-200]),Curve::Cubic([1.25,2.5,-3.,4.,-0.,5.])])]{
                let source=VectorGeometry{fill_rule:"evenodd".into(),fill:vec![Curve::Move([-0.,f64::MIN_POSITIVE]),Curve::Line([1e-200,9e99]),Curve::Quad([1.,2.,3.,4.]),Curve::Close],stroke};
                let decoded=PackedGeometry::new(&source).unwrap().unpack().unwrap();assert_eq!(serde_json::to_vec(&source).unwrap(),serde_json::to_vec(&decoded).unwrap());
            }
        }
        #[test]fn malformed_lengths_tags_and_nonfinite_values_never_publish_geometry(){
            for bytes in [vec![],vec![255;4],vec![1,0,0,0,255],vec![0,0,0,0,0],vec![1,0,0,0,1]]{
                assert!(decode(&base64::engine::general_purpose::STANDARD.encode(bytes)).is_err());
            }
            assert!(encode(&[Curve::Move([f64::NAN,0.])]).is_err());
        }
    }
}
