//! Document-level SVG writer following the reference exporter's recovered
//! conventions (TS-BEHAVIORS-AND-EXPORT-2026-10-26 / CANVAS-OPERATIONS
//! round 20: FGSvgExport #11958 → nine shape writers inlined in #30649).
//!
//! Recovered conventions implemented here:
//! - **All coordinates use C `%g` six-significant-digit formatting**
//!   ([`g6`]), trailing zeros trimmed — the reference emits no raw f64s.
//! - **Element ids follow `<kind>%d_<dataName>`** (`rect0_Card`), numbered
//!   per document in depth-first order, with the layer name sanitized to
//!   id-safe characters.
//! - **Attribute order**: id, opacity, fill-rule, geometry, fill/stroke
//!   presentation, `transform` last.
//! - **`fill-rule` is emitted per element** (`evenodd` chosen by the
//!   node's rule; the reference picks it per subpath — our model keeps one
//!   rule per node, which is the documented divergence).
//! - **Text is absolutely positioned and no `text-anchor` is written**,
//!   matching the reference writer.
//!
//! Honest divergences (v1): image paints emit no fill (the reference embeds
//! raster data); `angular`/`diamond` gradients degrade (angular → mid-stop
//! solid, diamond → radial); effects/masks and per-run text layout are not
//! emitted. This writer produces vector structure, not pixel parity with
//! the reference's raster output.

use crate::{
    bounds,
    math::Transform,
    path::Path,
    scene::{Document, Node, Stroke},
};
use std::fmt::Write;

/// C `%g` with 6 significant digits: fixed notation when the decimal
/// exponent is in `[-4, 6)`, otherwise scientific with a two-digit
/// exponent; trailing zeros trimmed. Non-finite values fail closed to `0`.
pub fn g6(value: f64) -> String {
    if !value.is_finite() || value == 0. {
        return "0".into();
    }
    let sci = format!("{value:.5e}");
    let (mantissa, exponent) = sci.split_once('e').expect("scientific form");
    let exponent: i32 = exponent.parse().expect("exponent digits");
    let trim = |s: &str| -> String {
        let mut s = s.to_string();
        if s.contains('.') {
            while s.ends_with('0') {
                s.pop();
            }
            if s.ends_with('.') {
                s.pop();
            }
        }
        s
    };
    if (-4..6).contains(&exponent) {
        let precision = (5 - exponent).max(0) as usize;
        trim(&format!("{value:.precision$}"))
    } else {
        let sign = if exponent < 0 { '-' } else { '+' };
        format!("{}e{sign}{:02}", trim(mantissa), exponent.abs())
    }
}

/// XML text escaping for attribute values and text nodes.
pub fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// Layer name → id-safe token for the `<kind>%d_<dataName>` scheme.
fn id_token(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn kind_token(kind: &str) -> &'static str {
    match kind {
        "rectangle" => "rect",
        "ellipse" => "ellipse",
        "text" => "text",
        "frame" => "frame",
        "group" => "group",
        "section" => "section",
        "line" => "line",
        _ => "path",
    }
}

/// Parse `#rrggbb`/`#rrggbbaa` into `(r, g, b, a)` bytes.
fn parse_hex_color(color: &str) -> Option<(u8, u8, u8, u8)> {
    let hex = color.strip_prefix('#')?;
    if hex.len() != 6 && hex.len() != 8 {
        return None;
    }
    let channel = |range: std::ops::Range<usize>| u8::from_str_radix(&hex[range], 16).ok();
    Some((
        channel(0..2)?,
        channel(2..4)?,
        channel(4..6)?,
        if hex.len() == 8 { channel(6..8)? } else { 255 },
    ))
}

/// `(#rrggbb, opacity multiplier)` for a stored color string.
fn color_attr(color: &str) -> Option<(String, f64)> {
    let (r, g, b, a) = parse_hex_color(color)?;
    Some((format!("#{r:02x}{g:02x}{b:02x}"), f64::from(a) / 255.))
}

fn transform_attr(t: &Transform) -> Option<String> {
    if *t == Transform::default() {
        return None;
    }
    let m = &t.0;
    Some(format!(
        "matrix({} {} {} {} {} {})",
        g6(m[0]),
        g6(m[1]),
        g6(m[2]),
        g6(m[3]),
        g6(m[4]),
        g6(m[5])
    ))
}

/// Path data in `%g` form (the shared [`Path::svg_data`] emits raw f64s,
/// so the writer formats the commands itself).
fn path_data(path: &Path) -> String {
    use crate::path::Command;
    let mut out = String::new();
    let mut coord = |out: &mut String, v: f64| {
        let _ = write!(out, "{} ", g6(v));
    };
    for command in &path.commands {
        match *command {
            Command::Move(p) => {
                out.push_str("M ");
                coord(&mut out, p.x);
                coord(&mut out, p.y);
            }
            Command::Line(p) => {
                out.push_str("L ");
                coord(&mut out, p.x);
                coord(&mut out, p.y);
            }
            Command::Quad(c, p) => {
                out.push_str("Q ");
                coord(&mut out, c.x);
                coord(&mut out, c.y);
                coord(&mut out, p.x);
                coord(&mut out, p.y);
            }
            Command::Cubic(a, b, p) => {
                out.push_str("C ");
                coord(&mut out, a.x);
                coord(&mut out, a.y);
                coord(&mut out, b.x);
                coord(&mut out, b.y);
                coord(&mut out, p.x);
                coord(&mut out, p.y);
            }
            Command::Arc {
                center,
                radius,
                start,
                sweep,
            } => {
                let pieces = (sweep.abs() / std::f64::consts::PI).ceil().max(1.) as usize;
                for i in 1..=pieces {
                    let a = start + sweep * i as f64 / pieces as f64;
                    let p = center + crate::math::Point::new(radius.x * a.cos(), radius.y * a.sin());
                    if radius.x == 0. || radius.y == 0. {
                        out.push_str("L ");
                        coord(&mut out, p.x);
                        coord(&mut out, p.y);
                    } else {
                        let _ = write!(
                            out,
                            "A{} {} 0 0 {} ",
                            g6(radius.x.abs()),
                            g6(radius.y.abs()),
                            u8::from(sweep * radius.x * radius.y > 0.)
                        );
                        coord(&mut out, p.x);
                        coord(&mut out, p.y);
                    }
                }
            }
            Command::SmoothCorner(corner) => {
                // SVG has no superellipse primitive; keep the legacy
                // 64-chord approximation, matching [`Path::svg_data`].
                out.push_str("L ");
                for p in corner.legacy_points() {
                    coord(&mut out, p.x);
                    coord(&mut out, p.y);
                }
            }
            Command::Close => out.push_str("Z "),
        }
    }
    out.trim_end().to_string()
}

struct Writer {
    body: String,
    defs: String,
    gradient_counter: usize,
    element_counter: usize,
}

impl Writer {
    fn gradient_id(&mut self) -> String {
        let id = format!("gradient{}", self.gradient_counter);
        self.gradient_counter += 1;
        id
    }

    /// One gradient def per gradient paint; `None` for kinds that degrade.
    fn write_gradient(&mut self, paint: &crate::scene::Paint) -> Option<String> {
        if paint.stops.is_empty() {
            return None;
        }
        let id = self.gradient_id();
        let angle_rad = paint.angle.to_radians();
        let (tag, geometry) = match paint.kind.as_str() {
            "linear" => (
                "linearGradient",
                format!(
                    "x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\"",
                    g6(0.5 - angle_rad.cos() * 0.5),
                    g6(0.5 - angle_rad.sin() * 0.5),
                    g6(0.5 + angle_rad.cos() * 0.5),
                    g6(0.5 + angle_rad.sin() * 0.5)
                ),
            ),
            "radial" | "diamond" => ("radialGradient", "cx=\"0.5\" cy=\"0.5\" r=\"0.5\"".into()),
            _ => return None,
        };
        let _ = writeln!(self.defs, "  <{tag} id=\"{id}\" {geometry}>");
        for stop in &paint.stops {
            let (color, alpha) = color_attr(&stop.color).unwrap_or(("#000000".into(), 1.));
            let opacity = alpha * paint.opacity;
            if opacity < 1. {
                let _ = writeln!(
                    self.defs,
                    "    <stop offset=\"{}\" stop-color=\"{color}\" stop-opacity=\"{}\"/>",
                    g6(stop.offset),
                    g6(opacity)
                );
            } else {
                let _ = writeln!(
                    self.defs,
                    "    <stop offset=\"{}\" stop-color=\"{color}\"/>",
                    g6(stop.offset)
                );
            }
        }
        let _ = writeln!(self.defs, "  </{tag}>");
        Some(id)
    }

    /// Fill value for one paint: solid color or gradient reference.
    /// `None` when the paint cannot be represented (image, unknown kind).
    fn paint_fill(&mut self, paint: &crate::scene::Paint) -> Option<(String, f64)> {
        if !paint.visible {
            return None;
        }
        if paint.kind == "solid" {
            let (color, alpha) = color_attr(&paint.color)?;
            return Some((color, alpha * paint.opacity));
        }
        if matches!(paint.kind.as_str(), "linear" | "radial" | "diamond") {
            let id = self.write_gradient(paint)?;
            return Some((format!("url(#{id})"), paint.opacity));
        }
        if paint.kind == "angular" {
            let mid = &paint.stops[paint.stops.len() / 2];
            let (color, alpha) = color_attr(&mid.color)?;
            return Some((color, alpha * paint.opacity));
        }
        None
    }

    fn next_element_id(&mut self, node: &Node) -> String {
        let seq = self.element_counter;
        self.element_counter += 1;
        let token = kind_token(&node.kind);
        let name = id_token(&node.name);
        if name.is_empty() {
            format!("{token}{seq}")
        } else {
            format!("{token}{seq}_{name}")
        }
    }

    fn stroke_attrs(&mut self, out: &mut String, stroke: &Stroke) {
        if let Some((color, opacity)) = self.paint_fill(&stroke.paint) {
            let _ = write!(out, " stroke=\"{color}\"");
            if opacity < 1. {
                let _ = write!(out, " stroke-opacity=\"{}\"", g6(opacity));
            }
        }
        let _ = write!(out, " stroke-width=\"{}\"", g6(stroke.width));
        let cap = match stroke.cap.as_str() {
            "butt" | "square" => stroke.cap.as_str(),
            _ => "round",
        };
        let join = match stroke.join.as_str() {
            "miter" | "bevel" => stroke.join.as_str(),
            _ => "round",
        };
        let _ = write!(out, " stroke-linecap=\"{cap}\" stroke-linejoin=\"{join}\"");
        if !stroke.dash.trim().is_empty() {
            let _ = write!(out, " stroke-dasharray=\"{}\"", stroke.dash);
        }
    }

    fn write_shape(&mut self, node: &Node, path: &Path) {
        let d = path_data(path);
        if d.is_empty() {
            return;
        }
        let id = self.next_element_id(node);
        let mut out = String::new();
        let _ = write!(out, "  <path id=\"{id}\"");
        if node.opacity < 1. {
            let _ = write!(out, " opacity=\"{}\"", g6(node.opacity));
        }
        if node.fill_even_odd() {
            let _ = write!(out, " fill-rule=\"evenodd\"");
        }
        let _ = write!(out, " d=\"{d}\"");
        let mut filled = false;
        for paint in node.fills.iter().filter(|p| p.visible) {
            if let Some((fill, opacity)) = self.paint_fill(paint) {
                let _ = write!(out, " fill=\"{fill}\"");
                if opacity < 1. {
                    let _ = write!(out, " fill-opacity=\"{}\"", g6(opacity));
                }
                filled = true;
                break;
            }
        }
        if !filled {
            let _ = write!(out, " fill=\"none\"");
        }
        if let Some(stroke) = node.strokes.iter().find(|s| s.visible) {
            self.stroke_attrs(&mut out, stroke);
        }
        if let Some(transform) = transform_attr(&node.transform) {
            let _ = write!(out, " transform=\"{transform}\"");
        }
        let _ = writeln!(out, "/>");
        self.body.push_str(&out);
    }

    fn write_text(&mut self, node: &Node) {
        if node.text.is_empty() {
            return;
        }
        let id = self.next_element_id(node);
        let mut out = String::new();
        let _ = write!(out, "  <text id=\"{id}\"");
        if node.opacity < 1. {
            let _ = write!(out, " opacity=\"{}\"", g6(node.opacity));
        }
        let _ = write!(out, " font-size=\"{}\"", g6(node.font_size));
        let mut filled = false;
        for paint in node.fills.iter().filter(|p| p.visible) {
            if let Some((fill, opacity)) = self.paint_fill(paint) {
                let _ = write!(out, " fill=\"{fill}\"");
                if opacity < 1. {
                    let _ = write!(out, " fill-opacity=\"{}\"", g6(opacity));
                }
                filled = true;
                break;
            }
        }
        if !filled {
            let _ = write!(out, " fill=\"#000000\"");
        }
        // Absolutely positioned first baseline; no text-anchor, matching
        // the reference writer. Multi-run layout is a documented v1 gap.
        let _ = write!(
            out,
            " x=\"{}\" y=\"{}\"",
            g6(node.transform.0[4]),
            g6(node.transform.0[5] + node.font_size)
        );
        if let Some(transform) = transform_attr(&node.transform) {
            let _ = write!(out, " transform=\"{transform}\"");
        }
        let _ = writeln!(out, ">{}</text>", escape_xml(&node.text));
        self.body.push_str(&out);
    }

    fn write_node(&mut self, doc: &Document, id: &str) {
        let Some(node) = doc.nodes.get(id) else {
            return;
        };
        if !node.visible {
            return;
        }
        if node.kind == "text" {
            self.write_text(node);
        } else if let Ok((_fill_path, line_path)) = node.paths() {
            let path = if node.kind == "line" || !node.fills.iter().any(|p| p.visible) {
                &line_path
            } else {
                &_fill_path
            };
            self.write_shape(node, path);
        }
        for child in &node.children {
            self.write_node(doc, child);
        }
    }
}

/// Export one page as a standalone SVG document. The viewBox is the exact
/// union of the root nodes' transformed path bounds.
pub fn export_svg(doc: &Document, page_id: &str) -> Result<String, String> {
    let page = doc
        .pages
        .iter()
        .find(|p| p.id == page_id)
        .ok_or_else(|| format!("Unknown page {page_id}"))?;
    let mut min = (f64::MAX, f64::MAX);
    let mut max = (f64::MIN, f64::MIN);
    for id in &page.children {
        let Some(node) = doc.nodes.get(id) else {
            continue;
        };
        if !node.visible {
            continue;
        }
        let Ok((fill, line)) = node.paths() else {
            continue;
        };
        if let Some(b) = bounds::paths_bounds(&fill, &line, node.transform) {
            min.0 = min.0.min(b.x);
            min.1 = min.1.min(b.y);
            max.0 = max.0.max(b.x + b.width);
            max.1 = max.1.max(b.y + b.height);
        }
    }
    if min.0 > max.0 || min.1 > max.1 {
        min = (0., 0.);
        max = (0., 0.);
    }
    let width = max.0 - min.0;
    let height = max.1 - min.1;
    let mut writer = Writer {
        body: String::new(),
        defs: String::new(),
        gradient_counter: 0,
        element_counter: 0,
    };
    for id in &page.children {
        writer.write_node(doc, id);
    }
    let mut svg = String::new();
    let _ = writeln!(
        svg,
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\" viewBox=\"{} {} {} {}\">",
        g6(width),
        g6(height),
        g6(min.0),
        g6(min.1),
        g6(width),
        g6(height)
    );
    if !writer.defs.is_empty() {
        let _ = writeln!(svg, "<defs>");
        svg.push_str(&writer.defs);
        let _ = writeln!(svg, "</defs>");
    }
    svg.push_str(&writer.body);
    let _ = writeln!(svg, "</svg>");
    Ok(svg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(kind: &str, name: &str, extra: serde_json::Value) -> Node {
        let mut value = json!({
            "id": format!("{kind}-{name}"),
            "kind": kind,
            "name": name,
            "width": 0.,
            "height": 0.,
        });
        if let (Some(base), Some(add)) = (value.as_object_mut(), extra.as_object()) {
            for (k, v) in add {
                base.insert(k.clone(), v.clone());
            }
        }
        serde_json::from_value(value).expect("valid node")
    }

    fn doc_with_page(nodes: Vec<Node>) -> Document {
        let page = crate::scene::Page {
            id: "page".into(),
            name: "Page 1".into(),
            children: nodes.iter().map(|n| n.id.clone()).collect(),
            background: "#ffffff".into(),
            guides: Vec::new(),
        };
        serde_json::from_value(json!({
            "schemaVersion": 20,
            "id": "doc",
            "name": "Doc",
            "pages": [page],
            "nodes": nodes
                .iter()
                .map(|n| (n.id.clone(), serde_json::to_value(n).unwrap()))
                .collect::<serde_json::Map<String, serde_json::Value>>(),
        }))
        .expect("valid document")
    }

    #[test]
    fn g6_formats_like_c_percent_g() {
        assert_eq!(g6(123.456_789), "123.457");
        assert_eq!(g6(0.000_001_234_567_89), "1.23457e-06");
        assert_eq!(g6(1_000_000.), "1e+06");
        assert_eq!(g6(1_234_567.), "1.23457e+06");
        assert_eq!(g6(0.5), "0.5");
        assert_eq!(g6(3.), "3");
        assert_eq!(g6(12.), "12");
        assert_eq!(g6(0.000_1), "0.0001");
        assert_eq!(g6(-2.5), "-2.5");
        assert_eq!(g6(0.), "0");
        assert_eq!(g6(f64::NAN), "0");
    }

    #[test]
    fn escapes_xml_specials() {
        assert_eq!(escape_xml("a<b>&\"c\""), "a&lt;b&gt;&amp;&quot;c&quot;");
    }

    #[test]
    fn exports_a_rectangle_with_reference_id_and_order() {
        let rect = node(
            "rectangle",
            "Card",
            json!({"width": 100., "height": 50., "fills": [{"kind": "solid", "color": "#ff0000"}]}),
        );
        let svg = export_svg(&doc_with_page(vec![rect]), "page").unwrap();
        // id scheme <kind>%d_<dataName>.
        assert!(svg.contains("id=\"rect0_Card\""), "{svg}");
        // Attribute order: geometry before fill; transform last when present.
        let element = svg.lines().find(|l| l.contains("rect0_Card")).unwrap();
        let d_at = element.find("d=").unwrap();
        let fill_at = element.find("fill=").unwrap();
        assert!(d_at < fill_at);
        // %g coordinates: 100 and 50, never 100.0/50.0.
        assert!(
            element.contains("d=\"M 0 0 L 100 0 L 100 50 L 0 50 Z\""),
            "{element}"
        );
        assert!(svg.starts_with(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"50\" viewBox=\"0 0 100 50\">"
        ));
    }

    #[test]
    fn opacity_evenodd_and_transform_emit_in_order() {
        let rect = node(
            "rectangle",
            "Odd",
            json!({
                "width": 10., "height": 10., "opacity": 0.5,
                "transform": [1., 0., 0., 1., 5., 7.],
                "fills": [{"kind": "solid", "color": "#00ff0080"}]
            }),
        );
        let svg = export_svg(&doc_with_page(vec![rect]), "page").unwrap();
        let element = svg.lines().find(|l| l.contains("rect0")).unwrap();
        let opacity_at = element.find("opacity=").unwrap();
        let rule_at = element.find("fill-rule=").unwrap();
        let d_at = element.find("d=").unwrap();
        let fill_at = element.find("fill=").unwrap();
        let fill_opacity_at = element.find("fill-opacity=").unwrap();
        let transform_at = element.rfind("transform=").unwrap();
        assert!(
            opacity_at < rule_at
                && rule_at < d_at
                && d_at < fill_at
                && fill_at < fill_opacity_at
                && fill_opacity_at < transform_at
        );
        // 0x80/255 alpha, six significant digits.
        assert!(element.contains("fill-opacity=\"0.501961\""), "{element}");
    }

    #[test]
    fn nonzero_network_rule_omits_the_evenodd_attribute() {
        let rect = node(
            "rectangle",
            "NonZero",
            json!({
                "width": 10., "height": 10.,
                "network": {"vertices": [], "edges": [], "fillRule": "nonzero"},
                "fills": [{"kind": "solid", "color": "#ff0000"}]
            }),
        );
        let svg = export_svg(&doc_with_page(vec![rect]), "page").unwrap();
        assert!(!svg.contains("fill-rule"), "{svg}");
    }

    #[test]
    fn linear_gradient_gets_a_def_and_url_reference() {
        let rect = node(
            "rectangle",
            "Grad",
            json!({
                "width": 40., "height": 40.,
                "fills": [{
                    "kind": "linear", "angle": 90.,
                    "stops": [
                        {"offset": 0., "color": "#ff0000"},
                        {"offset": 1., "color": "#0000ff"}
                    ]
                }]
            }),
        );
        let svg = export_svg(&doc_with_page(vec![rect]), "page").unwrap();
        assert!(svg.contains("<linearGradient id=\"gradient0\""), "{svg}");
        assert!(svg.contains("fill=\"url(#gradient0)\""), "{svg}");
        assert!(svg.contains("x1=\"0.5\" y1=\"0\" x2=\"0.5\" y2=\"1\""), "{svg}");
    }

    #[test]
    fn stroke_attributes_and_dash_follow_fill() {
        let line = node(
            "line",
            "Wire",
            json!({
                "width": 30., "height": 0.,
                "strokes": [{
                    "paint": {"kind": "solid", "color": "#123456"},
                    "width": 2.5, "cap": "butt", "join": "miter", "dash": "4 2"
                }]
            }),
        );
        let svg = export_svg(&doc_with_page(vec![line]), "page").unwrap();
        let element = svg.lines().find(|l| l.contains("line0")).unwrap();
        let fill_at = element.find("fill=\"none\"").unwrap();
        let stroke_at = element.find("stroke=").unwrap();
        assert!(fill_at < stroke_at);
        assert!(element.contains("stroke=\"#123456\""));
        assert!(element.contains("stroke-width=\"2.5\""));
        assert!(element.contains("stroke-linecap=\"butt\""));
        assert!(element.contains("stroke-linejoin=\"miter\""));
        assert!(element.contains("stroke-dasharray=\"4 2\""));
    }

    #[test]
    fn text_is_absolute_without_text_anchor() {
        let text = node(
            "text",
            "Label",
            json!({
                "text": "Hello <world>", "fontSize": 16.,
                "transform": [1., 0., 0., 1., 8., 9.],
                "fills": [{"kind": "solid", "color": "#000000"}]
            }),
        );
        let svg = export_svg(&doc_with_page(vec![text]), "page").unwrap();
        let element = svg.lines().find(|l| l.contains("text0")).unwrap();
        assert!(element.contains("font-size=\"16\""));
        assert!(element.contains("x=\"8\" y=\"25\""));
        assert!(!element.contains("text-anchor"));
        assert!(element.contains(">Hello &lt;world&gt;</text>"));
    }

    #[test]
    fn children_render_after_parent_in_depth_first_order() {
        let child = node(
            "rectangle",
            "Child",
            json!({
                "width": 4., "height": 4.,
                "transform": [1., 0., 0., 1., 2., 2.],
                "fills": [{"kind": "solid", "color": "#0000ff"}]
            }),
        );
        let frame = node(
            "frame",
            "Root",
            json!({"width": 10., "height": 10., "children": [child.id]}),
        );
        let svg = export_svg(&doc_with_page(vec![frame, child]), "page").unwrap();
        let frame_at = svg.find("frame0_Root").unwrap();
        let child_at = svg.find("rect1_Child").unwrap();
        assert!(frame_at < child_at);
    }

    #[test]
    fn unknown_page_errors_and_invisible_nodes_are_skipped() {
        let doc = doc_with_page(vec![]);
        assert!(export_svg(&doc, "nope").is_err());
        let hidden = node("rectangle", "Ghost", json!({"width": 5., "height": 5., "visible": false}));
        let svg = export_svg(&doc_with_page(vec![hidden]), "page").unwrap();
        assert!(!svg.contains("rect0"));
    }

    #[test]
    fn image_fills_degrade_to_no_fill_without_failing() {
        let rect = node(
            "rectangle",
            "Pic",
            json!({
                "width": 10., "height": 10.,
                "fills": [{"kind": "image", "image": "data:image/png;base64,AAAA"}]
            }),
        );
        let svg = export_svg(&doc_with_page(vec![rect]), "page").unwrap();
        assert!(svg.contains("fill=\"none\""), "{svg}");
    }
}
