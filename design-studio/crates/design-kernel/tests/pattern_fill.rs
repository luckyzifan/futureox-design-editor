//! E4 pattern-fill chain: identity invariance, grid periodicity, the seam
//! half-texel guard, negative-coordinate wrapping, stagger parity, a numeric
//! cross-check against a straight-line transcription of Figma's pattern-fill
//! shader (fragment chain plus the vertex shader that fixes `_coord2`'s
//! paint space), serde defaults and document validation.
use base64::Engine as _;
use futureox_design_kernel::math::{Point, Rect, Transform};
use futureox_design_kernel::paint::{Images, Sampler};
use futureox_design_kernel::pattern_fill;
use futureox_design_kernel::pattern_fill::{PatternTile, STAGGER_HORIZONTAL, STAGGER_VERTICAL};
use futureox_design_kernel::scene::{Document, Node, Paint};

fn gradient_png(w: u32, h: u32) -> String {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut data = Vec::new();
        for y in 0..h {
            for x in 0..w {
                data.extend([
                    (x * 255 / w.max(1)) as u8,
                    (y * 255 / h.max(1)) as u8,
                    160,
                    255,
                ]);
            }
        }
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&data)
            .unwrap();
    }
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn image_node(uri: &str, tile: Option<PatternTile>, w: f64, h: f64) -> (Paint, Node) {
    let doc: Document = serde_json::from_value(serde_json::json!({
        "schemaVersion":14,"id":"0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b","name":"a",
        "pages":[{"id":"p","name":"p","children":["n"],"background":"#ffffff"}],
        "nodes":{"n":{"id":"n","kind":"rectangle","width":w,"height":h,
            "fills":[{"kind":"image","color":"#000000","image":uri,"tile":tile}]}}
    }))
    .unwrap();
    let node = doc.nodes["n"].clone();
    (node.fills[0].clone(), node)
}

fn sampler(paint: &Paint, node: &Node, images: &mut Images) -> Sampler {
    Sampler::new(
        paint,
        node,
        Transform([1., 0., 0., 1., 0., 0.]),
        Rect::new(0, 0, node.width as u32, node.height as u32),
        images,
    )
    .unwrap()
}

fn tile(mode: &str, size: [f64; 2], offset: [f64; 2]) -> PatternTile {
    PatternTile {
        mode: mode.into(),
        size,
        offset,
        alignment: [
            pattern_fill::ALIGN_START.into(),
            pattern_fill::ALIGN_START.into(),
        ],
        ..PatternTile::native()
    }
}

#[test]
fn absent_and_none_tiles_are_bit_identical() {
    let uri = gradient_png(8, 8);
    let mut images = Images::default();
    let (plain_paint, plain_node) = image_node(&uri, None, 16., 16.);
    let plain = sampler(&plain_paint, &plain_node, &mut images);
    let (none_paint, none_node) =
        image_node(&uri, Some(tile("none", [4., 4.], [3., 3.])), 16., 16.);
    let inactive = sampler(&none_paint, &none_node, &mut images);
    for y in 0..16 {
        for x in 0..16 {
            let device = Point::new(x as f64 + 0.5, y as f64 + 0.5);
            assert_eq!(inactive.at(device), plain.at(device), "at ({x},{y})");
            assert_eq!(inactive.at_rgba8(device), plain.at_rgba8(device));
        }
    }
    assert_eq!(none_paint.tile.as_ref().unwrap().mode, "none");
    // Old documents without the field deserialize to absent.
    assert_eq!(plain_paint.tile, None);
}

#[test]
fn grid_tiles_repeat_with_authored_period() {
    let uri = gradient_png(8, 8);
    let mut images = Images::default();
    let (paint, node) = image_node(&uri, Some(tile("grid", [8., 8.], [0., 0.])), 32., 32.);
    let s = sampler(&paint, &node, &mut images);
    for y in 0..32 {
        for x in 0..32 {
            let device = Point::new(x as f64 + 0.5, y as f64 + 0.5);
            let base = s.at(device);
            assert_eq!(s.at(Point::new(device.x + 8., device.y)), base, "x period");
            assert_eq!(s.at(Point::new(device.x + 16., device.y)), base);
            assert_eq!(s.at(Point::new(device.x, device.y + 8.)), base, "y period");
            assert_eq!(
                s.at_rgba8(device),
                s.at_rgba8(Point::new(device.x + 24., device.y))
            );
        }
    }
}

#[test]
fn negative_coordinates_wrap_forward() {
    // fract(g) for g < 0 must land in [0,1) the GLSL way (x - floor(x)),
    // not Rust's truncating fract: -0.5/4 = -0.125 -> phase 0.875.
    let uri = gradient_png(8, 8);
    let mut images = Images::default();
    let (paint, node) = image_node(&uri, Some(tile("grid", [4., 4.], [0., 0.])), 8., 8.);
    let s = sampler(&paint, &node, &mut images);
    assert_eq!(s.at(Point::new(-0.5, 0.5)), s.at(Point::new(3.5, 0.5)));
    assert_eq!(s.at(Point::new(0.5, -0.25)), s.at(Point::new(0.5, 3.75)));
    assert_eq!(s.at(Point::new(-4.5, 0.5)), s.at(Point::new(3.5, 0.5)));
}

#[test]
fn seam_samples_clamp_to_the_half_texel_guard() {
    // The shader's `min(g*i, j)` with i = 1 caps the phase a half texel
    // below the wrap seam (j = 1 - 0.5/texSize). Our clamp(0.5, n-0.5) in
    // texel space is the same guard: with an awkward 3.7px period the
    // pixel-centre phase at x=3.5 maps to texel 7.5676 and must be capped
    // at exactly 7.5 — the compiled grid's cell/frac split (centre at
    // coord − 0.5) shows it as cell 7, fraction 0 (0.0676 unguarded).
    let uri = gradient_png(8, 8);
    let (_, node) = image_node(&uri, Some(tile("grid", [3.7, 3.7], [0., 0.])), 32., 32.);
    let paint = &node.fills[0];
    let grid = futureox_design_kernel::paint::image_sampling_grid(
        Rect::new(0, 0, 32, 32),
        Transform([1., 0., 0., 1., 0., 0.]),
        [32., 32.],
        [8, 8],
        paint,
        None,
    )
    .unwrap();
    let index = (3 * 32 + 3) * 4;
    assert!(
        (grid[index] - 7.).abs() < 1e-6,
        "seam cell: {}",
        grid[index]
    );
    assert!(
        grid[index + 2].abs() < 1e-6,
        "seam frac: {}",
        grid[index + 2]
    );
}

#[test]
fn stagger_shifts_alternate_bands_by_half_a_tile() {
    // patternTileType 1: rows with mod(g.y,2) < 1 shift +0.5 phase, rows
    // with mod >= 1 shift +1.0 (a no-op after fract). With 4px tiles that
    // is a 2px horizontal offset on odd bands only.
    let uri = gradient_png(8, 8);
    let mut images = Images::default();
    let (grid_paint, grid_node) =
        image_node(&uri, Some(tile("grid", [4., 4.], [0., 0.])), 16., 16.);
    let grid = sampler(&grid_paint, &grid_node, &mut images);
    let (stag_paint, stag_node) = image_node(
        &uri,
        Some(tile(STAGGER_HORIZONTAL, [4., 4.], [0., 0.])),
        16.,
        16.,
    );
    let stagger = sampler(&stag_paint, &stag_node, &mut images);
    for x in 0..16 {
        let device = Point::new(x as f64 + 0.5, 0.5);
        assert_eq!(
            stagger.at(device),
            grid.at(Point::new(device.x - 2., device.y)),
            "band 0 must shift half a tile at x={x}"
        );
        let device = Point::new(x as f64 + 0.5, 4.5);
        assert_eq!(
            stagger.at(device),
            grid.at(device),
            "band 1 must be unshifted at x={x}"
        );
    }
    // patternTileType 2 mirrors the coupling: columns shift by y parity.
    let (vert_paint, vert_node) = image_node(
        &uri,
        Some(tile(STAGGER_VERTICAL, [4., 4.], [0., 0.])),
        16.,
        16.,
    );
    let vertical = sampler(&vert_paint, &vert_node, &mut images);
    for y in 0..16 {
        assert_eq!(
            vertical.at(Point::new(0.5, y as f64 + 0.5)),
            grid.at(Point::new(0.5, y as f64 + 0.5 - 2.)),
            "column 0 must shift half a tile at y={y}"
        );
        assert_eq!(
            vertical.at(Point::new(4.5, y as f64 + 0.5)),
            grid.at(Point::new(4.5, y as f64 + 0.5)),
            "column 1 must be unshifted at y={y}"
        );
    }
}

#[test]
fn offset_moves_the_pattern_origin_and_stagger_parity() {
    // offsetPixels shifts the phase; because the parity test reads the
    // offset-applied g (source order), a half-period x offset removes the
    // stagger from band 0, and a half-period y offset splits the band.
    let uri = gradient_png(8, 8);
    let mut images = Images::default();
    let (grid_paint, grid_node) =
        image_node(&uri, Some(tile("grid", [4., 4.], [0., 0.])), 16., 16.);
    let grid = sampler(&grid_paint, &grid_node, &mut images);
    let (moved_x_paint, moved_x_node) = image_node(
        &uri,
        Some(tile(STAGGER_HORIZONTAL, [4., 4.], [2., 0.])),
        16.,
        16.,
    );
    let moved_x = sampler(&moved_x_paint, &moved_x_node, &mut images);
    let (moved_y_paint, moved_y_node) = image_node(
        &uri,
        Some(tile(STAGGER_HORIZONTAL, [4., 4.], [0., 2.])),
        16.,
        16.,
    );
    let moved_y = sampler(&moved_y_paint, &moved_y_node, &mut images);
    for x in 0..16 {
        let device = Point::new(x as f64 + 0.5, 0.5);
        // x offset 2 = half period: band 0's +0.5 stagger cancels exactly.
        assert_eq!(moved_x.at(device), grid.at(device), "x={x}");
    }
    for y in 0..4 {
        let top = Point::new(1.5, y as f64 + 0.5);
        // y offset 2 = half band: g.y in [-0.5,0) has mod-2 in [1.5,2) >= 1,
        // so those rows lose the stagger while g.y in [0,0.5) keeps it. The
        // offset also translates the phase itself, so the reference grid is
        // sampled at (x - stagger, y - 2).
        let shifted = y >= 2;
        let expect = grid.at(Point::new(
            top.x - if shifted { 2. } else { 0. },
            top.y - 2.,
        ));
        assert_eq!(moved_y.at(top), expect, "y={y}");
    }
}

/// Independent straight-line transcription of the pattern-fill main(), kept in
/// the minified source's own shape (separate d/e scales, explicit f/h
/// vectors, GLSL mod/step written from their definitions). Any factoring
/// mistake in `pattern_fill::tile_uv` shows up here.
fn reference_phase(
    coord2: [f64; 2],
    tex: [f64; 2],
    fill: [f64; 2],
    offset: [f64; 2],
    bounds: [f64; 2],
    pattern_tile_type: i32,
) -> [f64; 2] {
    let d = fill[0] / tex[0];
    let e = fill[1] / tex[1];
    let f = [offset[0] / tex[0], offset[1] / tex[1]];
    let mut g = [coord2[0] * d, coord2[1] * e];
    let h = [bounds[0] / tex[0], bounds[1] / tex[1]];
    g[0] -= f[0];
    g[1] -= f[1];
    g[0] += h[0];
    g[1] += h[1];
    // step(1., mod(g, 2.))
    let step_mod = |v: f64| {
        let m = v - 2.0 * (v / 2.0).floor(); // GLSL mod(x, 2.0)
        if 1.0 <= m { 1.0 } else { 0.0 }
    };
    if pattern_tile_type == 1 {
        g[0] += (1.0 + step_mod(g[1])) * 0.5;
    } else if pattern_tile_type == 2 {
        g[1] += (1.0 + step_mod(g[0])) * 0.5;
    }
    // fract
    [g[0] - g[0].floor(), g[1] - g[1].floor()]
}

#[test]
fn ported_chain_matches_shader185_reference() {
    let points = [
        [-13.7, -0.25],
        [0.0, 0.0],
        [0.5, 5.999],
        [6.0, 6.001],
        [11.3, 24.7],
        [-7.5, 13.2],
        [3.25, 7.75],
    ];
    let sizes = [[6.0, 6.0], [4.0, 9.0]];
    let offsets = [[0.0, 0.0], [1.3, -0.7], [-2.9, 11.1]];
    let bounds = [[0.0, 0.0], [1.25, -0.75]];
    for mode in [0, 1, 2] {
        for size in sizes {
            // Our contract: size = the shader's per-axis period, i.e.
            // patternTexSize/fillSize with fillSize = 1 -> tex = size.
            for offset in offsets {
                for bound in bounds {
                    // patternBoundsOffsetPixels folds into our offset with
                    // the opposite sign (both are pre-fract translations).
                    let ours = tile(
                        if mode == 0 {
                            "grid"
                        } else if mode == 1 {
                            STAGGER_HORIZONTAL
                        } else {
                            STAGGER_VERTICAL
                        },
                        size,
                        [offset[0] - bound[0], offset[1] - bound[1]],
                    );
                    for p in points {
                        let got = futureox_design_kernel::pattern_fill::tile_uv(
                            &ours,
                            Point::new(p[0], p[1]),
                            size,
                        );
                        let want = reference_phase(p, size, [1.0, 1.0], offset, bound, mode);
                        for axis in 0..2 {
                            assert!(
                                (got_axis(&got, axis) - want[axis]).abs() <= 1e-12,
                                "mode {mode} size {size:?} offset {offset:?} bounds {bound:?} point {p:?}: got {:?} want {want:?}",
                                [got.x, got.y]
                            );
                        }
                    }
                }
            }
        }
    }
}

fn got_axis(p: &Point, axis: usize) -> f64 {
    if axis == 0 { p.x } else { p.y }
}

#[test]
fn serde_defaults_and_round_trip() {
    // `{}` deserializes to a native-size grid (FIG TILE's base mapping).
    let native: PatternTile = serde_json::from_str("{}").unwrap();
    assert_eq!(native, PatternTile::native());
    assert_eq!(native.resolve([64., 32.]), [64., 32.]);
    // Authored values survive a round trip and 0 keeps native semantics.
    let authored = tile(STAGGER_VERTICAL, [12.5, 0.], [-3., 4.]);
    let round: PatternTile =
        serde_json::from_str(&serde_json::to_string(&authored).unwrap()).unwrap();
    assert_eq!(round, authored);
    assert_eq!(round.resolve([64., 32.]), [12.5, 32.]);
    // The paint field skips serialization when absent (old documents stay
    // byte-identical).
    let uri = gradient_png(4, 4);
    let (plain, _) = image_node(&uri, None, 8., 8.);
    let value = serde_json::to_value(&plain).unwrap();
    assert!(value.get("tile").is_none());
}

#[test]
fn document_validation_gates_schema_kind_and_ranges() {
    let uri = gradient_png(4, 4);
    let build = |schema: u32, kind: &str, tile: Option<PatternTile>| {
        serde_json::from_value::<Document>(serde_json::json!({
            "schemaVersion":schema,"id":"0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b","name":"a",
            "pages":[{"id":"p","name":"p","children":["n"],"background":"#ffffff"}],
            "nodes":{"n":{"id":"n","kind":"rectangle","width":8,"height":8,
                "fills":[{"kind":kind,"color":"#000000","image":uri,"tile":tile}]}}
        }))
        .unwrap()
    };
    build(14, "image", Some(tile("grid", [8., 8.], [0., 0.])))
        .validate()
        .unwrap();
    let err = build(13, "image", Some(tile("grid", [8., 8.], [0., 0.])))
        .validate()
        .unwrap_err();
    assert!(err.contains("schema 14"), "{err}");
    let err = build(14, "solid", Some(tile("grid", [8., 8.], [0., 0.])))
        .validate()
        .unwrap_err();
    assert!(
        err.contains("Pattern tiling requires an image paint"),
        "{err}"
    );
    let err = build(14, "image", Some(tile("grid", [-8., 8.], [0., 0.])))
        .validate()
        .unwrap_err();
    assert!(err.contains("Pattern tiling"), "{err}");
    let err = build(14, "image", Some(tile("brick", [8., 8.], [0., 0.])))
        .validate()
        .unwrap_err();
    assert!(err.contains("Pattern tiling"), "{err}");
    // NaN cannot travel through JSON; inject it post-parse.
    let mut nan = build(14, "image", Some(tile("grid", [8., 8.], [0., 0.])));
    nan.nodes.get_mut("n").unwrap().fills[0]
        .tile
        .as_mut()
        .unwrap()
        .size[1] = f64::NAN;
    let err = nan.validate().unwrap_err();
    assert!(err.contains("Pattern tiling"), "{err}");
    // `mode: none` renders legacy but still needs the field's schema.
    assert!(
        build(14, "image", Some(tile("none", [8., 8.], [0., 0.])))
            .validate()
            .is_ok()
    );
    assert!(build(14, "image", None).validate().is_ok());
}

#[test]
fn pattern_works_through_export_coordinate_grids() {
    // The exported image_sampling_grid path shares ImageCoordinates, so a
    // tiled paint must compile to periodic coordinates there too.
    let uri = gradient_png(8, 8);
    let (_, node) = image_node(&uri, Some(tile("grid", [8., 8.], [0., 0.])), 32., 32.);
    let paint = &node.fills[0];
    let rect = Rect::new(0, 0, 32, 32);
    let grid = futureox_design_kernel::paint::image_sampling_grid(
        rect,
        Transform([1., 0., 0., 1., 0., 0.]),
        [32., 32.],
        [8, 8],
        paint,
        None,
    )
    .unwrap();
    for y in 0..32i32 {
        for x in 0..32i32 {
            let i = ((y * 32 + x) * 4) as usize;
            let j = ((y * 32 + ((x + 8) % 32)) * 4) as usize;
            assert!(
                (grid[i] - grid[j]).abs() < 1e-9 && (grid[i + 1] - grid[j + 1]).abs() < 1e-9,
                "grid not periodic at ({x},{y})"
            );
        }
    }
    // The compact per-axis byte field must fall back to the dense grid
    // (independent_byte_axis returns None for non-separable tiling), and
    // the fallback makes the two byte-wise identical.
    let field = futureox_design_kernel::paint::image_byte_sampling_field(
        rect,
        Transform([1., 0., 0., 1., 0., 0.]),
        [32., 32.],
        [8, 8],
        paint,
        None,
    )
    .unwrap();
    let dense = futureox_design_kernel::paint::image_byte_sampling_grid(
        rect,
        Transform([1., 0., 0., 1., 0., 0.]),
        [32., 32.],
        [8, 8],
        paint,
        None,
    )
    .unwrap();
    assert_eq!(field, dense, "compact field must equal the dense oracle");
}
