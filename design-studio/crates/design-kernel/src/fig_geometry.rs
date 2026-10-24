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
    pub vector_geometry: Option<VectorGeometry>,
    pub vertex_styles: Vec<u32>,
    pub region_styles: Vec<u32>,
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
        vector_geometry: Some(geometry),
        vertex_styles,
        region_styles,
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
