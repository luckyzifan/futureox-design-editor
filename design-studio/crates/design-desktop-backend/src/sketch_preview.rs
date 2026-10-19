//! Shared, bounded native Session projection; never rereads a file.
use futureox_design_kernel::sketch::{Owner, Session};
use futureox_design_kernel::sketch::preview::{PreviewRequest, compile_preview};
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
            match futureox_design_kernel::sketch::preview::display_snapshot(session, selected_page) {
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
