//! Process-scoped native sessions; source paths never confer a durable write grant.
use crate::sketch_file::{InspectRequest, load_session};
use futureox_design_kernel::sketch::{CommandEnvelope, Layer, Owner, Session, SketchCommand};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Default)]
pub(crate) struct Sessions(Mutex<Option<OpenSession>>, Mutex<Option<Status>>);
struct OpenSession {
    session: Session,
    _source_path: PathBuf,
    saved_revision: u64,
    saved_as: bool,
    save_uncertain: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub owner: Owner,
    pub active: bool,
    pub revision: u64,
    pub dirty: bool,
    pub saved_revision: u64,
    pub save_uncertain: bool,
    pub undo_count: usize,
    pub redo_count: usize,
    pub layers: Vec<LayerSummary>,
    pub layers_truncated: bool,
    pub persistence: &'static str,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Rename {
    pub owner: Owner,
    pub expected_revision: u64,
    pub request_id: String,
    pub layer_id: String,
    pub name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResizeLegacyContainer {
    pub owner: Owner,
    pub expected_revision: u64,
    pub request_id: String,
    pub layer_id: String,
    pub width: f64,
    pub height: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SetTextOverride {
    pub owner: Owner,
    pub expected_revision: u64,
    pub request_id: String,
    pub instance_id: String,
    /// Native layer identities joined by '/', never a filesystem path.
    pub target_path: String,
    pub text: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Close {
    pub owner: Owner,
    pub expected_revision: u64,
    pub discard: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LayerSummary {
    pub id: String,
    pub name: String,
    pub page_id: String,
    pub depth: usize,
}
fn status(open: &OpenSession) -> Status {
    let s = &open.session;
    fn visit(
        layer: &Layer,
        page: &str,
        depth: usize,
        layers: &mut Vec<LayerSummary>,
        truncated: &mut bool,
    ) {
        if layers.len() >= 512 {
            *truncated = true;
            return;
        }
        layers.push(LayerSummary {
            id: layer.id().into(),
            name: layer
                .fields()
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .chars()
                .take(120)
                .collect(),
            page_id: page.into(),
            depth,
        });
        for child in layer.children() {
            visit(child, page, depth + 1, layers, truncated);
        }
    }
    let mut layers = Vec::new();
    let mut truncated = false;
    for page in s.document().pages() {
        visit(
            page.root(),
            page.root().id(),
            0,
            &mut layers,
            &mut truncated,
        );
    }
    let history = s.history_status();
    Status {
        owner: s.owner().clone(),
        active: true,
        revision: s.revision(),
        saved_revision: open.saved_revision,
        dirty: s.revision() != open.saved_revision || open.save_uncertain,
        save_uncertain: open.save_uncertain,
        undo_count: history.undo_count,
        redo_count: history.redo_count,
        layers,
        layers_truncated: truncated,
        persistence: if open.saved_as && !open.save_uncertain && s.revision() == open.saved_revision
        {
            "native-file-saved"
        } else {
            "memory-only-unsaved"
        },
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct History {
    pub owner: Owner,
    pub expected_revision: u64,
    pub request_id: String,
}
fn cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("Sketch operation cancelled before commit".into())
    } else {
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Identity {
    pub owner: Owner,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveAs {
    pub owner: Owner,
    pub expected_revision: u64,
    pub path: PathBuf,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Saved {
    #[serde(flatten)]
    pub status: Status,
    pub save_warning: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LeafFrameQuery {
    pub owner: Owner,
    pub expected_revision: u64,
    pub layer_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SetLeafFrame {
    pub owner: Owner,
    pub expected_revision: u64,
    pub request_id: String,
    pub layer_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Serialize)]
pub(crate) struct FrameValues {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LeafFrameStatus {
    pub owner: Owner,
    pub revision: u64,
    pub layer_id: String,
    pub frame: Option<FrameValues>,
    pub reason: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextTargetsQuery {
    pub owner: Owner,
    pub expected_revision: u64,
    pub instance_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextValueQuery {
    pub owner: Owner,
    pub expected_revision: u64,
    pub instance_id: String,
    pub target_path: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextTargetsStatus {
    pub owner: Owner,
    pub revision: u64,
    pub instance_id: String,
    pub targets: Vec<futureox_design_kernel::sketch::TextOverrideTarget>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextValueStatus {
    pub owner: Owner,
    pub revision: u64,
    pub instance_id: String,
    pub target_path: String,
    #[serde(flatten)]
    pub value: futureox_design_kernel::sketch::TextOverrideValue,
}
impl Sessions {
    pub fn text_targets(&self, request: TextTargetsQuery) -> Result<TextTargetsStatus, String> {
        self.with_snapshot(&request.owner, request.expected_revision, |session| {
            if request.instance_id.is_empty()
                || request.instance_id.len() > 128
                || request.instance_id.chars().any(char::is_control)
            {
                return Err("Invalid native instance identity".into());
            }
            let targets = session
                .document()
                .text_override_targets(&request.instance_id)
                .map_err(|e| e.to_string())?;
            Ok(TextTargetsStatus {
                owner: session.owner().clone(),
                revision: session.revision(),
                instance_id: request.instance_id.clone(),
                targets,
            })
        })
    }
    pub fn text_value(&self, request: TextValueQuery) -> Result<TextValueStatus, String> {
        self.with_snapshot(&request.owner, request.expected_revision, |session| {
            if request.instance_id.is_empty()
                || request.instance_id.len() > 128
                || request.instance_id.chars().any(char::is_control)
            {
                return Err("Invalid native instance identity".into());
            }
            if request.target_path.len() > 64 * 129 - 1 {
                return Err("Native target path exceeds IPC limit".into());
            }
            let value = session
                .document()
                .text_override_value(&request.instance_id, &request.target_path)
                .map_err(|e| e.to_string())?;
            Ok(TextValueStatus {
                owner: session.owner().clone(),
                revision: session.revision(),
                instance_id: request.instance_id.clone(),
                target_path: request.target_path.clone(),
                value,
            })
        })
    }

    pub fn with_snapshot<T>(
        &self,
        owner: &Owner,
        revision: u64,
        project: impl FnOnce(&Session) -> Result<T, String>,
    ) -> Result<T, String> {
        let slot = self.0.lock().map_err(|_| "Sketch session unavailable")?;
        let open = slot.as_ref().ok_or("No active Sketch session")?;
        open.session
            .assert_current(owner, revision)
            .map_err(|e| e.to_string())?;
        project(&open.session)
    }
    pub fn leaf_frame(&self, request: LeafFrameQuery) -> Result<LeafFrameStatus, String> {
        self.with_snapshot(&request.owner, request.expected_revision, |session| {
            let (frame, reason) = match session.document().editable_leaf_frame(&request.layer_id) {
                Ok(f) => (
                    Some(FrameValues {
                        x: f.x,
                        y: f.y,
                        width: f.width,
                        height: f.height,
                    }),
                    None,
                ),
                Err(error) => (None, Some(error.to_string().chars().take(1000).collect())),
            };
            Ok(LeafFrameStatus {
                owner: session.owner().clone(),
                revision: session.revision(),
                layer_id: request.layer_id.clone(),
                frame,
                reason,
            })
        })
    }
    pub fn set_leaf_frame(
        &self,
        request: SetLeafFrame,
        cancel: &AtomicBool,
    ) -> Result<Status, String> {
        let mut slot = self.0.lock().map_err(|_| "Sketch session unavailable")?;
        let open = slot.as_mut().ok_or("No active Sketch session")?;
        if request.expected_revision >= 9_007_199_254_740_991 || request.layer_id.len() > 128 {
            return Err("Frame request exceeds IPC limits".into());
        }
        cancelled(cancel)?;
        open.session
            .apply(CommandEnvelope {
                owner: request.owner,
                expected_revision: request.expected_revision,
                request_id: request.request_id,
                command: SketchCommand::SetLeafFrame {
                    layer_id: request.layer_id,
                    x: request.x,
                    y: request.y,
                    width: request.width,
                    height: request.height,
                },
            })
            .map_err(|e| e.to_string())?;
        Ok(status(open))
    }
    pub fn status(&self, request: Identity) -> Result<Status, String> {
        let slot = self.0.lock().map_err(|_| "Sketch session unavailable")?;
        if let Some(open) = slot.as_ref()
            && open.session.owner() == &request.owner
        {
            return Ok(status(open));
        }
        let closed = self.1.lock().map_err(|_| "Sketch session unavailable")?;
        if let Some(closed) = closed.as_ref().filter(|s| s.owner == request.owner) {
            return Ok(closed.clone());
        }
        Err("Unknown Sketch session owner; outcome cannot be inferred".into())
    }

    pub fn open(&self, request: InspectRequest, cancel: &AtomicBool) -> Result<Status, String> {
        let mut slot = self.0.lock().map_err(|_| "Sketch session unavailable")?;
        if slot.is_some() {
            return Err(
                "Close the existing Sketch session explicitly before opening another".into(),
            );
        }
        let path = request.path.clone();
        let session = load_session(request, cancel)?;
        cancelled(cancel)?;
        let open = OpenSession {
            session,
            _source_path: path,
            saved_revision: 0,
            saved_as: false,
            save_uncertain: false,
        };
        let result = status(&open);
        *slot = Some(open);
        Ok(result)
    }
    pub fn rename(&self, request: Rename, cancel: &AtomicBool) -> Result<Status, String> {
        let mut slot = self.0.lock().map_err(|_| "Sketch session unavailable")?;
        let open = slot.as_mut().ok_or("No active Sketch session")?;
        let s = &mut open.session;
        if request.expected_revision >= 9_007_199_254_740_991 {
            return Err("Revision exceeds IPC integer range".into());
        }
        if request.name.len() > 4096 || request.layer_id.len() > 128 {
            return Err("Rename exceeds IPC limits".into());
        }
        cancelled(cancel)?;
        s.apply(CommandEnvelope {
            owner: request.owner,
            expected_revision: request.expected_revision,
            request_id: request.request_id,
            command: SketchCommand::RenameLayer {
                layer_id: request.layer_id,
                name: request.name,
            },
        })
        .map_err(|e| e.to_string())?;
        // Commit is the cancellation boundary. Never report cancellation after mutation.
        Ok(status(open))
    }
    pub fn resize_legacy_container(
        &self,
        request: ResizeLegacyContainer,
        cancel: &AtomicBool,
    ) -> Result<Status, String> {
        let mut slot = self.0.lock().map_err(|_| "Sketch session unavailable")?;
        let open = slot.as_mut().ok_or("No active Sketch session")?;
        if request.expected_revision >= 9_007_199_254_740_991
            || request.layer_id.is_empty()
            || request.layer_id.len() > 128
            || request.layer_id.chars().any(char::is_control)
            || [request.width, request.height]
                .iter()
                .any(|v| !v.is_finite() || *v < 0.5 || *v > 1e9)
        {
            return Err("Invalid native legacy container resize".into());
        }
        cancelled(cancel)?;
        open.session
            .apply(CommandEnvelope {
                owner: request.owner,
                expected_revision: request.expected_revision,
                request_id: request.request_id,
                command: SketchCommand::ResizeLegacyContainer {
                    layer_id: request.layer_id,
                    width: request.width,
                    height: request.height,
                },
            })
            .map_err(|e| e.to_string())?;
        // No cancellation error after the native atomic commit/history boundary.
        Ok(status(open))
    }
    pub fn set_text_override(
        &self,
        request: SetTextOverride,
        cancel: &AtomicBool,
    ) -> Result<Status, String> {
        let mut slot = self.0.lock().map_err(|_| "Sketch session unavailable")?;
        let open = slot.as_mut().ok_or("No active Sketch session")?;
        let valid_id = |id: &str| {
            !id.is_empty()
                && id.len() <= 128
                && !id.contains('/')
                && !id.chars().any(char::is_control)
        };
        if request.expected_revision >= 9_007_199_254_740_991
            || !valid_id(&request.instance_id)
            || request.target_path.len() > 64 * 129 - 1
            || request.target_path.split('/').count() > 64
            || !request.target_path.split('/').all(valid_id)
            || request.text.encode_utf16().count() > 100_000
        {
            return Err("Text override exceeds native IPC limits".into());
        }
        cancelled(cancel)?;
        // Native resolution and the commit/history boundary stay in Sketch's Session.
        open.session
            .apply(CommandEnvelope {
                owner: request.owner,
                expected_revision: request.expected_revision,
                request_id: request.request_id,
                command: SketchCommand::SetTextOverride {
                    instance_id: request.instance_id,
                    target_path: request.target_path,
                    text: request.text,
                },
            })
            .map_err(|e| e.to_string())?;
        Ok(status(open))
    }
    pub fn history(
        &self,
        request: History,
        redo: bool,
        cancel: &AtomicBool,
    ) -> Result<Status, String> {
        let mut slot = self.0.lock().map_err(|_| "Sketch session unavailable")?;
        let open = slot.as_mut().ok_or("No active Sketch session")?;
        if request.expected_revision >= 9_007_199_254_740_991 {
            return Err("Revision exceeds IPC integer range".into());
        }
        cancelled(cancel)?;
        open.session
            .apply(CommandEnvelope {
                owner: request.owner,
                expected_revision: request.expected_revision,
                request_id: request.request_id,
                command: if redo {
                    SketchCommand::Redo
                } else {
                    SketchCommand::Undo
                },
            })
            .map_err(|e| e.to_string())?;
        Ok(status(open))
    }
    pub fn save_as(&self, request: SaveAs, cancel: &AtomicBool) -> Result<Saved, String> {
        let mut slot = self.0.lock().map_err(|_| "Sketch session unavailable")?;
        let open = slot.as_mut().ok_or("No active Sketch session")?;
        open.session
            .assert_current(&request.owner, request.expected_revision)
            .map_err(|e| e.to_string())?;
        cancelled(cancel)?;
        let bytes = open
            .session
            .document()
            .to_sketch()
            .map_err(|e| e.to_string())?;
        let outcome = crate::sketch_save::save_new(&request.path, &bytes, cancel)?;
        open.save_uncertain = !outcome.directory_synced;
        if outcome.directory_synced {
            open.saved_revision = open.session.revision();
            open.saved_as = true;
            open._source_path = request.path;
        }
        Ok(Saved {
            status: status(open),
            save_warning: outcome.warning,
        })
    }
    pub fn close(&self, request: Close, cancel: &AtomicBool) -> Result<Status, String> {
        let mut slot = self.0.lock().map_err(|_| "Sketch session unavailable")?;
        let open = slot.as_mut().ok_or("No active Sketch session")?;
        let s = &mut open.session;
        s.assert_current(&request.owner, request.expected_revision)
            .map_err(|e| e.to_string())?;
        if (s.revision() != open.saved_revision || open.save_uncertain) && !request.discard {
            return Err("Unsaved Sketch changes require explicit discard confirmation".into());
        }
        cancelled(cancel)?;
        open.session.close();
        let mut result = status(open);
        result.active = false;
        *self.1.lock().map_err(|_| "Sketch session unavailable")? = Some(result.clone());
        *slot = None;
        Ok(result)
    }
}
