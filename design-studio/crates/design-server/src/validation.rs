use futureox_design_kernel::{capacity, scene::MAX_GRADIENT_STOPS};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use uuid::Uuid;

fn number(v: &Value, min: f64, max: f64) -> bool {
    v.as_f64()
        .is_some_and(|n| n.is_finite() && n >= min && n <= max)
}
fn color(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| futureox_design_kernel::color::parse(s, Default::default()).is_ok())
}

fn point(v: &Value) -> bool {
    number(&v["x"], -1e7, 1e7) && number(&v["y"], -1e7, 1e7)
}
fn blend(v: Option<&Value>, layer: bool) -> bool {
    v.is_none_or(|v| {
        v.as_str().is_some_and(|s| {
            futureox_design_kernel::blend::valid_mode(s) || (layer && s == "pass-through")
        })
    })
}
fn paint(v: &Value) -> bool {
    let image = v.get("image").filter(|v| !v.is_null()).is_none_or(|s| {
        s.as_str().is_some_and(|s| {
            let valid_prefix = [
                "data:image/png;base64,",
                "data:image/jpeg;base64,",
                "data:image/webp;base64,",
            ]
            .iter()
            .any(|p| s.starts_with(p));
            valid_prefix
                && s.len() <= 12 * 1024 * 1024
                && s.split_once(',').is_some_and(|(_, data)| {
                    data.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
                })
        })
    });
    let kind = v["kind"].as_str();
    matches!(
        kind,
        Some("solid" | "linear" | "radial" | "image" | "angular" | "diamond")
    ) && color(&v["color"])
        && blend(v.get("blend"), false)
        && number(&v["opacity"], 0., 1.)
        && number(&v["angle"], -1e7, 1e7)
        && image
        && v["stops"].as_array().is_some_and(|stops| {
            stops.len() <= MAX_GRADIENT_STOPS
                && (matches!(kind, Some("solid" | "image")) || stops.len() >= 2)
                && stops
                    .iter()
                    .all(|s| number(&s["offset"], 0., 1.) && color(&s["color"]))
        })
}
pub fn validate(doc: &Value, id: Uuid) -> Result<String, &'static str> {
    // A patch can grow a snapshot beyond the HTTP request size. Enforce the
    // complete serialized budget for both snapshot and incremental commits.
    struct Budget(usize);
    impl std::io::Write for Budget {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_sub(bytes.len())
                .ok_or_else(|| std::io::Error::other("Document exceeds the service byte budget"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Budget(capacity::document_byte_limit()), doc)
        .map_err(|_| "Document exceeds the service byte budget")?;
    validate_document(doc, id, true)
}
fn validate_document(
    doc: &Value,
    id: Uuid,
    check_components: bool,
) -> Result<String, &'static str> {
    if doc["id"].as_str().and_then(|v| v.parse::<Uuid>().ok()) != Some(id) {
        return Err("Document identity is invalid");
    }
    let name = doc["name"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= 200)
        .ok_or("Document name must contain 1–200 characters")?;
    let pages = doc["pages"].as_array().ok_or("Invalid document pages")?;
    let nodes = doc["nodes"].as_object().ok_or("Invalid document nodes")?;
    capacity::check_document_counts(nodes.len(), pages.len())
        .map_err(|_| "Document exceeds the service structure budget")?;
    let has_animations = doc.get("animations").is_some();
    let mut scene = futureox_design_kernel::scene::Document::deserialize(doc).map_err(|_| {
        if has_animations {
            "Invalid animation document"
        } else {
            "Invalid kernel document"
        }
    })?;
    scene.validate().map_err(|_| {
        if has_animations {
            "Invalid animation tracks or keyframes"
        } else {
            "Invalid kernel document contract"
        }
    })?;
    futureox_design_kernel::font::Fonts::new()
        .with_resources(&scene.fonts)
        .map_err(|_| "Invalid embedded font resources")?;
    for (key, n) in nodes {
        if Uuid::parse_str(key).is_err() || n["id"].as_str() != Some(key) {
            return Err("Invalid node identity");
        }
        let kind = n["kind"].as_str().ok_or("Missing node kind")?;
        if ![
            "slice",
            "frame",
            "section",
            "group",
            "rectangle",
            "ellipse",
            "polygon",
            "star",
            "line",
            "vector",
            "text",
        ]
        .contains(&kind)
        {
            return Err("Unknown node kind");
        }
        let t = n["transform"]
            .as_array()
            .filter(|t| t.len() == 6 && t.iter().all(|v| number(v, -1e7, 1e7)))
            .ok_or("Invalid transform")?;
        if (t[0].as_f64().unwrap() * t[3].as_f64().unwrap()
            - t[1].as_f64().unwrap() * t[2].as_f64().unwrap())
        .abs()
            < 1e-9
        {
            return Err("Singular transform");
        }
        let min_points = if matches!(kind, "polygon" | "star") {
            3.
        } else {
            0.
        };
        let min_inner_radius = if kind == "star" { 0.01 } else { 0. };
        if !number(&n["smoothing"], 0., 1.)
            || !number(&n["fontSize"], 1., 4096.)
            || !number(&n["points"], min_points, 128.)
            || !number(&n["innerRadius"], min_inner_radius, 1.)
        {
            return Err("Invalid geometry");
        }
        if !n["radii"]
            .as_array()
            .is_some_and(|rs| rs.len() == 4 && rs.iter().all(|v| number(v, 0., 1e7)))
        {
            return Err("Invalid radii");
        }
        if n["name"].as_str().is_none_or(|s| s.len() > 1000)
            || n["text"].as_str().is_none_or(|s| s.len() > 400000)
        {
            return Err("Invalid node text");
        }
        let children = n["children"].as_array().ok_or("Invalid children")?;
        if !blend(n.get("blend"), true) {
            return Err("Invalid layer blend mode");
        }
        if !(children.is_empty()
            || ["frame", "section", "group"].contains(&kind)
            || kind == "vector" && n.get("booleanOperation").is_some())
        {
            return Err("Only containers may have children");
        }
        if !n["fills"]
            .as_array()
            .is_some_and(|ps| ps.len() <= 16 && ps.iter().all(paint))
        {
            return Err("Invalid fill");
        }
        if !n["strokes"].as_array().is_some_and(|ss| {
            ss.len() <= 16
                && ss.iter().all(|s| {
                    paint(&s["paint"])
                        && number(&s["width"], 0., 10000.)
                        && s["dash"].as_str().is_some_and(|s| {
                            s.len() < 1000
                                && s.bytes()
                                    .all(|b| b.is_ascii_digit() || b" .,-".contains(&b))
                        })
                })
        }) {
            return Err("Invalid stroke");
        }
        if !n["effects"].as_array().is_some_and(|es| {
            es.len() <= 16
                && es.iter().all(|e| {
                    matches!(
                        e["kind"].as_str(),
                        Some(
                            "shadow"
                                | "inner-shadow"
                                | "blur"
                                | "background-blur"
                                | "glass"
                                | "noise"
                                | "texture"
                                | "color-controls"
                                | "gaussian-blur"
                                | "motion-blur"
                                | "zoom-blur"
                        )
                    ) && color(&e["color"])
                        && number(&e["opacity"], 0., 1.)
                        && number(&e["radius"], 0., 1000.)
                        && ["x", "y", "spread", "amount"]
                            .iter()
                            .all(|key| number(&e[key], -1e7, 1e7))
                })
        }) {
            return Err("Invalid effect");
        }
        if let Some(g) = n.get("network").filter(|v| !v.is_null()) {
            let vs = g["vertices"]
                .as_array()
                .filter(|v| v.len() <= 10000)
                .ok_or("Invalid vertices")?;
            let es = g["edges"]
                .as_array()
                .filter(|v| v.len() <= 20000)
                .ok_or("Invalid edges")?;
            let mut ids = HashSet::new();
            for v in vs {
                let id = v["id"].as_str().ok_or("Invalid vertex ID")?;
                if !point(v) || !ids.insert(id) {
                    return Err("Invalid vertex");
                }
            }
            let mut edge_ids = HashSet::new();
            for e in es {
                if !e["id"].as_str().is_some_and(|id| edge_ids.insert(id))
                    || !e["from"].as_str().is_some_and(|id| ids.contains(id))
                    || !e["to"].as_str().is_some_and(|id| ids.contains(id))
                    || !["c1", "c2"]
                        .iter()
                        .all(|key| e.get(key).filter(|v| !v.is_null()).is_none_or(point))
                {
                    return Err("Invalid edge reference");
                }
            }
        }
    }
    fn visit<'a>(
        id: &'a str,
        nodes: &'a serde_json::Map<String, Value>,
        seen: &mut HashSet<&'a str>,
        depth: usize,
    ) -> Result<(), &'static str> {
        if depth > 64 || !seen.insert(id) {
            return Err("Cyclic or duplicate node reference");
        }
        let n = nodes.get(id).ok_or("Missing node")?;
        for child in n["children"].as_array().ok_or("Invalid children")? {
            visit(
                child.as_str().ok_or("Invalid child reference")?,
                nodes,
                seen,
                depth + 1,
            )?;
        }
        Ok(())
    }
    let mut seen = HashSet::new();
    let mut page_ids = HashSet::new();
    for p in pages {
        if !p["id"]
            .as_str()
            .is_some_and(|id| Uuid::parse_str(id).is_ok() && page_ids.insert(id))
            || p["name"].as_str().is_none()
            || !color(&p["background"])
        {
            return Err("Invalid page");
        }
        for child in p["children"].as_array().ok_or("Invalid page children")? {
            visit(
                child.as_str().ok_or("Invalid page reference")?,
                nodes,
                &mut seen,
                0,
            )?;
        }
    }
    if seen.len() != nodes.len() {
        return Err("Unreachable nodes in document");
    }
    if check_components
        && nodes.values().any(|n| {
            ["component", "componentSet", "instance", "instanceOrigin"]
                .iter()
                .any(|key| n.get(key).is_some())
        })
    {
        futureox_design_kernel::components::resolve(&mut scene)
            .map_err(|_| "Component expansion failed")?;
        let resolved =
            serde_json::to_value(scene).map_err(|_| "Invalid resolved component document")?;
        validate_document(&resolved, id, false)?;
    }
    Ok(name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn empty_document_and_identity() {
        let id = Uuid::new_v4();
        let d = json!({"schemaVersion":1,"id":id,"name":"设计","pages":[{"id":Uuid::new_v4(),"name":"Page","background":"#ffffff","children":[]}],"nodes":{}});
        assert!(validate(&d, id).is_ok());
        assert!(validate(&d, Uuid::new_v4()).is_err());
    }
    #[test]
    fn material_schema_is_preserved_and_older_versions_cannot_drop_parameters() {
        let mut d: Value = serde_json::from_str(include_str!(
            "../../../../testing/fixtures/design/material-api-document.json"
        ))
        .unwrap();
        let id = Uuid::parse_str(d["id"].as_str().unwrap()).unwrap();
        assert!(validate(&d, id).is_ok());
        d["schemaVersion"] = json!(4);
        assert!(validate(&d, id).is_err());
        d["schemaVersion"] = json!(6);
        assert!(validate(&d, id).is_ok());
        d["schemaVersion"] = json!(22);
        assert!(validate(&d, id).is_err());
        d["schemaVersion"] = json!(5);
        let key = d["nodes"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        d["nodes"][&key]["effects"][0]["glass"]["dispersion"] = json!(1.5);
        assert!(validate(&d, id).is_err());
    }
    #[test]
    fn imported_geometry_and_gaussian_blur_follow_the_kernel_contract() {
        let mut d: Value = serde_json::from_str(include_str!(
            "../../../../testing/fixtures/design/material-api-document.json"
        ))
        .unwrap();
        let id = Uuid::parse_str(d["id"].as_str().unwrap()).unwrap();
        let node = d["nodes"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .next()
            .unwrap();
        node["points"] = json!(0);
        node["innerRadius"] = json!(0);
        node["fills"][0]["stops"] = json!([]);
        node["effects"] = json!([{"id":"imported","kind":"gaussian-blur","visible":true,
            "radius":12,"x":0,"y":0,"spread":0,"color":"#000000","opacity":1,"amount":0}]);
        for version in [18, 20, 21] {
            d["schemaVersion"] = json!(version);
            assert!(validate(&d, id).is_ok(), "schema {version}");
        }
        for version in [0, 17, 22] {
            d["schemaVersion"] = json!(version);
            assert!(validate(&d, id).is_err(), "schema {version}");
        }
    }
    #[test]
    fn schema8_markers_and_layer_exports_follow_native_admission() {
        let mut d: Value = serde_json::from_str(include_str!(
            "../../../../testing/fixtures/design/material-api-document.json"
        ))
        .unwrap();
        let id = Uuid::parse_str(d["id"].as_str().unwrap()).unwrap();
        let key = d["nodes"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        d["schemaVersion"] = json!(8);
        d["nodes"][&key]["exportSettings"] =
            json!([{"id":"png","format":"png","scale":2,"suffix":"@2x"}]);
        assert!(validate(&d, id).is_ok());
        d["schemaVersion"] = json!(7);
        assert!(validate(&d, id).is_err());
        d["schemaVersion"] = json!(8);
        d["nodes"][&key]["exportSettings"][0]["suffix"] = json!("/invalid");
        assert!(validate(&d, id).is_err());
    }
    #[test]
    fn schema7_native_shape_parameters_follow_the_kernel_contract() {
        let mut d: Value = serde_json::from_str(include_str!(
            "../../../../testing/fixtures/design/material-api-document.json"
        ))
        .unwrap();
        let id = Uuid::parse_str(d["id"].as_str().unwrap()).unwrap();
        let key = d["nodes"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        d["schemaVersion"] = json!(7);
        d["nodes"][&key]["kind"] = json!("ellipse");
        d["nodes"][&key]["arc"] = json!({"startAngle":0.125,"sweepAngle":3.0,"innerRadius":0.625});
        d["nodes"][&key]["constrainProportions"] = json!(true);
        assert!(validate(&d, id).is_ok());
        d["schemaVersion"] = json!(6);
        assert!(validate(&d, id).is_err());
        d["schemaVersion"] = json!(7);
        d["nodes"][&key]["arc"]["innerRadius"] = json!(1.01);
        assert!(validate(&d, id).is_err());
    }
    #[test]
    fn schema6_local_variable_modes_follow_the_kernel_contract() {
        let mut d: Value = serde_json::from_str(include_str!(
            "../../../../testing/fixtures/design/material-api-document.json"
        ))
        .unwrap();
        let id = Uuid::parse_str(d["id"].as_str().unwrap()).unwrap();
        let key = d["nodes"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        d["schemaVersion"] = json!(6);
        d["designSystem"] = json!({
            "collections": {"theme": {"name": "Theme", "modes": ["light", "dark"], "defaultMode": "light"}},
            "variables": {}, "styles": {}
        });
        d["nodes"][&key]["variableModes"] = json!({"theme": "dark"});
        assert!(validate(&d, id).is_ok());
        let scene: futureox_design_kernel::scene::Document =
            serde_json::from_value(d.clone()).unwrap();
        assert_eq!(
            scene.nodes[&key]
                .variable_modes
                .get("theme")
                .map(String::as_str),
            Some("dark")
        );
        for version in 6..=21 {
            d["schemaVersion"] = json!(version);
            assert!(validate(&d, id).is_ok(), "schema {version}");
        }
        for version in [4, 5, 22] {
            d["schemaVersion"] = json!(version);
            assert!(validate(&d, id).is_err(), "schema {version}");
        }
        d["schemaVersion"] = json!(6);
        d["nodes"][&key]["variableModes"] = json!({"theme": "missing"});
        assert!(validate(&d, id).is_err());
        assert!(validate(&d, Uuid::new_v4()).is_err());
    }

    #[test]
    fn rejects_external_image_paints() {
        let p = json!({"kind":"image","color":"#ffffff","opacity":1,"angle":0,"stops":[{"offset":0,"color":"#ffffff"},{"offset":1,"color":"#000000"}],"image":"https://example.com/a.png"});
        assert!(!paint(&p));
    }
    #[test]
    fn null_optional_image_is_equivalent_to_missing_image() {
        let mut value = json!({"kind":"solid","color":"#ffffff","opacity":1,"angle":0,"stops":[{"offset":0,"color":"#ffffff"},{"offset":1,"color":"#000000"}]});
        assert!(paint(&value));
        value["image"] = Value::Null;
        assert!(paint(&value));
        value["image"] = json!("https://example.com/image.png");
        assert!(!paint(&value));
    }
    #[test]
    fn missing_graph_references_rejected() {
        let id = Uuid::new_v4();
        let d = json!({"schemaVersion":1,"id":id,"name":"设计","pages":[{"id":Uuid::new_v4(),"name":"Page","background":"#ffffff","children":[Uuid::new_v4()]}],"nodes":{}});
        assert!(validate(&d, id).is_err());
    }
    #[test]
    fn animation_payloads_are_validated_before_storage() {
        let id = Uuid::new_v4();
        let page = Uuid::new_v4();
        let mut d = json!({"schemaVersion":1,"id":id,"name":"animation","pages":[{"id":page,"name":"Page","background":"#ffffff","children":[]}],"nodes":{},"animations":[]});
        assert!(validate(&d, id).is_ok());
        d["animations"] = json!([{"id":"clip","name":"invalid","pageId":page,"durationMs":1000,"tracks":[{"nodeId":"outside-document","keyframes":[]}]}]);
        assert_eq!(
            validate(&d, id),
            Err("Invalid animation tracks or keyframes")
        );
        d["animations"] = json!("not-a-clip-array");
        assert_eq!(validate(&d, id), Err("Invalid animation document"));
    }
}
