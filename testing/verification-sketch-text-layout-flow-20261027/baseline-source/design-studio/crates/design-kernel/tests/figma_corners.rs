use futureox_design_kernel::{
    math::Point,
    path::{Command, Path},
};

fn parse(raw: &str) -> Path {
    let mut tokens = raw.split_whitespace();
    let mut commands = Vec::new();
    while let Some(kind) = tokens.next() {
        let mut point = || {
            Point::new(
                tokens.next().unwrap().parse().unwrap(),
                tokens.next().unwrap().parse().unwrap(),
            )
        };
        commands.push(match kind {
            "M" => Command::Move(point()),
            "L" => Command::Line(point()),
            "C" => Command::Cubic(point(), point(), point()),
            "Z" => Command::Close,
            _ => panic!("unexpected reference command {kind}"),
        });
    }
    Path { commands }
}
fn curves(path: &Path) -> Vec<[Point; 4]> {
    let mut current = Point::default();
    let mut result = Vec::new();
    for c in &path.commands {
        match *c {
            Command::Move(p) | Command::Line(p) => current = p,
            Command::Cubic(a, b, p) => {
                result.push([current, a, b, p]);
                current = p;
            }
            Command::Close => {}
            _ => panic!("non-cubic corner output"),
        }
    }
    result
}
#[test]
fn canonical_corner_model_matches_fresh_figma_flattened_controls() {
    let reference: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/figma-curves-2026-10-07.json"
    ))
    .unwrap();
    let mut worst = 0_f64;
    for row in reference["rows"].as_array().unwrap() {
        let radii = std::array::from_fn(|i| row["radii"][i].as_f64().unwrap());
        let path = Path::rectangle(
            row["width"].as_f64().unwrap(),
            row["height"].as_f64().unwrap(),
            radii,
            row["smoothing"].as_f64().unwrap(),
        );
        if row["smoothing"].as_f64().unwrap() == 0. {
            // Browser exports distinguish the zero-smoothing circular source
            // from its flattened cubic approximation (24 channel bytes in the
            // captured pair). Compare its PNG separately, preserve true arcs.
            assert_eq!(
                path.commands
                    .iter()
                    .filter(|c| matches!(c, Command::Arc { .. }))
                    .count(),
                4
            );
            continue;
        }
        let actual = curves(&path);
        let expected = curves(&parse(
            row["frames"][1]["paths"][0]["data"].as_str().unwrap(),
        ));
        assert_eq!(
            actual.len(),
            expected.len(),
            "case {} segment count",
            row["index"]
        );
        for (a, b) in actual.iter().zip(&expected) {
            for (a, b) in a.iter().zip(b) {
                let delta = (*a - *b).length();
                worst = worst.max(delta);
                // Geometry validation against finite-precision external flattening,
                // NOT a tolerance for final RGBA acceptance. Tiny-radius flattened
                // controls lose precision too; all PNG tests remain byte-exact.
                assert!(
                    delta <= 0.0002,
                    "case {}: {a:?} != {b:?}, error {delta}",
                    row["index"]
                );
            }
        }
    }
    eprintln!("Figma control-point maximum geometry error: {worst}");
}

#[test]
fn asymmetric_corners_use_adjacent_edge_budgets_not_a_global_half_size() {
    let path = Path::rectangle(96., 72., [40., 0., 0., 0.], 0.6);
    assert!(matches!(
        path.commands[0],
        Command::Move(Point { x: 0., y: 64. })
    ));
    let c = curves(&path);
    assert_eq!(c.len(), 3);
    assert_eq!(c[2][3], Point::new(64., 0.));
}
