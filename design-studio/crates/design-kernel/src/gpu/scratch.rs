//! One retained allocation for the curve and vertex words of a pose.
//!
//! Compiling a pose used to grow a fresh `Vec` and free it inside the packet
//! encoder. The spare keeps that capacity on the compiling thread after the
//! encoder finishes. `take_*` clears the length, so the next pose never reads
//! the previous words. Capacity above the existing 8_000_000-float aggregate
//! ceiling (the next power-of-two word count) is not retained. A scene dropped
//! without encoding does not return its buffer; `compile_gpu_packet` does.

use std::cell::RefCell;

thread_local! {
    static CURVES: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static VERTICES: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
}

fn take(slot: &'static std::thread::LocalKey<RefCell<Vec<f32>>>) -> Vec<f32> {
    slot.with(|cell| {
        let mut values = std::mem::take(&mut *cell.borrow_mut());
        values.clear();
        values
    })
}

/// `Compiler::install_program` rejects an aggregate above 8_000_000 floats.
/// Vec growth stops at the next power of two, 8_388_608 words.
const MAX_SPARE_BYTES: usize = 8_388_608 * 4;

fn recycle(slot: &'static std::thread::LocalKey<RefCell<Vec<f32>>>, mut values: Vec<f32>) {
    if values.capacity() == 0 || values.capacity() > MAX_SPARE_BYTES {
        return;
    }
    values.clear();
    slot.with(|cell| {
        let mut spare = cell.borrow_mut();
        if values.capacity() >= spare.capacity() {
            *spare = values;
        }
    });
}

pub(crate) fn take_curves() -> Vec<f32> {
    take(&CURVES)
}
pub(crate) fn take_vertices() -> Vec<f32> {
    take(&VERTICES)
}
pub(crate) fn recycle_curves(values: Vec<f32>) {
    recycle(&CURVES, values);
}
pub(crate) fn recycle_vertices(values: Vec<f32>) {
    recycle(&VERTICES, values);
}

/// `mem::take` removes geometry from the scene before the encoder returns.
/// Dropping this guard returns that allocation, including when encoding fails.
pub(crate) struct RecycledF32 {
    values: Vec<f32>,
    curves: bool,
}
impl RecycledF32 {
    pub(crate) fn curves(values: Vec<f32>) -> Self {
        Self {
            values,
            curves: true,
        }
    }
    pub(crate) fn vertices(values: Vec<f32>) -> Self {
        Self {
            values,
            curves: false,
        }
    }
}
impl Drop for RecycledF32 {
    fn drop(&mut self) {
        let values = std::mem::take(&mut self.values);
        if self.curves {
            recycle_curves(values);
        } else {
            recycle_vertices(values);
        }
    }
}
impl std::ops::Deref for RecycledF32 {
    type Target = Vec<f32>;
    fn deref(&self) -> &Vec<f32> {
        &self.values
    }
}

#[cfg(test)]
pub(crate) fn curve_spare_capacity() -> usize {
    CURVES.with(|cell| cell.borrow().capacity())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Transform;
    use crate::renderer::{Engine, RenderOptions};
    use serde_json::json;
    use std::collections::BTreeMap;

    fn document() -> String {
        let mut nodes = serde_json::Map::new();
        let mut children = Vec::new();
        for i in 0..6 {
            let id = format!("v{i}");
            children.push(id.clone());
            nodes.insert(id.clone(), json!({
                "id": id, "kind": "vector", "width": 40, "height": 30,
                "transform": [1, 0, 0, 1, 20.0 + i as f64 * 70.0, 30.0],
                "fills": [{"kind": "solid", "color": "#3d6ea8"}],
                "network": {
                    "fillRule": "nonzero",
                    "vertices": [
                        {"id": "a", "x": 2, "y": 4}, {"id": "b", "x": 34, "y": 3},
                        {"id": "c", "x": 30, "y": 26}, {"id": "d", "x": 3, "y": 24}
                    ],
                    "edges": [
                        {"id": "ab", "from": "a", "to": "b", "c1": {"x": 8, "y": -4}, "c2": {"x": 28, "y": 12}},
                        {"id": "bc", "from": "b", "to": "c"},
                        {"id": "cd", "from": "c", "to": "d", "c1": {"x": 36, "y": 32}, "c2": {"x": 0, "y": 28}},
                        {"id": "da", "from": "d", "to": "a"}
                    ]
                }
            }));
        }
        nodes.insert(
            "board".into(),
            json!({
                "id": "board", "kind": "frame", "width": 480, "height": 220, "clip": true,
                "fills": [{"kind": "solid", "color": "#dbe8f0"}],
                "children": children
            }),
        );
        json!({
            "schemaVersion": 1, "id": "scratch", "name": "scratch",
            "pages": [{"id": "p", "name": "p", "children": ["board"], "background": "#ffffff"}],
            "nodes": nodes
        })
        .to_string()
    }

    fn options(x: f64, y: f64, zoom: f64) -> RenderOptions {
        serde_json::from_value(json!({
            "pageId": "p", "width": 240, "height": 160,
            "view": {"x": x, "y": y, "zoom": zoom},
            "rasterProfile": "figmaSubpixel"
        }))
        .unwrap()
    }

    fn packet(engine: &mut Engine, options: &RenderOptions) -> Vec<u8> {
        engine.compile_gpu(options).unwrap().into_packet().unwrap()
    }

    #[test]
    fn curve_spare_is_reused_and_poses_match_a_fresh_engine() {
        let doc = document();
        let mut fresh = Engine::new();
        fresh.load_document(&doc).unwrap();
        let mut engine = Engine::new();
        engine.load_document(&doc).unwrap();
        let base = options(16., 12., 0.8);
        let expected = packet(&mut fresh, &base);
        let first = engine.compile_gpu(&base).unwrap();
        let words = first.curves.len();
        assert!(words > 64, "fixture should publish analytic curve words");
        assert_eq!(first.into_packet().unwrap(), expected);
        let kept = curve_spare_capacity();
        assert!(
            kept >= words,
            "released curve buffer should retain its capacity, kept {kept} words {words}"
        );

        let second = engine.compile_gpu(&base).unwrap();
        assert_eq!(
            curve_spare_capacity(),
            0,
            "the live scene should hold the only spare"
        );
        assert!(second.curves.capacity() >= kept);
        assert_eq!(second.curves, fresh.compile_gpu(&base).unwrap().curves);
        assert_eq!(second.into_packet().unwrap(), expected);
        assert!(curve_spare_capacity() >= words);

        for (x, y, zoom) in [(16. - 23.5, 4.25, 0.8), (-8., 20., 1.25), (30., -6., 0.5)] {
            let view = options(x, y, zoom);
            assert_eq!(
                packet(&mut engine, &view),
                packet(&mut fresh, &view),
                "camera {x},{y} zoom {zoom}"
            );
        }
        let pose: BTreeMap<_, _> =
            [("board".to_owned(), Transform([1., 0., 0., 1., 28.4, 7.2]))].into();
        assert!(engine.apply_interaction_transforms(&pose).unwrap());
        assert!(fresh.apply_interaction_transforms(&pose).unwrap());
        assert_eq!(
            packet(&mut engine, &base),
            packet(&mut fresh, &base),
            "clipped drag pose"
        );
    }
}
