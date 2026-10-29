//! Detached display projection. Never saved back over a native document and
//! never used to execute Sketch edits. Archive fields remain in the Sketch archive adapter.
//! The shared Rust renderer consumes this vocabulary; no second paint/shaping
//! algorithm and no embedded-preview-image substitution is used here.
use crate::sketch::{Document, Error, Layer, Owner, Result, Session};
use crate::{
    boolean::Operation,
    color::ColorSettings,
    facet::sample_node,
    font::{TextRun, TextStyle},
    math::{Point, Transform},
    scene::{
        Document as DisplayDocument, Edge, Effect, Network, Node, Page, Paint, Stop, Stroke, Vertex,
    },
};
use base64::Engine as _;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplaySnapshot {
    pub owner: Owner,
    pub revision: u64,
    pub page_id: String,
    pub document: DisplayDocument,
    pub assets: BTreeMap<String, String>,
    pub warnings: Vec<String>,
    pub source_fonts: Vec<String>,
    pub artboards: Vec<String>,
}
fn number(v: &Value, key: &str, default: f64) -> Result<f64> {
    match v.get(key) {
        None => Ok(default),
        Some(v) => v
            .as_f64()
            .filter(|v| v.is_finite() && v.abs() <= 1e7)
            .ok_or_else(|| Error::Invalid(format!("Sketch numeric field {key}"))),
    }
}
fn num(v: &Value, key: &str, default: f64) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(default)
}
fn yes(v: &Value, key: &str, default: bool) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(default)
}
fn transform_flag(v: &Value, key: &str) -> Result<bool> {
    match v.get(key) {
        None => Ok(false),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| Error::Invalid(format!("Sketch transform flag {key}"))),
    }
}
fn array<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn color(v: &Value) -> Result<String> {
    let c = [
        number(v, "red", 0.)?,
        number(v, "green", 0.)?,
        number(v, "blue", 0.)?,
        number(v, "alpha", 1.)?,
    ];
    if c.iter().any(|v| !(0. ..=1.).contains(v)) {
        return Err(Error::Unsupported("Sketch extended color".into()));
    }
    Ok(format!("color(srgb {} {} {} / {})", c[0], c[1], c[2], c[3]))
}
fn point(v: &Value) -> Result<Point> {
    let s = v
        .as_str()
        .ok_or_else(|| Error::Invalid("Sketch point".into()))?;
    let parts = s
        .trim()
        .trim_matches(['{', '}'])
        .split(',')
        .map(|s| s.trim().parse::<f64>())
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| Error::Invalid("Sketch point".into()))?;
    if parts.len() != 2 || parts.iter().any(|v| !v.is_finite() || v.abs() > 1e7) {
        return Err(Error::Invalid("Sketch point".into()));
    }
    Ok(Point::new(parts[0], parts[1]))
}
fn blend(v: &Value) -> Result<String> {
    let code = num(v, "blendMode", 0.) as i32;
    let modes = [
        "normal",
        "darken",
        "multiply",
        "color-burn",
        "lighten",
        "screen",
        "color-dodge",
        "overlay",
        "soft-light",
        "hard-light",
        "difference",
        "exclusion",
        "hue",
        "saturation",
        "color",
        "luminosity",
    ];
    modes
        .get(code as usize)
        .map(|s| s.to_string())
        .ok_or_else(|| Error::Unsupported(format!("Sketch blend mode {code}")))
}
fn solid(id: String, value: String) -> Paint {
    Paint {
        id,
        kind: "solid".into(),
        color: value,
        opacity: 1.,
        visible: true,
        angle: 0.,
        stops: vec![],
        image: None,
        fit: "cover".into(),
        blend: "normal".into(),
        adjust: None,
        tile: None,
        transform: None,
    }
}
struct Projection<'a> {
    source: &'a Document,
    nodes: BTreeMap<String, Node>,
    assets: BTreeMap<String, String>,
    fonts: BTreeSet<String>,
    warnings: BTreeSet<String>,
    serial: usize,
}
impl Projection<'_> {
    fn synthetic(&mut self, _parent: &str) -> String {
        loop {
            self.serial += 1;
            let id = format!("fd000000-0000-4000-8000-{:012x}", self.serial);
            if self.source.layer(&id).is_none() && !self.nodes.contains_key(&id) {
                return id;
            }
        }
    }
    fn paint(&mut self, v: &Value, id: String, size: [f64; 2]) -> Result<Paint> {
        let mut p = solid(id, color(&v["color"])?);
        p.opacity = number(&v["contextSettings"], "opacity", 1.)?;
        p.blend = blend(&v["contextSettings"])?;
        match num(v, "fillType", 0.) as i32 {
            0 => {}
            1 => {
                let g = &v["gradient"];
                let a = point(&g["from"])?;
                let b = point(&g["to"])?;
                let delta = b - a;
                if delta.length() < 1e-10 {
                    return Err(Error::Invalid("Degenerate Sketch gradient".into()));
                }
                p.kind = match num(g, "gradientType", 0.) as i32 {
                    0 => "linear",
                    1 => "radial",
                    2 => "angular",
                    _ => return Err(Error::Unsupported("Sketch gradient type".into())),
                }
                .into();
                let ratio = if num(g, "elipseLength", 0.) > 0. {
                    num(g, "elipseLength", 1.)
                } else {
                    1.
                };
                let cross = Point::new(
                    -delta.y * size[1] / size[0].max(1e-8),
                    delta.x * size[0] / size[1].max(1e-8),
                );
                p.transform = Some(if p.kind == "linear" {
                    Transform([delta.x, delta.y, cross.x, cross.y, a.x, a.y])
                } else {
                    Transform([
                        delta.x * 2.,
                        delta.y * 2.,
                        cross.x * 2. * ratio,
                        cross.y * 2. * ratio,
                        a.x - delta.x - cross.x * ratio,
                        a.y - delta.y - cross.y * ratio,
                    ])
                });
                p.stops = array(g, "stops")
                    .iter()
                    .map(|s| {
                        Ok(Stop {
                            offset: number(s, "position", 0.)?,
                            color: color(&s["color"])?,
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                p.stops.sort_by(|a, b| a.offset.total_cmp(&b.offset));
                if let Some(first) = p.stops.first() {
                    p.color = first.color.clone()
                }
            }
            4 => {
                let path = v["image"]["_ref"]
                    .as_str()
                    .ok_or_else(|| Error::Missing("Sketch image reference".into()))?;
                if !path.starts_with("images/") {
                    return Err(Error::Unsupported("Sketch external image".into()));
                }
                let key = format!("sketch-asset:{path}");
                if !self.assets.contains_key(&key) {
                    let bytes = self
                        .source
                        .resource(path)
                        .ok_or_else(|| Error::Missing(format!("Sketch image {path}")))?;
                    let mime = if bytes.starts_with(b"\x89PNG") {
                        "image/png"
                    } else if bytes.starts_with(&[0xff, 0xd8]) {
                        "image/jpeg"
                    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
                        "image/webp"
                    } else {
                        return Err(Error::Unsupported("Sketch image codec".into()));
                    };
                    if bytes.len() > 9 * 1024 * 1024 {
                        return Err(Error::Limit("Sketch image exceeds 9 MiB"));
                    }
                    self.assets.insert(
                        key.clone(),
                        format!(
                            "data:{mime};base64,{}",
                            base64::engine::general_purpose::STANDARD.encode(bytes)
                        ),
                    );
                }
                p.kind = "image".into();
                p.image = Some(key);
                p.fit = match num(v, "patternFillType", 1.) as i32 {
                    1 => "cover",
                    2 => "stretch",
                    3 => "contain",
                    _ => return Err(Error::Unsupported("Sketch tiled image fill".into())),
                }
                .into();
            }
            other => return Err(Error::Unsupported(format!("Sketch fill type {other}"))),
        }
        Ok(p)
    }
    fn geometry(&self, v: &Value, n: &mut Node) -> Result<()> {
        let raw = array(v, "points");
        if raw.is_empty() {
            return Ok(());
        }
        if raw.len() > 10000 {
            return Err(Error::Limit("Sketch path points"));
        }
        let scaled = |v: &Value| -> Result<Point> {
            let p = point(v)?;
            Ok(Point::new(p.x * n.width, p.y * n.height))
        };
        let mut network = Network {
            vertices: vec![],
            edges: vec![],
            filled_faces: None,
            fill_rule: if num(&v["style"], "windingRule", 1.) == 0. {
                "nonzero"
            } else {
                "evenodd"
            }
            .into(),
        };
        for (i, p) in raw.iter().enumerate() {
            let p = scaled(&p["point"])?;
            network.vertices.push(Vertex {
                id: i.to_string(),
                x: p.x,
                y: p.y,
            })
        }
        let count = if yes(v, "isClosed", true) {
            raw.len()
        } else {
            raw.len().saturating_sub(1)
        };
        for i in 0..count {
            let j = (i + 1) % raw.len();
            network.edges.push(Edge {
                id: format!("e{i}"),
                from: i.to_string(),
                to: j.to_string(),
                c1: if yes(&raw[i], "hasCurveFrom", false) {
                    Some(scaled(&raw[i]["curveFrom"])?)
                } else {
                    None
                },
                c2: if yes(&raw[j], "hasCurveTo", false) {
                    Some(scaled(&raw[j]["curveTo"])?)
                } else {
                    None
                },
            })
        }
        if raw.iter().any(|p| num(p, "cornerRadius", 0.) > 0.) {
            return Err(Error::Unsupported(
                "Sketch authored point corner radius".into(),
            ));
        }
        n.kind = "vector".into();
        n.network = Some(network);
        Ok(())
    }
    fn layer(&mut self, layer: &Layer) -> Result<String> {
        if ["transform", "affineTransform"]
            .iter()
            .any(|key| layer.fields().contains_key(*key))
        {
            return Err(Error::Unsupported(
                "Sketch unrecognized transform fields".into(),
            ));
        }
        let v = Value::Object(layer.fields().clone());
        let class = v["_class"].as_str().unwrap();
        let id = layer.id().to_string();
        let kind = match class {
            "artboard" | "frame" | "canvasFrame" | "symbolMaster" => "frame",
            "group" | "shapeGroup" => "group",
            "shapePath" => "vector",
            "rectangle" => "rectangle",
            "oval" => "ellipse",
            "text" => "text",
            "bitmap" => "rectangle",
            "slice" => "slice",
            _ => return Err(Error::Unsupported(format!("Sketch layer class {class}"))),
        };
        let mut n = sample_node(&id, kind);
        n.points = 5;
        n.inner_radius = 0.5;
        n.name = v["name"]
            .as_str()
            .unwrap_or("Layer")
            .chars()
            .take(200)
            .collect();
        n.visible = yes(&v, "isVisible", true);
        n.locked = yes(&v, "isLocked", false);
        let f = &v["frame"];
        n.width = number(f, "width", 0.)?;
        n.height = number(f, "height", 0.)?;
        let x = number(f, "x", 0.)?;
        let y = number(f, "y", 0.)?;
        if n.width < 0. || n.height < 0. {
            return Err(Error::Invalid("Sketch negative frame".into()));
        }
        n.transform = crate::sketch::geometry::layer_transform(
            [x, y, n.width, n.height],
            number(&v, "rotation", 0.)?,
            [
                transform_flag(&v, "isFlippedHorizontal")?,
                transform_flag(&v, "isFlippedVertical")?,
            ],
        );
        let style = &v["style"];
        n.opacity = number(&style["contextSettings"], "opacity", 1.)?;
        n.blend = blend(&style["contextSettings"])?;
        for (i, p) in array(style, "fills")
            .iter()
            .enumerate()
            .filter(|(_, p)| yes(p, "isEnabled", true))
        {
            n.fills
                .push(self.paint(p, format!("{id}:fill{i}"), [n.width, n.height])?)
        }
        if class == "bitmap" {
            let mut p = v.clone();
            p["fillType"] = Value::from(4);
            p["patternFillType"] = Value::from(2);
            n.fills
                .push(self.paint(&p, format!("{id}:bitmap"), [n.width, n.height])?)
        }
        let opts = &style["borderOptions"];
        for (i, p) in array(style, "borders")
            .iter()
            .enumerate()
            .filter(|(_, p)| yes(p, "isEnabled", true))
        {
            let paint = self.paint(p, format!("{id}:border-paint{i}"), [n.width, n.height])?;
            n.strokes.push(Stroke {
                id: format!("{id}:border{i}"),
                paint,
                width: number(p, "thickness", 1.)?,
                align: match num(p, "position", 0.) as i32 {
                    0 => "center",
                    1 => "inside",
                    2 => "outside",
                    _ => return Err(Error::Unsupported("Sketch border alignment".into())),
                }
                .into(),
                cap: match num(opts, "lineCapStyle", 0.) as i32 {
                    1 => "round",
                    2 => "square",
                    _ => "butt",
                }
                .into(),
                join: match num(opts, "lineJoinStyle", 0.) as i32 {
                    1 => "round",
                    2 => "bevel",
                    _ => "miter",
                }
                .into(),
                dash: array(opts, "dashPattern")
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join(" "),
                dash_offset: 0.,
                visible: true,
                width_profile: vec![],
                start_marker: Default::default(),
                end_marker: Default::default(),
            });
        }
        for (key, kind) in [("shadows", "shadow"), ("innerShadows", "inner-shadow")] {
            for (i, e) in array(style, key)
                .iter()
                .enumerate()
                .filter(|(_, e)| yes(e, "isEnabled", true))
            {
                n.effects.push(Effect {
                    id: format!("{id}:{key}{i}"),
                    kind: kind.into(),
                    visible: true,
                    radius: number(e, "blurRadius", 0.)?,
                    x: number(e, "offsetX", 0.)?,
                    y: number(e, "offsetY", 0.)?,
                    spread: number(e, "spread", 0.)?,
                    color: color(&e["color"])?,
                    opacity: number(&e["contextSettings"], "opacity", 1.)?,
                    amount: 0.,
                    glass: None,
                    texture: None,
                    gradient_blur: None,
                    show_shadow_behind_node: false,
                })
            }
        }
        let blur = &style["blur"];
        if yes(blur, "isEnabled", false) && num(blur, "radius", 0.) > 0. {
            let kind = match num(blur, "type", 0.) as i32 {
                0 => "blur",
                3 => "background-blur",
                _ => return Err(Error::Unsupported("Sketch motion/zoom blur".into())),
            };
            n.effects.push(Effect {
                id: format!("{id}:blur"),
                kind: kind.into(),
                radius: number(blur, "radius", 0.)?,
                visible: true,
                x: 0.,
                y: 0.,
                spread: 0.,
                color: "#000000".into(),
                opacity: 1.,
                amount: 0.,
                glass: None,
                texture: None,
                gradient_blur: None,
                show_shadow_behind_node: false,
            });
        }
        if yes(&style["colorControls"], "isEnabled", false) {
            return Err(Error::Unsupported("Sketch image color controls".into()));
        }
        if ["rectangle", "oval", "shapePath"].contains(&class) {
            self.geometry(&v, &mut n)?
        }
        if class == "artboard" {
            n.clip = true;
            if yes(&v, "hasBackgroundColor", false) {
                n.fills.insert(
                    0,
                    solid(format!("{id}:background"), color(&v["backgroundColor"])?),
                );
            }
        }
        if class == "slice" {
            n.fills.clear();
            n.strokes.clear();
            n.effects.clear()
        }
        if class == "text" {
            self.text(&v, &mut n)?
        }
        n.children = self.children(layer)?;
        let compound = class == "shapeGroup"
            && layer.children().iter().all(|child| {
                child
                    .fields()
                    .get("booleanOperation")
                    .and_then(Value::as_i64)
                    .unwrap_or(-1)
                    == -1
            });
        let union_only = class == "shapeGroup"
            && layer.children().iter().all(|child| {
                matches!(
                    child
                        .fields()
                        .get("booleanOperation")
                        .and_then(Value::as_i64)
                        .unwrap_or(-1),
                    -1 | 0
                )
            });
        if union_only && !n.children.is_empty() && n.children.len() <= 64 {
            // Union is associative. A single graph avoids repeatedly solving
            // growing prefixes of native compound artwork (e.g. map masks).
            n.kind = "vector".into();
            n.boolean_operation = Some(if compound {
                if v.pointer("/style/windingRule")
                    .or_else(|| v.get("windingRule"))
                    .and_then(Value::as_i64)
                    == Some(0)
                {
                    Operation::CompoundNonzero
                } else {
                    Operation::CompoundEvenodd
                }
            } else {
                Operation::Union
            });
        } else if class == "shapeGroup" && n.children.len() > 1 {
            // Native operations live on each operand. Preserve the left fold
            // with identity synthetic groups; styling stays on the outer shape.
            let mut result = n.children[0].clone();
            for (i, child) in layer.children().iter().enumerate().skip(1) {
                let code = child
                    .fields()
                    .get("booleanOperation")
                    .and_then(Value::as_i64)
                    .unwrap_or(-1);
                let op = match code {
                    -1 | 0 => Operation::Union,
                    1 => Operation::Subtract,
                    2 => Operation::Intersect,
                    3 => Operation::Exclude,
                    _ => return Err(Error::Unsupported("Sketch boolean operation".into())),
                };
                if i == n.children.len() - 1 {
                    n.kind = "vector".into();
                    n.boolean_operation = Some(op);
                    n.children = vec![result, n.children[i].clone()];
                    break;
                }
                let synthetic = self.synthetic(&id);
                let mut group = sample_node(&synthetic, "group");
                group.width = n.width;
                group.height = n.height;
                group.kind = "vector".into();
                group.boolean_operation = Some(op);
                group.children = vec![result, n.children[i].clone()];
                self.nodes.insert(synthetic.clone(), group);
                result = synthetic;
            }
        }
        n.width = n.width.max(0.01);
        n.height = n.height.max(0.01);
        self.nodes.insert(id.clone(), n);
        Ok(id)
    }
    fn children(&mut self, layer: &Layer) -> Result<Vec<String>> {
        let mut output = vec![];
        let mut mask: Option<String> = None;
        for child in layer.children() {
            let v = Value::Object(child.fields().clone());
            if yes(&v, "shouldBreakMaskChain", false) {
                mask = None
            }
            let id = self.layer(child)?;
            if yes(&v, "hasClippingMask", false) {
                let group_id = self.synthetic(layer.id());
                let mut group = sample_node(&group_id, "group");
                group.width = 1.;
                group.height = 1.;
                group.children = vec![id.clone()];
                let n = self.nodes.get_mut(&id).unwrap();
                n.mask = true;
                n.mask_type = Some("alpha".into());
                if num(&v, "clippingMaskMode", 0.) == 0. {
                    n.fills = vec![solid(format!("{id}:clip"), "#ffffff".into())];
                    n.opacity = 1.;
                    n.strokes.clear();
                    n.effects.clear()
                }
                self.nodes.insert(group_id.clone(), group);
                output.push(group_id.clone());
                mask = Some(group_id);
            } else if let Some(group) = &mask {
                self.nodes.get_mut(group).unwrap().children.push(id)
            } else {
                output.push(id)
            }
        }
        Ok(output)
    }
    fn text(&mut self, v: &Value, n: &mut Node) -> Result<()> {
        n.text = v["attributedString"]["string"]
            .as_str()
            .unwrap_or("")
            .into();
        let len = n.text.encode_utf16().count();
        let raw = array(&v["attributedString"], "attributes");
        let first = raw
            .first()
            .map(|r| &r["attributes"])
            .unwrap_or(&Value::Null);
        let fallback = &v["style"]["textStyle"]["encodedAttributes"];
        let first = if first.is_null() { fallback } else { first };
        n.font_size = num(
            &first["MSAttributedStringFontAttribute"]["attributes"],
            "size",
            12.,
        )
        .max(1.);
        let p = &first["paragraphStyle"];
        let line = num(p, "minimumLineHeight", 0.).max(num(p, "maximumLineHeight", 0.));
        n.text_style = Some(TextStyle {
            font_id: "default".into(),
            line_height: if line > 0. {
                (line / n.font_size).clamp(0.1, 10.)
            } else {
                1.35
            },
            letter_spacing: num(first, "kerning", 0.),
            wrap: num(v, "textBehaviour", 0.) != 0.,
            align: match num(p, "alignment", 0.) as i32 {
                1 => "end",
                2 => "center",
                3 => "justify",
                _ => "start",
            }
            .into(),
            paragraph_spacing: num(p, "paragraphSpacing", 0.),
            ..TextStyle::default()
        });
        if n.fills.is_empty() {
            n.fills.push(solid(
                format!("{}:text", n.id),
                color(&first["MSAttributedStringColorAttribute"])?,
            ))
        }
        for r in raw {
            let start = num(r, "location", 0.) as usize;
            let end = (start + num(r, "length", 0.) as usize).min(len);
            if start >= end {
                continue;
            }
            let a = &r["attributes"];
            let font = &a["MSAttributedStringFontAttribute"]["attributes"];
            let font_name = font["name"].as_str().unwrap_or("default");
            self.fonts.insert(font_name.into());
            n.text_runs.push(TextRun {
                text_case: None,
                start,
                end,
                color: Some(color(&a["MSAttributedStringColorAttribute"])?),
                font_id: None,
                font_size: Some(num(font, "size", n.font_size).max(1.)),
                weight: Some(if font_name.to_ascii_lowercase().contains("bold") {
                    700.
                } else if font_name.to_ascii_lowercase().contains("medium") {
                    500.
                } else {
                    400.
                }),
                underline: num(a, "underlineStyle", 0.) > 0.,
                strikethrough: num(a, "strikethroughStyle", 0.) > 0.,
                link: None,
            });
        }
        Ok(())
    }
}
pub fn display_snapshot(session: &Session, page_id: &str) -> Result<DisplaySnapshot> {
    let native = session.document();
    let space = native
        .native_document()
        .get("colorSpace")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if space > 1 {
        return Err(Error::Unsupported(
            "Sketch P3 display projection requires color management mapping".into(),
        ));
    }
    let page = native
        .pages()
        .iter()
        .find(|p| p.root().id() == page_id)
        .ok_or_else(|| Error::Missing("Sketch page".into()))?;
    if [
        "rotation",
        "isFlippedHorizontal",
        "isFlippedVertical",
        "transform",
        "affineTransform",
    ]
    .iter()
    .any(|key| page.root().fields().contains_key(*key))
    {
        return Err(Error::Unsupported("Sketch page transforms".into()));
    }
    let mut p = Projection {
        source: native,
        nodes: BTreeMap::new(),
        assets: BTreeMap::new(),
        fonts: BTreeSet::new(),
        warnings: BTreeSet::new(),
        serial: 0,
    };
    let roots = p.children(page.root())?;
    let artboards = page
        .root()
        .children()
        .iter()
        .filter(|l| {
            matches!(
                l.fields().get("_class").and_then(Value::as_str),
                Some("artboard" | "frame" | "canvasFrame")
            )
        })
        .map(|l| l.id().to_string())
        .collect();
    let name = page
        .root()
        .fields()
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Sketch")
        .chars()
        .take(200)
        .collect();
    let mut document = DisplayDocument {
        fd_compatibility: None,
        schema_version: if p.nodes.values().any(|n| {
            n.boolean_operation
                .is_some_and(|op| op.compound_rule().is_some())
        }) {
            16
        } else {
            11
        },
        id: session.owner().document_id.clone(),
        name,
        pages: vec![Page {
            id: page_id.into(),
            name: "Sketch".into(),
            background: "#f5f5f5".into(),
            children: roots,
            guides: vec![],
        }],
        nodes: p.nodes,
        fonts: BTreeMap::new(),
        color_management: Some(ColorSettings::default()),
        raster_profile: Some(crate::fidelity::RasterProfile::Figma),
        design_system: None,
        prototype: None,
        animations: vec![],
        reviews: vec![],
    };
    for n in document.nodes.values_mut() {
        n.points = 5;
        n.inner_radius = 0.5;
        for paint in n
            .fills
            .iter_mut()
            .chain(n.strokes.iter_mut().map(|s| &mut s.paint))
        {
            if paint.stops.is_empty() {
                paint.stops = vec![
                    Stop {
                        offset: 0.,
                        color: paint.color.clone(),
                    },
                    Stop {
                        offset: 1.,
                        color: paint.color.clone(),
                    },
                ]
            }
        }
    }
    // Image references remain opaque resource keys on the wire; each selected
    // artboard is hydrated and validated before rendering. No archive metadata
    // or operating-system path is sent to the renderer.
    let mut validation = document.clone();
    for n in validation.nodes.values_mut() {
        for paint in n
            .fills
            .iter_mut()
            .chain(n.strokes.iter_mut().map(|s| &mut s.paint))
        {
            if let Some(key) = &paint.image {
                paint.image = Some(
                    p.assets
                        .get(key)
                        .ok_or_else(|| Error::Missing("Sketch projected image".into()))?
                        .clone(),
                );
            }
        }
    }
    validation.validate().map_err(Error::Invalid)?;
    if !p.fonts.is_empty() {
        p.warnings
            .insert("按用户选择，原文件字体使用项目默认字体；文字形状可能与原字体不同。".into());
    }
    Ok(DisplaySnapshot {
        owner: session.owner().clone(),
        revision: session.revision(),
        page_id: page_id.into(),
        document,
        assets: p.assets,
        warnings: p.warnings.into_iter().collect(),
        source_fonts: p.fonts.into_iter().collect(),
        artboards,
    })
}
