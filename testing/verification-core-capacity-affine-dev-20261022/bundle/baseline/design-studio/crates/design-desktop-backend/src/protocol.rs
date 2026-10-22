use crate::{Backend, BackendError, MAX_DOCUMENT_BYTES, MAX_FRAME_BYTES, MAX_RECOVERIES, Result};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub id: Value,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BackendError>,
}

pub(crate) fn failed(id: Value, error: BackendError) -> Response {
    Response {
        id,
        result: None,
        error: Some(error),
    }
}

fn parse_params<T: DeserializeOwned>(params: Value) -> Result<T> {
    serde_json::from_value(params)
        .map_err(|e| BackendError::new("INVALID_REQUEST", format!("Invalid parameters: {e}")))
}

fn output(value: impl Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| BackendError::new("INTERNAL_ERROR", e.to_string()))
}

pub(crate) fn valid_id(id: &Value) -> bool {
    match id {
        Value::String(s) => !s.is_empty() && s.len() <= 128,
        Value::Number(n) => n
            .as_i64()
            .is_some_and(|i| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&i)),
        _ => false,
    }
}

pub(crate) fn parse_frame(frame: &[u8]) -> std::result::Result<Request, Response> {
    if frame.len() > MAX_FRAME_BYTES {
        return Err(failed(
            Value::Null,
            BackendError::new("FRAME_TOO_LARGE", "IPC frame exceeds 64 MiB"),
        ));
    }
    let value: Value = serde_json::from_slice(frame).map_err(|e| {
        failed(
            Value::Null,
            BackendError::new("INVALID_JSON", e.to_string()),
        )
    })?;
    let id = value
        .get("id")
        .filter(|id| valid_id(id))
        .cloned()
        .unwrap_or(Value::Null);
    let request: Request = serde_json::from_value(value)
        .map_err(|e| failed(id, BackendError::new("INVALID_REQUEST", e.to_string())))?;
    if !valid_id(&request.id) {
        return Err(failed(
            Value::Null,
            BackendError::new(
                "INVALID_REQUEST",
                "Request ID must be a bounded string or safe integer",
            ),
        ));
    }
    Ok(request)
}
pub fn handle_frame(backend: &Backend, frame: &[u8]) -> Response {
    match parse_frame(frame) {
        Ok(request) => handle_request(backend, request, &std::sync::atomic::AtomicBool::new(false)),
        Err(response) => response,
    }
}
pub(crate) fn handle_request(
    backend: &Backend,
    request: Request,
    cancel: &std::sync::atomic::AtomicBool,
) -> Response {
    match dispatch(backend, &request.method, request.params, cancel) {
        Ok(result) => Response {
            id: request.id,
            result: Some(result),
            error: None,
        },
        Err(error) => failed(request.id, error),
    }
}

fn dispatch(
    backend: &Backend,
    method: &str,
    params: Value,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Value> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Empty {}
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PathParams {
        path: PathBuf,
        directory_id: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct SaveParams {
        path: PathBuf,
        directory_id: Option<String>,
        document: Value,
        // Value rather than Option makes an omitted baseline an invalid request.
        expected_hash: Value,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RecoveryId {
        recovery_id: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RecoveryWrite {
        recovery_id: String,
        document: Value,
        #[serde(default)]
        source_path: Option<String>,
        #[serde(default)]
        source_hash: Option<String>,
    }
    match method {
        method if method.starts_with("automation.") => {
            let method = method.to_owned();
            workspace_call(backend, |store| {
                Box::pin(async move { crate::automation::dispatch(store, &method, params).await })
            })
        }
        "sketch.session.textTargets" => output(
            backend
                .sketch_sessions
                .text_targets(parse_params(params)?)
                .map_err(|e| BackendError::new("SKETCH_SESSION_FAILED", e))?,
        ),
        "sketch.session.textValue" => output(
            backend
                .sketch_sessions
                .text_value(parse_params(params)?)
                .map_err(|e| BackendError::new("SKETCH_SESSION_FAILED", e))?,
        ),
        "sketch.session.resizeLegacyContainer" => output(
            backend
                .sketch_sessions
                .resize_legacy_container(parse_params(params)?, cancel)
                .map_err(|e| BackendError::new("SKETCH_SESSION_FAILED", e))?,
        ),
        "sketch.session.setTextOverride" => output(
            backend
                .sketch_sessions
                .set_text_override(parse_params(params)?, cancel)
                .map_err(|e| BackendError::new("SKETCH_SESSION_FAILED", e))?,
        ),
        "sketch.session.leafFrame" => output(
            backend
                .sketch_sessions
                .leaf_frame(parse_params(params)?)
                .map_err(|e| BackendError::new("SKETCH_SESSION_FAILED", e))?,
        ),
        "sketch.session.setLeafFrame" => output(
            backend
                .sketch_sessions
                .set_leaf_frame(parse_params(params)?, cancel)
                .map_err(|e| BackendError::new("SKETCH_SESSION_FAILED", e))?,
        ),
        "sketch.session.preview" => {
            let request = parse_params::<crate::sketch_preview::Request>(params)?;
            output(
                backend
                    .sketch_sessions
                    .with_snapshot(&request.owner, request.expected_revision, |session| {
                        crate::sketch_preview::snapshot(session, &request)
                    })
                    .map_err(|e| BackendError::new("SKETCH_SESSION_FAILED", e))?,
            )
        }
        "sketch.session.saveAs" => output(
            backend
                .sketch_sessions
                .save_as(parse_params(params)?, cancel)
                .map_err(|e| BackendError::new("SKETCH_SESSION_FAILED", e))?,
        ),
        "sketch.session.undo" => output(
            backend
                .sketch_sessions
                .history(parse_params(params)?, false, cancel)
                .map_err(|e| BackendError::new("SKETCH_SESSION_FAILED", e))?,
        ),
        "sketch.session.redo" => output(
            backend
                .sketch_sessions
                .history(parse_params(params)?, true, cancel)
                .map_err(|e| BackendError::new("SKETCH_SESSION_FAILED", e))?,
        ),
        "sketch.session.status" => output(
            backend
                .sketch_sessions
                .status(parse_params(params)?)
                .map_err(|e| BackendError::new("SKETCH_SESSION_FAILED", e))?,
        ),
        "sketch.session.open" => output(
            backend
                .sketch_sessions
                .open(parse_params(params)?, cancel)
                .map_err(|e| BackendError::new("SKETCH_SESSION_FAILED", e))?,
        ),
        "sketch.session.rename" => output(
            backend
                .sketch_sessions
                .rename(parse_params(params)?, cancel)
                .map_err(|e| BackendError::new("SKETCH_SESSION_FAILED", e))?,
        ),
        "sketch.session.close" => output(
            backend
                .sketch_sessions
                .close(parse_params(params)?, cancel)
                .map_err(|e| BackendError::new("SKETCH_SESSION_FAILED", e))?,
        ),
        "sketch.inspect" => {
            let request = parse_params::<crate::sketch_inspect::InspectRequest>(params)?;
            output(
                crate::sketch_inspect::inspect(request, cancel)
                    .map_err(|message| BackendError::new("SKETCH_ADMISSION_FAILED", message))?,
            )
        }
        "health" => {
            parse_params::<Empty>(params)?;
            Ok(
                json!({"protocolVersion":1,"maxDocumentBytes":MAX_DOCUMENT_BYTES,"maxFrameBytes":MAX_FRAME_BYTES,"maxRecoveries":MAX_RECOVERIES,"catalogVersion":1,"catalogAvailable":backend.catalog.is_some(),"catalogError":if backend.catalog.is_none(){Some(backend.catalog_unavailable())}else{None},"workspaceVersion":crate::workspace::SCHEMA_VERSION,"workspaceAvailable":backend.workspace.is_some(),"workspaceError":if backend.workspace.is_none(){Some(backend.workspace_unavailable())}else{None},"fileRecoveryAvailable":true,"maxPendingRequests":crate::runtime::MAX_PENDING,"maxPendingBytes":crate::runtime::MAX_PENDING_BYTES}),
            )
        }
        "open" | "stat" => {
            let request = parse_params::<PathParams>(params)?;
            check_directory(backend, request.directory_id.as_deref(), &request.path)?;
            let mut result = if method == "open" {
                output(backend.open(&request.path)?)?
            } else {
                output(backend.stat(&request.path)?)?
            };
            check_directory(backend, request.directory_id.as_deref(), &request.path)?;
            if method == "open"
                && let Err(error) =
                    touch_catalog(backend, request.directory_id.as_deref(), &request.path)
            {
                result["warning"] = json!(format!(
                    "File opened; recent metadata could not be updated: {error}"
                ));
            }
            Ok(result)
        }
        "save" => {
            let request = parse_params::<SaveParams>(params)?;
            if !request.expected_hash.is_null() && !request.expected_hash.is_string() {
                return Err(BackendError::new(
                    "INVALID_REQUEST",
                    "expectedHash must be a SHA-256 string or explicit null",
                ));
            }
            check_directory(backend, request.directory_id.as_deref(), &request.path)?;
            let mut saved = crate::storage::save_guarded(
                &request.path,
                &request.document,
                request.expected_hash.as_str(),
                || check_directory(backend, request.directory_id.as_deref(), &request.path),
            )?;
            if let Err(error) =
                check_directory(backend, request.directory_id.as_deref(), &request.path)
            {
                let warning = format!("File commit completed; directory grant changed: {error}");
                saved.warning = Some(match saved.warning {
                    Some(old) => format!("{old}; {warning}"),
                    None => warning,
                });
            }
            if let Err(error) =
                touch_catalog(backend, request.directory_id.as_deref(), &request.path)
            {
                let warning = format!("File saved; recent metadata could not be updated: {error}");
                saved.warning = Some(match saved.warning {
                    Some(old) => format!("{old}; {warning}"),
                    None => warning,
                });
            }
            output(saved)
        }
        "recovery.write" => {
            let request = parse_params::<RecoveryWrite>(params)?;
            output(backend.recovery_write(
                &request.recovery_id,
                &request.document,
                request.source_path.as_deref(),
                request.source_hash.as_deref(),
            )?)
        }
        "recovery.list" => {
            parse_params::<Empty>(params)?;
            output(backend.recovery_list()?)
        }
        "recovery.read" => {
            output(backend.recovery_read(&parse_params::<RecoveryId>(params)?.recovery_id)?)
        }
        "recovery.remove" => Ok(
            json!({"removed":backend.recovery_remove(&parse_params::<RecoveryId>(params)?.recovery_id)?}),
        ),
        "fonts.list" => {
            parse_params::<Empty>(params)?;
            output(backend.fonts.list()?)
        }
        "fonts.read" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct ReadFont {
                id: String,
            }
            let request = parse_params::<ReadFont>(params)?;
            output(backend.fonts.read(&request.id)?)
        }
        "workspace.observe" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Observe {
                control: futureox_design_kernel::protocol::Envelope,
                presence: crate::workspace::LocalPresence,
            }
            let request = parse_params::<Observe>(params)?;
            workspace_call(backend, |store| {
                Box::pin(async move { store.observe(request.control, request.presence).await })
            })
        }
        "workspace.leave" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Leave {
                id: String,
            }
            let request = parse_params::<Leave>(params)?;
            workspace_call(backend, |store| {
                Box::pin(async move {
                    store.leave_session(&request.id).await?;
                    Ok(json!({"left":true}))
                })
            })
        }
        "workspace.list" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct List {
                #[serde(default)]
                include_deleted: bool,
            }
            let request = parse_params::<List>(params)?;
            workspace_call(backend, |store| {
                Box::pin(store.list(request.include_deleted))
            })
        }
        "workspace.open" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Open {
                id: String,
                revision: Option<i64>,
            }
            let request = parse_params::<Open>(params)?;
            workspace_call(backend, |store| {
                Box::pin(async move { output(store.read(&request.id, request.revision).await?) })
            })
        }
        "workspace.commit" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Commit {
                document: Value,
                expected_revision: Value,
                mutation_id: String,
            }
            let request = parse_params::<Commit>(params)?;
            let expected = if request.expected_revision.is_null() {
                None
            } else {
                Some(request.expected_revision.as_i64().ok_or_else(|| {
                    BackendError::new(
                        "INVALID_REQUEST",
                        "expectedRevision must be an integer or explicit null",
                    )
                })?)
            };
            workspace_call(backend, |store| {
                Box::pin(async move {
                    output(
                        store
                            .commit(&request.document, expected, &request.mutation_id)
                            .await?,
                    )
                })
            })
        }
        "workspace.trash" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Trash {
                id: String,
                expected_revision: i64,
                mutation_id: String,
                deleted: Option<bool>,
            }
            let request = parse_params::<Trash>(params)?;
            workspace_call(backend, |store| {
                Box::pin(async move {
                    output(
                        store
                            .trash(
                                &request.id,
                                request.expected_revision,
                                &request.mutation_id,
                                request.deleted.unwrap_or(true),
                            )
                            .await?,
                    )
                })
            })
        }
        "workspace.revisions" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Revisions {
                id: String,
                before_revision: Option<i64>,
            }
            let request = parse_params::<Revisions>(params)?;
            workspace_call(backend, |store| {
                Box::pin(async move { store.revisions(&request.id, request.before_revision).await })
            })
        }
        "workspace.restore" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Restore {
                id: String,
                revision: i64,
                expected_revision: i64,
                mutation_id: String,
            }
            let request = parse_params::<Restore>(params)?;
            workspace_call(backend, |store| {
                Box::pin(async move {
                    output(
                        store
                            .restore(
                                &request.id,
                                request.revision,
                                request.expected_revision,
                                &request.mutation_id,
                            )
                            .await?,
                    )
                })
            })
        }
        "catalog.list" => {
            parse_params::<Empty>(params)?;
            catalog_call(backend, |catalog| Box::pin(catalog.list()))
        }
        "catalog.register" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Register {
                path: PathBuf,
                name: Option<String>,
            }
            let r = parse_params::<Register>(params)?;
            let catalog = backend.catalog()?;
            tokio::runtime::Handle::try_current()
                .map_err(|_| {
                    BackendError::new("CATALOG_UNAVAILABLE", "Catalog requires the Tokio worker")
                })?
                .block_on(catalog.register(&r.path, r.name.as_deref()))
        }
        "catalog.scan" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Scan {
                directory_id: String,
                path: PathBuf,
            }
            let r = parse_params::<Scan>(params)?;
            let catalog = backend.catalog()?;
            tokio::runtime::Handle::try_current()
                .map_err(|_| {
                    BackendError::new("CATALOG_UNAVAILABLE", "Catalog requires the Tokio worker")
                })?
                .block_on(catalog.scan(&r.directory_id, &r.path, cancel))
        }
        _ => Err(BackendError::new(
            "UNKNOWN_METHOD",
            "Unknown desktop backend method",
        )),
    }
}

fn touch_catalog(backend: &Backend, id: Option<&str>, path: &std::path::Path) -> Result<()> {
    if let Some(id) = id {
        let catalog = backend.catalog()?;
        tokio::runtime::Handle::try_current()
            .map_err(|_| {
                BackendError::new("CATALOG_UNAVAILABLE", "Catalog requires the Tokio worker")
            })?
            .block_on(catalog.touch(id, path))?;
    }
    Ok(())
}
fn check_directory(backend: &Backend, id: Option<&str>, path: &std::path::Path) -> Result<()> {
    if let Some(id) = id {
        backend.catalog()?.validate_file(id, path)?;
    }
    Ok(())
}
fn catalog_call(
    backend: &Backend,
    f: impl for<'a> FnOnce(
        &'a crate::catalog::Catalog,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value>> + Send + 'a>,
    >,
) -> Result<Value> {
    let catalog = backend.catalog()?;
    tokio::runtime::Handle::try_current()
        .map_err(|_| BackendError::new("CATALOG_UNAVAILABLE", "Catalog requires the Tokio worker"))?
        .block_on(f(catalog))
}

fn workspace_call(
    backend: &Backend,
    f: impl for<'a> FnOnce(
        &'a crate::workspace::WorkspaceStore,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value>> + Send + 'a>,
    >,
) -> Result<Value> {
    let workspace = backend.workspace()?;
    tokio::runtime::Handle::try_current()
        .map_err(|_| {
            BackendError::new(
                "WORKSPACE_UNAVAILABLE",
                "Workspace requires the Tokio worker",
            )
        })?
        .block_on(f(workspace))
}

/// Reads at most limit bytes into memory. An oversized line is drained without
/// allocating it, then one error is emitted and the next request remains usable.
fn read_frame(reader: &mut impl BufRead, limit: usize) -> io::Result<Option<(Vec<u8>, bool)>> {
    let mut frame = Vec::new();
    let mut oversized = false;
    let mut saw_data = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(saw_data.then_some((frame, oversized)));
        }
        saw_data = true;
        let newline = available.iter().position(|&c| c == b'\n');
        let length = newline.unwrap_or(available.len());
        if !oversized {
            if length > limit.saturating_sub(frame.len()) {
                oversized = true;
                frame.clear();
            } else {
                frame.extend_from_slice(&available[..length]);
            }
        }
        reader.consume(length + usize::from(newline.is_some()));
        if newline.is_some() {
            return Ok(Some((frame, oversized)));
        }
    }
}

pub fn serve(
    backend: &Backend,
    reader: &mut impl BufRead,
    writer: &mut impl Write,
) -> io::Result<()> {
    while let Some((frame, oversized)) = read_frame(reader, MAX_FRAME_BYTES)? {
        let response = if oversized {
            failed(
                Value::Null,
                BackendError::new("FRAME_TOO_LARGE", "IPC frame exceeds 64 MiB"),
            )
        } else {
            handle_frame(backend, &frame)
        };
        serde_json::to_writer(&mut *writer, &response)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_limit_drains_and_resynchronizes() {
        let mut reader = io::Cursor::new(b"123456789\nok\nlast");
        assert_eq!(read_frame(&mut reader, 4).unwrap(), Some((vec![], true)));
        assert_eq!(
            read_frame(&mut reader, 4).unwrap(),
            Some((b"ok".to_vec(), false))
        );
        assert_eq!(
            read_frame(&mut reader, 4).unwrap(),
            Some((b"last".to_vec(), false))
        );
        assert_eq!(read_frame(&mut reader, 4).unwrap(), None);
    }
}
