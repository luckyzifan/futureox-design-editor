//! Read-only picking against the resolved source that already supplied the pixels.
//! No file acquisition, document clone, render, or persistent picking cache.
use crate::{
    math::{Point, Transform},
    scene::{Document, Node},
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Query {
    pub document_id: String,
    pub stage_id: String,
    pub root_id: String,
    pub point: Point,
    pub zoom: f64,
    pub deep: bool,
}
type Hit<'a> = (&'a Node, Transform);

pub(super) fn pick(doc: &Document, authored: &Document, q: &Query) -> Result<Value, String> {
    if !q.point.finite()
        || !(0.001..=128.).contains(&q.zoom)
        || [&q.document_id, &q.stage_id, &q.root_id]
            .iter()
            .any(|id| id.is_empty() || id.len() > 1024)
    {
        return Err("Invalid source hit query".into());
    }
    if doc.id != q.document_id
        || !doc
            .pages
            .first()
            .is_some_and(|p| p.children.len() == 1 && p.children[0] == q.stage_id)
    {
        return Ok(Value::Null);
    }
    let Some(stage) = doc.nodes.get(&q.stage_id) else {
        return Ok(Value::Null);
    };
    if !stage.children.contains(&q.root_id) {
        return Ok(Value::Null);
    }
    let Some(root) = doc.nodes.get(&q.root_id) else {
        return Ok(Value::Null);
    };
    let camera = Transform([
        q.zoom,
        0.,
        0.,
        q.zoom,
        -q.point.x * q.zoom,
        -q.point.y * q.zoom,
    ]);
    let origin = Point::new(0., 0.);
    fn visit<'a>(
        doc: &'a Document,
        authored: &Document,
        n: &'a Node,
        parent: Transform,
        camera: Transform,
        point: Point,
        deep: bool,
        left: &mut usize,
    ) -> Result<Option<Hit<'a>>, String> {
        *left = left.checked_sub(1).ok_or("Source hit work limit")?;
        if !n.visible || n.locked {
            return Ok(None);
        }
        let world = parent.concat(n.transform);
        let device = camera.concat(world);
        if n.clip && !crate::hit_test_fill_device(n, point, device)? {
            return Ok(None);
        }
        if let Some(mask) = doc.mask_child(n) {
            if mask.opacity <= 0.
                || !crate::hit_test_fill_device(mask, point, device.concat(mask.transform))?
            {
                return Ok(None);
            }
        }
        // Rich text is painted as a group of resolved spans. The authored text
        // box remains selectable, including whitespace between glyphs.
        if authored.nodes.get(&n.id).is_some_and(|a| a.kind == "text") {
            let Ok(inv) = device.inverse() else {
                return Ok(None);
            };
            let p = inv.point(point);
            return Ok(
                (p.x >= 0. && p.y >= 0. && p.x <= n.width && p.y <= n.height).then_some((n, world)),
            );
        }
        let barrier = !deep
            && (n.kind == "group"
                || n.component.is_some()
                || n.component_set
                || n.instance.is_some()
                || n.boolean_operation.is_some());
        // Text expansion may generate paint children; the editable text owns their hit.
        if n.kind != "text" {
            for id in n.render_children().iter().rev() {
                if let Some(child) = doc.nodes.get(id) {
                    if child.mask {
                        continue;
                    }
                    if let Some(hit) =
                        visit(doc, authored, child, world, camera, point, deep, left)?
                    {
                        return Ok(Some(if barrier { (n, world) } else { hit }));
                    }
                }
            }
        }
        if n.kind == "group" {
            return Ok(None);
        }
        // Reject distant ordinary shapes without expanding their paths. Imported
        // networks, vector data, and strokes may extend outside the authored box.
        if n.network.is_none()
            && n.vector_geometry.is_none()
            && n.strokes.is_empty()
            && n.boolean_operation.is_none()
        {
            let Ok(inv) = device.inverse() else {
                return Ok(None);
            };
            let p = inv.point(point);
            if p.x < 0. || p.y < 0. || p.x > n.width || p.y > n.height {
                return Ok(None);
            }
        }
        Ok(crate::hit_test_device(n, point, device, 5.)?.then_some((n, world)))
    }
    let hit = visit(
        doc,
        authored,
        root,
        stage.transform,
        camera,
        origin,
        q.deep,
        &mut 32768,
    )?;
    Ok(match hit {
        None => json!({"hit":null}),
        Some((n, m)) => {
            let corners = [(0., 0.), (n.width, 0.), (n.width, n.height), (0., n.height)]
                .map(|(x, y)| m.point(Point::new(x, y)));
            if !corners.iter().all(|p| p.finite()) {
                return Ok(Value::Null);
            }
            json!({"hit":{"nodeId":n.id,"corners":corners}})
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> Document {
        serde_json::from_value(json!({"schemaVersion":2,"id":"doc","name":"source",
          "pages":[{"id":"page","name":"Page","children":["stage"],"background":"#ffffff"}],"nodes":{
          "stage":{"id":"stage","kind":"frame","width":300,"height":300,"children":["board"]},
          "board":{"id":"board","kind":"frame","width":120,"height":120,"clip":true,"transform":[0,1,-1,0,200,100],"children":["under","group"]},
          "under":{"id":"under","kind":"text","width":100,"height":100},
          "group":{"id":"group","kind":"group","width":40,"height":40,"transform":[1,0,0,1,10,15],"children":["label","lock"]},
          "label":{"id":"label","kind":"text","width":18,"height":10},
          "lock":{"id":"lock","kind":"text","width":40,"height":40,"locked":true}
        }})).unwrap()
    }
    #[test]
    fn source_hit_follows_paint_hierarchy_and_returns_rotated_world_geometry() {
        let mut doc = source();
        let mut q = Query {
            document_id: "doc".into(),
            stage_id: "stage".into(),
            root_id: "board".into(),
            point: Point::new(180., 115.),
            zoom: 32.,
            deep: false,
        };
        let a = pick(&doc, &doc, &q).unwrap();
        assert_eq!(a["hit"]["nodeId"], "group");
        q.deep = true;
        let original = doc.clone();
        doc.nodes.get_mut("label").unwrap().kind = "group".into();
        let b = pick(&doc, &original, &q).unwrap();
        assert_eq!(b["hit"]["nodeId"], "label");
        assert_eq!(b["hit"]["corners"][1], json!({"x":185.,"y":128.}));
        doc.nodes.get_mut("group").unwrap().visible = false;
        assert_eq!(pick(&doc, &doc, &q).unwrap()["hit"]["nodeId"], "under");
        q.point = Point::new(90., 210.);
        assert_eq!(pick(&doc, &doc, &q).unwrap()["hit"]["nodeId"], "board");
        q.point = Point::new(202., 130.);
        assert_eq!(pick(&doc, &doc, &q).unwrap(), json!({"hit":null}));
        q.root_id = "label".into();
        assert_eq!(pick(&doc, &doc, &q).unwrap(), Value::Null);
    }
}
