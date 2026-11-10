//! Shared, bounded native Session projection; never rereads a file.
use futureox_design_kernel::sketch::preview::{PreviewRequest, compile_preview};
use futureox_design_kernel::sketch::{Owner, Session};
use serde::{Deserialize, Serialize};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub owner: Owner,
    pub expected_revision: u64,
    pub page_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub owner: Owner,
    pub revision: u64,
    pub page_count: usize,
    pub page_id: String,
    pub preview: Preview,
}
pub(crate) fn snapshot(session: &Session, request: &Request) -> Result<Snapshot, String> {
    session
        .assert_current(&request.owner, request.expected_revision)
        .map_err(|e| e.to_string())?;
    let preview = preview(session, &request.page_id);
    session
        .assert_current(&request.owner, request.expected_revision)
        .map_err(|e| e.to_string())?;
    Ok(Snapshot {
        owner: session.owner().clone(),
        revision: session.revision(),
        page_id: request.page_id.clone(),
        page_count: session.document().pages().len(),
        preview,
    })
}
#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Preview {
    Display {
        snapshot: Box<futureox_design_kernel::sketch::preview::DisplaySnapshot>,
        page_name: String,
        page_id: String,
    },
    Ready {
        frame_json: String,
        page_name: String,
        page_id: String,
    },
    Unavailable {
        reason: String,
    },
}
pub(crate) fn preview(session: &Session, selected_page: &str) -> Preview {
    let Some(page) = session
        .document()
        .pages()
        .iter()
        .find(|p| p.root().id() == selected_page)
    else {
        return Preview::Unavailable {
            reason: "Unknown native page".into(),
        };
    };
    let page_id = page.root().id().to_owned();
    let page_name = page
        .root()
        .fields()
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("未命名页面")
        .chars()
        .take(200)
        .collect::<String>();
    let result = (|| -> Result<String, String> {
        let frame = compile_preview(
            session,
            &PreviewRequest {
                owner: session.owner().clone(),
                expected_revision: session.revision(),
                page_id: page_id.clone(),
                width: 512,
                height: 384,
            },
        )
        .map_err(|e| e.to_string())?;
        if frame.scene.nodes.len() > 128
            || frame.scene.curves.len() > 262144
            || frame
                .scene
                .nodes
                .values()
                .map(|n| n.fills.len())
                .sum::<usize>()
                > 256
        {
            return Err("Sketch preview exceeds the bounded desktop scene budget".into());
        }
        frame.assert_current(session).map_err(|e| e.to_string())?;
        let json = serde_json::to_string(&frame).map_err(|e| e.to_string())?;
        if json.len() > 2 * 1024 * 1024 {
            return Err("Sketch preview exceeds 2 MiB".into());
        }
        Ok(json)
    })();
    match result {
        Ok(frame_json) => Preview::Ready {
            frame_json,
            page_name,
            page_id,
        },
        Err(legacy_reason) => {
            match futureox_design_kernel::sketch::preview::display_snapshot(session, selected_page)
            {
                Ok(snapshot) => {
                    let bytes = serde_json::to_vec(&snapshot)
                        .map(|b| b.len())
                        .unwrap_or(usize::MAX);
                    if bytes > 48 * 1024 * 1024 {
                        return Preview::Unavailable {
                            reason: "Sketch display resources exceed 48 MiB".into(),
                        };
                    }
                    Preview::Display {
                        snapshot: Box::new(snapshot),
                        page_name,
                        page_id,
                    }
                }
                Err(reason) => Preview::Unavailable {
                    reason: format!("{reason}; legacy projection: {legacy_reason}")
                        .chars()
                        .take(1000)
                        .collect(),
                },
            }
        }
    }
}

#[cfg(test)]
mod admission_tests {
    use super::Preview;
    use futureox_design_kernel::interop::export_sketch;
    use futureox_design_kernel::scene::Document;
    use futureox_design_kernel::sketch::{Document as SketchDocument, Session};
    use serde_json::json;

    fn basic_shapes() -> Document {
        serde_json::from_value(json!({
            "schemaVersion": 2,
            "rasterProfile": "analytic",
            "id": "doc-basic",
            "name": "选区",
            "pages": [{
                "id": "page-1",
                "name": "页面 1",
                "background": "#f5f5f5",
                "children": ["alpha", "beta"]
            }],
            "nodes": {
                "alpha": {
                    "id": "alpha", "kind": "rectangle", "name": "Alpha",
                    "transform": [1, 0, 0, 1, 20, 20], "width": 160, "height": 100, "points": 3,
                    "fills": [{"kind": "solid", "color": "#DB3344", "opacity": 1}]
                },
                "beta": {
                    "id": "beta", "kind": "ellipse", "name": "Beta",
                    "transform": [1, 0, 0, 1, 100, 70], "width": 140, "height": 100,
                    "points": 3, "innerRadius": 0.45,
                    "fills": [{"kind": "solid", "color": "#3366DD", "opacity": 0.7}]
                }
            }
        }))
        .unwrap()
    }

    #[test]
    fn desktop_preview_admits_the_product_rectangle_and_oval_export() {
        let bytes = export_sketch(&basic_shapes()).unwrap();
        let session = Session::new(
            SketchDocument::from_sketch(&bytes).unwrap(),
            "native-basic-shapes".into(),
            1,
        )
        .unwrap();
        let page_id = session.document().pages()[0].root().id();
        match super::preview(&session, page_id) {
            Preview::Unavailable { reason } => {
                panic!("native preview rejected the product export: {reason}")
            }
            Preview::Ready {
                frame_json,
                page_id: ready_page,
                ..
            } => {
                assert_eq!(ready_page, page_id);
                let frame: serde_json::Value = serde_json::from_str(&frame_json).unwrap();
                assert_eq!(frame["scene"]["nodes"].as_object().unwrap().len(), 2);
            }
            Preview::Display {
                snapshot,
                page_id: display_page,
                ..
            } => {
                assert_eq!(display_page, page_id);
                let mut names = snapshot
                    .document
                    .nodes
                    .values()
                    .map(|node| node.name.as_str())
                    .collect::<Vec<_>>();
                names.sort_unstable();
                assert_eq!(names, ["Alpha", "Beta"]);
                let beta = snapshot
                    .document
                    .nodes
                    .values()
                    .find(|node| node.name == "Beta")
                    .unwrap();
                assert_eq!(beta.fills[0].opacity, 0.7);
                assert!((beta.transform.0[4] - 100.).abs() < 1e-9);
                let encoded = serde_json::to_vec(&snapshot).unwrap();
                assert!(encoded.len() < 48 * 1024 * 1024);
            }
        }
    }
}
