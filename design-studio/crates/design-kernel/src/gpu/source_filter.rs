//! Reduced vector geometry for an isolated, wide display filter. The packet
//! carries paths and material parameters. The GPU rasterizes all four sample
//! phases, filters them and reconstructs the result at the screen density.
use super::*;
use crate::path::Contour;
use crate::scene::Paint;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFilter {
    pub factor: u32,
    pub effect_index: usize,
    pub sharp_halo: i32,
    pub input: Rect,
    pub radius: f64,
    pub gaussian: bool,
    pub output: Rect,
    pub masks: Vec<FilterPath>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub group_roots: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub additional: Vec<SourceFilter>,
}
impl SourceFilter {
    pub(super) fn channels(&self) -> impl Iterator<Item = &FilterPath> {
        self.masks
            .iter()
            .chain(self.additional.iter().flat_map(|f| &f.masks))
    }
    pub(super) fn channels_mut(&mut self) -> impl Iterator<Item = &mut FilterPath> {
        self.masks
            .iter_mut()
            .chain(self.additional.iter_mut().flat_map(|f| &mut f.masks))
    }
}
#[derive(Clone, Serialize)]
pub struct FilterPath {
    pub path: GpuPath,
    pub opacity: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paint: Option<GpuPaint>,
}
struct Layout {
    factor: u32,
    output: Rect,
    input: Rect,
    radius: f64,
    gaussian: bool,
    sharp_halo: i32,
}

fn paint_alpha(p: &Paint) -> Option<f32> {
    if !p.visible || p.opacity <= 0. {
        return Some(0.);
    }
    if p.blend != "normal" || !(0. ..=1.).contains(&p.opacity) {
        return None;
    }
    let alpha = |s: &str| {
        crate::color::parse(s, crate::color::ColorSpace::Srgb)
            .ok()
            .map(|v| v.2)
    };
    let a = match p.kind.as_str() {
        "solid" => alpha(&p.color)?,
        "linear" | "radial" | "angular" | "diamond" => {
            let a = alpha(&p.stops.first()?.color)?;
            if !p.stops.iter().all(|s| alpha(&s.color) == Some(a)) {
                return None;
            }
            a
        }
        _ => return None,
    };
    (0. ..=1.).contains(&a).then_some((a * p.opacity) as f32)
}
fn supported_paint(p: &Paint) -> bool {
    if !p.visible || p.opacity <= 0. {
        return true;
    }
    let bounded = |s: &str| {
        crate::color::parse(s, crate::color::ColorSpace::Srgb).is_ok_and(|(space, rgb, a)| {
            matches!(
                space,
                crate::color::ColorSpace::Srgb | crate::color::ColorSpace::LinearSrgb
            ) && (0. ..=1.).contains(&a)
                && rgb.iter().all(|v| (0. ..=1.).contains(v))
        })
    };
    p.blend == "normal"
        && (0. ..=1.).contains(&p.opacity)
        && match p.kind.as_str() {
            "solid" => bounded(&p.color),
            "linear" | "radial" | "angular" | "diamond" => {
                !p.stops.is_empty() && p.stops.iter().all(|s| bounded(&s.color))
            }
            _ => false,
        }
}
fn effect_list(n: &Node) -> Option<Vec<&Effect>> {
    if n.effects.is_empty() || !n.render_children().is_empty() || n.clip || n.mask {
        return None;
    }
    let effects = n.effects.iter().filter(|e| e.visible).collect::<Vec<_>>();
    if effects.len() == 1 {
        return Some(effects);
    }
    if (2..=4).contains(&effects.len()) {
        let last = *effects.last()?;
        let prefix = &effects[..effects.len() - 1];
        let simple = effects.iter().all(|e| {
            e.gradient_blur.is_none()
                && e.spread == 0.
                && matches!(
                    e.kind.as_str(),
                    "shadow" | "inner-shadow" | "gaussian-blur" | "blur"
                )
        });
        // A final blur filters the complete preceding source. A final wide
        // shadow can also follow pointwise shadows: their sharp originals
        // remain on the native lattice, including their offset neighbourhood.
        if simple
            && (matches!(last.kind.as_str(), "gaussian-blur" | "blur")
                || last.radius > 0.
                    && prefix.iter().all(|e| {
                        matches!(e.kind.as_str(), "shadow" | "inner-shadow") && e.radius == 0.
                    }))
        {
            return Some(vec![last]);
        }
    }
    // Each correlated sample has alpha zero or one. An inner shadow over
    // such a source preserves that sample's alpha, so every following inner
    // shadow can read the original silhouette independently and in order.
    let binary = |p: &Paint| matches!(paint_alpha(p), Some(0.) | Some(1.));
    (effects.len() >= 2
        && effects.len() <= 4
        && effects.iter().all(|e| e.kind == "inner-shadow")
        && n.fills.iter().all(binary)
        && n.strokes
            .iter()
            .all(|s| !s.visible || s.width <= 0. || binary(&s.paint)))
    .then_some(effects)
}
fn layout(n: &Node, m: Transform, region: Rect, e: &Effect, bake_prefix: bool) -> Option<Layout> {
    if n.clip
        || n.mask
        || n.blend != "normal"
        || n.passes_backdrop()
        || region.empty()
        || region.w > 1024
        || region.h > 1024
        || n.fills.len() + n.strokes.len() > 12
    {
        return None;
    }
    let gaussian = e.kind == "gaussian-blur";
    if !matches!(
        e.kind.as_str(),
        "shadow" | "inner-shadow" | "gaussian-blur" | "blur"
    ) || e.spread != 0. && !matches!(e.kind.as_str(), "shadow" | "inner-shadow")
        || e.gradient_blur.is_some()
        || !n.fills.iter().all(supported_paint)
        || !n
            .strokes
            .iter()
            .all(|s| !s.visible || s.width <= 0. || supported_paint(&s.paint))
    {
        return None;
    }
    let radius = e.radius * m.max_scale();
    if !(96. ..=32768.).contains(&radius) {
        return None;
    }
    let minimum_sigma = if !gaussian || n.render_children().is_empty() {
        24.
    } else {
        8.
    };
    let mut factor = 2;
    while factor < 256 && radius / f64::from(factor * 2) >= minimum_sigma {
        factor *= 2
    }
    let f = f64::from(factor);
    let radius = radius / f;
    let is_shadow = matches!(e.kind.as_str(), "shadow" | "inner-shadow");
    let dx = if is_shadow {
        m.0[0] * e.x + m.0[2] * e.y
    } else {
        0.
    };
    let dy = if is_shadow {
        m.0[1] * e.x + m.0[3] * e.y
    } else {
        0.
    };
    if !dx.is_finite() || !dy.is_finite() || dx.abs() > 1_000_000. || dy.abs() > 1_000_000. {
        return None;
    }
    let r = region.expand(3);
    let output = Rect::new(
        r.x - dx.ceil() as i32 - 1,
        r.y - dy.ceil() as i32 - 1,
        r.w + 3,
        r.h + 3,
    );
    let x = (f64::from(output.x) / f).floor() as i32 - 2;
    let y = (f64::from(output.y) / f).floor() as i32 - 2;
    let right = (f64::from(output.right()) / f).ceil() as i32 + 2;
    let bottom = (f64::from(output.bottom()) / f).ceil() as i32 + 2;
    let grid = Rect::new(x, y, (right - x) as u32, (bottom - y) as u32);
    let support = if gaussian {
        crate::effects::gaussian_box_radii(radius)
            .ok()?
            .iter()
            .sum::<u32>() as i32
    } else {
        radius.ceil() as i32
    };
    let mut prefix_support = 0i32;
    let mut sharp_halo = 0i32;
    let preceding = n
        .effects
        .iter()
        .filter(|v| v.visible)
        .take_while(|v| !std::ptr::eq(*v, e));
    if bake_prefix {
        for prior in preceding {
            let reach = prior.radius * m.max_scale() / f;
            let offset = (m.0[0] * prior.x + m.0[2] * prior.y)
                .abs()
                .max((m.0[1] * prior.x + m.0[3] * prior.y).abs());
            if !reach.is_finite() || !offset.is_finite() || offset > 1_000_000. {
                return None;
            }
            let taps = if prior.kind == "gaussian-blur" {
                crate::effects::gaussian_box_radii(reach)
                    .ok()?
                    .iter()
                    .sum::<u32>() as i32
            } else {
                reach.ceil() as i32
            };
            prefix_support = prefix_support.saturating_add(taps + (offset / f).ceil() as i32 + 3);
            if is_shadow {
                sharp_halo = sharp_halo.saturating_add(offset.ceil() as i32 + 2)
            }
        }
    }
    let spread = (e.spread.abs() * m.max_scale()).round();
    if !spread.is_finite() || spread > 2048. {
        return None;
    }
    let input = grid.expand(support + (spread / f).ceil() as i32 + prefix_support + 2);
    if input.pixels() > 524288
        || [output.x, output.y, output.right(), output.bottom()]
            .iter()
            .any(|v| i64::from(*v).abs() > 2_000_000)
    {
        return None;
    }
    Some(Layout {
        factor,
        output,
        input,
        radius,
        gaussian,
        sharp_halo,
    })
}
pub(super) fn eligible(n: &Node, m: Transform, region: Rect) -> bool {
    effect_list(n).is_some_and(|effects| {
        effects
            .iter()
            .all(|e| layout(n, m, region, e, effects.len() == 1).is_some())
    })
}

fn shadow_child_id(parent: &str, child: &str) -> String {
    format!("\0source-shadow/{}/{}{}", parent.len(), parent, child)
}
// Only the isolated foreground is evaluated on this grid. Each descendant is
// sent through the ordinary compiler and painter, including nested effects.
fn subtree_layout(doc: &Document, n: &Node, m: Transform, region: Rect) -> Option<Layout> {
    if n.render_children().is_empty()
        || n.fills.iter().any(|p| p.visible)
        || n.strokes.iter().any(|s| s.visible && s.width > 0.)
    {
        return None;
    }
    let mut active = n.effects.iter().filter(|e| e.visible);
    let effect = active.next()?;
    if !matches!(
        effect.kind.as_str(),
        "gaussian-blur" | "shadow" | "inner-shadow"
    ) || active.next().is_some()
    {
        return None;
    }
    let field = layout(n, m, region, effect, false)?;
    let mut parent = m;
    for v in &mut parent.0 {
        *v /= f64::from(field.factor);
    }
    fn check(
        doc: &Document,
        n: &Node,
        parent: Transform,
        count: &mut usize,
        halo: f64,
        spatial_limit: f64,
        shadow_parent: Option<&str>,
    ) -> bool {
        if !n.visible || n.opacity == 0. {
            return true;
        }
        *count += 1;
        if *count > 128
            || shadow_parent.is_some_and(|id| doc.nodes.contains_key(&shadow_child_id(id, &n.id)))
            || n.clip
            || n.mask
            || n.blend != "normal"
            || n.render_children().len() > 64
            || !n.fills.iter().all(supported_paint)
            || !n
                .strokes
                .iter()
                .all(|s| !s.visible || s.width <= 0. || supported_paint(&s.paint))
            || n.effects.iter().filter(|e| e.visible).any(|e| {
                !matches!(
                    e.kind.as_str(),
                    "blur" | "gaussian-blur" | "shadow" | "inner-shadow"
                ) || e.gradient_blur.is_some()
                    || e.spread != 0.
                    || !e.radius.is_finite()
            })
        {
            return false;
        }
        let m = parent.concat(n.transform);
        let support = halo + n.effect_outset(m.max_scale()) + 4.;
        support.is_finite()
            && support <= spatial_limit
            && n.render_children().iter().all(|id| {
                check(
                    doc,
                    &doc.nodes[id],
                    m,
                    count,
                    support,
                    spatial_limit,
                    shadow_parent,
                )
            })
    }
    let mut count = 0;
    let spatial_limit = ((724. - f64::from(field.input.w.max(field.input.h))) / 2.)
        .min(256.)
        .floor();
    n.render_children()
        .iter()
        .all(|id| {
            check(
                doc,
                &doc.nodes[id],
                parent,
                &mut count,
                0.,
                spatial_limit,
                (!field.gaussian).then_some(n.id.as_str()),
            )
        })
        .then_some(field)
}
pub(super) fn group_supported(doc: &Document, n: &Node, m: Transform, region: Rect) -> bool {
    subtree_layout(doc, n, m, region).is_some()
}
impl Compiler<'_> {
    fn reduced_group(
        &mut self,
        n: &Node,
        m: Transform,
        field: Layout,
    ) -> Result<SourceFilter, String> {
        let mut parent = m;
        for v in &mut parent.0 {
            *v /= f64::from(field.factor);
        }
        let mut prepared = HashMap::new();
        let mut segments = 0;
        let mut strokes = Default::default();
        let guard = field.input.expand(260);
        for id in n.render_children() {
            crate::geometry_snapshot::prepare_node_geometry(
                id,
                parent,
                (self.doc, self.fonts, guard, self.compatible),
                self.paths,
                &mut strokes,
                &mut prepared,
                &mut segments,
            )?;
        }
        // The buffers retain packet-global offsets and the original byte cap.
        // A separate geometry/program cache keeps the two lattices disjoint.
        let mut small = Compiler {
            doc: self.doc,
            fonts: self.fonts,
            paths: self.paths,
            extent: field.input,
            prepared: Arc::new(prepared),
            compatible: self.compatible,
            profile: self.profile,
            interactive_effects: false,
            large_packet: self.large_packet,
            gaussian_regions: false,
            gaussian_reduction: 0,
            source_filter_fields: false,
            prune_backdrop_output: false,
            stages: None,
            backdrop_outputs: Default::default(),
            shadow_outputs: Default::default(),
            curves: std::mem::take(&mut self.curves),
            vertices: std::mem::take(&mut self.vertices),
            area_paths: std::mem::take(&mut self.area_paths),
            programs: Default::default(),
            fragments: Default::default(),
            fragment_targets: Default::default(),
            compiled_order: Vec::new(),
            nodes: BTreeMap::new(),
        };
        let result = n
            .render_children()
            .iter()
            .try_for_each(|id| small.node(id, parent, Some(field.input)).map(|_| ()));
        self.curves = small.curves;
        self.vertices = small.vertices;
        self.area_paths = small.area_paths;
        result?;
        let roots = if field.gaussian {
            self.compiled_order.extend(small.compiled_order);
            self.nodes.append(&mut small.nodes);
            n.render_children().to_vec()
        } else {
            // A shadow also needs the original sharp subtree. Give its sampled
            // geometry private names, preserving all declared child ordering.
            let tag = |id: &str| shadow_child_id(&n.id, id);
            self.compiled_order
                .extend(small.compiled_order.iter().map(|id| tag(id)));
            for (id, mut child) in small.nodes {
                let key = tag(&id);
                child.id = key.clone();
                child.children = child.children.iter().map(|id| tag(id)).collect();
                child.mask_id = child.mask_id.as_deref().map(tag);
                self.nodes.insert(key, child);
            }
            n.render_children().iter().map(|id| tag(id)).collect()
        };
        Ok(SourceFilter {
            factor: field.factor,
            effect_index: 0,
            sharp_halo: 0,
            input: field.input,
            output: field.output,
            radius: field.radius,
            gaussian: field.gaussian,
            masks: Vec::new(),
            group_roots: roots,
            additional: Vec::new(),
        })
    }
    pub(super) fn filter_planes(
        &mut self,
        n: &Node,
        p: &crate::geometry_snapshot::Prepared,
        region: Rect,
    ) -> Result<Option<SourceFilter>, String> {
        if !n.render_children().is_empty() {
            return subtree_layout(self.doc, n, p.matrix, region)
                .map(|field| self.reduced_group(n, p.matrix, field))
                .transpose();
        }
        let Some(effects) = effect_list(n) else {
            return Ok(None);
        };
        let Some(layouts) = effects
            .iter()
            .map(|e| layout(n, p.matrix, region, e, effects.len() == 1))
            .collect::<Option<Vec<_>>>()
        else {
            return Ok(None);
        };
        let mut fields = Vec::with_capacity(layouts.len());
        for (index, l) in layouts.into_iter().enumerate() {
            let f = f64::from(l.factor);
            let mut masks = Vec::new();
            let mut matrix = p.matrix;
            for v in &mut matrix.0 {
                *v /= f;
            }
            let inverse = matrix.inverse_composed(l.input)?;
            let colour = n
                .effects
                .iter()
                .any(|e| e.visible && matches!(e.kind.as_str(), "gaussian-blur" | "blur"))
                || n.fills.iter().any(|p| paint_alpha(p).is_none())
                || n.strokes
                    .iter()
                    .any(|s| s.visible && s.width > 0. && paint_alpha(&s.paint).is_none());
            let mut add = |slot: usize,
                           contours: &[Contour],
                           even_odd: bool,
                           opacity: f32,
                           paint: Option<&Paint>|
             -> Result<(), String> {
                if opacity <= 0. || contours.is_empty() {
                    return Ok(());
                }
                let scaled = contours
                    .iter()
                    .map(|c| Contour {
                        closed: c.closed,
                        points: c
                            .points
                            .iter()
                            .map(|v| Point::new(v.x / f, v.y / f))
                            .collect(),
                    })
                    .collect::<Vec<_>>();
                let path = self.area_path(
                    &scaled,
                    (
                        &n.id,
                        n.strokes.len() + 1 + index * (2 + n.strokes.len() + n.fills.len()) + slot,
                    ),
                    l.input,
                    even_odd,
                    None,
                )?;
                if path.count > 0 {
                    masks.push(FilterPath {
                        path,
                        opacity,
                        paint: paint
                            .map(|paint| {
                                GpuPaint::new(paint, inverse, [n.width, n.height], l.input, false)
                            })
                            .transpose()?,
                    });
                }
                Ok(())
            };
            let fill = n
                .fills
                .iter()
                .filter_map(paint_alpha)
                .fold(0f32, |v, a| a + v * (1. - a));
            if colour {
                for (i, paint) in n
                    .fills
                    .iter()
                    .enumerate()
                    .filter(|(_, p)| p.visible && p.opacity > 0.)
                {
                    add(
                        i,
                        &p.fill,
                        n.kind != "text" && n.fill_even_odd(),
                        1.,
                        Some(paint),
                    )?;
                }
            } else {
                add(
                    0,
                    &p.fill,
                    n.kind != "text" && n.fill_even_odd(),
                    fill,
                    None,
                )?;
            }
            for (i, s) in n.strokes.iter().enumerate() {
                if s.visible && s.width > 0. {
                    let Some(outline) = p.strokes.get(i) else {
                        return Ok(None);
                    };
                    add(
                        n.fills.len() + i + 1,
                        outline,
                        false,
                        if colour {
                            1.
                        } else {
                            paint_alpha(&s.paint).unwrap_or(0.)
                        },
                        colour.then_some(&s.paint),
                    )?;
                }
            }
            let effect_index = n
                .effects
                .iter()
                .filter(|e| e.visible)
                .position(|e| std::ptr::eq(e, effects[index]))
                .unwrap();
            fields.push(SourceFilter {
                factor: l.factor,
                effect_index,
                sharp_halo: l.sharp_halo,
                input: l.input,
                output: l.output,
                radius: l.radius,
                gaussian: l.gaussian,
                masks,
                group_roots: Vec::new(),
                additional: Vec::new(),
            });
        }
        let mut fields = fields.into_iter();
        let mut first = fields.next().unwrap();
        first.additional = fields.collect();
        Ok(Some(first))
    }
}
