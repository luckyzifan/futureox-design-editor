//! Bounded FIG geometry decoding shared by native import and the web worker.
//! Binary floats are decoded at their source precision, then all coordinate
//! arithmetic uses f64. No decimal cleanup or f32 re-quantization is applied.
use crate::{
    math::Point,
    path::{Command, Path},
    scene::{Edge, Network, Vertex},
    vector_geometry::{MAX_COMMANDS, VectorGeometry},
};
use serde::Serialize;

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl Reader<'_> {
    fn word(&mut self) -> Result<u32, String> {
        let end = self
            .at
            .checked_add(4)
            .ok_or("FIG geometry offset overflow")?;
        let bytes = self
            .bytes
            .get(self.at..end)
            .ok_or("Truncated FIG geometry")?;
        self.at = end;
        Ok(u32::from_le_bytes(bytes.try_into().unwrap()))
    }
    fn scalar(&mut self) -> Result<f64, String> {
        let value = f32::from_bits(self.word()?) as f64;
        if !value.is_finite() {
            Err("Nonfinite FIG coordinate".into())
        } else {
            Ok(value)
        }
    }
    fn point(&mut self, sx: f64, sy: f64) -> Result<Point, String> {
        let p = Point::new(self.scalar()? * sx, self.scalar()? * sy);
        if !p.finite() || p.x.abs() > 1e7 || p.y.abs() > 1e7 {
            Err("FIG coordinate exceeds geometry allowance".into())
        } else {
            Ok(p)
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decoded {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<Network>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_geometry: Option<std::sync::Arc<VectorGeometry>>,
    pub vertex_styles: Vec<u32>,
    pub region_styles: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corner_skip: Option<String>,
    /// FIG vertex style `strokeCap`, when every styled vertex agrees.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke_cap: Option<String>,
    /// FIG vertex style `strokeJoin`, when every styled vertex agrees.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke_join: Option<String>,
}

/// Figma masks only the suffix after each visible mask. Multiple masks nest
/// (desigma draw_children recurses into the suffix); process right to left so
/// adding one explicit scope cannot change any earlier source index.
pub fn mask_suffixes(flags:&[u8])->Result<Vec<u32>,String>{
    if flags.len()>u32::MAX as usize||flags.iter().any(|v|*v>1){return Err("Invalid FIG mask flags".into());}
    Ok(flags.iter().enumerate().rev().filter_map(|(i,v)|(*v==1).then_some(i as u32)).collect())
}

fn uniform_style(ids: &[u32], values: &std::collections::HashMap<u32, String>) -> Option<String> {
    let mut chosen: Option<&str> = None;
    for id in ids {
        if *id == 0 { continue; }
        let Some(value) = values.get(id) else { continue };
        if chosen.is_some_and(|previous| previous != value) { return None; }
        chosen = Some(value);
    }
    chosen.map(str::to_string)
}

/// Bake known circular corners on a single closed straight contour.
/// Handle mirroring is already stored on the edge tangents. A vertex style
/// that only carries that mirroring, a zero radius, or one shared stroke
/// cap/join is consumed instead of left as an untranslated override.
/// Paint keys and a non-zero radius on a curve or branch stay untranslated.
pub fn round_network(decoded:&mut Decoded,radius:f64,smoothing:f64,styles:&serde_json::Value)->Result<bool,String>{
    if !radius.is_finite()||radius<0.||!smoothing.is_finite(){return Err("Invalid FIG corner radius".into());}
    let mut overrides=std::collections::HashMap::new();
    let mut caps=std::collections::HashMap::new();
    let mut joins=std::collections::HashMap::new();
    if let Some(styles)=styles.as_array(){
        for style in styles{
            let Some(map)=style.as_object() else{decoded.corner_skip=Some("style-shape".into());return Ok(false)};
            if map.keys().any(|key|!matches!(key.as_str(),"styleID"|"cornerRadius"|"cornerSmoothing"|"handleMirroring"|"strokeCap"|"strokeJoin")){
                decoded.corner_skip=Some("paint-style".into());return Ok(false);
            }
            let Some(id)=style.get("styleID").and_then(serde_json::Value::as_u64).and_then(|n|u32::try_from(n).ok()) else{decoded.corner_skip=Some("style-id".into());return Ok(false)};
            let r=style.get("cornerRadius").and_then(serde_json::Value::as_f64).unwrap_or(radius);
            if !r.is_finite()||r<0.{return Err("Invalid FIG vertex radius".into());}
            if overrides.insert(id,r).is_some(){decoded.corner_skip=Some("duplicate-style".into());return Ok(false);}
            if let Some(cap)=style.get("strokeCap").and_then(serde_json::Value::as_str){caps.insert(id,cap.to_string());}
            if let Some(join)=style.get("strokeJoin").and_then(serde_json::Value::as_str){joins.insert(id,join.to_string());}
        }
    }
    let Some(network)=decoded.network.as_ref() else{decoded.corner_skip=Some("no-network".into());return Ok(false);};
    let mut vertex_radii=Vec::with_capacity(decoded.vertex_styles.len());
    for style in &decoded.vertex_styles{
        let r=if *style==0{radius}else{let Some(r)=overrides.get(style) else{decoded.corner_skip=Some("missing-style".into());return Ok(false)};*r};
        vertex_radii.push(r);
    }
    let metadata=||{
        (uniform_style(&decoded.vertex_styles,&caps), uniform_style(&decoded.vertex_styles,&joins))
    };
    let region_styled=decoded.region_styles.iter().any(|id|*id!=0);
    let straight_loop=network.vertices.len()>=3 && network.vertices.len()==network.edges.len()
        && network.edges.iter().all(|edge|edge.c1.is_none()&&edge.c2.is_none());
    if region_styled || !straight_loop {
        if !region_styled && vertex_radii.iter().all(|r|*r==0.) {
            let (cap,join)=metadata();
            if caps.len()>0 && cap.is_none() || joins.len()>0 && join.is_none() {
                decoded.corner_skip=Some("mixed-stroke-style".into());
                return Ok(false);
            }
            decoded.stroke_cap=cap;
            decoded.stroke_join=join;
            decoded.vertex_styles.fill(0);
            return Ok(true);
        }
        decoded.corner_skip=Some(if region_styled{"region-style"}else{"contour"}.into());
        return Ok(false);
    }
    let mut corners=std::collections::HashMap::new();
    for (vertex,r) in network.vertices.iter().zip(&vertex_radii){
        if corners.insert((vertex.x.to_bits(),vertex.y.to_bits()),*r).is_some(){decoded.corner_skip=Some("coincident".into());return Ok(false);}
    }
    if let Some(faces)=&network.filled_faces{
        if faces.len()!=1||faces[0].len()!=network.edges.len()||
            faces[0].iter().collect::<std::collections::HashSet<_>>().len()!=network.edges.len(){return Ok(false);}
    }
    let (fill,_)=network.paths()?;
    let mut points=Vec::new();let mut closed=false;
    for command in &fill.commands{
        match command{
            Command::Move(p) if points.is_empty()=>points.push(*p),
            Command::Line(p) if !closed=>points.push(*p),
            Command::Close if !closed=>closed=true,
            _=>return Ok(false),
        }
    }
    if points.first()==points.last(){points.pop();}
    if !closed||points.len()!=network.vertices.len(){return Ok(false);}
    let radii:Option<Vec<_>>=points.iter().map(|p|corners.get(&(p.x.to_bits(),p.y.to_bits())).copied()).collect();
    let Some(radii)=radii else{return Ok(false)};
    let (stroke_cap, stroke_join) = metadata();
    let circular=crate::authoring_shapes::rounded_polygon_radii_smoothed(&points,&radii,smoothing.clamp(0.,1.))?;
    // Native Figma circular vector corners export as cubic Beziers (the
    // quarter-circle control length is radius * 4/3*tan(pi/8)). Convert only
    // these imported corner commands explicitly; generic native Arc encoding
    // retains its existing refusal to approximate parametric authored arcs.
    let mut path=Path::default();
    for command in circular.commands{
        match command{
            Command::Arc{center,radius,start,sweep}=>{
                let steps=(sweep.abs()/std::f64::consts::FRAC_PI_2).ceil().max(1.) as usize;
                for step in 0..steps{
                    let a=start+sweep*step as f64/steps as f64;
                    let b=start+sweep*(step+1) as f64/steps as f64;
                    let k=4./3.*((b-a)/4.).tan();
                    let p=|t:f64|Point::new(center.x+radius.x*t.cos(),center.y+radius.y*t.sin());
                    let tangent=|t:f64|Point::new(-radius.x*t.sin(),radius.y*t.cos());
                    path.commands.push(Command::Cubic(p(a)+tangent(a)*k,p(b)-tangent(b)*k,p(b)));
                }
            },
            command=>path.commands.push(command),
        }
    }
    decoded.vector_geometry=Some(VectorGeometry::from_paths(&path,&path,&network.fill_rule)?.into());
    decoded.network=None;
    decoded.stroke_cap=stroke_cap;
    decoded.stroke_join=stroke_join;
    decoded.vertex_styles.fill(0);
    Ok(true)
}
fn emit(
    path: &mut Path,
    edge: &Edge,
    reverse: bool,
    points: &[Vertex],
    mov: bool,
) -> Result<(), String> {
    let a = edge
        .from
        .strip_prefix('v')
        .and_then(|s| s.parse::<usize>().ok())
        .ok_or("Invalid FIG endpoint")?;
    let b = edge
        .to
        .strip_prefix('v')
        .and_then(|s| s.parse::<usize>().ok())
        .ok_or("Invalid FIG endpoint")?;
    let (a, b, c1, c2) = if reverse {
        (points[b].point(), points[a].point(), edge.c2, edge.c1)
    } else {
        (points[a].point(), points[b].point(), edge.c1, edge.c2)
    };
    if mov {
        path.commands.push(Command::Move(a));
    }
    path.commands.push(if c1.is_some() || c2.is_some() {
        Command::Cubic(c1.unwrap_or(a), c2.unwrap_or(b), b)
    } else {
        Command::Line(b)
    });
    Ok(())
}
fn region_path(network: &Network, edges: &[usize]) -> Result<(Path, bool), String> {
    if edges.is_empty() {
        return Err("Empty FIG region loop".into());
    }
    for reverse in [false, true] {
        let first = &network.edges[edges[0]];
        let start = if reverse { &first.to } else { &first.from };
        let mut at = start;
        let mut path = Path::default();
        let mut valid = true;
        for (i, &index) in edges.iter().enumerate() {
            let edge = &network.edges[index];
            let rev = if i == 0 {
                reverse
            } else if &edge.from == at {
                false
            } else if &edge.to == at {
                true
            } else {
                valid = false;
                break;
            };
            emit(&mut path, edge, rev, &network.vertices, i == 0)?;
            at = if rev { &edge.from } else { &edge.to };
        }
        let same_position = || {
            let a = start[1..].parse::<usize>().unwrap();
            let b = at[1..].parse::<usize>().unwrap();
            network.vertices[a].point() == network.vertices[b].point()
        };
        if valid && (at == start || same_position()) {
            path.commands.push(Command::Close);
            // A native region can close at distinct, exactly coincident
            // vertices. Keep its fill explicit instead of merging editable
            // endpoints and accidentally changing the open stroke's caps.
            return Ok((path, at != start));
        }
        if valid {
            // Native stroke-only vectors (for example a two-edge check mark)
            // also carry region records. An open walk has no filled face; keep
            // every source edge in the network/stroke without inventing a
            // closing segment or snapping its distinct endpoints together.
            return Ok((Path::default(), false));
        }
    }
    Err("FIG region loop is not connected and closed".into())
}
pub fn decode_network(bytes: &[u8], sx: f64, sy: f64) -> Result<Decoded, String> {
    if bytes.len() > 16 * 1024 * 1024 || ![sx, sy].iter().all(|s| s.is_finite() && *s > 0.) {
        return Err("Invalid FIG geometry input/scale".into());
    }
    let mut reader = Reader { bytes, at: 0 };
    let nv = reader.word()? as usize;
    let ne = reader.word()? as usize;
    let nr = reader.word()? as usize;
    let minimum = nv
        .checked_mul(12)
        .and_then(|n| ne.checked_mul(28).and_then(|e| n.checked_add(e)))
        .and_then(|n| nr.checked_mul(8).and_then(|r| n.checked_add(r)))
        .and_then(|n| n.checked_add(12))
        .ok_or("FIG record count overflow")?;
    if nv > MAX_COMMANDS || ne > MAX_COMMANDS || nr > 10000 || minimum > bytes.len() {
        return Err("Invalid FIG geometry record counts".into());
    }
    let mut network = Network {
        vertices: Vec::with_capacity(nv),
        edges: Vec::with_capacity(ne),
        fill_rule: "nonzero".into(),
        filled_faces: None,
    };
    let mut vertex_styles = Vec::with_capacity(nv);
    let mut region_styles = Vec::with_capacity(nr);
    for i in 0..nv {
        vertex_styles.push(reader.word()?);
        let p = reader.point(sx, sy)?;
        network.vertices.push(Vertex {
            id: format!("v{i}"),
            x: p.x,
            y: p.y,
        });
    }
    for i in 0..ne {
        let _style = reader.word()?;
        let a = reader.word()? as usize;
        let ta = reader.point(sx, sy)?;
        let b = reader.word()? as usize;
        let tb = reader.point(sx, sy)?;
        if a >= nv || b >= nv {
            return Err("FIG segment endpoint is missing".into());
        }
        let curved = ta.x != 0. || ta.y != 0. || tb.x != 0. || tb.y != 0.;
        network.edges.push(Edge {
            id: format!("e{i}"),
            from: format!("v{a}"),
            to: format!("v{b}"),
            c1: curved.then(|| network.vertices[a].point() + ta),
            c2: curved.then(|| network.vertices[b].point() + tb),
        });
    }
    let mut fill = Path::default();
    let mut faces = Vec::new();
    let mut rule = None;
    let mut region_edges = 0usize;
    let mut explicit_fill = false;
    for _ in 0..nr {
        let style = reader.word()?;
        region_styles.push(style >> 1);
        let current = if style & 1 == 1 { "nonzero" } else { "evenodd" };
        if rule.is_some_and(|old| old != current) {
            return Err("Mixed FIG region winding requires separate paint geometry".into());
        }
        rule = Some(current);
        let count = reader.word()? as usize;
        if count > 10000 {
            return Err("FIG region loop allowance exceeded".into());
        }
        for _ in 0..count {
            let count = reader.word()? as usize;
            region_edges = region_edges
                .checked_add(count)
                .ok_or("FIG loop count overflow")?;
            if count > ne
                || region_edges > MAX_COMMANDS
                || count.saturating_mul(4) > bytes.len().saturating_sub(reader.at)
            {
                return Err("Invalid FIG region edge count".into());
            }
            let mut indices = Vec::with_capacity(count);
            for _ in 0..count {
                let i = reader.word()? as usize;
                if i >= ne {
                    return Err("FIG region edge is missing".into());
                }
                indices.push(i);
            }
            let (path, coincident_closure) = region_path(&network, &indices)?;
            explicit_fill |= coincident_closure;
            fill.commands.extend(path.commands);
            faces.push(indices.iter().map(|i| format!("e{i}")).collect());
        }
    }
    if reader.at != bytes.len() {
        return Err("Trailing FIG network bytes".into());
    }
    if let Some(rule) = rule {
        network.fill_rule = rule.into();
        network.filled_faces = Some(faces);
    }
    if nv <= 10000 && ne <= 20000 && !explicit_fill {
        return Ok(Decoded {
            network: Some(network),
            vector_geometry: None,
            vertex_styles,
            region_styles,
            corner_skip: None,
            stroke_cap: None,
            stroke_join: None,
        });
    }
    // Large, nonbranching contours have a linear render representation. Branch
    // topology remains explicitly rejected until its source workset is admitted.
    let mut degree = vec![0u8; nv];
    for e in &network.edges {
        for id in [&e.from, &e.to] {
            let i = id[1..].parse::<usize>().unwrap();
            degree[i] = degree[i].saturating_add(1);
        }
    }
    if (nv > 10000 || ne > 20000) && degree.iter().any(|d| *d > 2) {
        return Err("Large branched FIG topology requires a smaller editing workset".into());
    }
    let faces = network.filled_faces.take();
    let (automatic, stroke) = network.paths()?;
    let geometry = VectorGeometry::from_paths(
        if nr == 0 { &automatic } else { &fill },
        &stroke,
        &network.fill_rule,
    )?;
    drop(faces);
    Ok(Decoded {
        network: None,
        vector_geometry: Some(geometry.into()),
        vertex_styles,
        region_styles,
        corner_skip: None,
        stroke_cap: None,
        stroke_join: None,
    })
}

/// FIG fill/stroke commands use byte opcodes followed by little-endian f32.
/// Truncation and unknown opcodes fail before publishing any partial path.
pub fn decode_commands(bytes: &[u8]) -> Result<Path, String> {
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("FIG commands exceed byte allowance".into());
    }
    let mut reader = Reader { bytes, at: 0 };
    let mut path = Path::default();
    let mut open = false;
    while reader.at < bytes.len() {
        let op = bytes[reader.at];
        reader.at += 1;
        if path.commands.len() >= MAX_COMMANDS {
            return Err("FIG commands exceed count allowance".into());
        }
        let command = match op {
            0 if open => {
                open = false;
                Command::Close
            }
            1 => {
                open = true;
                Command::Move(reader.point(1., 1.)?)
            }
            2 if open => Command::Line(reader.point(1., 1.)?),
            3 if open => Command::Quad(reader.point(1., 1.)?, reader.point(1., 1.)?),
            4 if open => Command::Cubic(
                reader.point(1., 1.)?,
                reader.point(1., 1.)?,
                reader.point(1., 1.)?,
            ),
            _ => return Err("Invalid FIG path opcode or contour sequence".into()),
        };
        path.commands.push(command);
    }
    Ok(path)
}

/// A FIG fillGeometry carrier is an area, unlike the editable stroke network.
/// Its command stream may leave subpaths implicitly closed. Make those closes
/// explicit for the shared render-geometry contract without touching any point
/// or changing the separately decoded stroke's caps/joins.
pub fn decode_fill_commands(bytes: &[u8]) -> Result<Path, String> {
    let source = decode_commands(bytes)?;
    let mut path = Path::default();
    let mut open = false;
    for command in source.commands {
        if matches!(command, Command::Move(_)) && open {
            path.commands.push(Command::Close);
        }
        match command { Command::Move(_) => open = true, Command::Close => open = false, _ => {} }
        path.commands.push(command);
        if path.commands.len() > MAX_COMMANDS { return Err("FIG fill commands exceed count allowance".into()); }
    }
    if open { path.commands.push(Command::Close); }
    if path.commands.len() > MAX_COMMANDS { return Err("FIG fill commands exceed count allowance".into()); }
    Ok(path)
}
