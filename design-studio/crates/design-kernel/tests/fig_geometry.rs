use futureox_design_kernel::{
    fig_geometry::{decode_commands, decode_network},
    math::Point,
    path::Command,
};
fn blob() -> Vec<u8> {
    let mut data = Vec::new();
    for word in [3u32, 3, 1] {
        data.extend(word.to_le_bytes());
    }
    for (x, y) in [(10.125f32, 0f32), (20.25, 0.), (20.25, 10.5)] {
        data.extend(0u32.to_le_bytes());
        data.extend(x.to_le_bytes());
        data.extend(y.to_le_bytes());
    }
    for (a, b, ta, tb) in [
        (0u32, 1u32, [0.25f32, 2f32], [-0.5f32, 3.]),
        (1, 2, [0., 0.], [0., 0.]),
        (2, 0, [0., 0.], [0., 0.]),
    ] {
        data.extend(0u32.to_le_bytes());
        data.extend(a.to_le_bytes());
        for f in ta {
            data.extend(f.to_le_bytes());
        }
        data.extend(b.to_le_bytes());
        for f in tb {
            data.extend(f.to_le_bytes());
        }
    }
    for word in [1u32, 1, 3, 0, 1, 2] {
        data.extend(word.to_le_bytes());
    }
    data
}
#[test]
fn segment_offsets_relative_tangents_scale_and_regions_share_one_decoder() {
    let decoded = decode_network(&blob(), 2., 3.).unwrap();
    let net = decoded.network.unwrap();
    assert_eq!(net.vertices[0].x, 20.25);
    assert_eq!(net.vertices[2].y, 31.5);
    assert_eq!(net.edges[0].from, "v0");
    assert_eq!(net.edges[0].to, "v1");
    assert_eq!(net.edges[0].c1, Some(Point::new(20.75, 6.)));
    assert_eq!(net.edges[0].c2, Some(Point::new(39.5, 9.)));
    assert_eq!(net.fill_rule, "nonzero");
    assert_eq!(
        net.filled_faces,
        Some(vec![vec!["e0".into(), "e1".into(), "e2".into()]])
    );
}
#[test]
fn truncated_or_forged_networks_never_publish_partial_geometry() {
    let original = blob();
    for length in 0..original.len() {
        assert!(
            decode_network(&original[..length], 1., 1.).is_err(),
            "prefix {length}"
        );
    }
    let mut count = original.clone();
    count[..4].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(decode_network(&count, 1., 1.).is_err());
    let mut endpoint = original.clone();
    endpoint[52..56].copy_from_slice(&3u32.to_le_bytes());
    assert!(decode_network(&endpoint, 1., 1.).is_err());
    assert!(decode_network(&original, f64::NAN, 1.).is_err());
}
#[test]
fn precomputed_curve_commands_keep_source_float_values_and_reject_truncation() {
    let mut bytes = vec![1u8];
    for v in [0.125f32, -0.0] {
        bytes.extend(v.to_le_bytes());
    }
    bytes.push(4);
    for v in [1.25f32, 2.5, 3.75, 4.125, 5.25, 6.5] {
        bytes.extend(v.to_le_bytes());
    }
    bytes.push(0);
    let path = decode_commands(&bytes).unwrap();
    assert_eq!(
        path.commands[1],
        Command::Cubic(
            Point::new(1.25, 2.5),
            Point::new(3.75, 4.125),
            Point::new(5.25, 6.5)
        )
    );
    let Command::Move(p) = path.commands[0] else {
        panic!()
    };
    assert_eq!(p.y.to_bits(), (-0.0f64).to_bits());
    assert!(decode_commands(&bytes[..bytes.len() - 2]).is_err());
    assert!(decode_commands(&[99]).is_err());
}
