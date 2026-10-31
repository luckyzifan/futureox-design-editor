use futureox_design_kernel::{
    math::{Rect, Transform},
    scene::Document,
    texture_replay::{self, Replay, TileOutcome},
};
use serde_json::{Value, json};

fn input() -> Value {
    json!({"schemaVersion":5,"id":"synthetic","name":"synthetic",
        "pages":[{"id":"p","name":"p","background":"#ffffff","children":["root"]}],
        "nodes":{
            "root":{"id":"root","kind":"frame","width":1400,"height":1100,"clip":true,
                "transform":[1,0,0,1,3104.25,-40.5],"children":["leaf"],
                "fills":[{"kind":"solid","color":"#ffffff"}]},
            "leaf":{"id":"leaf","kind":"rectangle","width":1001,"height":701,
                "transform":[1,0,0,1,11,7],
                "fills":[{"kind":"linear","color":"#112233","angle":45,
                    "stops":[{"offset":0,"color":"#123456"},{"offset":1,"color":"#cba987"}]}],
                "effects":[{"kind":"texture","radius":2,"amount":0,"opacity":1,"color":"#000000",
                    "texture":{"noiseSize":[11,17],"clipToShape":true}}]}}})
}
fn get(value: Value, shift: [f64; 2]) -> Result<Option<Replay>, String> {
    let doc: Document = serde_json::from_value(value).unwrap();
    let root = &doc.nodes["root"];
    let leaf = &doc.nodes["leaf"];
    let camera = Transform([
        0.75,
        0.,
        0.,
        0.75,
        -root.transform.0[4] * 0.75 + 13.25 + shift[0],
        -root.transform.0[5] * 0.75 + 9.5 + shift[1],
    ]);
    let matrix = camera.concat(root.transform).concat(leaf.transform);
    texture_replay::recipe(&doc, leaf, matrix, &leaf.effects[0])
}

#[test]
fn structural_eligibility_accepts_only_the_supported_source_graph() {
    for angle in [0., 45.] {
        for clipped in [false, true] {
            let mut v = input();
            v["nodes"]["leaf"]["fills"][0]["angle"] = json!(angle);
            v["nodes"]["leaf"]["effects"][0]["texture"]["clipToShape"] = json!(clipped);
            assert!(get(v, [0.; 2]).unwrap().is_some());
        }
    }
    // The two exact normalized axes are now supported; general affine
    // transforms below must still reject the capture shortcut.
    for (matrix, angle) in [([1.,0.,0.,1.,0.,0.],0.),([0.,1.,-1.,0.,1.,0.],90.)] {
        let mut v=input(); v["nodes"]["leaf"]["fills"][0]["transform"]=json!(matrix);
        let replay=get(v,[0.;2]).unwrap().expect("canonical paint matrix");
        assert_eq!(replay.paint.angle,angle);
        assert!(replay.paint.transform.is_none());
    }
    let mut solid = input();
    solid["nodes"]["leaf"]["fills"] = json!([{"kind":"solid","color":"#2468ac"}]);
    assert!(get(solid, [0.; 2]).unwrap().is_some());
    let mut constant = input();
    constant["nodes"]["leaf"]["fills"][0]["stops"][1]["color"] = json!("#123456");
    let unchanged = constant.clone();
    let replay = get(constant, [0.; 2]).unwrap().unwrap();
    assert_eq!(replay.paint.kind, "solid");
    assert_eq!(replay.paint.color, "#123456");
    assert!(replay.paint.stops.is_empty());
    assert_eq!(unchanged["nodes"]["leaf"]["fills"][0]["kind"], "linear");
    for (path, value) in [
        ("/nodes/leaf/opacity", json!(0.5)),
        ("/nodes/leaf/radii", json!([1, 1, 1, 1])),
        ("/nodes/leaf/fills/0/opacity", json!(0.5)),
        ("/nodes/leaf/fills/0/angle", json!(30)),
        ("/nodes/leaf/fills/0/transform", json!([1, 0.125, 0, 1, 0, 0])),
        ("/nodes/root/kind", json!("group")),
        ("/nodes/root/clip", json!(false)),
        ("/nodes/root/opacity", json!(0.9)),
        ("/nodes/root/transform", json!([2, 0, 0, 2, 0, 0])),
    ] {
        let mut v = input();
        let keys: Vec<_> = path.trim_start_matches('/').split('/').collect();
        let mut place = &mut v;
        for key in &keys[..keys.len() - 1] {
            place = if place.is_array() {
                &mut place[key.parse::<usize>().unwrap()]
            } else {
                &mut place[*key]
            };
        }
        place[keys[keys.len() - 1]] = value;
        assert!(get(v, [0.; 2]).unwrap().is_none(), "{path}");
    }
    let mut v = input();
    let effect = v["nodes"]["leaf"]["effects"][0].clone();
    v["nodes"]["leaf"]["effects"]
        .as_array_mut()
        .unwrap()
        .push(effect);
    assert!(get(v, [0.; 2]).unwrap().is_none());
    let mut v = input();
    v["nodes"]["root"]["children"] = json!(["leaf", "later"]);
    v["nodes"]["later"] = json!({"id":"later","kind":"rectangle","width":1,"height":1});
    assert!(get(v, [0.; 2]).unwrap().is_none());
    let mut v = input();
    v["pages"][0]["children"] = json!(["outer"]);
    v["nodes"]["outer"] =
        json!({"id":"outer","kind":"frame","width":1600,"height":1200,"children":["root"]});
    assert!(get(v, [0.; 2]).unwrap().is_none());
}

#[test]
fn cropped_viewport_preserves_canonical_capture_and_local_dither() {
    let full = get(input(), [0.; 2]).unwrap().unwrap();
    let crop = get(input(), [-237., -187.]).unwrap().unwrap();
    let viewport = Rect::new(237, 187, 500, 350);
    let cropped_viewport = Rect::new(0, 0, 500, 350);
    let a = full.tiles(viewport).unwrap();
    let b = crop.tiles(cropped_viewport).unwrap();
    assert_eq!(a.len(), 4);
    assert_eq!(a.len(), b.len());
    for ((oa, ra), (ob, rb)) in a.into_iter().zip(b) {
        assert_eq!([oa[0] - 237, oa[1] - 187], ob);
        assert_eq!(Rect::new(ra.x - 237, ra.y - 187, ra.w, ra.h), rb);
        for aa in 0..4 {
            let TileOutcome::Capture(pa) = full.tile(oa, aa, viewport).unwrap() else {
                panic!("capture")
            };
            let TileOutcome::Capture(pb) = crop.tile(ob, aa, cropped_viewport).unwrap() else {
                panic!("capture")
            };
            assert_eq!(
                serde_json::to_value(&pa.capture).unwrap(),
                serde_json::to_value(&pb.capture).unwrap()
            );
            assert_eq!(
                serde_json::to_value(&pa.expanded).unwrap(),
                serde_json::to_value(&pb.expanded).unwrap()
            );
            let p = pa.expanded.coverage;
            assert_eq!(
                pa.expanded.at(p.x, p.y).unwrap(),
                pb.expanded.at(p.x, p.y).unwrap()
            );
        }
    }
    let origin = full.tiles(Rect::new(0, 0, 1100, 850)).unwrap()[0].0;
    let TileOutcome::Capture(p) = full.tile(origin, 0, Rect::new(0, 0, 1100, 850)).unwrap() else {
        panic!("capture")
    };
    assert!(
        (0..8).any(
            |i| p.expanded.at(10 + i, 20).unwrap()[1] != p.expanded.at(522 + i, 20).unwrap()[1]
        )
    );
}

#[test]
fn malformed_recipes_fields_and_viewports_are_errors_before_allocation() {
    let replay = get(input(), [0.; 2]).unwrap().unwrap();
    assert!(replay.tiles(Rect::new(i32::MAX, 0, u32::MAX, 1)).is_err());
    let (origin, _) = replay.tiles(Rect::new(0, 0, 1100, 850)).unwrap()[0];
    assert!(replay.tile(origin, 4, Rect::new(0, 0, 1100, 850)).is_err());
    assert!(
        replay
            .tile([origin[0] + 1, origin[1]], 0, Rect::new(0, 0, 1100, 850))
            .is_err()
    );
    let TileOutcome::Capture(mut tile) =
        replay.tile(origin, 0, Rect::new(0, 0, 1100, 850)).unwrap()
    else {
        panic!("capture")
    };
    tile.expanded.coverage = Rect::new(i32::MAX, 0, u32::MAX, 1);
    let surface = texture_replay::parameter_template().unwrap();
    assert_eq!(surface.rect, Rect::new(0, 0, 1, 1));
    assert!(tile.expanded.at(0, 0).is_err());
    assert!(tile.expanded.sampling_grid(&surface).is_err());
    let mut bad = replay.clone();
    bad.radius = f32::NAN;
    assert!(bad.validate().is_err());
    let mut bad = replay.clone();
    bad.noise_size[0] = 0.;
    assert!(bad.validate().is_err());
}

#[test]
fn activation_original_source_and_offscreen_are_distinct_outcomes() {
    let viewport = Rect::new(0, 0, 1100, 850);
    let mut replay = get(input(), [0.; 2]).unwrap().unwrap();
    let origin = replay.tiles(viewport).unwrap()[0].0;
    replay.radius = 0.;
    assert!(matches!(
        replay.tile(origin, 0, viewport).unwrap(),
        TileOutcome::Passthrough
    ));
    replay.radius = 1000.;
    let TileOutcome::Capture(tile) = replay.tile(origin, 0, viewport).unwrap() else {
        panic!("capture")
    };
    assert!(!tile.capture.use_expanded_only);
    assert_eq!(tile.original.as_ref().unwrap().side, 512);
    assert_eq!(tile.expanded.side, 1024);
    replay.clipped = false;
    let TileOutcome::Capture(tile) = replay.tile(origin, 0, viewport).unwrap() else {
        panic!("capture")
    };
    assert!(tile.capture.use_expanded_only);
    assert!(tile.original.is_none());
    assert!(
        replay
            .tiles(Rect::new(-900, -900, 10, 10))
            .unwrap()
            .is_empty()
    );
    let mut doc: Document = serde_json::from_value(input()).unwrap();
    doc.color_management = Some(Default::default());
    let leaf = &doc.nodes["leaf"];
    assert!(
        texture_replay::recipe(&doc, leaf, Transform::default(), &leaf.effects[0])
            .unwrap()
            .is_none()
    );
}

#[test]
fn tiny_and_halo_only_sources_fall_back_for_the_whole_node_in_every_crop() {
    let mut replay = get(input(), [0.; 2]).unwrap().unwrap();
    replay.parent_world_transform = Transform::default();
    replay.camera_matrix = Transform([2., 0., 0., 2., 0., 0.]);
    replay.parent_matrix = replay.camera_matrix;
    replay.parent_size = [280., 24.];
    replay.node_transform = Transform([1., 0., 0., 1., 242.01, 4.125]);
    replay.node_size = [12., 10.];
    replay.radius = 2.;
    replay.clipped = false;
    let full = Rect::new(0, 0, 560, 48);
    assert!(matches!(
        replay.tile([0, 0], 0, full).unwrap(),
        TileOutcome::Capture(_)
    ));
    assert!(matches!(
        replay.tile([512, 0], 0, full).unwrap(),
        TileOutcome::Unsupported
    ));
    assert!(!replay.supported_for_all_tiles().unwrap());
    replay.camera_matrix.0[4] -= 300.;
    replay.parent_matrix.0[4] -= 300.;
    assert!(!replay.supported_for_all_tiles().unwrap());
    replay.camera_matrix = Transform([2., 0., 0., 2., 0., 0.]);
    replay.parent_matrix = replay.camera_matrix;
    replay.parent_size = [20., 20.];
    replay.node_transform = Transform([1., 0., 0., 1., 5.125, 4.125]);
    replay.node_size = [0.05, 0.05];
    assert!(!replay.supported_for_all_tiles().unwrap());
    assert!((0..4).any(|aa| matches!(
        replay.tile([0, 0], aa, Rect::new(0, 0, 40, 40)).unwrap(),
        TileOutcome::Unsupported
    )));
}
