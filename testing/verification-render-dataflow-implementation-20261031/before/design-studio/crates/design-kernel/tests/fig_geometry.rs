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
fn coincident_blob(offset:f32)->Vec<u8>{
 let mut data=Vec::new();for word in [4u32,3,1]{data.extend(word.to_le_bytes());}
 for(x,y)in[(0f32,0f32),(4.,0.),(4.,3.),(offset,0.)]{data.extend(0u32.to_le_bytes());data.extend(x.to_le_bytes());data.extend(y.to_le_bytes());}
 for(a,b)in[(0u32,1u32),(1,2),(2,3)]{data.extend(0u32.to_le_bytes());data.extend(a.to_le_bytes());data.extend([0u8;8]);data.extend(b.to_le_bytes());data.extend([0u8;8]);}
 for word in [1u32,1,3,0,1,2]{data.extend(word.to_le_bytes());}data
}
#[test]
fn exactly_coincident_region_closure_keeps_fill_closed_and_stroke_open(){
 use futureox_design_kernel::vector_geometry::Curve;
 let decoded=decode_network(&coincident_blob(0.),2.25,3.5).unwrap();assert!(decoded.network.is_none());
 let geometry=decoded.vector_geometry.unwrap();assert_eq!(geometry.fill_rule,"nonzero");
 let open=vec![Curve::Move([0.,0.]),Curve::Line([9.,0.]),Curve::Line([9.,10.5]),Curve::Line([0.,0.])];
 let mut closed=open.clone();closed.push(Curve::Close);assert_eq!(geometry.fill,closed);assert_eq!(geometry.stroke,Some(open));
 assert_eq!(decoded.vertex_styles,vec![0;4]);assert_eq!(decoded.region_styles,vec![0]);
 // No snapping/tolerance: a nearby distinct endpoint remains an open stroke,
 // with no invented filled face or closing edge.
 let open=decode_network(&coincident_blob(1e-7),1.,1.).unwrap().network.unwrap();
 assert_eq!(open.vertices[3].x,1e-7f32 as f64);
 let(fill,stroke)=open.paths().unwrap();assert!(fill.commands.is_empty());assert!(!stroke.commands.contains(&Command::Close));
 let mut disconnected=coincident_blob(0.);let edge_start=12+4*12;disconnected[edge_start+28+4..edge_start+28+8].copy_from_slice(&2u32.to_le_bytes());
 assert!(decode_network(&disconnected,1.,1.).is_err());
}
#[test]
fn declared_fill_streams_close_subpaths_without_changing_generic_strokes(){
 use futureox_design_kernel::fig_geometry::decode_fill_commands;
 let mut bytes=Vec::new();
 for(op,point)in[(1u8,[0.125f32,-0.0]),(2,[4.,0.]),(2,[4.,3.]),(1,[10.,10.]),(2,[13.,10.]),(2,[13.,13.])]{bytes.push(op);for value in point{bytes.extend(value.to_le_bytes());}}
 let stroke=decode_commands(&bytes).unwrap();assert!(!stroke.commands.contains(&Command::Close));
 let fill=decode_fill_commands(&bytes).unwrap();assert_eq!(fill.commands.iter().filter(|c|matches!(c,Command::Close)).count(),2);
 assert_eq!(fill.commands[3],Command::Close);assert_eq!(fill.commands.last(),Some(&Command::Close));
 let source:Vec<_>=fill.commands.into_iter().filter(|c|!matches!(c,Command::Close)).collect();assert_eq!(source,stroke.commands);
 let Command::Move(point)=source[0]else{panic!()};assert_eq!(point.y.to_bits(),(-0.0f64).to_bits());
 assert!(decode_fill_commands(&bytes[..bytes.len()-1]).is_err());
}
