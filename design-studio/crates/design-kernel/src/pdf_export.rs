//! True-vector single-page PDF 1.7 export. Paths, axial and radial gradients,
//! and image fills become native PDF objects; the bitmap PDF in
//! `export_formats::transcode` remains the fallback for unsupported content.
//!
//! Coordinates: design space has its origin at the top-left with y growing
//! downward, while PDF user space starts at the bottom-left. One page-level
//! `1 0 0 -1 0 height cm` flip converts between them, so every `Node.transform`
//! composes unchanged inside `q ... cm ... Q` pairs.
//!
//! v1 scope (declared fallbacks):
//! - Plain text exports as native text operators (BT/Tf/Tm/Tj) through a
//!   Type0 CID font (Identity-H) with the whole font file embedded
//!   (/FontFile2 TrueType or /FontFile3 OpenType-CFF), never subsetted.
//!   Path text, rotated Latin runs inside vertical writing and
//!   underline/strikethrough runs fall back to glyph outlines, as do text
//!   nodes with non-solid fills, strokes or clip usage. Embedded variable
//!   fonts render at their default instance (PDF carries no variation
//!   state), while /W widths and glyph positions follow the shaped
//!   instance. Without resident fonts (`encode_pdf_vector`) the free
//!   function only sees text the caller already expanded to outlines.
//! - Angular and diamond gradients have no PDF shading equivalent; they fall
//!   back to a solid fill of the first stop color.
//! - Mask nodes and effects are ignored. Strokes with inside/outside
//!   alignment, width profiles, markers, or non-solid paint export as the
//!   kernel's expanded outline geometry instead of the `S` operator.
//! - `RenderOptions.view` is ignored; width/height become MediaBox points.

use crate::{
    Engine, RenderOptions,
    color::ColorSettings,
    font::Fonts,
    math::{Point, Transform},
    path::{Command, Path},
    scene::{Document, Node, Paint, Stroke},
};
use std::{collections::BTreeMap, fmt::Write as _};

/// Acrobat's 14400-unit default user-space bound still applies to pages.
const MAX_SIDE_POINTS: f64 = 14400.;
/// Kernel images admit three URI schemes; anything else is rejected here too.
const IMAGE_URI_PREFIXES: [&str; 3] = [
    "data:image/png;base64,",
    "data:image/jpeg;base64,",
    "data:image/webp;base64,",
];

pub fn encode_pdf_vector(
    doc: &Document,
    page_id: &str,
    width: f64,
    height: f64,
    background: Option<&str>,
) -> Result<Vec<u8>, String> {
    encode(doc, page_id, width, height, background, None)
}

fn encode(
    doc: &Document,
    page_id: &str,
    width: f64,
    height: f64,
    background: Option<&str>,
    fonts: Option<&Fonts>,
) -> Result<Vec<u8>, String> {
    if ![width, height].iter().all(|v| v.is_finite())
        || width <= 0.
        || height <= 0.
        || width > MAX_SIDE_POINTS
        || height > MAX_SIDE_POINTS
    {
        return Err("PDF page requires finite dimensions of up to 14400 points".into());
    }
    let page = doc
        .pages
        .iter()
        .find(|p| p.id == page_id)
        .ok_or("Page not found")?;
    let mut pdf = Pdf::new();
    if let Some(background) = background {
        let (rgb, _) = color(doc.color_management, background, 1.)?;
        let _ = writeln!(
            pdf.content,
            "{} {} {} rg 0 0 {} {} re f",
            num(f64::from(rgb[0]))?,
            num(f64::from(rgb[1]))?,
            num(f64::from(rgb[2]))?,
            num(width)?,
            num(height)?
        );
    }
    for id in &page.children {
        visit(&mut pdf, doc.color_management, fonts, doc, id)?;
    }
    pdf.finish(width, height)
}

impl Engine {
    /// True-vector PDF of one page. Mirrors the PNG path's document preparation
    /// (layout, boolean and text resolution) so exported geometry matches the
    /// raster; `width`/`height` become MediaBox points and `transparent` drops
    /// the page background fill. Text exports as outlines via resident fonts.
    pub fn export_pdf_vector(&mut self, options: &RenderOptions) -> Result<Vec<u8>, String> {
        self.prepare_frame(options)?;
        self.resolve_layout()?;
        let doc = self
            .doc
            .as_ref()
            .ok_or("Load a document before exporting")?;
        let page = doc
            .pages
            .iter()
            .find(|p| p.id == options.page_id)
            .ok_or("Page not found")?;
        let background = (!options.transparent).then_some(page.background.as_str());
        encode(
            doc,
            &options.page_id,
            f64::from(options.width),
            f64::from(options.height),
            background,
            Some(&self.fonts),
        )
    }
}

/// Scene traversal in authored order: fills paint below children, strokes on
/// top, exactly like the CPU renderer's node bundle.
fn visit(
    pdf: &mut Pdf,
    settings: Option<ColorSettings>,
    fonts: Option<&Fonts>,
    doc: &Document,
    id: &str,
) -> Result<(), String> {
    let node = doc
        .nodes
        .get(id)
        .ok_or_else(|| format!("Missing node {id}"))?;
    if !node.visible || node.mask || node.opacity <= 0. {
        return Ok(());
    }
    pdf.content.push_str("q\n");
    write_transform(&mut pdf.content, node.transform)?;
    // Plain horizontal text paints through native text operators with an
    // embedded Type0 font; everything else keeps the outline path below.
    let mut text = false;
    if node.kind == "text"
        && let Some(fonts) = fonts
        && text_operators_apply(node)
    {
        text = write_text_operators(pdf, settings, node, fonts)?;
    }
    let (fill, stroke) = if text {
        (Path::default(), Path::default())
    } else {
        node_geometry(fonts, node)?
    };
    // The CPU sampler treats plain shapes as even-odd and text outlines as
    // nonzero; vector networks opt into nonzero explicitly.
    let evenodd = node.kind != "text"
        && node
            .network
            .as_ref()
            .is_none_or(|g| g.fill_rule == "evenodd");
    if !fill.commands.is_empty() {
        for paint in node.fills.iter().filter(|p| p.visible && p.opacity > 0.) {
            write_fill(pdf, settings, node, paint, evenodd, |ops| {
                write_path(ops, &fill)
            })?;
        }
    }
    let clipped = node.clip && !node.children.is_empty() && !fill.commands.is_empty();
    if clipped {
        pdf.content.push_str("q\n");
        write_path(&mut pdf.content, &fill)?;
        pdf.content
            .push_str(if evenodd { "W* n\n" } else { "W n\n" });
    }
    for child in node.render_children() {
        visit(pdf, settings, fonts, doc, child)?;
    }
    if clipped {
        pdf.content.push_str("Q\n");
    }
    if !stroke.commands.is_empty() {
        for s in node.strokes.iter().filter(|s| s.visible && s.width > 0.) {
            write_stroke(pdf, settings, node, s, &stroke)?;
        }
    }
    pdf.content.push_str("Q\n");
    Ok(())
}

fn node_geometry(fonts: Option<&Fonts>, node: &Node) -> Result<(Path, Path), String> {
    if node.kind == "text"
        && let Some(fonts) = fonts
    {
        let path = fonts.node_path(node)?;
        return Ok((path.clone(), path));
    }
    node.paths()
}

/// Text runs through BT/Tj only for the plain case: no path text, no clip,
/// no stroke, solid fills only and no underline/strikethrough runs (nodes
/// with colored or decorated runs usually arrive already expanded into
/// outline groups by `font::expand_rich_text`). Everything else falls back
/// to the outline geometry the CPU renderer draws.
fn text_operators_apply(node: &Node) -> bool {
    node.text_path.is_none()
        && !node.clip
        && node.strokes.iter().all(|s| !s.visible || s.width <= 0.)
        && node
            .fills
            .iter()
            .all(|p| !p.visible || p.opacity <= 0. || p.kind == "solid")
        && node
            .text_runs
            .iter()
            .all(|r| !r.underline && !r.strikethrough)
}

/// Emits one BT/ET block per visible solid fill, placing every glyph with
/// its own text matrix: shaping already positioned x/y in node-local design
/// space, so per-glyph Tm is exact and advances never accumulate error.
/// The negative d term undoes the page-level y-flip so glyphs paint
/// upright. Each used font is embedded whole (see `Pdf::font`). Returns
/// false when shaping produced rotated/path glyphs and the caller must
/// fall back to outlines.
fn write_text_operators(
    pdf: &mut Pdf,
    settings: Option<ColorSettings>,
    node: &Node,
    fonts: &Fonts,
) -> Result<bool, String> {
    let layout = fonts.node_layout(node, Some(node.width))?;
    if layout.glyphs.iter().any(|g| g.path_transform.is_some()) {
        return Ok(false);
    }
    // Glyph ids and per-instance advances grouped per font resource.
    let mut tables: BTreeMap<&str, BTreeMap<u16, u32>> = BTreeMap::new();
    let mut upems: BTreeMap<&str, u16> = BTreeMap::new();
    for glyph in &layout.glyphs {
        let bytes = fonts.bytes(&glyph.font_id)?;
        let upem = *upems.entry(glyph.font_id.as_str()).or_insert_with(|| {
            ttf_parser::Face::parse(bytes, 0)
                .ok()
                .map(|face| face.units_per_em())
                .unwrap_or(1000)
                .max(1)
        });
        // Prefer the face's own horizontal metric on the shaped variation
        // instance; faces without hmtx (bare CFF) fall back to the shaped
        // advance rescaled into font units.
        let units = u32::from(fonts.glyph_advance_units(glyph).unwrap_or_else(|| {
            ((glyph.advance / glyph.size) * f64::from(upem))
                .round()
                .clamp(0., 65535.) as u16
        }));
        tables
            .entry(glyph.font_id.as_str())
            .or_default()
            .entry(glyph.id)
            .or_insert(units);
    }
    let mut names: BTreeMap<&str, String> = BTreeMap::new();
    for (id, widths) in tables {
        let name = pdf.font(fonts.bytes(id)?, id, &widths)?;
        names.insert(id, name);
    }
    for paint in node.fills.iter().filter(|p| p.visible && p.opacity > 0.) {
        let (rgb, _) = color(settings, &paint.color, 1.)?;
        let alpha = (node.opacity * paint.opacity).clamp(0., 1.);
        let gs = pdf.gstate(alpha, effective_blend(node, paint))?;
        emit_gs(&mut pdf.content, &gs);
        let _ = writeln!(
            pdf.content,
            "{} {} {} rg",
            num(f64::from(rgb[0]))?,
            num(f64::from(rgb[1]))?,
            num(f64::from(rgb[2]))?
        );
        pdf.content.push_str("BT\n");
        for glyph in &layout.glyphs {
            let Some(name) = names.get(glyph.font_id.as_str()) else {
                continue;
            };
            let _ = writeln!(pdf.content, "{name} {} Tf", num(glyph.size)?);
            let _ = writeln!(
                pdf.content,
                "1 0 0 -1 {} {} Tm <{:04x}> Tj",
                num(glyph.x)?,
                num(glyph.y)?,
                glyph.id
            );
        }
        pdf.content.push_str("ET\n");
    }
    Ok(true)
}

fn effective_blend<'a>(node: &'a Node, paint: &'a Paint) -> &'a str {
    if paint.blend != "normal" {
        &paint.blend
    } else {
        node.composite_blend()
    }
}

/// Fills with a paint. `ops` emits the path construction operators inside the
/// caller's current coordinate system; the paint decides between direct color,
/// a clipped shading, or a clipped image XObject.
fn write_fill(
    pdf: &mut Pdf,
    settings: Option<ColorSettings>,
    node: &Node,
    paint: &Paint,
    evenodd: bool,
    ops: impl FnOnce(&mut String) -> Result<(), String>,
) -> Result<(), String> {
    let alpha = (node.opacity * paint.opacity).clamp(0., 1.);
    let gs = pdf.gstate(alpha, effective_blend(node, paint))?;
    let clip = if evenodd { "W* n " } else { "W n " };
    match paint.kind.as_str() {
        "solid" => {
            let (rgb, _) = color(settings, &paint.color, 1.)?;
            solid(pdf, &gs, rgb, evenodd, ops)
        }
        "linear" | "radial" => match gradient_solid(settings, paint)? {
            Some(rgb) => solid(pdf, &gs, rgb, evenodd, ops),
            None => {
                let name = pdf.shading(settings, paint, node)?;
                emit_gs(&mut pdf.content, &gs);
                pdf.content.push_str("q\n");
                ops(&mut pdf.content)?;
                let _ = write!(pdf.content, "{clip}{name} sh\nQ\n");
                Ok(())
            }
        },
        "angular" | "diamond" => {
            // No PDF shading exists for these; the first stop color is the
            // documented v1 fallback.
            let (rgb, _) = color(
                settings,
                paint
                    .stops
                    .first()
                    .map(|s| s.color.as_str())
                    .unwrap_or(paint.color.as_str()),
                1.,
            )?;
            solid(pdf, &gs, rgb, evenodd, ops)
        }
        "image" => {
            let Some(uri) = paint.image.as_deref() else {
                return Ok(());
            };
            let (name, width, height) = pdf.image(uri)?;
            // Map the image unit square with its first (top) row at v=1, so
            // the top lands on the smaller design-space y.
            let place = image_placement(paint, node.width, node.height, width, height)
                .concat(Transform([1., 0., 0., -1., 0., 1.]));
            emit_gs(&mut pdf.content, &gs);
            pdf.content.push_str("q\n");
            ops(&mut pdf.content)?;
            let _ = write!(pdf.content, "{clip}");
            write_transform(&mut pdf.content, place)?;
            let _ = write!(pdf.content, "{name} Do\nQ\n");
            Ok(())
        }
        _ => Err(format!("Unsupported paint kind {}", paint.kind)),
    }
}

fn solid(
    pdf: &mut Pdf,
    gs: &str,
    rgb: [f32; 3],
    evenodd: bool,
    ops: impl FnOnce(&mut String) -> Result<(), String>,
) -> Result<(), String> {
    emit_gs(&mut pdf.content, gs);
    let _ = writeln!(
        pdf.content,
        "{} {} {} rg",
        num(f64::from(rgb[0]))?,
        num(f64::from(rgb[1]))?,
        num(f64::from(rgb[2]))?
    );
    ops(&mut pdf.content)?;
    pdf.content.push_str(if evenodd { "f*\n" } else { "f\n" });
    Ok(())
}

/// Center-aligned solid strokes stay true vector strokes; everything else
/// (alignment, width profiles, markers, gradient/image paint) exports the
/// kernel's own expanded outline geometry as a fill.
fn write_stroke(
    pdf: &mut Pdf,
    settings: Option<ColorSettings>,
    node: &Node,
    s: &Stroke,
    path: &Path,
) -> Result<(), String> {
    let solid = if s.paint.kind == "solid" {
        Some(color(settings, &s.paint.color, 1.)?.0)
    } else {
        gradient_solid(settings, &s.paint)?
    };
    if s.align == "center"
        && s.width_profile.is_empty()
        && crate::stroke::Marker::is_none(&s.start_marker)
        && crate::stroke::Marker::is_none(&s.end_marker)
        && let Some(rgb) = solid
    {
        let alpha = (node.opacity * s.paint.opacity).clamp(0., 1.);
        let gs = pdf.gstate(alpha, effective_blend(node, &s.paint))?;
        emit_gs(&mut pdf.content, &gs);
        let _ = write!(
            pdf.content,
            "{} {} {} RG\n{} w\n",
            num(f64::from(rgb[0]))?,
            num(f64::from(rgb[1]))?,
            num(f64::from(rgb[2]))?,
            num(s.width)?
        );
        let cap = match s.cap.as_str() {
            "butt" => "0 J\n",
            "round" => "1 J\n",
            _ => "2 J\n",
        };
        let join = match s.join.as_str() {
            "miter" => "0 j\n",
            "round" => "1 j\n",
            _ => "2 j\n",
        };
        pdf.content.push_str(cap);
        pdf.content.push_str(join);
        if let Some((values, phase)) = dash(s)? {
            let pattern = values
                .iter()
                .map(|v| num(*v))
                .collect::<Result<Vec<_>, _>>()?
                .join(" ");
            let _ = writeln!(pdf.content, "[{pattern}] {} d", num(phase)?);
        }
        write_path(&mut pdf.content, path)?;
        pdf.content.push_str("S\n");
        return Ok(());
    }
    let lines = path.flatten(Transform::default(), 0.01)?;
    let outlines = crate::stroke::expand(&lines, s, 0.01, 0.)?;
    if outlines.is_empty() {
        return Ok(());
    }
    // Expanded stroke outlines carry positive winding, so they fill nonzero.
    write_fill(pdf, settings, node, &s.paint, false, |ops| {
        write_contours(ops, &outlines)
    })
}

/// Kernel dash strings are validated comma/space lists at document admission;
/// an all-zero pattern means "solid" exactly like `stroke::pattern`.
fn dash(s: &Stroke) -> Result<Option<(Vec<f64>, f64)>, String> {
    let mut values: Vec<f64> = s
        .dash
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|v| !v.is_empty())
        .map(|v| {
            v.parse::<f64>()
                .map_err(|_| "Invalid dash pattern".to_owned())
        })
        .collect::<Result<_, _>>()?;
    if values.iter().all(|v| *v == 0.) {
        return Ok(None);
    }
    if values.len() % 2 == 1 {
        let repeated = values.clone();
        values.extend(repeated);
    }
    Ok(Some((values, s.dash_offset)))
}

/// A gradient that carries no spatial variation exports as its constant color.
fn gradient_solid(
    settings: Option<ColorSettings>,
    paint: &Paint,
) -> Result<Option<[f32; 3]>, String> {
    if let Some(constant) = paint.constant_color() {
        return Ok(Some(color(settings, constant, 1.)?.0));
    }
    if paint.stops.is_empty() {
        return Ok(Some(color(settings, &paint.color, 1.)?.0));
    }
    let mut offsets: Vec<f64> = paint.stops.iter().map(|s| s.offset).collect();
    offsets.sort_by(f64::total_cmp);
    offsets.dedup();
    if offsets.len() == 1 {
        // One authored offset is a hard step; export the dominant final stop.
        let last = paint.stops.last().expect("stops checked");
        return Ok(Some(color(settings, &last.color, 1.)?.0));
    }
    Ok(None)
}

/// Image XObject placement in node-local design space, before the top-row
/// flip applied by the caller. Mirrors `paint::ImageCoordinates`: a paint
/// transform maps the unit square directly, otherwise cover/contain center
/// the scaled asset and stretch spans the node.
fn image_placement(
    paint: &Paint,
    width: f64,
    height: f64,
    image_width: u32,
    image_height: u32,
) -> Transform {
    let (iw, ih) = (f64::from(image_width), f64::from(image_height));
    if let Some(transform) = paint.transform {
        return Transform([width, 0., 0., height, 0., 0.]).concat(transform);
    }
    if paint.fit == "stretch" {
        return Transform([width / iw, 0., 0., height / ih, 0., 0.]);
    }
    let ratio = if paint.fit == "contain" {
        (width / iw).min(height / ih)
    } else {
        (width / iw).max(height / ih)
    };
    Transform([
        ratio,
        0.,
        0.,
        ratio,
        (width - iw * ratio) / 2.,
        (height - ih * ratio) / 2.,
    ])
}

fn emit_gs(content: &mut String, gs: &str) {
    if !gs.is_empty() {
        let _ = writeln!(content, "{gs} gs");
    }
}

fn write_transform(out: &mut String, m: Transform) -> Result<(), String> {
    let values = m.0.iter().map(|v| num(*v)).collect::<Result<Vec<_>, _>>()?;
    let _ = writeln!(out, "{} cm", values.join(" "));
    Ok(())
}

fn move_op(out: &mut String, p: Point) -> Result<(), String> {
    let _ = write!(out, "{} {} m ", num(p.x)?, num(p.y)?);
    Ok(())
}

fn write_path(out: &mut String, path: &Path) -> Result<(), String> {
    let (mut pen, mut first, mut open) = (Point::default(), Point::default(), false);
    for command in &path.commands {
        match *command {
            Command::Move(p) => {
                move_op(out, p)?;
                (pen, first, open) = (p, p, true);
            }
            Command::Line(p) => {
                if open {
                    let _ = write!(out, "{} {} l ", num(p.x)?, num(p.y)?);
                } else {
                    move_op(out, p)?;
                    (first, open) = (p, true);
                }
                pen = p;
            }
            Command::Quad(control, p) => {
                if !open {
                    move_op(out, pen)?;
                    (first, open) = (pen, true);
                }
                // Exact degree elevation, not a two-segment approximation.
                let a = pen.lerp(control, 2. / 3.);
                let b = p.lerp(control, 2. / 3.);
                let _ = write!(
                    out,
                    "{} {} {} {} {} {} c ",
                    num(a.x)?,
                    num(a.y)?,
                    num(b.x)?,
                    num(b.y)?,
                    num(p.x)?,
                    num(p.y)?
                );
                pen = p;
            }
            Command::Cubic(a, b, p) => {
                if !open {
                    move_op(out, pen)?;
                    (first, open) = (pen, true);
                }
                let _ = write!(
                    out,
                    "{} {} {} {} {} {} c ",
                    num(a.x)?,
                    num(a.y)?,
                    num(b.x)?,
                    num(b.y)?,
                    num(p.x)?,
                    num(p.y)?
                );
                pen = p;
            }
            Command::Arc {
                center,
                radius,
                start,
                sweep,
            } => {
                // PDF has no arc operator; the kernel's rational pieces
                // downgrade to cubics at its documented error bound.
                for (from, piece) in crate::path::rational_arc(
                    center,
                    radius,
                    start,
                    sweep,
                    std::f64::consts::FRAC_PI_2,
                )? {
                    if !open {
                        move_op(out, from)?;
                        (first, open) = (from, true);
                    }
                    let (a, b, end) = piece.to_cubic(from);
                    let _ = write!(
                        out,
                        "{} {} {} {} {} {} c ",
                        num(a.x)?,
                        num(a.y)?,
                        num(b.x)?,
                        num(b.y)?,
                        num(end.x)?,
                        num(end.y)?
                    );
                    pen = end;
                }
            }
            Command::SmoothCorner(corner) => {
                if !open {
                    move_op(out, corner.point(0.))?;
                    (first, open) = (corner.point(0.), true);
                }
                // SVG exchange keeps the legacy 64-chord superellipse.
                for p in corner.legacy_points() {
                    let _ = write!(out, "{} {} l ", num(p.x)?, num(p.y)?);
                }
                pen = corner.point(std::f64::consts::FRAC_PI_2);
            }
            Command::Close => {
                if open {
                    out.push_str("h ");
                    pen = first;
                }
            }
        }
    }
    out.push('\n');
    Ok(())
}

fn write_contours(out: &mut String, contours: &[crate::path::Contour]) -> Result<(), String> {
    for contour in contours {
        if let Some((first, rest)) = contour.points.split_first() {
            move_op(out, *first)?;
            for p in rest {
                let _ = write!(out, "{} {} l ", num(p.x)?, num(p.y)?);
            }
            if contour.closed {
                out.push_str("h ");
            }
        }
    }
    out.push('\n');
    Ok(())
}

/// Straight sRGB components in [0, 1], applying the managed-document
/// conversion the CPU renderer uses; unmanaged hex is already sRGB.
fn color(
    settings: Option<ColorSettings>,
    value: &str,
    opacity: f32,
) -> Result<([f32; 3], f32), String> {
    let pixel = crate::color::pixel(settings, value, opacity)?;
    let straight = settings.map_or_else(
        || {
            let rgb = pixel.rgb();
            [rgb[0], rgb[1], rgb[2], pixel.0[3]]
        },
        |s| s.output(pixel, crate::color::ColorOutput::default()),
    );
    Ok((
        [straight[0], straight[1], straight[2]].map(|v| v.clamp(0., 1.)),
        straight[3].clamp(0., 1.),
    ))
}

/// Compact fixed-precision token; every exported number passes through here,
/// which doubles as the finite-value gate for the whole file.
fn num(v: f64) -> Result<String, String> {
    if !v.is_finite() {
        return Err("PDF export encountered a non-finite number".into());
    }
    let mut token = format!("{v:.4}");
    if token.contains('.') {
        token = token.trim_end_matches('0').trim_end_matches('.').to_owned();
    }
    if token == "-0" {
        token = "0".into();
    }
    Ok(token)
}

/// Hand-written object table: objects 1-4 are catalog, pages, page and the
/// content stream; every resource object follows in first-use order.
struct Pdf {
    content: String,
    objects: Vec<Vec<u8>>,
    gstates: BTreeMap<(u64, String), String>,
    gstate_list: Vec<(String, usize)>,
    shadings: BTreeMap<String, String>,
    shading_list: Vec<(String, usize)>,
    images: BTreeMap<String, (String, u32, u32)>,
    image_list: Vec<(String, usize)>,
    fonts: BTreeMap<String, String>,
    font_list: Vec<(String, usize)>,
    icc_spaces: BTreeMap<Vec<u8>, usize>,
}

impl Pdf {
    fn new() -> Self {
        Self {
            content: String::new(),
            objects: Vec::new(),
            gstates: BTreeMap::new(),
            gstate_list: Vec::new(),
            shadings: BTreeMap::new(),
            shading_list: Vec::new(),
            images: BTreeMap::new(),
            image_list: Vec::new(),
            fonts: BTreeMap::new(),
            font_list: Vec::new(),
            icc_spaces: BTreeMap::new(),
        }
    }

    /// RGB samples are sRGB unless the caller passes the profile that actually
    /// describes them. DeviceRGB is not used for those samples.
    fn icc_color_space(&mut self, profile: &[u8]) -> Result<String, String> {
        if let Some(number) = self.icc_spaces.get(profile) {
            return Ok(format!("[/ICCBased {number} 0 R]"));
        }
        let body = crate::export::pdf_icc_based_object(profile)?;
        let number = self.add_object(body);
        self.icc_spaces.insert(profile.to_vec(), number);
        Ok(format!("[/ICCBased {number} 0 R]"))
    }

    fn srgb_color_space(&mut self) -> Result<String, String> {
        let profile = crate::export::srgb_icc_profile()?;
        self.icc_color_space(&profile)
    }

    fn add_object(&mut self, body: Vec<u8>) -> usize {
        let number = 5 + self.objects.len();
        self.objects.push(body);
        number
    }

    /// Empty when the state is the default (opaque normal), so ordinary
    /// opaque content never allocates an ExtGState object.
    fn gstate(&mut self, alpha: f64, blend: &str) -> Result<String, String> {
        if alpha == 1. && blend == "normal" {
            return Ok(String::new());
        }
        let key = (alpha.to_bits(), blend.to_owned());
        if let Some(name) = self.gstates.get(&key) {
            return Ok(name.clone());
        }
        let name = format!("/GS{}", self.gstate_list.len());
        // Kernel blend identifiers pass through verbatim in lower case; PDF
        // spells its standard modes capitalized, so strict viewers read an
        // unknown name as Normal instead of rejecting the file.
        let body = format!(
            "<< /Type /ExtGState /ca {} /CA {} /BM /{} >>",
            num(alpha)?,
            num(alpha)?,
            blend
        );
        let number = self.add_object(body.into_bytes());
        self.gstates.insert(key, name.clone());
        self.gstate_list.push((name.clone(), number));
        Ok(name)
    }

    /// Axial/radial shading object for one paint, deduplicated by parameters.
    /// The shading space is the paint's unit square; /Matrix carries it into
    /// node-local design space, which reproduces the CPU sampler's normalized
    /// gradient parameter exactly.
    fn shading(
        &mut self,
        settings: Option<ColorSettings>,
        paint: &Paint,
        node: &Node,
    ) -> Result<String, String> {
        let angle = paint.angle.to_radians();
        let key = format!(
            "{}|{angle:?}|{:?}|{}|{}|{}",
            paint.kind,
            paint.transform,
            node.width,
            node.height,
            paint
                .stops
                .iter()
                .map(|s| format!("{}:{:?}", s.offset, s.color))
                .collect::<String>()
        );
        if let Some(name) = self.shadings.get(&key) {
            return Ok(name.clone());
        }
        let stops = unique_stops(settings, paint)?;
        let scale = Transform([node.width, 0., 0., node.height, 0., 0.]);
        let (shading_type, coords, matrix) = if paint.kind == "linear" {
            match paint.transform {
                None => {
                    // The authored angle axis passes through the normalized
                    // center; projecting onto it is the sampler's t.
                    let (s, c) = angle.sin_cos();
                    let length = (c.abs() + s.abs()).max(1e-12);
                    let (ux, uy) = (c / length, s / length);
                    (
                        2,
                        format!(
                            "{} {} {} {}",
                            num(0.5 - 0.5 * ux)?,
                            num(0.5 - 0.5 * uy)?,
                            num(0.5 + 0.5 * ux)?,
                            num(0.5 + 0.5 * uy)?
                        ),
                        scale,
                    )
                }
                Some(transform) => (2, "0 0 1 0".into(), scale.concat(transform)),
            }
        } else {
            (
                3,
                "0.5 0.5 0 0.5 0.5 0.5".into(),
                paint
                    .transform
                    .map_or(scale, |transform| scale.concat(transform)),
            )
        };
        let component = |c: f32| num(f64::from(c));
        let first = &stops[0];
        let last = &stops[stops.len() - 1];
        // The function domain clamps to the stop span, matching the sampler's
        // partition behavior outside the authored offsets.
        let function = if stops.len() == 2 {
            format!(
                "<< /FunctionType 2 /Domain [{} {}] /C0 [{} {} {}] /C1 [{} {} {}] /N 1 >>",
                num(first.0)?,
                num(last.0)?,
                component(first.1[0])?,
                component(first.1[1])?,
                component(first.1[2])?,
                component(last.1[0])?,
                component(last.1[1])?,
                component(last.1[2])?
            )
        } else {
            let bounds = stops[1..stops.len() - 1]
                .iter()
                .map(|(offset, _)| num(*offset))
                .collect::<Result<Vec<_>, _>>()?;
            let mut functions = Vec::with_capacity(stops.len() - 1);
            for pair in stops.windows(2) {
                functions.push(format!(
                    "<< /FunctionType 2 /Domain [0 1] /C0 [{} {} {}] /C1 [{} {} {}] /N 1 >>",
                    component(pair[0].1[0])?,
                    component(pair[0].1[1])?,
                    component(pair[0].1[2])?,
                    component(pair[1].1[0])?,
                    component(pair[1].1[1])?,
                    component(pair[1].1[2])?
                ));
            }
            let encode = "0 1 ".repeat(stops.len() - 1);
            format!(
                "<< /FunctionType 3 /Domain [{} {}] /Functions [{}] /Bounds [{}] /Encode [{}] >>",
                num(first.0)?,
                num(last.0)?,
                functions.join(" "),
                bounds.join(" "),
                encode.trim_end()
            )
        };
        let matrix = matrix
            .0
            .iter()
            .map(|v| num(*v))
            .collect::<Result<Vec<_>, _>>()?
            .join(" ");
        let space = self.srgb_color_space()?;
        let body = format!(
            "<< /ShadingType {shading_type} /ColorSpace {space} /Coords [{coords}] /Function {function} /Extend [true true] /Matrix [{matrix}] >>"
        );
        let number = self.add_object(body.into_bytes());
        let name = format!("/Sh{}", self.shading_list.len());
        self.shadings.insert(key, name.clone());
        self.shading_list.push((name.clone(), number));
        Ok(name)
    }

    fn image(&mut self, uri: &str) -> Result<(String, u32, u32), String> {
        if let Some(hit) = self.images.get(uri) {
            return Ok(hit.clone());
        }
        let name = format!("/Im{}", self.image_list.len());
        let (number, width, height) = embed_image(self, uri)?;
        self.images
            .insert(uri.to_owned(), (name.clone(), width, height));
        self.image_list.push((name.clone(), number));
        Ok((name, width, height))
    }

    /// Embeds one font resource as a Type0 (Identity-H) CID font and returns
    /// its resource name. The whole font file is embedded, never subsetted
    /// (declared trade-off): document font resources already carry a 24 MB
    /// decoded budget in `Fonts::with_resources`, and whole-file embedding
    /// keeps cmap recovery and future re-use exact. TrueType outlines embed
    /// as /FontFile2 with a CIDFontType2 descendant; OpenType-CFF as
    /// /FontFile3 /Subtype/OpenType with CIDFontType0. /W lists the used
    /// glyphs' advances in 1000-unit glyph space, matching the shaped
    /// variation instance.
    fn font(
        &mut self,
        bytes: &[u8],
        id: &str,
        widths: &BTreeMap<u16, u32>,
    ) -> Result<String, String> {
        if let Some(name) = self.fonts.get(id) {
            return Ok(name.clone());
        }
        let face =
            ttf_parser::Face::parse(bytes, 0).map_err(|_| format!("Corrupt font resource {id}"))?;
        let upem = f64::from(face.units_per_em().max(1));
        // Font-unit metrics rescale into glyph space (1000 units per em).
        let glyph_units = |value: f64| (value * 1000. / upem).round() as i64;
        let base = postscript_name(&face, id);
        // Consecutive glyph runs share one `gid [w ...]` entry.
        let gids: Vec<u16> = widths.keys().copied().collect();
        let mut w = String::from("/W [");
        let mut index = 0;
        while index < gids.len() {
            let mut end = index;
            while end + 1 < gids.len() && gids[end + 1] == gids[end] + 1 {
                end += 1;
            }
            let _ = write!(w, " {} [", gids[index]);
            for gid in &gids[index..=end] {
                let _ = write!(w, " {}", glyph_units(f64::from(widths[gid])));
            }
            w.push_str(" ]");
            index = end + 1;
        }
        w.push(']');
        let compressed = miniz_oxide::deflate::compress_to_vec_zlib(bytes, 6);
        let cff = face.tables().cff.is_some();
        let file_dictionary = if cff {
            format!(
                "/Subtype/OpenType/Filter/FlateDecode/Length1 {}/Length {}",
                bytes.len(),
                compressed.len()
            )
        } else {
            format!(
                "/Filter/FlateDecode/Length1 {}/Length {}",
                bytes.len(),
                compressed.len()
            )
        };
        let mut file = format!("<< {file_dictionary} >>\nstream\n").into_bytes();
        file.extend_from_slice(&compressed);
        file.extend_from_slice(b"\nendstream");
        let file_number = self.add_object(file);
        let bbox = face.global_bounding_box();
        let italic = face
            .tables()
            .post
            .map_or(0., |post| f64::from(post.italic_angle));
        // Symbolic (4) plus italic (64) when the face says so.
        let flags = 4 | (u32::from(face.is_italic()) * 64);
        let cap = face
            .tables()
            .os2
            .and_then(|os2| os2.capital_height())
            .unwrap_or_else(|| face.ascender());
        let descriptor = format!(
            "<< /Type/FontDescriptor/FontName/{base}/Flags {flags}/FontBBox [{} {} {} {}]/ItalicAngle {}/Ascent {}/Descent {}/CapHeight {}/StemV 80/FontFile{} {file_number} 0 R >>",
            glyph_units(f64::from(bbox.x_min)),
            glyph_units(f64::from(bbox.y_min)),
            glyph_units(f64::from(bbox.x_max)),
            glyph_units(f64::from(bbox.y_max)),
            num(italic)?,
            glyph_units(f64::from(face.ascender())),
            glyph_units(f64::from(face.descender())),
            glyph_units(f64::from(cap)),
            if cff { 3 } else { 2 },
        );
        let descriptor_number = self.add_object(descriptor.into_bytes());
        let descendant = format!(
            "<< /Type/Font/Subtype/CIDFontType{}/BaseFont/{base}/CIDSystemInfo <</Registry (Adobe)/Ordering (Identity)/Supplement 0>>/FontDescriptor {descriptor_number} 0 R/DW 1000 {w}{} >>",
            if cff { 0 } else { 2 },
            if cff { "" } else { "/CIDToGIDMap/Identity" },
        );
        let descendant_number = self.add_object(descendant.into_bytes());
        let type0 = format!(
            "<< /Type/Font/Subtype/Type0/BaseFont/{base}/Encoding/Identity-H/DescendantFonts [{descendant_number} 0 R] >>"
        );
        let type0_number = self.add_object(type0.into_bytes());
        let name = format!("/F{}", self.font_list.len());
        self.fonts.insert(id.to_owned(), name.clone());
        self.font_list.push((name.clone(), type0_number));
        Ok(name)
    }

    fn finish(mut self, width: f64, height: f64) -> Result<Vec<u8>, String> {
        let srgb = self.srgb_color_space()?;
        let mut resources = format!("/ColorSpace << /DefaultRGB {srgb} >> ");
        for (tag, list) in [
            ("/ExtGState", &self.gstate_list),
            ("/Shading", &self.shading_list),
            ("/XObject", &self.image_list),
            ("/Font", &self.font_list),
        ] {
            if list.is_empty() {
                continue;
            }
            resources.push_str(&format!("{tag} <<"));
            for (name, number) in list {
                let _ = write!(resources, " {name} {number} 0 R");
            }
            resources.push_str(" >> ");
        }
        let content = format!("q 1 0 0 -1 0 {} cm\n{}Q\n", num(height)?, self.content);
        let stream = |dictionary: String, data: Vec<u8>| {
            let mut object =
                format!("<< {dictionary} /Length {} >>\nstream\n", data.len()).into_bytes();
            object.extend(data);
            object.extend_from_slice(b"\nendstream");
            object
        };
        let page = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Resources <<{resources}>> /Contents 4 0 R >>",
            num(width)?,
            num(height)?
        );
        let mut objects = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            page.into_bytes(),
            stream(String::new(), content.into_bytes()),
        ];
        objects.append(&mut self.objects);
        let mut output = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec();
        let mut offsets = vec![0];
        for (index, object) in objects.into_iter().enumerate() {
            offsets.push(output.len());
            output.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
            output.extend(object);
            output.extend_from_slice(b"\nendobj\n");
        }
        let xref = output.len();
        output.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len()).as_bytes(),
        );
        for offset in offsets.iter().skip(1) {
            output.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        output.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                offsets.len()
            )
            .as_bytes(),
        );
        Ok(output)
    }
}

/// PostScript name of a face sanitized into a PDF name token; falls back to
/// a stable name derived from the font resource id.
fn postscript_name(face: &ttf_parser::Face, id: &str) -> String {
    let raw = face
        .names()
        .into_iter()
        .find(|name| {
            name.name_id == ttf_parser::name::name_id::POST_SCRIPT_NAME && name.is_unicode()
        })
        .and_then(|name| name.to_string())
        .unwrap_or_else(|| format!("Font{id}"));
    let sanitized: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.'))
        .collect();
    if sanitized.is_empty() {
        format!(
            "Font{}",
            id.chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
        )
    } else {
        sanitized
    }
}

/// Sorted stop list with the final color retained at duplicate offsets; the
/// CPU sampler's partition selects that color on the open interval after a
/// step, so the two differ only at the measure-zero offset itself.
fn unique_stops(
    settings: Option<ColorSettings>,
    paint: &Paint,
) -> Result<Vec<(f64, [f32; 3])>, String> {
    let mut stops: Vec<(f64, [f32; 3])> = paint
        .stops
        .iter()
        .map(|s| Ok::<_, String>((s.offset, color(settings, &s.color, 1.)?.0)))
        .collect::<Result<_, _>>()?;
    stops.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut unique: Vec<(f64, [f32; 3])> = Vec::with_capacity(stops.len());
    for (offset, rgb) in stops {
        if unique.last().is_some_and(|(last, _)| *last == offset) {
            unique.last_mut().expect("checked").1 = rgb;
        } else {
            unique.push((offset, rgb));
        }
    }
    Ok(unique)
}

fn embed_image(pdf: &mut Pdf, uri: &str) -> Result<(usize, u32, u32), String> {
    if uri.len() > 12 * 1024 * 1024 {
        return Err("Image exceeds 12 MB encoded limit".into());
    }
    if !IMAGE_URI_PREFIXES
        .iter()
        .any(|prefix| uri.starts_with(prefix))
    {
        return Err("Unsupported image URI".into());
    }
    use base64::Engine as _;
    let (_, encoded) = uri.split_once(',').ok_or("Invalid image URI")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid image data")?;
    let stream = |dictionary: String, data: Vec<u8>| {
        let mut object =
            format!("<< {dictionary} /Length {} >>\nstream\n", data.len()).into_bytes();
        object.extend(data);
        object.extend_from_slice(b"\nendstream");
        object
    };
    if bytes.starts_with(&[0xFF, 0xD8]) {
        // JPEG bytes pass through untouched; DCTDecode is the PDF-native
        // representation and re-encoding would be lossy.
        let (width, height, components) = jpeg_geometry(&bytes)?;
        let colorspace = match components {
            1 => "/DeviceGray".to_string(),
            3 => {
                let profile = jpeg_icc(&bytes)?.unwrap_or(crate::export::srgb_icc_profile()?);
                pdf.icc_color_space(&profile)?
            }
            4 => "/DeviceCMYK".to_string(),
            _ => return Err("Unsupported JPEG component count".into()),
        };
        let body = stream(
            format!(
                "/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace {colorspace} /BitsPerComponent 8 /Filter /DCTDecode"
            ),
            bytes,
        );
        return Ok((pdf.add_object(body), width, height));
    }
    let rgba = decode_image_srgb(&bytes)?;
    let (width, height) = rgba.dimensions();
    if width == 0 || height == 0 {
        return Err("Image has no pixels".into());
    }
    let mut rgb = Vec::with_capacity(rgba.len() * 3);
    let mut alpha = Vec::with_capacity(rgba.len());
    let mut opaque = true;
    for pixel in rgba.pixels() {
        rgb.extend_from_slice(&pixel.0[..3]);
        alpha.push(pixel.0[3]);
        opaque &= pixel.0[3] == 255;
    }
    let smask = (!opaque).then(|| {
        pdf.add_object(stream(
            format!("/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode"),
            miniz_oxide::deflate::compress_to_vec_zlib(&alpha, 6),
        ))
    });
    let space = pdf.srgb_color_space()?;
    let mut dictionary = format!(
        "/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace {space} /BitsPerComponent 8 /Filter /FlateDecode"
    );
    if let Some(mask) = smask {
        dictionary.push_str(&format!(" /SMask {mask} 0 R"));
    }
    let body = stream(
        dictionary,
        miniz_oxide::deflate::compress_to_vec_zlib(&rgb, 6),
    );
    Ok((pdf.add_object(body), width, height))
}

/// Walk JPEG marker segments to the first SOF: (width, height, components).
/// DCTDecode passthrough must state the true component count, which no other
/// header field carries.
fn jpeg_icc(bytes: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let mut at = 2;
    let mut parts: Vec<Option<Vec<u8>>> = Vec::new();
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xFF {
            return Err("Malformed JPEG marker stream".into());
        }
        let marker = bytes[at + 1];
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        if (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            at += 2;
            continue;
        }
        if marker == 0xFF {
            at += 1;
            continue;
        }
        let length = u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
        if length < 2 || at + 2 + length > bytes.len() {
            return Err("Truncated JPEG marker".into());
        }
        if marker == 0xE2 {
            let payload = &bytes[at + 4..at + 2 + length];
            if let Some(rest) = payload.strip_prefix(b"ICC_PROFILE\0") {
                if rest.len() < 2 {
                    return Err("Truncated JPEG ICC chunk".into());
                }
                let seq = rest[0] as usize;
                let count = rest[1] as usize;
                if count == 0 || count > 16 || seq == 0 || seq > count {
                    return Err("Invalid JPEG ICC chunk index".into());
                }
                if parts.is_empty() {
                    parts.resize(count, None);
                }
                if parts.len() != count || parts[seq - 1].is_some() {
                    return Err("Inconsistent JPEG ICC profile".into());
                }
                parts[seq - 1] = Some(rest[2..].to_vec());
            }
        }
        at += 2 + length;
    }
    if parts.is_empty() {
        return Ok(None);
    }
    if parts.iter().any(Option::is_none) {
        return Err("Incomplete JPEG ICC profile".into());
    }
    let mut profile = Vec::new();
    for part in parts.into_iter().flatten() {
        profile.extend(part);
    }
    if profile.len() < 128 || &profile[36..40] != b"acsp" || &profile[16..20] != b"RGB " {
        return Err("JPEG ICC profile is not a usable RGB profile".into());
    }
    Ok(Some(profile))
}

/// Untagged samples stay byte-for-byte and are declared sRGB. A cICP space
/// other than sRGB, or an ICC profile, is converted before that declaration.
fn decode_image_srgb(bytes: &[u8]) -> Result<image::RgbaImage, String> {
    let space = crate::image_color::png_space(bytes)?;
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let profile = if space.is_none() {
        crate::image_color::icc(&mut decoder)?
    } else {
        None
    };
    let orientation = crate::image_color::orientation(&mut decoder)?;
    let mut decoded = image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    decoded.apply_orientation(orientation);
    let convert = match space {
        Some(crate::color::ColorSpace::Srgb) | None if profile.is_none() => false,
        None => true,
        Some(_) => true,
    };
    if !convert {
        return Ok(decoded.into_rgba8());
    }
    let mut image = decoded.into_rgba32f();
    crate::image_color::to_sdr(&mut image, space, profile.as_deref())?;
    let mut out = image::RgbaImage::new(image.width(), image.height());
    for (dst, src) in out.pixels_mut().zip(image.pixels()) {
        for channel in 0..4 {
            let value = f64::from(if channel == 3 {
                src[channel]
            } else {
                src[channel].clamp(0., 1.)
            });
            dst[channel] = (value * 255.).round_ties_even() as u8;
        }
    }
    Ok(out)
}

fn jpeg_geometry(bytes: &[u8]) -> Result<(u32, u32, u8), String> {
    let mut at = 2;
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xFF {
            return Err("Malformed JPEG marker stream".into());
        }
        let marker = bytes[at + 1];
        if marker == 0xD9 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            at += 2;
            continue;
        }
        if marker == 0xFF {
            // Fill byte before the real marker.
            at += 1;
            continue;
        }
        let length = u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
        let frame = (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if frame && at + 10 <= bytes.len() {
            let height = u16::from_be_bytes([bytes[at + 5], bytes[at + 6]]);
            let width = u16::from_be_bytes([bytes[at + 7], bytes[at + 8]]);
            let components = bytes[at + 9];
            return Ok((u32::from(width), u32::from(height), components));
        }
        at += 2 + length.max(2);
    }
    Err("JPEG SOF marker not found".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn document(nodes: serde_json::Value, children: &[&str]) -> Document {
        serde_json::from_value(json!({
            "schemaVersion": 1,
            "id": "d",
            "name": "pdf export",
            "pages": [{"id": "p", "name": "page", "children": children, "background": "#ffffff"}],
            "nodes": nodes
        }))
        .unwrap()
    }

    /// The importer runs in other processes; validate the file structurally:
    /// every xref entry must point at its own "N 0 obj" header.
    fn assert_xref_offsets(pdf: &[u8]) {
        let marker = b"startxref\n";
        let at = pdf
            .windows(marker.len())
            .rposition(|window| window == marker)
            .expect("startxref")
            + marker.len();
        let newline = pdf[at..]
            .iter()
            .position(|b| *b == b'\n')
            .expect("startxref newline");
        let xref: usize = std::str::from_utf8(&pdf[at..at + newline])
            .expect("ascii")
            .parse()
            .expect("xref offset");
        assert_eq!(&pdf[xref..xref + 5], b"xref\n");
        let mut lines = pdf[xref..].split(|b| *b == b'\n');
        lines.next().expect("xref keyword");
        let header = std::str::from_utf8(lines.next().expect("subsection")).expect("ascii");
        let count: usize = header
            .split_whitespace()
            .nth(1)
            .expect("entry count")
            .parse()
            .expect("count");
        assert_eq!(header.split_whitespace().next().unwrap(), "0");
        assert_eq!(lines.next().expect("free entry"), b"0000000000 65535 f ");
        for (index, line) in lines.take(count - 1).enumerate() {
            let offset: usize = std::str::from_utf8(&line[..10])
                .expect("ascii")
                .parse()
                .expect("offset");
            let object = format!("{} 0 obj", index + 1);
            assert!(
                pdf[offset..].starts_with(object.as_bytes()),
                "xref entry {object} points at {:?}",
                &pdf[offset..(offset + 16).min(pdf.len())]
            );
        }
    }

    /// The content stream is the first stream object in the file and is pure
    /// ASCII, so lossy decoding cannot shift the extracted region.
    fn content_stream(pdf: &[u8]) -> String {
        let text = String::from_utf8_lossy(pdf);
        let start = text.find("stream\n").expect("stream") + "stream\n".len();
        let end = start + text[start..].find("\nendstream").expect("endstream");
        text[start..end].to_string()
    }

    #[test]
    fn empty_page_writes_a_parseable_pdf_skeleton() {
        let doc = document(json!({}), &[]);
        let pdf = encode_pdf_vector(&doc, "p", 640., 480., None).unwrap();
        assert!(pdf.starts_with(b"%PDF-1.7"));
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Type /Catalog"));
        assert!(text.contains("/Type /Page"));
        assert!(text.contains("/MediaBox [0 0 640 480]"));
        assert!(text.contains("xref") && text.contains("trailer"));
        assert!(pdf.ends_with(b"%%EOF\n"));
        assert_xref_offsets(&pdf);
        let content = content_stream(&pdf);
        assert_eq!(content, "q 1 0 0 -1 0 480 cm\nQ\n");
        assert_eq!(content.matches('q').count(), content.matches('Q').count());
        assert!(encode_pdf_vector(&doc, "missing", 10., 10., None).is_err());
        assert!(encode_pdf_vector(&doc, "p", f64::NAN, 10., None).is_err());
        assert!(encode_pdf_vector(&doc, "p", 0., 10., None).is_err());
        assert!(encode_pdf_vector(&doc, "p", 20000., 10., None).is_err());
    }

    #[test]
    fn rounded_transparent_and_gradient_nodes_emit_matching_operators() {
        let doc = document(
            json!({
                "solid": {"id":"solid","kind":"rectangle","width":120.,"height":80.,
                          "radii":[16.,16.,16.,16.],"transform":[1.,0.,0.,1.,8.,12.],
                          "fills":[{"kind":"solid","color":"#3366cc","opacity":0.5}]},
                "ramp": {"id":"ramp","kind":"rectangle","width":200.,"height":140.,
                         "fills":[{"kind":"linear","color":"#000000","angle":90.,
                                   "stops":[{"offset":0.,"color":"#ff0000"},{"offset":1.,"color":"#0000ff"}]}],
                         "strokes":[{"paint":{"kind":"solid","color":"#101010"},"width":2.,"cap":"butt","join":"miter"}]}
            }),
            &["solid", "ramp"],
        );
        let pdf = encode_pdf_vector(&doc, "p", 400., 300., None).unwrap();
        assert_xref_offsets(&pdf);
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Shading << /Sh0"));
        assert!(text.contains("/ShadingType 2"));
        assert!(text.contains("/FunctionType 2"));
        let content = content_stream(&pdf);
        assert!(content.contains("0.2 0.4 0.8 rg"), "{content}");
        assert!(content.contains("/GS0 gs"));
        assert!(text.contains("/ca 0.5"));
        assert!(
            content.contains(" c "),
            "rounded corners keep curve operators"
        );
        // Plain shapes fill even-odd, so the gradient clips with W*.
        assert!(content.contains("W* n /Sh0 sh"));
        assert!(content.contains("/Sh0 sh"));
        assert!(content.contains("0.0627 0.0627 0.0627 RG"), "{content}");
        assert!(content.contains("2 w"));
        assert!(content.contains("0 J"));
        assert!(content.contains("0 j"));
        assert!(content.contains("S\n"));
        assert_eq!(content.matches('q').count(), content.matches('Q').count());
    }

    #[test]
    fn nested_transforms_nest_their_graphics_state() {
        let doc = document(
            json!({
                "g": {"id":"g","kind":"group","width":100.,"height":100.,
                      "transform":[1.,0.,0.,1.,10.,20.],"children":["c"]},
                "c": {"id":"c","kind":"rectangle","width":20.,"height":20.,
                      "transform":[2.,0.,0.,2.,5.,5.],
                      "fills":[{"kind":"solid","color":"#ff0000"}]}
            }),
            &["g"],
        );
        let pdf = encode_pdf_vector(&doc, "p", 200., 200., None).unwrap();
        let content = content_stream(&pdf);
        assert!(content.contains("1 0 0 1 10 20 cm"));
        assert!(content.contains("2 0 0 2 5 5 cm"));
        let first = content.find("q\n").expect("open");
        let second = content[first + 2..]
            .find("q\n")
            .map(|at| at + first + 2)
            .expect("inner open");
        let close = content.find("Q\n").expect("close");
        let inner_close = content[close + 2..]
            .find("Q\n")
            .map(|at| at + close + 2)
            .expect("inner close");
        assert!(first < second && second < close && close < inner_close);
        assert_eq!(content.matches('q').count(), content.matches('Q').count());
    }

    #[test]
    fn radial_shades_while_angular_and_diamond_fall_back_to_solid() {
        let stops = json!([{"offset":0.,"color":"#ff0000"},{"offset":1.,"color":"#0000ff"}]);
        let doc = document(
            json!({
                "r": {"id":"r","kind":"ellipse","width":90.,"height":70.,
                      "fills":[{"kind":"radial","color":"#000000","stops":stops}]},
                "a": {"id":"a","kind":"rectangle","width":40.,"height":30.,
                      "transform":[1.,0.,0.,1.,0.,80.],
                      "fills":[{"kind":"angular","color":"#000000","stops":stops}]},
                "d": {"id":"d","kind":"rectangle","width":40.,"height":30.,
                      "transform":[1.,0.,0.,1.,0.,120.],
                      "fills":[{"kind":"diamond","color":"#000000","stops":stops}]}
            }),
            &["r", "a", "d"],
        );
        let pdf = encode_pdf_vector(&doc, "p", 200., 200., None).unwrap();
        assert!(String::from_utf8_lossy(&pdf).contains("/ShadingType 3"));
        let content = content_stream(&pdf);
        assert_eq!(content.matches(" sh\n").count(), 1);
        assert_eq!(content.matches("1 0 0 rg").count(), 2);
    }

    #[test]
    fn engine_export_honors_transparency_and_page_background() {
        let doc = document(
            json!({
                "r": {"id":"r","kind":"rectangle","width":50.,"height":40.,
                      "fills":[{"kind":"solid","color":"#3366cc"}]}
            }),
            &["r"],
        );
        let mut engine = Engine::new();
        engine
            .load_document(&serde_json::to_string(&doc).unwrap())
            .unwrap();
        let options: RenderOptions = serde_json::from_value(json!({
            "pageId": "p", "width": 320, "height": 200,
            "view": {"x": 0., "y": 0., "zoom": 1.}, "transparent": false
        }))
        .unwrap();
        let pdf = engine.export_pdf_vector(&options).unwrap();
        assert!(pdf.starts_with(b"%PDF-1.7"));
        assert_xref_offsets(&pdf);
        let content = content_stream(&pdf);
        assert!(
            content.starts_with("q 1 0 0 -1 0 200 cm\n1 1 1 rg 0 0 320 200 re f\n"),
            "{content}"
        );
        let transparent: RenderOptions = serde_json::from_value(json!({
            "pageId": "p", "width": 320, "height": 200,
            "view": {"x": 0., "y": 0., "zoom": 1.}, "transparent": true
        }))
        .unwrap();
        let pdf = engine.export_pdf_vector(&transparent).unwrap();
        assert!(!content_stream(&pdf).contains(" re f"));
        let missing: RenderOptions = serde_json::from_value(json!({
            "pageId": "z", "width": 320, "height": 200,
            "view": {"x": 0., "y": 0., "zoom": 1.}
        }))
        .unwrap();
        assert!(engine.export_pdf_vector(&missing).is_err());
    }

    #[test]
    fn image_fills_embed_png_pixels_and_pass_jpeg_through() {
        use base64::Engine as _;
        use image::ImageEncoder as _;
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(
                &[
                    255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 255, 255, 255, 255,
                ],
                2,
                2,
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
            .encode(
                &[255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255],
                2,
                2,
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        let uri = |bytes: &[u8], mime: &str| {
            format!(
                "data:image/{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        };
        let doc = document(
            json!({
                "png": {"id":"png","kind":"rectangle","width":60.,"height":40.,
                        "fills":[{"kind":"image","color":"#000000","image":uri(&png, "png")}]},
                "jpeg": {"id":"jpeg","kind":"rectangle","width":60.,"height":40.,
                         "transform":[1.,0.,0.,1.,0.,50.],
                         "fills":[{"kind":"image","color":"#000000","image":uri(&jpeg, "jpeg")}]}
            }),
            &["png", "jpeg"],
        );
        let pdf = encode_pdf_vector(&doc, "p", 100., 100., None).unwrap();
        assert_xref_offsets(&pdf);
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Subtype /Image"));
        assert!(text.contains("/SMask"));
        assert!(text.contains("/Filter /FlateDecode"));
        assert!(text.contains("/Filter /DCTDecode"));
        assert!(text.contains("/ICCBased"));
        assert!(text.contains("/DefaultRGB"));
        assert!(!text.contains("/ColorSpace /DeviceRGB"));
        let content = content_stream(&pdf);
        assert!(content.contains("/Im0 Do"));
        assert!(content.contains("/Im1 Do"));
        assert_eq!(content.matches('q').count(), content.matches('Q').count());
    }

    fn kernel_font_bytes() -> Vec<u8> {
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../frontend/design-client/public/fonts/NotoSansSC.ttf"
        ))
        .unwrap()
    }

    fn text_node(text: &str, extra: serde_json::Value) -> serde_json::Value {
        let mut node = json!({
            "id":"t", "kind":"text", "text":text, "fontSize":20,
            "width":500, "height":100,
            "fills":[{"kind":"solid","color":"#3366cc"}]
        });
        if let (Some(value), Some(target)) = (extra.as_object(), node.as_object_mut()) {
            for (key, value) in value {
                target.insert(key.clone(), value.clone());
            }
        }
        node
    }

    fn export_text(node: serde_json::Value) -> Vec<u8> {
        let mut engine = Engine::new();
        engine.load_font(&kernel_font_bytes()).unwrap();
        // Text runs require schema 4, so this builder does not share the
        // schema-1 `document` helper.
        let doc = json!({
            "schemaVersion": 4,
            "id": "d",
            "name": "pdf text",
            "pages": [{"id": "p", "name": "page", "children": ["t"], "background": "#ffffff"}],
            "nodes": {"t": node}
        });
        engine
            .load_document(&serde_json::to_string(&doc).unwrap())
            .unwrap();
        let options: RenderOptions = serde_json::from_value(json!({
            "pageId": "p", "width": 500, "height": 120, "transparent": true,
            "view": {"x": 0., "y": 0., "zoom": 1.}
        }))
        .unwrap();
        engine.export_pdf_vector(&options).unwrap()
    }

    /// Parses the descendant CIDFont's /W array: `gid [w ...]` runs become a
    /// glyph-id -> width map in glyph-space units.
    fn width_table(pdf: &[u8]) -> std::collections::BTreeMap<u16, f64> {
        let text = String::from_utf8_lossy(pdf);
        let marker = "/DW 1000 /W [";
        let start = text.find(marker).expect("W array") + marker.len();
        // The array closes at the last bracket before the dictionary ends.
        let stop = start + text[start..].find(" >>").expect("dictionary end");
        let body = &text[start..stop];
        let end = body.rfind(']').expect("W terminator");
        let mut tokens = body[..end].split_whitespace();
        let mut widths = std::collections::BTreeMap::new();
        while let (Some(gid), bracket) = (tokens.next(), tokens.next()) {
            assert_eq!(bracket, Some("["), "width run opens a list");
            let gid: u16 = gid.parse().expect("glyph id");
            let list: Vec<&str> = tokens.by_ref().take_while(|t| *t != "]").collect();
            for (offset, value) in list.iter().enumerate() {
                widths.insert(
                    gid + offset as u16,
                    value.parse::<f64>().expect("width number"),
                );
            }
        }
        widths
    }

    #[test]
    fn chinese_text_exports_cid_font_text_operators() {
        let pdf = export_text(text_node("测试AV设计", json!({})));
        assert_xref_offsets(&pdf);
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Subtype/Type0"), "{text:.400}");
        assert!(text.contains("/Encoding/Identity-H"));
        assert!(text.contains("/FontFile2"), "TrueType glyph outlines embed");
        assert!(text.contains("/CIDFontType2"));
        assert!(text.contains("/CIDToGIDMap/Identity"));
        assert!(text.contains("/FontName/NotoSansSC"));
        assert!(text.contains("/Font << /F0"), "page carries font resources");
        let content = content_stream(&pdf);
        assert!(content.contains("BT\n"), "{content:.300}");
        assert!(content.contains("ET\n"));
        assert!(content.contains("/F0 20 Tf"));
        assert!(content.contains(" Tm <"), "per-glyph text matrices");
        assert!(content.contains("> Tj"));
        assert_eq!(content.matches("BT\n").count(), 1, "one block per fill");
        // The /W width of the first CJK glyph matches the shaped advance.
        let mut with_font = Fonts::new();
        with_font.load(&kernel_font_bytes()).unwrap();
        let node: Node = serde_json::from_value(text_node("测试AV设计", json!({}))).unwrap();
        let layout = with_font.node_layout(&node, Some(500.)).unwrap();
        let glyph = &layout.glyphs[0];
        let width = *width_table(&pdf).get(&glyph.id).expect("width entry");
        let resolved = width / 1000. * glyph.size;
        assert!(
            (resolved - glyph.advance).abs() < 0.02,
            "width {resolved} matches shaped advance {}",
            glyph.advance
        );
        let id = format!("<{:04x}> Tj", glyph.id);
        assert!(content.contains(&id), "glyph id {id} appears in content");
    }

    #[test]
    fn text_fallbacks_keep_the_outline_path() {
        // Underline runs expand into outline groups before export.
        let underlined = export_text(text_node(
            "测试",
            json!({"textRuns":[{"start":0,"end":2,"underline":true}]}),
        ));
        assert!(!content_stream(&underlined).contains("BT\n"));
        // Rotated Latin in vertical writing has path transforms.
        let rotated = export_text(text_node(
            "测试AV设计",
            json!({"textStyle":{"writingMode":"vertical"}}),
        ));
        assert!(
            !content_stream(&rotated).contains("BT\n"),
            "rotated runs export as outlines"
        );
        // Upright-only vertical text still uses operators.
        let upright = export_text(text_node(
            "测试设计",
            json!({"textStyle":{"writingMode":"vertical"}}),
        ));
        assert!(content_stream(&upright).contains("BT\n"));
        // Non-solid fills and strokes on text keep the outline geometry.
        let gradient = export_text(text_node(
            "测试",
            json!({"fills":[{"kind":"linear","color":"#000000","angle":90.,
                     "stops":[{"offset":0.,"color":"#ff0000"},
                              {"offset":1.,"color":"#0000ff"}]}]}),
        ));
        assert!(!content_stream(&gradient).contains("BT\n"));
        let stroked = export_text(text_node(
            "测试",
            json!({"strokes":[{"paint":{"kind":"solid","color":"#101010"},
                       "width":2.,"cap":"butt","join":"miter"}]}),
        ));
        assert!(!content_stream(&stroked).contains("BT\n"));
        assert!(
            String::from_utf8_lossy(&stroked).contains("/Shading")
                || content_stream(&stroked).contains(" c ")
                || content_stream(&stroked).contains(" l ")
        );
    }

    #[test]
    fn translucent_text_sets_graphics_state_around_operators() {
        let pdf = export_text(text_node(
            "测试",
            json!({"fills":[{"kind":"solid","color":"#3366cc","opacity":0.5}]}),
        ));
        assert_xref_offsets(&pdf);
        let content = content_stream(&pdf);
        assert!(
            content.contains("/GS0 gs\n0.2 0.4 0.8 rg\nBT\n"),
            "state precedes the text object: {content:.300}"
        );
        assert!(String::from_utf8_lossy(&pdf).contains("/ca 0.5"));
        assert_eq!(content.matches('q').count(), content.matches('Q').count());
    }
}
