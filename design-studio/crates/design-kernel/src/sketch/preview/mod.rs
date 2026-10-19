//! Read-only native Sketch projection into the shared analytic display list.
//! This deliberately narrow admission boundary rejects unsupported rendering
//! semantics; it does not replace the native archive with a Figma document.
//! Accepted: a plain page, translation-only groups, sharp rectangles without
//! authored corner points, and closed native shape paths, with inline solid
//! sRGB fills, plus axis-aligned same-RGB alpha-only linear gradients. Other
//! gradient colors, duplicate stops and diagonal axes remain unsupported.
//! Text, symbols, artboards, images, rounded rectangles, borders,
//! effects, clipping and unrecognized fields fail with `Unsupported`.
//! This is a CPU display-list outlet, not an installed desktop preview.
//! Callers must recheck `PreviewFrame::assert_current` before publishing a frame.
use crate::{
    area_program::{AreaProgram, MAX_FLOATS},
    color::ColorSettings,
    gpu::{AreaPath, GpuNode, GpuPaint, GpuPath, GpuScene},
    math::{Point, Rect, Transform},
    path::{Command, Path},
    renderer::View,
    scene::{Paint, Stop},
};
use crate::sketch::{
    CurveContour, Error, Layer, LayerKind, Owner, PathSink, Result, Session,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
mod display;
pub use display::{DisplaySnapshot, display_snapshot};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewRequest {
    pub owner: Owner,
    pub expected_revision: u64,
    pub page_id: String,
    pub width: u32,
    pub height: u32,
}
#[derive(Serialize)]
pub struct PreviewFrame {
    pub owner: Owner,
    pub revision: u64,
    pub page_id: String,
    pub scene: GpuScene,
}
impl PreviewFrame {
    pub fn assert_current(&self, session: &Session) -> Result<()> {
        session.assert_current(&self.owner, self.revision)
    }
}
fn unsupported(name: &str) -> Error {
    Error::Unsupported(format!("Sketch preview: {name}"))
}
fn keys(map: &Map<String, Value>, allowed: &[&str]) -> Result<()> {
    for key in map.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(unsupported(key));
        }
    }
    Ok(())
}
fn object(value: &Value) -> Result<&Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| Error::Invalid("preview object".into()))
}
fn number(map: &Map<String, Value>, key: &str, default: f64) -> Result<f64> {
    match map.get(key) {
        None => Ok(default),
        Some(v) => v
            .as_f64()
            .filter(|x| x.is_finite() && x.abs() <= 1e7)
            .ok_or_else(|| Error::Invalid(format!("preview number: {key}"))),
    }
}
fn boolean(map: &Map<String, Value>, key: &str, default: bool) -> Result<bool> {
    match map.get(key) {
        None => Ok(default),
        Some(v) => v
            .as_bool()
            .ok_or_else(|| Error::Invalid(format!("preview boolean: {key}"))),
    }
}
fn context(map: &Map<String, Value>) -> Result<f64> {
    let Some(value) = map.get("contextSettings") else {
        return Ok(1.);
    };
    let ctx = object(value)?;
    keys(ctx, &["_class", "opacity", "blendMode"])?;
    if number(ctx, "blendMode", 0.)? != 0. {
        return Err(unsupported("blend mode"));
    }
    let opacity = number(ctx, "opacity", 1.)?;
    if !(0. ..=1.).contains(&opacity) {
        return Err(Error::Invalid("opacity".into()));
    }
    Ok(opacity)
}
fn native_color(value: &Value, scene: &mut GpuScene) -> Result<([f64; 4], String)> {
    let color = object(value)?;
    keys(color, &["_class", "red", "green", "blue", "alpha"])?;
    let mut c = [0.; 4];
    for (i, key) in ["red", "green", "blue", "alpha"].iter().enumerate() {
        c[i] = number(color, key, if i == 3 { 1. } else { 0. })?;
        if !(0. ..=1.).contains(&c[i]) {
            return Err(unsupported("extended color"));
        }
    }
    let text = format!("color(srgb {} {} {} / {})", c[0], c[1], c[2], c[3]);
    let linear = ColorSettings::default()
        .parse_straight(&text)
        .map_err(Error::Invalid)?;
    scene.colors.insert(text.clone(), linear);
    Ok((c, text))
}
// Native schema evidence: sketchformat_style.dis.txt FillType=1 (gradient),
// GradientType=0 (linear), and normalized from/to plus position/color stops.
fn gradient_point(value: Option<&Value>) -> Result<[f64; 2]> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Invalid("gradient point string".into()))?;
    let inner = text
        .trim()
        .strip_prefix('{')
        .and_then(|v| v.strip_suffix('}'))
        .ok_or_else(|| Error::Invalid("gradient point".into()))?;
    let mut parts = inner.split(',');
    let mut point = [0.; 2];
    for coordinate in &mut point {
        *coordinate = parts
            .next()
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite() && (0. ..=1.).contains(v))
            .ok_or_else(|| Error::Invalid("normalized gradient point".into()))?;
    }
    if parts.next().is_some() {
        return Err(Error::Invalid("gradient point arity".into()));
    }
    Ok(point)
}
fn alpha_gradient(
    fill: &Map<String, Value>,
    scene: &mut GpuScene,
) -> Result<(String, Option<Transform>, Vec<Stop>)> {
    let gradient = object(
        fill.get("gradient")
            .ok_or_else(|| unsupported("missing gradient definition"))?,
    )?;
    keys(
        gradient,
        &[
            "_class",
            "gradientType",
            "from",
            "to",
            "stops",
            "elipseLength",
        ],
    )?;
    if number(gradient, "gradientType", 0.)? != 0. || number(gradient, "elipseLength", 0.)? != 0. {
        return Err(unsupported("non-linear gradient"));
    }
    let a = gradient_point(gradient.get("from"))?;
    let b = gradient_point(gradient.get("to"))?;
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    // Axis-aligned only: avoids assuming whether native diagonal projection
    // uses document-pixel or normalized-space distances on non-square layers.
    if (dx == 0.) == (dy == 0.) {
        return Err(unsupported("diagonal or degenerate gradient"));
    }
    let transform = Transform([dx, dy, -dy, dx, a[0], a[1]]);
    transform.inverse().map_err(Error::Invalid)?;
    let values = gradient
        .get("stops")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::Missing("gradient stops".into()))?;
    if !(2..=16).contains(&values.len()) {
        return Err(Error::Limit("gradient stops"));
    }
    let mut stops = Vec::new();
    let mut rgb = None;
    for value in values {
        let stop = object(value)?;
        keys(stop, &["_class", "position", "color"])?;
        let offset = stop
            .get("position")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && (0. ..=1.).contains(v))
            .ok_or_else(|| Error::Invalid("gradient stop position".into()))?;
        let (c, text) = native_color(
            stop.get("color")
                .ok_or_else(|| Error::Missing("stop color".into()))?,
            scene,
        )?;
        let next = [c[0], c[1], c[2]];
        if rgb.is_some_and(|previous| previous != next) {
            return Err(unsupported("gradient RGB interpolation"));
        }
        rgb = Some(next);
        stops.push(Stop {
            offset,
            color: text,
        });
    }
    stops.sort_by(|a, b| a.offset.total_cmp(&b.offset));
    if stops
        .windows(2)
        .any(|pair| pair[0].offset == pair[1].offset)
    {
        return Err(unsupported("duplicate gradient stops"));
    }
    // Same RGB makes premultiplied and straight alpha interpolation equivalent;
    // use the shared color conversion/sampler instead of choosing a new space.
    Ok((stops[0].color.clone(), Some(transform), stops))
}
fn style(layer: &Layer, scene: &mut GpuScene) -> Result<(Vec<GpuPaint>, f64)> {
    let Some(value) = layer.fields().get("style") else {
        return Ok((vec![], 1.));
    };
    let style = object(value)?;
    // Unknown effects, borders, shared styles and paint types are never dropped.
    keys(
        style,
        &[
            "_class",
            "do_objectID",
            "fills",
            "contextSettings",
            "windingRule",
        ],
    )?;
    let opacity = context(style)?;
    let Some(fills) = style.get("fills") else {
        return Ok((vec![], opacity));
    };
    let fills = fills
        .as_array()
        .ok_or_else(|| Error::Invalid("fills".into()))?;
    if fills.len() > 32 {
        return Err(Error::Limit("preview fills"));
    }
    let mut out = vec![];
    for (index, value) in fills.iter().enumerate() {
        let fill = object(value)?;
        keys(
            fill,
            &[
                "_class",
                "isEnabled",
                "fillType",
                "color",
                "gradient",
                "contextSettings",
            ],
        )?;
        if !boolean(fill, "isEnabled", true)? {
            continue;
        }
        let (text, transform, stops) = match number(fill, "fillType", 0.)? {
            0. => {
                if fill.contains_key("gradient") {
                    return Err(unsupported("gradient on solid fill"));
                }
                let (_, text) = native_color(
                    fill.get("color")
                        .ok_or_else(|| Error::Missing("fill color".into()))?,
                    scene,
                )?;
                (text, None, vec![])
            }
            1. => alpha_gradient(fill, scene)?,
            _ => return Err(unsupported("fill type")),
        };
        let linear = transform.is_some();
        out.push(GpuPaint {
            paint: Paint {
                transform,
                id: format!("{}:{index}", layer.id()),
                kind: if linear { "linear" } else { "solid" }.into(),
                color: text.clone(),
                opacity: context(fill)?,
                visible: true,
                angle: 0.,
                stops,
                image: None,
                fit: "cover".into(),
                blend: "normal".into(),
                adjust: None,
                tile: None,
            },
            constant_color: (!linear).then_some(text),
            figma_gradient: false,
            gradient_plane: None,
            fixed_gradient: None,
        });
    }
    Ok((out, opacity))
}
struct Sink(Path);
impl PathSink for Sink {
    type Error = Error;
    fn move_to(&mut self, p: [f64; 2]) -> Result<()> {
        self.0.commands.push(Command::Move(Point::new(p[0], p[1])));
        Ok(())
    }
    fn line_to(&mut self, p: [f64; 2]) -> Result<()> {
        self.0.commands.push(Command::Line(Point::new(p[0], p[1])));
        Ok(())
    }
    fn cubic_to(&mut self, a: [f64; 2], b: [f64; 2], p: [f64; 2]) -> Result<()> {
        self.0.commands.push(Command::Cubic(
            Point::new(a[0], a[1]),
            Point::new(b[0], b[1]),
            Point::new(p[0], p[1]),
        ));
        Ok(())
    }
    fn close(&mut self) -> Result<()> {
        self.0.commands.push(Command::Close);
        Ok(())
    }
}
fn visit(
    layer: &Layer,
    parent: Transform,
    scene: &mut GpuScene,
    commands: &mut usize,
) -> Result<()> {
    let f = layer.fields();
    keys(
        f,
        &[
            "_class",
            "do_objectID",
            "name",
            "isVisible",
            "isLocked",
            "frame",
            "style",
            "rotation",
            "isFlippedHorizontal",
            "isFlippedVertical",
            "hasClippingMask",
            "points",
            "isClosed",
        ],
    )?;
    if !boolean(f, "isVisible", true)? {
        return Ok(());
    }
    if number(f, "rotation", 0.)? != 0.
        || boolean(f, "isFlippedHorizontal", false)?
        || boolean(f, "isFlippedVertical", false)?
        || boolean(f, "hasClippingMask", false)?
    {
        return Err(unsupported("transform or clipping"));
    }
    let frame = object(
        f.get("frame")
            .ok_or_else(|| Error::Missing("layer frame".into()))?,
    )?;
    keys(
        frame,
        &[
            "_class",
            "x",
            "y",
            "width",
            "height",
            "constrainProportions",
        ],
    )?;
    let [x, y, w, h] = [
        number(frame, "x", 0.)?,
        number(frame, "y", 0.)?,
        number(frame, "width", 0.)?,
        number(frame, "height", 0.)?,
    ];
    if w < 0. || h < 0. {
        return Err(Error::Invalid("negative frame".into()));
    }
    let matrix = parent.concat(Transform([1., 0., 0., 1., x, y]));
    if matrix.0.iter().any(|v| !v.is_finite() || v.abs() > 1e7) {
        return Err(Error::Limit("preview transform"));
    }
    if layer.kind() != LayerKind::ShapePath
        && (f.contains_key("points") || f.contains_key("isClosed"))
    {
        return Err(unsupported("non-path authored contour"));
    }
    let (mut fills, opacity) = style(layer, scene)?;
    if layer.kind() == LayerKind::Group {
        if !fills.is_empty() || opacity != 1. {
            return Err(unsupported("group paint/compositing"));
        }
        for child in layer.children() {
            visit(child, matrix, scene, commands)?;
        }
        return Ok(());
    }
    if !layer.children().is_empty() {
        return Err(unsupported("leaf children"));
    }
    let mut sink = Sink(Path::default());
    match layer.kind() {
        LayerKind::Rectangle => {
            if f.contains_key("points") {
                return Err(unsupported("rectangle corner geometry"));
            }
            sink.move_to([0., 0.])?;
            sink.line_to([w, 0.])?;
            sink.line_to([w, h])?;
            sink.line_to([0., h])?;
            sink.close()?;
        }
        LayerKind::ShapePath => {
            for p in f
                .get("points")
                .and_then(Value::as_array)
                .ok_or_else(|| Error::Missing("points".into()))?
            {
                let p = object(p)?;
                keys(
                    p,
                    &[
                        "_class",
                        "point",
                        "curveFrom",
                        "curveTo",
                        "hasCurveFrom",
                        "hasCurveTo",
                        "cornerRadius",
                        "curveMode",
                    ],
                )?;
                if number(p, "cornerRadius", 0.)? != 0. {
                    return Err(unsupported("rounded path corner"));
                }
            }
            let contour = CurveContour::from_layer(layer)?;
            if !contour.is_closed() {
                return Err(unsupported("open filled path"));
            }
            contour.emit(&mut sink)?;
        }
        _ => return Err(unsupported("layer class")),
    }
    *commands += sink.0.commands.len();
    if *commands > 10_000 || scene.nodes.len() >= 1000 {
        return Err(Error::Limit("preview geometry"));
    }
    if fills.is_empty() {
        return Ok(());
    }
    let contours = sink.0.flatten(matrix, 0.015625).map_err(Error::Invalid)?;
    // Pinned cfab820: sketchformat_common.dis.txt:40-52 gives 0=NonZero,
    // 1=EvenOdd; sketchformat_style.dis.txt:2021-2027 defaults to NonZero.
    let winding = f.get("style").and_then(|s| s.get("windingRule"));
    let even_odd = match winding {
        None => false,
        Some(v) if v.as_u64() == Some(0) => false,
        Some(v) if v.as_u64() == Some(1) => true,
        _ => return Err(unsupported("winding rule")),
    };
    let program =
        AreaProgram::compile(&contours, scene.extent, even_odd).map_err(Error::Invalid)?;
    if scene.curves.len() + program.data.len() > MAX_FLOATS {
        return Err(Error::Limit("preview intervals"));
    }
    if program.rect.empty() {
        return Ok(());
    }
    let area = AreaPath {
        first: (scene.curves.len() / 4) as u32,
        count: (program.data.len() / 4) as u32,
        fingerprint: None,
    };
    scene.curves.extend(program.data);
    let rect = program.rect;
    for fill in &mut fills {
        fill.fixed_gradient = crate::fixed_gradient::FixedGradient::new(
            &fill.paint,
            matrix.inverse_composed(rect).map_err(Error::Invalid)?,
            [w, h],
            rect,
        )
        .map_err(Error::Invalid)?;
    }
    let id = layer.id().to_owned();
    scene.roots.push(id.clone());
    scene.nodes.insert(
        id.clone(),
        GpuNode {
            opaque_coverage: false,
            passthrough: false,
            backdrop_box: [0.; 4],
            id,
            rect,
            matrix,
            inverse: matrix.inverse_composed(rect).map_err(Error::Invalid)?,
            size: [w, h],
            glass_shape: None,
            capture_replay: None,
            texture_replay: None,
            fill: GpuPath {
                opaque_rect: None,
                area: Some(area),
                analytic: None,
                sample_count: None,
                rect,
                first: 0,
                count: 3,
                rule: if even_odd { "evenodd" } else { "nonzero" }.into(),
                analytic_rect: None,
            },
            fills,
            strokes: vec![],
            children: vec![],
            mask_id: None,
            mask: false,
            mask_type: None,
            clip: false,
            opacity,
            blend: "normal".into(),
            effects: vec![],
        },
    );
    Ok(())
}

/// Compile CPU interval geometry only. No GPU device or foreign document exists.
pub fn compile_preview(session: &Session, request: &PreviewRequest) -> Result<PreviewFrame> {
    session.assert_current(&request.owner, request.expected_revision)?;
    if request.width == 0 || request.height == 0 || request.width > 4096 || request.height > 4096 {
        return Err(Error::Limit("preview viewport"));
    }
    let doc = session.document();
    // Sketch's native enum is Unmanaged=0, SRGB=1, P3=2. The byte preview
    // already uses sRGB paint values; an explicitly sRGB document must not be
    // rejected as a wide-gamut document. P3 still requires a managed pipeline.
    if doc
        .native_document()
        .get("colorSpace")
        .is_some_and(|v| !matches!(v.as_u64(), Some(0) | Some(1)))
    {
        return Err(unsupported("document color space"));
    }
    let page = doc
        .pages()
        .iter()
        .find(|p| p.root().id() == request.page_id)
        .ok_or_else(|| Error::Missing("preview page".into()))?;
    keys(
        page.root().fields(),
        &["_class", "do_objectID", "name", "isVisible", "isLocked"],
    )?;
    let extent = Rect::new(0, 0, request.width, request.height);
    let mut scene = GpuScene {
        software_raster: false,
        output: None,
        float_compositing: true,
        color_management: Some(ColorSettings::default()),
        colors: BTreeMap::new(),
        backdrop_samples: false,
        coherent_samples: false,
        integrated_blur: true,
        curves: vec![],
        resolve: None,
        presentation: None,
        version: 7,
        width: request.width,
        height: request.height,
        extent,
        background: "#00000000".into(),
        transparent: true,
        grid: false,
        checkerboard: false,
        checkerboard_size: 16,
        view: View {
            x: 0.,
            y: 0.,
            zoom: 1.,
        },
        roots: vec![],
        nodes: BTreeMap::new(),
        vertices: vec![],
    };
    if boolean(page.root().fields(), "isVisible", true)? {
        let mut commands = 0;
        for layer in page.root().children() {
            visit(layer, Transform::default(), &mut scene, &mut commands)?;
        }
    }
    Ok(PreviewFrame {
        owner: request.owner.clone(),
        revision: request.expected_revision,
        page_id: request.page_id.clone(),
        scene,
    })
}
