//! Editable vector brushes preserving source Bezier commands. Scatter uses bounded
//! arc-length inversion. Straight Stretch is an exact affine map; curved, corner,
//! cusp and closed Stretch use the same arc-length budget without flattening the source.
mod stretch;
use crate::{math::{Point, Transform}, path::{Path, Command}, scene::Network};
use serde::{Deserialize, Serialize};
const LIMIT: usize = 100_000;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VectorBrush {
    pub source: Network,
    pub mode: String,
    pub width: f64,
    pub spacing: f64,
    pub seed: u32,
    pub rotation: f64,
    pub rotation_variance: f64,
    pub scale_variance: f64,
    pub scatter: f64,
    pub follow_tangent: bool,
}
impl VectorBrush {
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.mode.as_str(), "stretch" | "scatter")
            || ![self.width,self.spacing,self.rotation,self.rotation_variance,self.scale_variance,self.scatter].iter().all(|v|v.is_finite())
            || !(0.001..=10000.).contains(&self.width)
            || !(0.001..=1e7).contains(&self.spacing)
            || self.rotation.abs()>std::f64::consts::TAU
            || !(0. ..=std::f64::consts::TAU).contains(&self.rotation_variance)
            || !(0. ..=0.99).contains(&self.scale_variance)
            || !(0. ..=10000.).contains(&self.scatter) { return Err("Invalid vector brush parameters".into()); }
        check_network(&self.source)
    }
}
fn check_network(n:&Network)->Result<(),String>{
    if n.vertices.len()>4096 || n.edges.len()>4096 {return Err("Vector brush input budget exceeded".into())}
    let mut vertices=std::collections::HashSet::new();let mut edges=std::collections::HashSet::new();
    if !matches!(n.fill_rule.as_str(),"nonzero"|"evenodd")
        || n.vertices.iter().any(|v|v.id.is_empty()||v.id.len()>128||!vertices.insert(v.id.as_str()))
        || n.edges.iter().any(|e|e.id.is_empty()||e.id.len()>128||!edges.insert(e.id.as_str())||!vertices.contains(e.from.as_str())||!vertices.contains(e.to.as_str())) {
        return Err("Invalid vector brush network identifiers".into())
    }
    if n.filled_faces.as_ref().is_some_and(|faces|faces.len()>4096||faces.iter().any(|face|face.len()>4096||face.iter().any(|id|!edges.contains(id.as_str())))) {
        return Err("Invalid vector brush source fill faces".into())
    }
    if n.vertices.iter().any(|p|!p.x.is_finite()||!p.y.is_finite()||p.x.abs()>1e7||p.y.abs()>1e7)
        ||n.edges.iter().flat_map(|e|[e.c1,e.c2]).flatten().any(|p|!p.finite()||p.x.abs()>1e7||p.y.abs()>1e7){return Err("Invalid vector brush coordinates".into())}
    Ok(())
}

// A certified geometric bracket: chord <= cubic arc length <= control polygon.
// Sum of bracket widths is bounded, rather than treating flatness as length error.
pub const ARC_ERROR: f64 = 0.00001;
const WORK_LIMIT: usize = 1_000_000;
#[derive(Clone, Copy)]
struct Curve([Point;4]);
fn distance(a:Point,b:Point)->f64{(b.x-a.x).hypot(b.y-a.y)}
impl Curve {
    fn split(self)->(Self,Self){let p=self.0;let a=(p[0]+p[1])*0.5;let b=(p[1]+p[2])*0.5;let c=(p[2]+p[3])*0.5;let d=(a+b)*0.5;let e=(b+c)*0.5;let f=(d+e)*0.5;(Self([p[0],a,d,f]),Self([f,e,c,p[3]]))}
    fn bounds(self,tol:f64,depth:u32,work:&mut usize)->Result<(f64,f64),String>{
        *work+=1;if *work>WORK_LIMIT{return Err("Vector brush arc-length work budget exceeded".into())}
        let p=self.0;let lo=distance(p[0],p[3]);let hi=distance(p[0],p[1])+distance(p[1],p[2])+distance(p[2],p[3]);
        if hi-lo<=tol{return Ok((lo,hi))}if depth>=32{return Err("Vector brush arc-length precision budget exceeded".into())}
        let(a,b)=self.split();let(a0,a1)=a.bounds(tol/2.,depth+1,work)?;let(b0,b1)=b.bounds(tol/2.,depth+1,work)?;Ok((a0+b0,a1+b1))
    }
    fn leaves(self,tol:f64,depth:u32,out:&mut Vec<Segment>,work:&mut usize)->Result<(),String>{
        *work+=1;if *work>WORK_LIMIT||out.len()>=100000{return Err("Vector brush arc-length work budget exceeded".into())}
        let p=self.0;let lo=distance(p[0],p[3]);let hi=distance(p[0],p[1])+distance(p[1],p[2])+distance(p[2],p[3]);
        if hi-lo<=tol{out.push(Segment::Cubic(self));return Ok(())}
        if depth>=32{return Err("Vector brush arc-length precision budget exceeded".into())}
        let(a,b)=self.split();a.leaves(tol/2.,depth+1,out,work)?;b.leaves(tol/2.,depth+1,out,work)
    }
    fn frame(self,u:f64)->(Point,Point){let p=self.0;let v=1.-u;let at=p[0]*(v*v*v)+p[1]*(3.*v*v*u)+p[2]*(3.*v*u*u)+p[3]*(u*u*u);
        let mut t=(p[1]-p[0])*(3.*v*v)+(p[2]-p[1])*(6.*v*u)+(p[3]-p[2])*(3.*u*u);
        if t.length()<1e-12{t=if u<0.5{p[2]-p[0]}else{p[3]-p[1]};if t.length()<1e-12{t=p[3]-p[0]}}
        let len=t.length();(at,if len>0.{t*(1./len)}else{Point::new(1.,0.)})
    }
    fn at_distance(self,mut d:f64,work:&mut usize)->Result<(Point,Point),String>{
        let original=self;let mut c=self;let(mut start,mut end)=(0.,1.);
        for _ in 0..48 {
            let (lo,hi)=c.bounds(ARC_ERROR/128.,0,work)?;
            if hi<=ARC_ERROR{return Ok(original.frame((start+end)/2.))}
            if d<=0.{return Ok(original.frame(start))}if d>=hi{return Ok(original.frame(end))}
            let(a,b)=c.split();let(l,h)=a.bounds(ARC_ERROR/128.,0,work)?;let mid=(start+end)/2.;
            if d<l {c=a;end=mid}else if d>h{c=b;start=mid;d-=(l+h)/2.}else{return Ok(original.frame(mid))}
            let _=lo;
        }Err("Vector brush inverse arc-length precision budget exceeded".into())
    }
}
#[derive(Clone,Copy)]
enum Segment{Line(Point,Point),Cubic(Curve)}
struct Track{segments:Vec<Segment>,ends:Vec<f64>,length:f64,lower:f64,upper:f64,closed:bool}
impl Track{
    fn new(path:&Path,error:f64,work:&mut usize)->Result<Self,String>{
        let mut segments=Vec::new();let(mut pen,mut first)=(Point::new(0.,0.),Point::new(0.,0.));let mut moves=0;let mut closed=false;
        for c in &path.commands{match *c{
            Command::Move(p)=>{moves+=1;pen=p;first=p},
            Command::Line(p)=>{if distance(pen,p)>1e-12{segments.push(Segment::Line(pen,p))}pen=p},
            Command::Cubic(a,b,p)=>{segments.push(Segment::Cubic(Curve([pen,a,b,p])));pen=p},
            Command::Close=>{closed=true;if distance(pen,first)>1e-12{segments.push(Segment::Line(pen,first))}pen=first},
            _=>return Err("Unsupported vector brush guide command".into()),
        }}
        if moves!=1||segments.is_empty(){return Err("Vector brush requires one nondegenerate connected guide contour".into())}
        let tol=error/segments.len() as f64;
        let mut refined=Vec::new();for s in segments{match s{Segment::Cubic(c)=>c.leaves(tol,0,&mut refined,work)?,s=>refined.push(s)}}
        let segments=refined;let mut ends=vec![0.];let mut length=0.;let mut lower=0.;let mut upper=0.;
        for s in &segments{let(l,h)=match s{Segment::Line(a,b)=>{let d=distance(*a,*b);(d,d)},Segment::Cubic(c)=>{let p=c.0;let l=distance(p[0],p[3]);let h=distance(p[0],p[1])+distance(p[1],p[2])+distance(p[2],p[3]);(l,h)}};lower+=l;upper+=h;length+=(l+h)/2.;ends.push(length)}
        if length<=1e-9||!length.is_finite(){return Err("Vector brush guide is degenerate".into())}
        Ok(Self{segments,ends,length,lower,upper,closed})
    }
    fn frame(&self,d:f64,work:&mut usize)->Result<(Point,Point),String>{let d=d.clamp(0.,self.length);let i=self.ends.partition_point(|e|*e<=d).saturating_sub(1).min(self.segments.len()-1);let delta=d-self.ends[i];match self.segments[i]{Segment::Line(a,b)=>{let len=distance(a,b);let t=(b-a)*(1./len);Ok((a+t*delta,t))},Segment::Cubic(c)=>c.at_distance(delta,work)}}
}
fn transformed(path:&Path,m:Transform,out:&mut Vec<Command>)->Result<(),String>{
    if out.len()+path.commands.len()>LIMIT{return Err("Vector brush output budget exceeded".into())}
    for c in &path.commands{out.push(match *c{Command::Move(p)=>Command::Move(m.point(p)),Command::Line(p)=>Command::Line(m.point(p)),Command::Cubic(a,b,p)=>Command::Cubic(m.point(a),m.point(b),m.point(p)),Command::Quad(a,p)=>Command::Quad(m.point(a),m.point(p)),Command::Close=>Command::Close,_=>return Err("Unsupported brush source command".into())})}Ok(())
}
fn random(seed:&mut u32)->f64{*seed=seed.wrapping_mul(1664525).wrapping_add(1013904223);f64::from(*seed)/4294967296. *2.-1.}
pub fn paths(guide:&Network,brush:&VectorBrush)->Result<Path,String>{
    brush.validate()?;check_network(guide)?;
    if guide.fill_rule != "nonzero" || brush.source.fill_rule != "nonzero" { return Err("Vector brushes require nonzero source and guide fill rules".into()); }
    let source=brush.source.paths()?.0;
    if source.commands.iter().filter(|c|matches!(c,Command::Move(_))).count()!=1 || source.commands.iter().filter(|c|matches!(c,Command::Close)).count()!=1 {return Err("Vector brush source requires one closed filled contour; holes are unsupported".into())}
    let mut degrees=std::collections::HashMap::new();for e in &brush.source.edges{*degrees.entry(&e.from).or_insert(0)+=1;*degrees.entry(&e.to).or_insert(0)+=1;}
    if degrees.values().any(|d|*d!=2){return Err("Vector brush source must be a closed unbranched contour".into())}
    if source.commands.is_empty(){return Err("Vector brush source must contain closed filled contours".into())}
    let mut points=Vec::new();for c in &source.commands{match *c{Command::Move(p)|Command::Line(p)=>points.push(p),Command::Cubic(a,b,p)=>points.extend([a,b,p]),Command::Quad(a,p)=>points.extend([a,p]),_=>{}}}
    let xmin=points.iter().map(|p|p.x).fold(f64::INFINITY,f64::min);let xmax=points.iter().map(|p|p.x).fold(f64::NEG_INFINITY,f64::max);
    let ymin=points.iter().map(|p|p.y).fold(f64::INFINITY,f64::min);let ymax=points.iter().map(|p|p.y).fold(f64::NEG_INFINITY,f64::max);
    if xmax-xmin<=1e-9||ymax-ymin<=1e-9{return Err("Vector brush source has zero extent".into())}
    let mut work=0;let guide_path=guide.paths()?.1;let mut track=Track::new(&guide_path,ARC_ERROR,&mut work)?;let yc=(ymin+ymax)/2.;let mut out=Vec::new();
    if brush.mode=="stretch"{
        let(first,t)=track.frame(0.,&mut work)?;
        // Straight forward-only polylines stay an exact affine image of the source.
        let straight=track.segments.iter().all(|segment|{let Segment::Line(a,b)=*segment else{return false};let u=(b-a)*(1./distance(a,b));distance(u,t)<=1e-12});
        if straight {
            let sx=track.length/(xmax-xmin);let sy=brush.width/(ymax-ymin);
            transformed(&source,Transform([t.x*sx,t.y*sx,-t.y*sy,t.x*sy,first.x-t.x*sx*xmin+t.y*sy*yc,first.y-t.y*sx*xmin-t.x*sy*yc]),&mut out)?;
        } else {
            out=stretch::apply(&track,&source,xmin,xmax,ymin,ymax,brush.width,&mut work)?;
        }
    }else{
        let count=if track.closed{
            let mut error=ARC_ERROR;
            while (track.lower/brush.spacing).ceil()!=(track.upper/brush.spacing).ceil(){
                error/=16.;
                if error<1e-12{return Err("Closed Scatter seam count is ambiguous at the precision budget; change spacing".into())}
                track=Track::new(&guide_path,error,&mut work).map_err(|_|"Closed Scatter seam count is ambiguous at the precision/work budget; change spacing")?;
            }
            (track.lower/brush.spacing).ceil()
        }else{(track.length/brush.spacing).floor()+1.};
        if count>4096.||count*source.commands.len() as f64>LIMIT as f64{return Err("Vector brush scatter budget exceeded".into())}
        let mut seed=brush.seed;
        for i in 0..count as usize{let(p,t)=track.frame(i as f64*brush.spacing,&mut work)?;
            let angle=brush.rotation+random(&mut seed)*brush.rotation_variance+if brush.follow_tangent{t.y.atan2(t.x)}else{0.};
            let scale=brush.width/(ymax-ymin)*(1.+random(&mut seed)*brush.scale_variance);let normal=random(&mut seed)*brush.scatter;let(s,c)=angle.sin_cos();let xc=(xmin+xmax)/2.;
            transformed(&source,Transform([scale*c,scale*s,-scale*s,scale*c,p.x-t.y*normal-scale*c*xc+scale*s*yc,p.y+t.x*normal-scale*s*xc-scale*c*yc]),&mut out)?;
        }
    }
    Ok(Path{commands:out, ..Path::default()})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cubic_length_bracket_and_inverse_are_bounded_at_high_zoom(){
        let c=Curve([Point::new(-20.,0.),Point::new(-20.,100.),Point::new(80.,100.),Point::new(80.,0.)]);
        let mut work=0;let(l,h)=c.bounds(ARC_ERROR,0,&mut work).unwrap();
        // This symmetric cubic has analytic length 200 and midpoint (30,75).
        assert!(l<=200.+1e-10&&h>=200.-1e-10);assert!(h-l<=ARC_ERROR*1.001);
        let(p,t)=c.at_distance(100.,&mut work).unwrap();
        assert!(distance(p,Point::new(30.,75.))*32.<0.001);assert!(distance(t,Point::new(1.,0.))<1e-6);
    }
    #[test]
    fn nonuniform_collinear_cubic_uses_arc_length_not_parameter(){
        let c=Curve([Point::new(0.,0.),Point::new(0.,0.),Point::new(0.,0.),Point::new(100.,0.)]);let mut work=0;
        let(p,_)=c.at_distance(50.,&mut work).unwrap();assert!((p.x-50.).abs()<ARC_ERROR*2.);
    }
    #[test]
    fn arc_budget_never_silently_degrades(){let c=Curve([Point::new(0.,0.),Point::new(0.,100.),Point::new(100.,100.),Point::new(100.,0.)]);let mut work=WORK_LIMIT;assert!(c.bounds(ARC_ERROR,0,&mut work).is_err());}
    #[test]
    fn stretch_setup_stays_bounded(){
        let path=Path{commands:vec![Command::Move(Point::new(0.,0.)),Command::Cubic(Point::new(0.,40.),Point::new(40.,40.),Point::new(40.,0.))],..Path::default()};
        let mut work=0;let track=Track::new(&path,ARC_ERROR,&mut work).unwrap();
        assert!(track.segments.len()<20000,"arc-length leaves {}",track.segments.len());
        assert!(work<WORK_LIMIT);
    }
}
