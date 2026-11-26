//! Issue #177 baseline measurement on this Linux CPU.
//!
//! The Mac Sketch CLI / hardware WebGPU / Electron Metal references are not
//! in this environment. This compares the real CPU renderer with an independent
//! zero-padded Gaussian (sigma = blurRadius/2) and encoded sRGB source-over.
//! It does not retune the 16/255 over 1% screening line and does not treat a
//! pass against this reference as Sketch CLI fidelity.
use futureox_design_kernel::editing::{DocumentEditor, DocumentPatch};
use futureox_design_kernel::export::{ExportBounds, RegionRequest};
use futureox_design_kernel::fidelity::RasterProfile;
use futureox_design_kernel::interop::{export_sketch, import_sketch_report, read_zip_public};
use futureox_design_kernel::math::Point;
use futureox_design_kernel::scene::Document;
use futureox_design_kernel::sketch::geometry::layer_transform;
use futureox_design_kernel::{Engine, RenderOptions, View};
use serde_json::{Value, json};
use std::io::Write;

const W: usize = 512;
const ZOOM: f64 = 2.;
const PROBE_ALPHA: f64 = 0.5;
const FILL: [f64; 3] = [51., 102., 153.];

fn png_archive(layers: Value) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    let document = json!({
        "_class": "document",
        "colorSpace": 1,
        "pages": [{"_class": "MSJSONFileReference", "_ref": "pages/p"}]
    });
    let page = json!({"_class": "page", "do_objectID": "p", "name": "Page", "layers": layers});
    for (name, bytes) in [
        (
            "meta.json",
            serde_json::to_vec(&json!({"version": 136})).unwrap(),
        ),
        ("document.json", serde_json::to_vec(&document).unwrap()),
        ("pages/p.json", serde_json::to_vec(&page).unwrap()),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn color(r: f64, g: f64, b: f64, a: f64) -> Value {
    json!({"_class": "color", "red": r, "green": g, "blue": b, "alpha": a})
}

fn shadow(
    class: &str,
    radius: f64,
    x: f64,
    y: f64,
    spread: f64,
    rgb: [f64; 3],
    alpha: f64,
) -> Value {
    json!({
        "_class": class,
        "isEnabled": true,
        "blurRadius": radius,
        "offsetX": x,
        "offsetY": y,
        "spread": spread,
        "color": color(rgb[0], rgb[1], rgb[2], alpha),
        "contextSettings": {"_class": "graphicsContextSettings", "blendMode": 0, "opacity": 1}
    })
}

struct Cell {
    name: &'static str,
    /// Published issue parameters. Unpublished audit bytes are not reconstructed.
    layer_opacity: f64,
    rotation: f64,
    stroke: bool,
    shadows: Vec<Value>,
    inner: Vec<Value>,
    /// Axis-aligned integer geometry: area coverage is exact, so the Gaussian
    /// reference is a pixel oracle. Rotated edges are diagnostic only.
    exact_coverage: bool,
}

fn cells() -> Vec<Cell> {
    let outer = |r, x, y, s| shadow("shadow", r, x, y, s, [0., 0., 0.], PROBE_ALPHA);
    let inner = |r, x, y, s| shadow("innerShadow", r, x, y, s, [0., 0., 0.], PROBE_ALPHA);
    vec![
        Cell {
            name: "control",
            layer_opacity: 1.,
            rotation: 0.,
            stroke: false,
            shadows: vec![],
            inner: vec![],
            exact_coverage: true,
        },
        Cell {
            name: "drop-hard",
            layer_opacity: 1.,
            rotation: 0.,
            stroke: false,
            shadows: vec![outer(0., 8., 12., 0.)],
            inner: vec![],
            exact_coverage: true,
        },
        Cell {
            name: "drop-blur4",
            layer_opacity: 1.,
            rotation: 0.,
            stroke: false,
            shadows: vec![outer(4., 4., 8., 0.)],
            inner: vec![],
            exact_coverage: true,
        },
        Cell {
            name: "drop-blur16",
            layer_opacity: 1.,
            rotation: 0.,
            stroke: false,
            shadows: vec![outer(16., 4., 8., 0.)],
            inner: vec![],
            exact_coverage: true,
        },
        Cell {
            name: "drop-fractional",
            layer_opacity: 1.,
            rotation: 0.,
            stroke: false,
            shadows: vec![outer(4.5, 0.25, 6.75, 0.)],
            inner: vec![],
            exact_coverage: true,
        },
        Cell {
            name: "drop-spread-positive",
            layer_opacity: 1.,
            rotation: 0.,
            stroke: false,
            shadows: vec![outer(12., 4., 8., 8.)],
            inner: vec![],
            exact_coverage: true,
        },
        Cell {
            name: "drop-spread-negative",
            layer_opacity: 1.,
            rotation: 0.,
            stroke: false,
            shadows: vec![outer(12., 4., 8., -8.)],
            inner: vec![],
            exact_coverage: true,
        },
        Cell {
            name: "inner-hard",
            layer_opacity: 1.,
            rotation: 0.,
            stroke: false,
            shadows: vec![],
            inner: vec![inner(0., 6., 8., 0.)],
            exact_coverage: true,
        },
        Cell {
            name: "inner-blur12",
            layer_opacity: 1.,
            rotation: 0.,
            stroke: false,
            shadows: vec![],
            inner: vec![inner(12., 4., 6., 0.)],
            exact_coverage: true,
        },
        Cell {
            name: "inner-spread-positive",
            layer_opacity: 1.,
            rotation: 0.,
            stroke: false,
            shadows: vec![],
            inner: vec![inner(12., 4., 6., 8.)],
            exact_coverage: true,
        },
        Cell {
            name: "inner-spread-negative",
            layer_opacity: 1.,
            rotation: 0.,
            stroke: false,
            shadows: vec![],
            inner: vec![inner(12., 4., 6., -4.)],
            exact_coverage: true,
        },
        Cell {
            name: "drop-multiple",
            layer_opacity: 1.,
            rotation: 0.,
            stroke: false,
            shadows: vec![outer(12., 4., 8., 0.), outer(12., 4., 8., 0.)],
            inner: vec![],
            exact_coverage: true,
        },
        Cell {
            name: "group-opacity",
            layer_opacity: 0.5,
            rotation: 0.,
            stroke: false,
            shadows: vec![outer(12., 4., 8., 0.)],
            inner: vec![],
            exact_coverage: true,
        },
        Cell {
            name: "drop-rotated37",
            layer_opacity: 1.,
            rotation: 37.,
            stroke: false,
            shadows: vec![outer(12., 6., 10., 0.)],
            inner: vec![],
            exact_coverage: false,
        },
        Cell {
            name: "stroke-only-shadow",
            layer_opacity: 1.,
            rotation: 0.,
            stroke: true,
            shadows: vec![outer(8., 4., 8., 0.)],
            inner: vec![],
            exact_coverage: true,
        },
        Cell {
            name: "drop-colored",
            layer_opacity: 1.,
            rotation: 0.,
            stroke: false,
            shadows: vec![shadow("shadow", 12., 4., 8., 0., [1., 0., 0.], PROBE_ALPHA)],
            inner: vec![],
            exact_coverage: true,
        },
        Cell {
            name: "drop-wide64",
            layer_opacity: 1.,
            rotation: 0.,
            stroke: false,
            shadows: vec![outer(64., 0., 10., 0.)],
            inner: vec![],
            exact_coverage: true,
        },
    ]
}

fn layer_json(cell: &Cell) -> Value {
    let fills = if cell.stroke {
        json!([])
    } else {
        json!([{"_class": "fill", "isEnabled": true, "fillType": 0, "color": color(0.2, 0.4, 0.6, 1.)}])
    };
    let borders = if cell.stroke {
        json!([{"_class": "border", "isEnabled": true, "fillType": 0, "thickness": 8, "position": 0,
            "color": color(0.2, 0.4, 0.6, 1.),
            "contextSettings": {"_class": "graphicsContextSettings", "blendMode": 0, "opacity": 1}}])
    } else {
        json!([])
    };
    json!({
        "_class": "rectangle",
        "do_objectID": "shape",
        "name": "Shape",
        "rotation": cell.rotation,
        "frame": {"_class": "rect", "x": 40, "y": 48, "width": 96, "height": 64},
        "style": {
            "_class": "style",
            "contextSettings": {"_class": "graphicsContextSettings", "opacity": cell.layer_opacity, "blendMode": 0},
            "fills": fills,
            "borders": borders,
            "shadows": cell.shadows,
            "innerShadows": cell.inner
        }
    })
}

fn import_cell(cell: &Cell) -> Document {
    import_sketch_report(&png_archive(json!([layer_json(cell)])))
        .unwrap_or_else(|e| panic!("{} import {e}", cell.name))
        .document
}

fn render(doc: &Document, profile: RasterProfile) -> Result<Vec<u8>, String> {
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(doc).unwrap())?;
    let pixels = engine.render(&RenderOptions {
        page_id: doc.pages[0].id.clone(),
        width: W as u32,
        height: W as u32,
        view: View {
            x: 0.,
            y: 0.,
            zoom: ZOOM,
        },
        transparent: false,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: profile,
        interactive_effects: false,
        checkerboard: false,
    })?;
    let ledger = engine.compositing_ledger();
    if ledger.budget_rejections != 0 {
        return Err(format!(
            "budget rejections {} peak {} last {:?}",
            ledger.budget_rejections, ledger.scene_peak_bytes, ledger.last_rejection
        ));
    }
    Ok(pixels)
}

fn shape<'a>(doc: &'a Document) -> &'a futureox_design_kernel::scene::Node {
    doc.nodes
        .values()
        .find(|n| n.name == "Shape")
        .expect("shape")
}

fn blur_alpha(src: &[f32], sigma: f64) -> Vec<f32> {
    if sigma <= 0.05 {
        return src.to_vec();
    }
    let radius = (3. * sigma).ceil() as i32;
    let mut kernel = vec![0f32; (radius * 2 + 1) as usize];
    let mut mass = 0f32;
    for i in -radius..=radius {
        let t = i as f64 / sigma;
        let weight = (-0.5 * t * t).exp() as f32;
        kernel[(i + radius) as usize] = weight;
        mass += weight;
    }
    for weight in &mut kernel {
        *weight /= mass;
    }
    let mut horizontal = vec![0f32; W * W];
    for y in 0..W {
        for x in 0..W {
            let mut acc = 0f32;
            for i in -radius..=radius {
                let sx = x as i32 + i;
                if (0..W as i32).contains(&sx) {
                    acc += src[y * W + sx as usize] * kernel[(i + radius) as usize];
                }
            }
            horizontal[y * W + x] = acc;
        }
    }
    let mut out = vec![0f32; W * W];
    for y in 0..W {
        for x in 0..W {
            let mut acc = 0f32;
            for i in -radius..=radius {
                let sy = y as i32 + i;
                if (0..W as i32).contains(&sy) {
                    acc += horizontal[sy as usize * W + x] * kernel[(i + radius) as usize];
                }
            }
            out[y * W + x] = acc;
        }
    }
    out
}

fn morphology(src: &[f32], radius: i32, dilate: bool) -> Vec<f32> {
    if radius <= 0 {
        return src.to_vec();
    }
    let mut horizontal = vec![0f32; W * W];
    for y in 0..W as i32 {
        for x in 0..W as i32 {
            let mut v = if dilate { 0f32 } else { 1. };
            for xx in (x - radius).max(0)..=(x + radius).min(W as i32 - 1) {
                let s = src[y as usize * W + xx as usize];
                v = if dilate { v.max(s) } else { v.min(s) };
            }
            horizontal[y as usize * W + x as usize] = v;
        }
    }
    let mut out = vec![0f32; W * W];
    for y in 0..W as i32 {
        for x in 0..W as i32 {
            let mut v = if dilate { 0f32 } else { 1. };
            for yy in (y - radius).max(0)..=(y + radius).min(W as i32 - 1) {
                let s = horizontal[yy as usize * W + x as usize];
                v = if dilate { v.max(s) } else { v.min(s) };
            }
            out[y as usize * W + x as usize] = v;
        }
    }
    out
}

struct ShadowSpec {
    radius: f64,
    ox: f64,
    oy: f64,
    spread: f64,
    rgb: [f64; 3],
    alpha: f64,
    inner: bool,
}

fn specs(cell: &Cell) -> Vec<ShadowSpec> {
    let mut out = Vec::new();
    for (part, inner) in cell
        .shadows
        .iter()
        .map(|p| (p, false))
        .chain(cell.inner.iter().map(|p| (p, true)))
    {
        let c = &part["color"];
        out.push(ShadowSpec {
            radius: part["blurRadius"].as_f64().unwrap(),
            ox: part["offsetX"].as_f64().unwrap(),
            oy: part["offsetY"].as_f64().unwrap(),
            spread: part["spread"].as_f64().unwrap(),
            rgb: [
                c["red"].as_f64().unwrap() * 255.,
                c["green"].as_f64().unwrap() * 255.,
                c["blue"].as_f64().unwrap() * 255.,
            ],
            alpha: c["alpha"].as_f64().unwrap(),
            inner,
        });
    }
    out
}

fn coverage(cell: &Cell) -> Vec<f32> {
    let mut cover = vec![0f32; W * W];
    let page = layer_transform([40., 48., 96., 64.], cell.rotation, [false, false]);
    let inverse = page.inverse().unwrap();
    for y in 0..W as i32 {
        for x in 0..W as i32 {
            let point = inverse.point(Point::new((x as f64 + 0.5) / ZOOM, (y as f64 + 0.5) / ZOOM));
            let inside = (0. ..96.).contains(&point.x) && (0. ..64.).contains(&point.y);
            let on_stroke = if cell.stroke {
                let outer = point.x >= -4. && point.x < 100. && point.y >= -4. && point.y < 68.;
                let hole = (4. ..92.).contains(&point.x) && (4. ..60.).contains(&point.y);
                outer && !hole
            } else {
                inside
            };
            if on_stroke {
                cover[y as usize * W + x as usize] = 1.;
            }
        }
    }
    cover
}

fn device_offset(cell: &Cell, spec: &ShadowSpec) -> (f64, f64) {
    let page = layer_transform([40., 48., 96., 64.], cell.rotation, [false, false]);
    let origin = page.point(Point::default());
    let moved = page.point(Point::new(spec.ox, spec.oy));
    ((moved.x - origin.x) * ZOOM, (moved.y - origin.y) * ZOOM)
}

fn paint_shadow(image: &mut [f64], shape: &[f32], cell: &Cell, spec: &ShadowSpec) {
    let mut alpha = shape.to_vec();
    let grow = (spec.spread * ZOOM).abs().round() as i32;
    if grow > 0 {
        let dilate = if spec.inner {
            spec.spread < 0.
        } else {
            spec.spread > 0.
        };
        alpha = morphology(&alpha, grow, dilate);
    }
    let blurred = blur_alpha(&alpha, spec.radius * ZOOM / 2.);
    let (dx, dy) = device_offset(cell, spec);
    for y in 0..W as i32 {
        for x in 0..W as i32 {
            let sx = x as f64 - dx;
            let sy = y as f64 - dy;
            let x0 = sx.floor() as i32;
            let y0 = sy.floor() as i32;
            let (u, v) = ((sx - x0 as f64) as f32, (sy - y0 as f64) as f32);
            let tap = |x: i32, y: i32| -> f32 {
                if (0..W as i32).contains(&x) && (0..W as i32).contains(&y) {
                    blurred[y as usize * W + x as usize]
                } else {
                    0.
                }
            };
            let b = tap(x0, y0) * (1. - u) * (1. - v)
                + tap(x0 + 1, y0) * u * (1. - v)
                + tap(x0, y0 + 1) * (1. - u) * v
                + tap(x0 + 1, y0 + 1) * u * v;
            let shape_a = f64::from(shape[y as usize * W + x as usize]);
            let coverage = if spec.inner {
                shape_a * (1. - f64::from(b))
            } else {
                f64::from(b)
            };
            let sa = (coverage * spec.alpha).clamp(0., 1.);
            let i = (y as usize * W + x as usize) * 4;
            let (br, bg, bb, ba) = (image[i], image[i + 1], image[i + 2], image[i + 3]);
            image[i] = spec.rgb[0] / 255. * sa + br * (1. - sa);
            image[i + 1] = spec.rgb[1] / 255. * sa + bg * (1. - sa);
            image[i + 2] = spec.rgb[2] / 255. * sa + bb * (1. - sa);
            image[i + 3] = sa + ba * (1. - sa);
        }
    }
}

fn oracle(cell: &Cell) -> Vec<u8> {
    let shape = coverage(cell);
    // Drop shadows stack under the original silhouette. The fill or stroke
    // then covers them. Inner shadows source-over that coverage.
    let mut image = vec![0f64; W * W * 4];
    for spec in specs(cell).iter().filter(|spec| !spec.inner) {
        paint_shadow(&mut image, &shape, cell, spec);
    }
    for i in 0..W * W {
        if shape[i] == 1. {
            let o = i * 4;
            image[o] = FILL[0] / 255.;
            image[o + 1] = FILL[1] / 255.;
            image[o + 2] = FILL[2] / 255.;
            image[o + 3] = 1.;
        }
    }
    for spec in specs(cell).iter().filter(|spec| spec.inner) {
        paint_shadow(&mut image, &shape, cell, spec);
    }
    let opacity = cell.layer_opacity;
    let mut bytes = vec![255u8; W * W * 4];
    for i in 0..W * W {
        let o = i * 4;
        let (r, g, b, a) = (
            image[o] * opacity,
            image[o + 1] * opacity,
            image[o + 2] * opacity,
            image[o + 3] * opacity,
        );
        let over = |c: f64| (c + 1. * (1. - a)).clamp(0., 1.);
        bytes[o] = (over(r) * 255.).round() as u8;
        bytes[o + 1] = (over(g) * 255.).round() as u8;
        bytes[o + 2] = (over(b) * 255.).round() as u8;
        bytes[o + 3] = 255;
    }
    bytes
}

fn score(actual: &[u8], expected: &[u8]) -> (f64, f64, i32) {
    let mut bad = 0usize;
    let mut sum = 0f64;
    let mut max = 0i32;
    let n = actual.len() / 4;
    for i in 0..n {
        let mut pixel_max = 0i32;
        for c in 0..3 {
            let d = (actual[i * 4 + c] as i32 - expected[i * 4 + c] as i32).abs();
            pixel_max = pixel_max.max(d);
            sum += d as f64;
        }
        max = max.max(pixel_max);
        if pixel_max > 16 {
            bad += 1;
        }
    }
    (bad as f64 / n as f64 * 100., sum / (n * 3) as f64, max)
}

fn exported_rotation(doc: &Document) -> Option<f64> {
    let files = read_zip_public(&export_sketch(doc).unwrap()).unwrap();
    let page: Value = serde_json::from_slice(
        files
            .iter()
            .find(|(name, _)| name.starts_with("pages/"))
            .unwrap()
            .1,
    )
    .unwrap();
    page["layers"][0]["rotation"].as_f64()
}

fn exported_classes(doc: &Document) -> String {
    let files = read_zip_public(&export_sketch(doc).unwrap()).unwrap();
    let page: Value = serde_json::from_slice(
        files
            .iter()
            .find(|(name, _)| name.starts_with("pages/"))
            .unwrap()
            .1,
    )
    .unwrap();
    let style = &page["layers"][0]["style"];
    let class_of = |key: &str| {
        style[key]
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .map(|part| part["_class"].as_str().unwrap_or("?").to_string())
            .collect::<Vec<_>>()
            .join(",")
    };
    format!(
        "shadows=[{}] inner=[{}]",
        class_of("shadows"),
        class_of("innerShadows")
    )
}

fn region(
    doc: &Document,
    scale: f64,
    profile: RasterProfile,
) -> Result<(u128, usize, u32), String> {
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(doc).unwrap())?;
    let started = std::time::Instant::now();
    let png = engine.render_region_png(&RegionRequest {
        page_id: doc.pages[0].id.clone(),
        bounds: ExportBounds {
            x: 0.,
            y: 0.,
            width: 256.,
            height: 256.,
        },
        scale,
        node_ids: None,
        raster_profile: Some(profile),
        color_output: None,
    })?;
    let ms = started.elapsed().as_millis();
    if &png[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("region export was not a png".into());
    }
    let ledger = engine.compositing_ledger();
    Ok((ms, ledger.scene_peak_bytes, ledger.budget_rejections))
}

#[test]
fn measure_issue_177_cpu_against_independent_gaussian() {
    println!("ENV linux-cpu sketch_cli=NOT_RUN webgpu_readback=NOT_RUN electron_metal=NOT_RUN");
    println!(
        "REFERENCE zero-pad-gaussian sigma=blurRadius/2 square-spread encoded-srgb-source-over"
    );
    println!("SCREEN historical line is >16/255 on >1% of pixels; this run does not retune it");
    println!(
        "UNPUBLISHED Mac fixture bytes are not reconstructed; probe alpha={PROBE_ALPHA} fill=0.2,0.4,0.6 rect=(40,48,96,64)"
    );
    let mut exact_over = Vec::new();
    let mut exports = Vec::new();
    for cell in cells() {
        let doc = import_cell(&cell);
        let node = shape(&doc);
        let effects = node
            .effects
            .iter()
            .map(|e| {
                format!(
                    "{} r={} x={} y={} s={} a={}",
                    e.kind, e.radius, e.x, e.y, e.spread, e.opacity
                )
            })
            .collect::<Vec<_>>()
            .join(" | ");
        let exported = exported_classes(&doc);
        let rotation = exported_rotation(&doc);
        exports.push((cell.name, exported.clone(), rotation));
        println!(
            "SOURCE\t{}\topacity={}\trotation={rotation:?}\teffects={}\texport={exported}",
            cell.name,
            node.opacity,
            if effects.is_empty() {
                "none".into()
            } else {
                effects
            },
        );
        let started = std::time::Instant::now();
        match render(&doc, RasterProfile::Analytic) {
            Ok(pixels) => {
                let ms = started.elapsed().as_millis();
                let reference = oracle(&cell);
                let (over, mae, max) = score(&pixels, &reference);
                println!(
                    "METRIC\t{}\tanalytic\t{over:.4}\tmae={mae:.4}\tmax={max}\tms={ms}\texact_coverage={}",
                    cell.name, cell.exact_coverage
                );
                if cell.exact_coverage {
                    exact_over.push((cell.name, over, max));
                }
            }
            Err(error) => println!("METRIC\t{}\tanalytic\tERROR\t{error}", cell.name),
        }
    }
    let hard = import_cell(&cells().into_iter().find(|c| c.name == "drop-hard").unwrap());
    let mut managed = hard.clone();
    managed.color_management = Some(futureox_design_kernel::color::ColorSettings::default());
    let unmanaged = render(&hard, RasterProfile::Analytic).unwrap();
    let linear = render(&managed, RasterProfile::Analytic).unwrap();
    let at = |px: &[u8], x, y| {
        let i = (y * W + x) * 4;
        [px[i], px[i + 1], px[i + 2], px[i + 3]]
    };
    println!(
        "TARGET\tdrop-hard crescent unmanaged_analytic={:?} explicit_linear_management={:?} (these targets are separate)",
        at(&unmanaged, 106, 234),
        at(&linear, 106, 234)
    );
    let mut unmanaged_engine = Engine::new();
    unmanaged_engine
        .load_document(&serde_json::to_string(&hard).unwrap())
        .unwrap();
    let unmanaged_color = unmanaged_engine.render_color_png(
        &RenderOptions {
            page_id: hard.pages[0].id.clone(),
            width: 16,
            height: 16,
            view: View {
                x: 0.,
                y: 0.,
                zoom: 1.,
            },
            transparent: false,
            grid: false,
            pixel_preview: None,
            animation: None,
            raster_profile: RasterProfile::Analytic,
            interactive_effects: false,
            checkerboard: false,
        },
        Default::default(),
    );
    println!("TARGET\tunmanaged_color_png={unmanaged_color:?}");
    assert!(
        unmanaged_color
            .as_ref()
            .is_err_and(|error| error.contains("managed document")),
        "exact color PNG stays a managed target, separate from Sketch colorSpace 1"
    );
    let wide = import_cell(
        &cells()
            .into_iter()
            .find(|c| c.name == "drop-wide64")
            .unwrap(),
    );
    for scale in [1., 2., 3.] {
        let (ms, peak, rejected) = region(&wide, scale, RasterProfile::Analytic)
            .unwrap_or_else(|error| panic!("drop-wide64 scale {scale}: {error}"));
        println!(
            "EXPORT\tdrop-wide64\tscale={scale}\tms={ms}\tpeak={peak}\trejections={rejected}\tcap={}",
            256 * 1024 * 1024
        );
        assert_eq!(rejected, 0, "scale {scale} must not be budget-rejected");
        assert!(
            peak <= 256 * 1024 * 1024 && peak > 0,
            "peak {peak} left the existing 256MiB ledger"
        );
    }
    let over1: Vec<_> = exact_over
        .iter()
        .filter(|(_, over, _)| *over > 1.)
        .collect();
    println!(
        "SUMMARY\texact_cells={}\tover_1pct={}\tmax_over={:?}",
        exact_over.len(),
        over1.len(),
        exact_over
            .iter()
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
    );
    assert_eq!(
        exact_over.len(),
        16,
        "every exact-coverage cell must render"
    );
    assert!(
        over1.is_empty(),
        "independent Gaussian screen is still >16/255 on >1%: {over1:?}"
    );
    let unmanaged_crescent = at(&unmanaged, 106, 234);
    let linear_crescent = at(&linear, 106, 234);
    assert_eq!(
        unmanaged_crescent,
        [128, 128, 128, 255],
        "Sketch-compat hard shadow is encoded 50% black"
    );
    assert!(
        (i32::from(linear_crescent[0]) - 128).abs() > 20,
        "explicit linear management must stay a different target: {linear_crescent:?}"
    );
    for (name, exported, rotation) in &exports {
        if name.starts_with("inner-") {
            assert_eq!(
                exported, "shadows=[] inner=[innerShadow]",
                "{name} must export the native innerShadow class, got {exported}"
            );
            let cell = cells().into_iter().find(|cell| cell.name == *name).unwrap();
            let again = import_sketch_report(&export_sketch(&import_cell(&cell)).unwrap())
                .unwrap()
                .document;
            let effect = &shape(&again).effects[0];
            assert_eq!(effect.kind, "inner-shadow");
            assert_eq!(effect.radius, cell.inner[0]["blurRadius"].as_f64().unwrap());
            assert_eq!(effect.spread, cell.inner[0]["spread"].as_f64().unwrap());
        }
        if *name == "drop-rotated37" {
            let rotation = rotation.expect("rotated cell exports a rotation");
            assert!(
                (rotation - 37.).abs() < 1e-6,
                "rotation round-trip {rotation}"
            );
        }
        if *name == "drop-multiple" {
            assert_eq!(exported, "shadows=[shadow,shadow] inner=[]");
        }
    }
}

#[test]
fn misclassified_outer_class_is_not_an_inner_shadow_defect() {
    let bad = Cell {
        name: "negative-control-class-shadow",
        layer_opacity: 1.,
        rotation: 0.,
        stroke: false,
        shadows: vec![shadow("shadow", 0., 6., 8., 0., [0., 0., 0.], PROBE_ALPHA)],
        inner: vec![],
        exact_coverage: true,
    };
    let imported = import_cell(&bad);
    let node = shape(&imported);
    assert_eq!(node.effects.len(), 1);
    assert_eq!(node.effects[0].kind, "shadow");
    let outer = render(&imported, RasterProfile::Analytic).unwrap();
    let inner = render(
        &import_cell(
            &cells()
                .into_iter()
                .find(|cell| cell.name == "inner-hard")
                .unwrap(),
        ),
        RasterProfile::Analytic,
    )
    .unwrap();
    assert_ne!(
        outer, inner,
        "the bad _class=shadow fixture must not be scored as the inner-hard cell"
    );
}

fn coverage_supersampled(cell: &Cell, samples: i32) -> Vec<f32> {
    let mut cover = vec![0f32; W * W];
    let page = layer_transform([40., 48., 96., 64.], cell.rotation, [false, false]);
    let inverse = page.inverse().unwrap();
    let step = 1. / f64::from(samples);
    for y in 0..W as i32 {
        for x in 0..W as i32 {
            let mut hit = 0i32;
            for sy in 0..samples {
                for sx in 0..samples {
                    let px = (f64::from(x) + (f64::from(sx) + 0.5) * step) / ZOOM;
                    let py = (f64::from(y) + (f64::from(sy) + 0.5) * step) / ZOOM;
                    let point = inverse.point(Point::new(px, py));
                    if (0. ..96.).contains(&point.x) && (0. ..64.).contains(&point.y) {
                        hit += 1;
                    }
                }
            }
            cover[y as usize * W + x as usize] = hit as f32 / (samples * samples) as f32;
        }
    }
    cover
}

fn oracle_coverage(cell: &Cell, shape: &[f32]) -> Vec<u8> {
    let mut image = vec![0f64; W * W * 4];
    for spec in specs(cell).iter().filter(|spec| !spec.inner) {
        paint_shadow(&mut image, shape, cell, spec);
    }
    for i in 0..W * W {
        let cover = f64::from(shape[i]);
        if cover > 0. {
            let o = i * 4;
            let (br, bg, bb, ba) = (image[o], image[o + 1], image[o + 2], image[o + 3]);
            let sa = cover;
            image[o] = FILL[0] / 255. * sa + br * (1. - sa);
            image[o + 1] = FILL[1] / 255. * sa + bg * (1. - sa);
            image[o + 2] = FILL[2] / 255. * sa + bb * (1. - sa);
            image[o + 3] = sa + ba * (1. - sa);
        }
    }
    for spec in specs(cell).iter().filter(|spec| spec.inner) {
        paint_shadow(&mut image, shape, cell, spec);
    }
    let opacity = cell.layer_opacity;
    let mut bytes = vec![255u8; W * W * 4];
    for i in 0..W * W {
        let o = i * 4;
        let (r, g, b, a) = (
            image[o] * opacity,
            image[o + 1] * opacity,
            image[o + 2] * opacity,
            image[o + 3] * opacity,
        );
        let over = |c: f64| (c + 1. * (1. - a)).clamp(0., 1.);
        bytes[o] = (over(r) * 255.).round() as u8;
        bytes[o + 1] = (over(g) * 255.).round() as u8;
        bytes[o + 2] = (over(b) * 255.).round() as u8;
        bytes[o + 3] = 255;
    }
    bytes
}

#[test]
#[test]
fn diagnose_rotated_shadow_against_area_coverage() {
    let cell = cells()
        .into_iter()
        .find(|cell| cell.name == "drop-rotated37")
        .unwrap();
    let doc = import_cell(&cell);
    let pixels = render(&doc, RasterProfile::Analytic).unwrap();
    let binary = oracle(&cell);
    let area = oracle_coverage(&cell, &coverage_supersampled(&cell, 8));
    let (over_b, mae_b, max_b) = score(&pixels, &binary);
    let (over_a, mae_a, max_a) = score(&pixels, &area);
    println!(
        "ROTATED\tbinary\tover={over_b:.4}\tmae={mae_b:.4}\tmax={max_b}\tarea\tover={over_a:.4}\tmae={mae_a:.4}\tmax={max_a}"
    );
    // Measured after the knockout scale fix, against an 8×8 area-coverage
    // Gaussian. The previous CPU frame was max 32 and 0.0633% above 16/255.
    // The binary point oracle has no edge coverage; its max is not this gate.
    assert!(
        max_a <= 4,
        "rotated shadow left the area-coverage reference by {max_a}"
    );
    assert!(
        over_a <= 0.001,
        "rotated shadow still exceeds 16/255 on {over_a:.4}% of the frame"
    );
    let _ = (over_b, mae_b, mae_a);
}

#[test]
fn inner_shadow_edit_undo_reopen_and_scaled_export_keep_the_effect() {
    let cell = cells()
        .into_iter()
        .find(|cell| cell.name == "inner-spread-positive")
        .unwrap();
    let doc = import_cell(&cell);
    let mut editor = DocumentEditor::new(doc).unwrap();
    let id = shape(editor.document()).id.clone();
    let mut edited = editor.document().clone();
    edited.nodes.get_mut(&id).unwrap().effects[0].spread = 3.;
    editor
        .apply(
            0,
            DocumentPatch::between(editor.document(), &edited).unwrap(),
        )
        .unwrap();
    assert_eq!(shape(editor.document()).effects[0].spread, 3.);
    editor.undo().unwrap();
    assert_eq!(shape(editor.document()).effects[0].spread, 8.);
    editor.redo().unwrap();
    assert_eq!(shape(editor.document()).effects[0].spread, 3.);
    assert_eq!(shape(editor.document()).effects[0].kind, "inner-shadow");

    let directory = std::env::temp_dir().join(format!(
        "futureox-shadow-matrix-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("scene.fsc");
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let stored = futureox_design_kernel::scene_store::write(
        &path,
        "source:test",
        editor.document(),
        &[],
        &cancel,
    )
    .unwrap();
    let (reopened, _) = futureox_design_kernel::scene_store::Reader::open(&path, &stored, &cancel)
        .unwrap()
        .into_document(&cancel)
        .unwrap();
    let _ = std::fs::remove_dir_all(&directory);
    assert_eq!(shape(&reopened).effects[0].spread, 3.);
    assert_eq!(shape(&reopened).effects[0].kind, "inner-shadow");
    assert_eq!(
        exported_classes(&reopened),
        "shadows=[] inner=[innerShadow]"
    );

    let bare = import_cell(
        &cells()
            .into_iter()
            .find(|cell| cell.name == "control")
            .unwrap(),
    );
    for scale in [1., 2., 3.] {
        let (shadow_ms, shadow_peak, shadow_rejected) =
            region(&reopened, scale, RasterProfile::Analytic).unwrap();
        let (bare_ms, _, bare_rejected) = region(&bare, scale, RasterProfile::Analytic).unwrap();
        assert_eq!(shadow_rejected, 0);
        assert_eq!(bare_rejected, 0);
        assert!(shadow_peak <= 256 * 1024 * 1024);
        let shadow_png = {
            let mut engine = Engine::new();
            engine
                .load_document(&serde_json::to_string(&reopened).unwrap())
                .unwrap();
            engine
                .render_region_png(&RegionRequest {
                    page_id: reopened.pages[0].id.clone(),
                    bounds: ExportBounds {
                        x: 0.,
                        y: 0.,
                        width: 256.,
                        height: 256.,
                    },
                    scale,
                    node_ids: None,
                    raster_profile: Some(RasterProfile::Analytic),
                    color_output: None,
                })
                .unwrap()
        };
        let bare_png = {
            let mut engine = Engine::new();
            engine
                .load_document(&serde_json::to_string(&bare).unwrap())
                .unwrap();
            engine
                .render_region_png(&RegionRequest {
                    page_id: bare.pages[0].id.clone(),
                    bounds: ExportBounds {
                        x: 0.,
                        y: 0.,
                        width: 256.,
                        height: 256.,
                    },
                    scale,
                    node_ids: None,
                    raster_profile: Some(RasterProfile::Analytic),
                    color_output: None,
                })
                .unwrap()
        };
        assert_ne!(
            shadow_png, bare_png,
            "scale {scale} dropped the inner shadow"
        );
        println!(
            "LIFECYCLE\tinner-spread-positive\tscale={scale}\tshadow_ms={shadow_ms}\tbare_ms={bare_ms}\tpeak={shadow_peak}"
        );
    }
}

fn render_options(
    doc: &Document,
    width: u32,
    height: u32,
    zoom: f64,
    transparent: bool,
) -> RenderOptions {
    RenderOptions {
        page_id: doc.pages[0].id.clone(),
        width,
        height,
        view: View { x: 0., y: 0., zoom },
        transparent,
        grid: false,
        pixel_preview: None,
        animation: None,
        raster_profile: RasterProfile::Analytic,
        interactive_effects: false,
        checkerboard: false,
    }
}

fn render_unretained_view(
    doc: &Document,
    width: u32,
    height: u32,
    zoom: f64,
) -> Result<Vec<u8>, String> {
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(doc).unwrap())?;
    let pixels = engine.render_unretained(&render_options(doc, width, height, zoom, true))?;
    let ledger = engine.compositing_ledger();
    if ledger.budget_rejections != 0 {
        return Err(format!(
            "budget rejections {} peak {}",
            ledger.budget_rejections, ledger.scene_peak_bytes
        ));
    }
    Ok(pixels)
}

fn diff_summary(actual: &[u8], expected: &[u8]) -> (i32, usize, i32, usize) {
    let mut max = 0i32;
    let mut count = 0usize;
    let mut rgb_max = 0i32;
    let mut rgb_over = 0usize;
    for i in 0..actual.len() / 4 {
        let mut pixel = 0i32;
        for c in 0..4 {
            pixel = pixel.max((actual[i * 4 + c] as i32 - expected[i * 4 + c] as i32).abs());
        }
        if pixel > 0 {
            count += 1;
            max = max.max(pixel);
        }
        let over = |px: &[u8], c: usize| {
            let a = px[i * 4 + 3] as f32 / 255.;
            (px[i * 4 + c] as f32 + 255. * (1. - a)).round() as i32
        };
        let mut rgb = 0i32;
        for c in 0..3 {
            rgb = rgb.max((over(actual, c) - over(expected, c)).abs());
        }
        rgb_max = rgb_max.max(rgb);
        if rgb > 16 {
            rgb_over += 1;
        }
    }
    (max, count, rgb_max, rgb_over)
}

fn region_rgba(doc: &Document, scale: f64) -> Result<Vec<u8>, String> {
    let side = (256.0_f64 * scale).round() as u32;
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(doc).unwrap())?;
    let png = engine.render_region_png(&RegionRequest {
        page_id: doc.pages[0].id.clone(),
        bounds: ExportBounds { x: 0., y: 0., width: 256., height: 256. },
        scale,
        node_ids: None,
        raster_profile: Some(RasterProfile::Analytic),
        color_output: None,
    })?;
    let ledger = engine.compositing_ledger();
    if ledger.budget_rejections != 0 {
        return Err(format!("export rejected {}", ledger.budget_rejections));
    }
    let image = image::load_from_memory(&png).map_err(|error| error.to_string())?;
    let rgba = image.to_rgba8();
    if rgba.width() != side || rgba.height() != side {
        return Err(format!("png {}x{} expected {side}", rgba.width(), rgba.height()));
    }
    Ok(rgba.into_raw())
}

fn first_diff(actual: &[u8], expected: &[u8]) -> Option<(usize, [u8; 4], [u8; 4], i32)> {
    if actual.len() != expected.len() {
        return None;
    }
    let mut max = 0i32;
    let mut at = None;
    for i in 0..actual.len() / 4 {
        let mut pixel = 0i32;
        for c in 0..4 {
            pixel = pixel.max((actual[i * 4 + c] as i32 - expected[i * 4 + c] as i32).abs());
        }
        if pixel > max {
            max = pixel;
            at = Some((
                i,
                actual[i * 4..i * 4 + 4].try_into().unwrap(),
                expected[i * 4..i * 4 + 4].try_into().unwrap(),
                pixel,
            ));
        }
    }
    at.filter(|(_, _, _, pixel)| *pixel > 0)
}

#[test]
fn issue_177_single_tile_wide_shadow_keeps_the_viewport_alpha() {
    let cell = cells().into_iter().find(|cell| cell.name == "drop-wide64").unwrap();
    let doc = import_cell(&cell);
    let mut engine = Engine::new();
    engine.load_document(&serde_json::to_string(&doc).unwrap()).unwrap();
    let viewport = engine.render(&render_options(&doc, 256, 256, 1., true)).unwrap();
    let full = render_unretained_view(&doc, 256, 256, 1.).unwrap();
    let exported = region_rgba(&doc, 1.).unwrap();
    let (max, count, ..) = diff_summary(&exported, &viewport);
    let at = (8 * 256 + 71) * 4 + 3;
    println!("WIDE64_1X x71,y8 viewport={} unretained={} export={} differences={:?}",
        viewport[at], full[at], exported[at], diff_summary(&full, &viewport));
    assert_eq!((count, max), (0, 0), "1× single-tile PNG lost the viewport shadow's alpha");
    assert_eq!(full, exported, "the unretained viewport must use the same shadow taps");
    // Three boxes of radius 31, 31 and 32 over the sharp source rectangle
    // contribute alpha 7 at (71, -2), then the painter offsets it down by 10.
    assert_eq!(exported[at], 7);
}

/// Issue #177 CPU checks the published matrix does not already lock.
/// Tiled 1×/2×/3× PNG must match one analytic frame. Sketch reimport
/// keeps those pixels. An isolated group at opacity 0.5 matches the same
/// rectangle's layer opacity.
#[test]
fn issue_177_export_reimport_and_isolated_group_match_the_full_frame() {
    for cell in cells() {
        let doc = import_cell(&cell);
        let again = import_sketch_report(&export_sketch(&doc).unwrap())
            .unwrap_or_else(|error| panic!("{} reimport {error}", cell.name))
            .document;
        let original = render(&doc, RasterProfile::Analytic).unwrap();
        let round_trip = render(&again, RasterProfile::Analytic).unwrap();
        if let Some((index, got, want, delta)) = first_diff(&round_trip, &original) {
            let side = W as i32;
            panic!(
                "{} sketch reimport pixel ({}, {}) {got:?} != {want:?} delta {delta}",
                cell.name,
                index as i32 % side,
                index as i32 / side
            );
        }
        for scale in [1., 2., 3.] {
            let side = (256.0_f64 * scale).round() as u32;
            let reference = render_unretained_view(&doc, side, side, scale).unwrap();
            let exported = region_rgba(&doc, scale).unwrap();
            let (export_max, export_n, export_rgb, export_over) = diff_summary(&exported, &reference);
            let name = cell.name;
            println!(
                "EXPORT_FRAME\t{name}\tscale={scale}\tmax={export_max}\tn={export_n}\trgb={export_rgb}\tover16={export_over}"
            );
            assert_eq!(
                (export_max, export_over),
                (0, 0),
                "{name} scale {scale} export left the single analytic frame"
            );
        }
    }

    let shadow = shadow("shadow", 12., 4., 8., 0., [0., 0., 0.], 0.35);
    let shape = json!({
        "_class": "rectangle",
        "do_objectID": "shape",
        "name": "Shape",
        "frame": {"_class": "rect", "x": 0, "y": 0, "width": 96, "height": 64},
        "style": {
            "_class": "style",
            "contextSettings": {"_class": "graphicsContextSettings", "opacity": 1, "blendMode": 0},
            "fills": [{"_class": "fill", "isEnabled": true, "fillType": 0, "color": color(0.2, 0.4, 0.6, 1.)}],
            "borders": [],
            "shadows": [shadow.clone()],
            "innerShadows": []
        }
    });
    let group = json!({
        "_class": "group",
        "do_objectID": "group",
        "name": "Group",
        "frame": {"_class": "rect", "x": 40, "y": 48, "width": 96, "height": 64},
        "style": {
            "_class": "style",
            "contextSettings": {"_class": "graphicsContextSettings", "opacity": 0.5, "blendMode": 0},
            "fills": [], "borders": [], "shadows": [], "innerShadows": []
        },
        "layers": [shape]
    });
    let grouped = import_sketch_report(&png_archive(json!([group]))).unwrap().document;
    let mut flat = Cell {
        name: "layer-opacity-0.35",
        layer_opacity: 0.5,
        rotation: 0.,
        stroke: false,
        shadows: vec![shadow],
        inner: vec![],
        exact_coverage: true,
    };
    // The published group-opacity cell uses probe alpha 0.5. This is the
    // issue comment's isolated group: child shadow alpha 0.35, group 0.5.
    flat.shadows[0]["color"]["alpha"] = json!(0.35);
    let layered = import_cell(&flat);
    let group_px = render(&grouped, RasterProfile::Analytic).unwrap();
    let layer_px = render(&layered, RasterProfile::Analytic).unwrap();
    let (over, mae, max) = score(&group_px, &layer_px);
    println!("GROUP\tisolated-vs-layer-opacity\tover={over:.4}\tmae={mae:.4}\tmax={max}");
    let group_node = grouped.nodes.values().find(|node| node.name == "Group").unwrap();
    assert_eq!(group_node.opacity, 0.5);
    assert_eq!(group_node.blend, "normal");
    assert!(
        max == 0,
        "isolated group opacity diverged from the same rectangle layer opacity: over={over:.4}% mae={mae:.4} max={max}"
    );
}
