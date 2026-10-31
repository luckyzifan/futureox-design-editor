//! Deterministic, absolute-time animation sampling shared by native and Wasm.
//! Cubic timing: https://www.w3.org/TR/css-easing-1/
//! Transform decomposition: https://www.w3.org/TR/css-transforms-1/#interpolation-of-2d-matrices
//! Springs solve m*x'' + c*x' + k*(x-1) = 0 analytically; no frame-step drift.
use crate::{
    math::Transform,
    scene::{Document, Effect, Network, Node, Paint, Stroke},
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Easing {
    #[default]
    Linear,
    /// A named preset from Figma's 21-function easing library
    /// (Penner equations: sine/quad/cubic/quart/quint/expo/circ
    /// × in/out/inOut).
    Named { name: String },
    Hold,
    Cubic {
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
    },
    Spring {
        mass: f64,
        stiffness: f64,
        damping: f64,
        #[serde(default)]
        velocity: f64,
    },
}
impl Easing {
    pub fn validate(&self) -> Result<(), String> {
        let valid = match *self {
            Easing::Named { ref name } => Self::named_curve(name, 0.5).is_some(),
            Self::Linear | Self::Hold => true,
            Self::Cubic { x1, y1, x2, y2 } => {
                [x1, x2]
                    .iter()
                    .all(|v| v.is_finite() && (0. ..=1.).contains(v))
                    && [y1, y2].iter().all(|v| v.is_finite() && v.abs() <= 10.)
            }
            Self::Spring {
                mass,
                stiffness,
                damping,
                velocity,
            } => {
                mass.is_finite()
                    && (0.0001..=1000.).contains(&mass)
                    && stiffness.is_finite()
                    && (0.01..=1e6).contains(&stiffness)
                    && damping.is_finite()
                    && (0. ..=1e5).contains(&damping)
                    && velocity.is_finite()
                    && velocity.abs() <= 10000.
            }
        };
        if valid {
            Ok(())
        } else {
            Err("Invalid animation easing".into())
        }
    }
    /// Figma's 21 named easing presets: standard Penner equations, each
    /// in/out/inOut.
    pub fn named_curve(curve: &str, t: f64) -> Option<f64> {
        let result = match curve {
            "ease-in-sine" => 1. - (t * std::f64::consts::PI / 2.).cos(),
            "ease-out-sine" => (t * std::f64::consts::PI / 2.).sin(),
            "ease-in-out-sine" => -((t * std::f64::consts::PI).cos() - 1.) / 2.,
            "ease-in-quad" => t * t,
            "ease-out-quad" => 1. - (1. - t) * (1. - t),
            "ease-in-out-quad" => if t < 0.5 { 2. * t * t } else { 1. - (-2. * t + 2.).powi(2) / 2. },
            "ease-in-cubic" => t * t * t,
            "ease-out-cubic" => 1. - (1. - t).powi(3),
            "ease-in-out-cubic" => if t < 0.5 { 4. * t * t * t } else { 1. - (-2. * t + 2.).powi(3) / 2. },
            "ease-in-quart" => t.powi(4),
            "ease-out-quart" => 1. - (1. - t).powi(4),
            "ease-in-out-quart" => if t < 0.5 { 8. * t.powi(4) } else { 1. - (-2. * t + 2.).powi(4) / 2. },
            "ease-in-quint" => t.powi(5),
            "ease-out-quint" => 1. - (1. - t).powi(5),
            "ease-in-out-quint" => if t < 0.5 { 16. * t.powi(5) } else { 1. - (-2. * t + 2.).powi(5) / 2. },
            "ease-in-expo" => if t == 0. { 0. } else { (2.0f64).powf(10. * t - 10.) },
            "ease-out-expo" => if t == 1. { 1. } else { 1. - (2.0f64).powf(-10. * t) },
            "ease-in-out-expo" => if t == 0. { 0. } else if t == 1. { 1. }
                else if t < 0.5 { (2.0f64).powf(20. * t - 10.) / 2. }
                else { (2. - (2.0f64).powf(-20. * t + 10.)) / 2. },
            "ease-in-circ" => 1. - (1. - t * t).sqrt(),
            "ease-out-circ" => (1. - (t - 1.).powi(2)).sqrt(),
            "ease-in-out-circ" => if t < 0.5 {
                (1. - (1. - 4. * t * t).sqrt()) / 2.
            } else {
                ((1. - (-2. * t + 2.).powi(2)).sqrt() + 1.) / 2.
            },
            _ => return None,
        };
        Some(result)
    }

    pub fn sample(&self, progress: f64, duration_ms: f64) -> f64 {
        if progress <= 0. {
            return 0.;
        }
        if progress >= 1. {
            return 1.;
        }
        // Named preset curves route through the Penner equation library.
        if let Easing::Named { ref name } = *self {
            if let Some(v) = Self::named_curve(name, progress) {
                return v;
            }
        }
        match *self {
            Self::Named { .. } => progress,
            Self::Linear => progress,
            Self::Hold => 0.,
            Self::Cubic { x1, y1, x2, y2 } => {
                let curve = |a: f64, b: f64, t: f64| {
                    let q = 1. - t;
                    3. * q * q * t * a + 3. * q * t * t * b + t * t * t
                };
                let (mut lo, mut hi) = (0., 1.);
                for _ in 0..48 {
                    let t = (lo + hi) * 0.5;
                    if curve(x1, x2, t) < progress {
                        lo = t
                    } else {
                        hi = t
                    }
                }
                curve(y1, y2, (lo + hi) * 0.5)
            }
            Self::Spring {
                mass,
                stiffness,
                damping,
                velocity,
            } => {
                let t = progress * duration_ms / 1000.;
                let omega = (stiffness / mass).sqrt();
                let zeta = damping / (2. * (stiffness * mass).sqrt());
                let displacement = if (zeta - 1.).abs() < 1e-7 {
                    (-1. + (velocity - omega) * t) * (-omega * t).exp()
                } else if zeta < 1. {
                    let wd = omega * (1. - zeta * zeta).sqrt();
                    (-omega * zeta * t).exp()
                        * (-(wd * t).cos() + (velocity - zeta * omega) / wd * (wd * t).sin())
                } else {
                    let q = (zeta * zeta - 1.).sqrt();
                    let r1 = -omega / (zeta + q);
                    let r2 = -omega * (zeta + q);
                    let a = (velocity + r2) / (r1 - r2);
                    a * (r1 * t).exp() + (-1. - a) * (r2 * t).exp()
                };
                1. + displacement
            }
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pose {
    pub kind: String,
    pub transform: Transform,
    pub width: f64,
    pub height: f64,
    pub opacity: f64,
    pub radii: [f64; 4],
    pub smoothing: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arc: Option<crate::scene::EllipseArc>,
    #[serde(default, skip_serializing_if = "crate::authoring_shapes::is_zero")]
    pub corner_radius: f64,
    pub fills: Vec<Paint>,
    pub strokes: Vec<Stroke>,
    pub effects: Vec<Effect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<std::sync::Arc<Network>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vector_geometry: Option<std::sync::Arc<crate::vector_geometry::VectorGeometry>>,
}
impl From<&Node> for Pose {
    fn from(n: &Node) -> Self {
        Self {
            kind: n.kind.clone(),
            transform: n.transform,
            width: n.width,
            height: n.height,
            opacity: n.opacity,
            radii: n.radii,
            smoothing: n.smoothing,
            arc: n.arc,
            corner_radius: n.corner_radius,
            fills: n.fills.clone(),
            strokes: n.strokes.clone(),
            effects: n.effects.clone(),
            network: n.network.clone(),
            vector_geometry: n.vector_geometry.clone(),
        }
    }
}
impl Pose {
    pub fn apply(&self, n: &mut Node) {
        n.transform = self.transform;
        n.width = self.width;
        n.height = self.height;
        n.opacity = self.opacity;
        n.radii = self.radii;
        n.smoothing = self.smoothing;
        n.arc = self.arc;
        n.corner_radius = self.corner_radius;
        n.fills = self.fills.clone();
        n.strokes = self.strokes.clone();
        n.effects = self.effects.clone();
        n.network = self.network.clone();
        n.vector_geometry = self.vector_geometry.clone();
    }
    fn validate(
        &self,
        base: &Node,
        color: Option<crate::color::ColorSettings>,
    ) -> Result<(), String> {
        crate::authoring_shapes::validate(
            &self.kind,
            self.arc,
            self.corner_radius,
            self.network.is_some(),
        )?;
        if self.kind != base.kind {
            return Err("Animation target kind changed; re-record its keyframes".into());
        }
        if self.transform.inverse().is_err()
            || self
                .transform
                .0
                .iter()
                .any(|v| !v.is_finite() || v.abs() > 1e7)
            || [self.width, self.height]
                .iter()
                .any(|v| !v.is_finite() || *v < 0.01 || *v > 1e7)
            || !self.opacity.is_finite()
            || !(0. ..=1.).contains(&self.opacity)
            || !self.smoothing.is_finite()
            || !(0. ..=1.).contains(&self.smoothing)
            || self
                .radii
                .iter()
                .any(|v| !v.is_finite() || *v < 0. || *v > 1e7)
            || self.fills.len() > 16
            || self.strokes.len() > 16
            || self.effects.len() > 16
        {
            return Err("Invalid animation pose".into());
        }
        for p in self
            .fills
            .iter()
            .chain(self.strokes.iter().map(|s| &s.paint))
        {
            crate::color::pixel(color, &p.color, 1.)?;
            if !p.opacity.is_finite()
                || !(0. ..=1.).contains(&p.opacity)
                || !p.angle.is_finite()
                || p.angle.abs() > 1e7
                || !crate::blend::valid_mode(&p.blend)
                || !matches!(p.kind.as_str(), "solid" | "linear" | "radial" | "image")
                || p.stops.len() > crate::scene::MAX_GRADIENT_STOPS
                || !matches!(p.fit.as_str(), "cover" | "contain" | "stretch")
            {
                return Err("Invalid animated paint".into());
            }
            if p.kind == "image"
                && !p.image.as_ref().is_some_and(|uri| {
                    uri.len() <= 12 * 1024 * 1024
                        && [
                            "data:image/png;base64,",
                            "data:image/jpeg;base64,",
                            "data:image/webp;base64,",
                        ]
                        .iter()
                        .any(|prefix| uri.starts_with(prefix))
                })
            {
                return Err("Animation images must use embedded PNG/JPEG/WebP data".into());
            }
            for stop in &p.stops {
                crate::color::pixel(color, &stop.color, 1.)?;
                if !stop.offset.is_finite() || !(0. ..=1.).contains(&stop.offset) {
                    return Err("Invalid animated gradient".into());
                }
            }
        }
        for e in &self.effects {
            e.validate_material()?;
            crate::color::pixel(color, &e.color, 1.)?;
            if !matches!(
                e.kind.as_str(),
                "blur"
                    | "background-blur"
                    | "glass"
                    | "shadow"
                    | "inner-shadow"
                    | "noise"
                    | "texture"
                    | "color-controls"
                    | "gaussian-blur"
                    | "motion-blur" | "zoom-blur"
            ) || [e.radius, e.x, e.y, e.spread, e.amount, e.opacity]
                .iter()
                .any(|v| !v.is_finite() || v.abs() > 1e7)
                || !(0. ..=1000.).contains(&e.radius)
                || !(0. ..=1.).contains(&e.opacity)
            {
                return Err("Invalid animated effect".into());
            }
        }
        let mut probe = base.clone();
        self.apply(&mut probe);
        probe.validate_strokes()?;
        if let Some(geometry)=&self.vector_geometry {
            if self.kind!="vector" || self.network.is_some() {return Err("Invalid animated vector representation".into());}
            geometry.validate()?;
        }
        if let Some(n) = &self.network {
            if n.vertices.len() > 20000
                || n.edges.len() > 40000
                || n.vertices.iter().any(|v| {
                    !v.x.is_finite() || !v.y.is_finite() || v.x.abs() > 1e7 || v.y.abs() > 1e7
                })
                || n.edges.iter().any(|e| {
                    [e.c1, e.c2]
                        .into_iter()
                        .flatten()
                        .any(|p| !p.finite() || p.x.abs() > 1e7 || p.y.abs() > 1e7)
                })
            {
                return Err("Invalid animated vector".into());
            }
            n.paths()?;
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe {
    pub time_ms: f64,
    pub value: Pose,
    #[serde(default)]
    pub easing: Easing,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub node_id: String,
    pub keyframes: Vec<Keyframe>,
    #[serde(default)]
    pub rotation_turns: i32,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Repeat {
    #[default]
    Once,
    Loop,
    Alternate,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub name: String,
    pub page_id: String,
    pub duration_ms: f64,
    #[serde(default)]
    pub delay_ms: f64,
    #[serde(default)]
    pub repeat: Repeat,
    pub tracks: Vec<Track>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub clip_id: String,
    pub time_ms: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleState {
    pub local_ms: f64,
    pub iteration: u64,
    pub finished: bool,
    pub changed_nodes: usize,
}

pub(crate) fn compatible(a: &Pose, b: &Pose) -> bool {
    let paints = |a: &[Paint], b: &[Paint]| {
        a.len() == b.len()
            && a.iter().zip(b).all(|(a, b)| {
                a.kind == b.kind
                    && a.blend == b.blend
                    && a.visible == b.visible
                    && a.fit == b.fit
                    && a.image == b.image
                    && a.stops.len() == b.stops.len()
            })
    };
    let networks = match (&a.network, &b.network) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a.fill_rule == b.fill_rule
                && a.vertices.len() == b.vertices.len()
                && a.edges.len() == b.edges.len()
                && a.vertices
                    .iter()
                    .zip(&b.vertices)
                    .all(|(a, b)| a.id == b.id)
                && a.edges.iter().zip(&b.edges).all(|(a, b)| {
                    a.id == b.id
                        && a.from == b.from
                        && a.to == b.to
                        && a.c1.is_some() == b.c1.is_some()
                        && a.c2.is_some() == b.c2.is_some()
                })
        }
        _ => false,
    };
    let det = |m: Transform| m.0[0] * m.0[3] - m.0[1] * m.0[2];
    det(a.transform).signum() == det(b.transform).signum()
        && paints(&a.fills, &b.fills)
        && a.strokes.len() == b.strokes.len()
        && a.strokes.iter().zip(&b.strokes).all(|(a, b)| {
            a.align == b.align
                && a.start_marker == b.start_marker
                && a.end_marker == b.end_marker
                && a.cap == b.cap
                && a.join == b.join
                && a.dash == b.dash
                && a.visible == b.visible
                && a.width_profile == b.width_profile
                && paints(
                    std::slice::from_ref(&a.paint),
                    std::slice::from_ref(&b.paint),
                )
        })
        && a.effects.len() == b.effects.len()
        && a.effects.iter().zip(&b.effects).all(|(a, b)| {
            a.kind == b.kind
                && a.visible == b.visible
                && a.glass.is_some() == b.glass.is_some()
                && a.gradient_blur.as_ref().map(|g| g.smooth)
                    == b.gradient_blur.as_ref().map(|g| g.smooth)
                && a.texture.as_ref().map(|t| t.clip_to_shape)
                    == b.texture.as_ref().map(|t| t.clip_to_shape)
        })
        && networks
        && a.vector_geometry == b.vector_geometry
}
pub fn validate(doc: &Document) -> Result<(), String> {
    if doc.schema_version < 8 && crate::stroke::has_markers(doc) {
        return Err("Stroke markers require schema 8".into());
    }
    if doc.schema_version < 7
        && doc
            .animations
            .iter()
            .flat_map(|c| &c.tracks)
            .flat_map(|t| &t.keyframes)
            .any(|k| k.value.arc.is_some() || k.value.corner_radius != 0.)
    {
        return Err("Native shape authoring requires schema 7".into());
    }
    if doc.schema_version < 5
        && doc
            .animations
            .iter()
            .flat_map(|c| &c.tracks)
            .flat_map(|t| &t.keyframes)
            .flat_map(|k| &k.value.effects)
            .any(|e| e.glass.is_some() || e.texture.is_some())
    {
        return Err("Material parameters require schema 5".into());
    }
    if doc.animations.len() > 64 {
        return Err("Animation clip budget exceeded".into());
    }
    let mut ids = HashSet::new();
    let mut total = 0usize;
    let mut vertices = 0usize;
    for clip in &doc.animations {
        if clip.id.is_empty()
            || clip.id.len() > 128
            || !ids.insert(&clip.id)
            || clip.name.len() > 200
            || !clip.duration_ms.is_finite()
            || !(1. ..=600000.).contains(&clip.duration_ms)
            || !clip.delay_ms.is_finite()
            || !(0. ..=600000.).contains(&clip.delay_ms)
            || clip.tracks.is_empty()
            || clip.tracks.len() > 1024
        {
            return Err("Invalid animation clip or work budget".into());
        }
        let page = doc
            .pages
            .iter()
            .find(|p| p.id == clip.page_id)
            .ok_or("Animation page is missing")?;
        let mut descendants = HashSet::new();
        let mut pending = page.children.clone();
        while let Some(id) = pending.pop() {
            if descendants.insert(id.clone()) {
                let node = doc.nodes.get(&id).ok_or("Animation layer is missing")?;
                pending.extend(node.children.clone());
            }
        }
        let mut targets = HashSet::new();
        for track in &clip.tracks {
            let base = doc
                .nodes
                .get(&track.node_id)
                .ok_or("Animation target is missing")?;
            if !descendants.contains(&track.node_id)
                || !targets.insert(&track.node_id)
                || track.rotation_turns.unsigned_abs() > 16
                || track.keyframes.is_empty()
                || track.keyframes.len() > 256
            {
                return Err("Invalid animation track".into());
            }
            total += track.keyframes.len();
            if total > 16384 {
                return Err("Animation keyframe budget exceeded".into());
            }
            let mut previous = None;
            for key in &track.keyframes {
                if !key.time_ms.is_finite()
                    || key.time_ms < 0.
                    || key.time_ms > clip.duration_ms
                    || previous.is_some_and(|time| time >= key.time_ms)
                {
                    return Err("Animation keyframes must have unique increasing times".into());
                }
                previous = Some(key.time_ms);
                key.easing.validate()?;
                key.value.validate(base, doc.color_management)?;
                if key.value.vector_geometry.is_some() && doc.schema_version<16 {return Err("Animated vector render geometry requires schema 16".into());}
                if let Some(n) = &key.value.network {
                    vertices += n.vertices.len() + n.edges.len();
                    if vertices > 1_000_000 {
                        return Err("Animated vector budget exceeded".into());
                    }
                }
                if !compatible(&track.keyframes[0].value, &key.value) {
                    return Err("Keyframes require matching paint, effect and vector topology; reflection changes need separate layers".into());
                }
            }
        }
    }
    Ok(())
}
fn mix(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}
fn color(a: &str, b: &str, t: f64, settings: Option<crate::color::ColorSettings>) -> String {
    if let Some(settings) = settings {
        let a = settings.parse(a, 1.).expect("validated animated color");
        let b = settings.parse(b, 1.).expect("validated animated color");
        let p = crate::blend::Pixel(std::array::from_fn(|i| {
            mix(f64::from(a.0[i]), f64::from(b.0[i]), t) as f32
        }));
        let rgb = p.rgb();
        return format!(
            "color(srgb-linear {} {} {} / {})",
            rgb[0],
            rgb[1],
            rgb[2],
            p.0[3].clamp(0., 1.)
        );
    }
    if a.starts_with("color(") || b.starts_with("color(") {
        let a = crate::color::pixel(None, a, 1.).expect("validated animated SDR color");
        let b = crate::color::pixel(None, b, 1.).expect("validated animated SDR color");
        let pixel = crate::blend::Pixel(std::array::from_fn(|i| {
            mix(f64::from(a.0[i]), f64::from(b.0[i]), t) as f32
        }));
        let rgb = pixel.rgb();
        return format!("color(srgb {} {} {} / {})", rgb[0], rgb[1], rgb[2], pixel.0[3].clamp(0., 1.));
    }
    let a = u32::from_str_radix(&a[1..], 16).expect("validated color");
    let b = u32::from_str_radix(&b[1..], 16).expect("validated color");
    let channels = [16, 8, 0].map(|shift| {
        mix(((a >> shift) & 255) as f64, ((b >> shift) & 255) as f64, t)
            .round()
            .clamp(0., 255.) as u32
    });
    format!("#{:02x}{:02x}{:02x}", channels[0], channels[1], channels[2])
}
fn transform(a: Transform, b: Transform, t: f64, turns: i32) -> Transform {
    let decompose = |m: Transform| {
        let [a, b, c, d, x, y] = m.0;
        let sx = a.hypot(b);
        let sy = (a * d - b * c) / sx;
        [x, y, b.atan2(a), sx, sy, (a * c + b * d) / (sx * sy)]
    };
    let a = decompose(a);
    let b = decompose(b);
    let tau = std::f64::consts::TAU;
    let mut delta = (b[2] - a[2] + std::f64::consts::PI).rem_euclid(tau) - std::f64::consts::PI;
    if delta == -std::f64::consts::PI {
        delta = std::f64::consts::PI;
    }
    let angle = a[2] + (delta + f64::from(turns) * tau) * t;
    let (s, c) = angle.sin_cos();
    let sx = mix(a[3], b[3], t).max(0.0001);
    let sy = mix(a[4], b[4], t).abs().max(0.0001) * a[4].signum();
    let shear = mix(a[5], b[5], t);
    Transform([
        c * sx,
        s * sx,
        (c * shear - s) * sy,
        (s * shear + c) * sy,
        mix(a[0], b[0], t).clamp(-1e7, 1e7),
        mix(a[1], b[1], t).clamp(-1e7, 1e7),
    ])
}
fn paint(a: &Paint, b: &Paint, t: f64, settings: Option<crate::color::ColorSettings>) -> Paint {
    let mut out = a.clone();
    out.color = color(&a.color, &b.color, t, settings);
    out.opacity = mix(a.opacity, b.opacity, t).clamp(0., 1.);
    out.angle = mix(a.angle, b.angle, t);
    out.transform = if a.transform.is_some() || b.transform.is_some() {
        Some(transform(
            a.transform.unwrap_or_default(),
            b.transform.unwrap_or_default(),
            t,
            0,
        ))
    } else {
        None
    };
    for ((s, a), b) in out.stops.iter_mut().zip(&a.stops).zip(&b.stops) {
        s.offset = mix(a.offset, b.offset, t).clamp(0., 1.);
        s.color = color(&a.color, &b.color, t, settings);
    }
    out
}
pub(crate) fn interpolate(
    a: &Pose,
    b: &Pose,
    t: f64,
    turns: i32,
    settings: Option<crate::color::ColorSettings>,
) -> Pose {
    if t == 0. {
        return a.clone();
    }
    if t == 1. {
        return b.clone();
    }
    let mut out = a.clone();
    out.transform = transform(a.transform, b.transform, t, turns);
    out.width = mix(a.width, b.width, t).clamp(0.01, 1e7);
    out.height = mix(a.height, b.height, t).clamp(0.01, 1e7);
    out.opacity = mix(a.opacity, b.opacity, t).clamp(0., 1.);
    out.smoothing = mix(a.smoothing, b.smoothing, t).clamp(0., 1.);
    out.corner_radius = mix(a.corner_radius, b.corner_radius, t).clamp(0., 1e7);
    if a.arc.is_some() || b.arc.is_some() {
        let full = crate::scene::EllipseArc {
            start_angle: 0.,
            sweep_angle: std::f64::consts::TAU,
            inner_radius: 0.,
        };
        let aa = a.arc.unwrap_or(full);
        let bb = b.arc.unwrap_or(full);
        out.arc = Some(crate::scene::EllipseArc {
            start_angle: mix(aa.start_angle, bb.start_angle, t).clamp(-1e7, 1e7),
            sweep_angle: mix(aa.sweep_angle, bb.sweep_angle, t)
                .clamp(-std::f64::consts::TAU, std::f64::consts::TAU),
            inner_radius: mix(aa.inner_radius, bb.inner_radius, t).clamp(0., 1.),
        });
    }
    out.radii = std::array::from_fn(|i| mix(a.radii[i], b.radii[i], t).clamp(0., 1e7));
    out.fills = a
        .fills
        .iter()
        .zip(&b.fills)
        .map(|(a, b)| paint(a, b, t, settings))
        .collect();
    for ((s, a), b) in out.strokes.iter_mut().zip(&a.strokes).zip(&b.strokes) {
        s.width = mix(a.width, b.width, t).clamp(0., 4096.);
        s.dash_offset = mix(a.dash_offset, b.dash_offset, t).clamp(-1e7, 1e7);
        s.paint = paint(&a.paint, &b.paint, t, settings);
    }
    for ((e, a), b) in out.effects.iter_mut().zip(&a.effects).zip(&b.effects) {
        e.color = color(&a.color, &b.color, t, settings);
        e.radius = mix(a.radius, b.radius, t).clamp(0., 1000.);
        e.x = mix(a.x, b.x, t);
        e.y = mix(a.y, b.y, t);
        e.spread = mix(a.spread, b.spread, t);
        e.opacity = mix(a.opacity, b.opacity, t).clamp(0., 1.);
        e.amount = mix(a.amount, b.amount, t);
        e.motion_angle = mix(a.motion_angle,b.motion_angle,t);
        if let (Some(o),Some(a),Some(b))=(&mut e.zoom_blur,a.zoom_blur,b.zoom_blur) {
            o.amount=mix(a.amount,b.amount,t);o.center=std::array::from_fn(|i|mix(a.center[i],b.center[i],t));
        }
        if let (Some(o), Some(a), Some(b)) = (&mut e.glass, &a.glass, &b.glass) {
            o.depth = mix(a.depth, b.depth, t);
            o.refraction = mix(a.refraction, b.refraction, t);
            o.dispersion = mix(a.dispersion, b.dispersion, t);
            o.light_intensity = mix(a.light_intensity, b.light_intensity, t);
            if a.bevel_size.is_some() || b.bevel_size.is_some() {
                o.bevel_size = Some(mix(a.bevel_size(), b.bevel_size(), t));
            }
            o.light_angle = a.light_angle
                + ((b.light_angle - a.light_angle + 180.).rem_euclid(360.) - 180.) * t;
        }
        if let (Some(o), Some(a), Some(b)) =
            (&mut e.gradient_blur, &a.gradient_blur, &b.gradient_blur)
        {
            o.start = std::array::from_fn(|i| mix(a.start[i], b.start[i], t));
            o.end = std::array::from_fn(|i| mix(a.end[i], b.end[i], t));
            o.start_count = mix(a.start_count, b.start_count, t);
            o.end_count = mix(a.end_count, b.end_count, t);
        }
        if let (Some(o), Some(a), Some(b)) = (&mut e.texture, &a.texture, &b.texture) {
            o.noise_size = std::array::from_fn(|i| mix(a.noise_size[i], b.noise_size[i], t));
        }
    }
    if let (Some(out), Some(a), Some(b)) = (&mut out.network, &a.network, &b.network) {
        let out = std::sync::Arc::make_mut(out);
        for ((v, a), b) in out.vertices.iter_mut().zip(&a.vertices).zip(&b.vertices) {
            v.x = mix(a.x, b.x, t);
            v.y = mix(a.y, b.y, t);
        }
        for ((e, a), b) in out.edges.iter_mut().zip(&a.edges).zip(&b.edges) {
            e.c1 = a.c1.zip(b.c1).map(|(a, b)| a.lerp(b, t));
            e.c2 = a.c2.zip(b.c2).map(|(a, b)| a.lerp(b, t));
        }
    }
    out
}
pub fn sample(doc: &Document, request: &Sample) -> Result<(Document, SampleState), String> {
    doc.validate()?;
    sample_validated(doc, request)
}
pub(crate) fn sample_validated(
    doc: &Document,
    request: &Sample,
) -> Result<(Document, SampleState), String> {
    if !request.time_ms.is_finite() || !(0. ..=1e12).contains(&request.time_ms) {
        return Err("Invalid animation time".into());
    }
    let clip = doc
        .animations
        .iter()
        .find(|c| c.id == request.clip_id)
        .ok_or("Animation clip not found")?;
    let elapsed = (request.time_ms - clip.delay_ms).max(0.);
    let iteration = (elapsed / clip.duration_ms).floor() as u64;
    let local_ms = match clip.repeat {
        Repeat::Once => elapsed.min(clip.duration_ms),
        Repeat::Loop => elapsed % clip.duration_ms,
        Repeat::Alternate => {
            let phase = elapsed % clip.duration_ms;
            if iteration.is_multiple_of(2) {
                phase
            } else {
                clip.duration_ms - phase
            }
        }
    };
    let mut result = doc.clone();
    for track in &clip.tracks {
        let index = track.keyframes.partition_point(|k| k.time_ms <= local_ms);
        let value = if index == 0 {
            track.keyframes[0].value.clone()
        } else if index == track.keyframes.len() {
            track.keyframes[index - 1].value.clone()
        } else {
            let a = &track.keyframes[index - 1];
            let b = &track.keyframes[index];
            let span = b.time_ms - a.time_ms;
            interpolate(
                &a.value,
                &b.value,
                a.easing.sample((local_ms - a.time_ms) / span, span),
                track.rotation_turns,
                doc.color_management,
            )
        };
        let node = result
            .nodes
            .get_mut(&track.node_id)
            .ok_or("Animation target disappeared")?;
        value.validate(node, doc.color_management)?;
        value.apply(node);
    }
    Ok((
        result,
        SampleState {
            local_ms,
            iteration,
            finished: clip.repeat == Repeat::Once && elapsed >= clip.duration_ms,
            changed_nodes: clip.tracks.len(),
        },
    ))
}
