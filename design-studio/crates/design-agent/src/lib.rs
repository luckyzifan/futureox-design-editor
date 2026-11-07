//! Futureox page-agent core. Tokio runs the turn loop, provider probes, and
//! CC Switch reads. The browser/Electron shell only displays the dialog and
//! commits the returned operation batch.

mod assistant;
mod items;
mod operations;
mod providers;
mod skills;
mod turn;

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::{extract::State, routing::{get, post}, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::RwLock;

pub use items::TurnItem;
pub use operations::{DesignContext, Operation};
pub use providers::{CcSwitchSnapshot, Provider, ProviderKind, ProviderView, Wire};
pub use skills::SkillId;

use providers::ProviderSet;
use turn::run_turn;

#[derive(Clone)]
pub struct AgentCore {
    inner: Arc<Inner>,
}

struct Inner {
    providers: RwLock<ProviderSet>,
    sessions: RwLock<HashMap<String, Vec<TurnItem>>>,
    cancels: RwLock<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
pub struct TurnRequest {
    pub session_id: String,
    pub message: String,
    #[serde(default)]
    pub history: Vec<String>,
    #[serde(default)]
    pub context: DesignContext,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnResponse {
    pub session_id: String,
    pub skills: Vec<String>,
    pub items: Vec<TurnItem>,
    pub operations: Vec<Operation>,
    pub mutation_id: String,
    pub assistant: String,
    pub target_page_id: String,
    pub summary: String,
}

impl AgentCore {
    pub fn from_env() -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(45))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            inner: Arc::new(Inner {
                providers: RwLock::new(ProviderSet::from_env()),
                sessions: RwLock::new(HashMap::new()),
                cancels: RwLock::new(HashMap::new()),
                http,
            }),
        }
    }

    pub fn router(self) -> Router {
        Router::new()
            .route("/health", get(health))
            .route("/v1/turn", post(turn_handler))
            .route("/v1/cancel", post(cancel_handler))
            .route("/v1/providers", get(list_providers).post(upsert_provider))
            .route("/v1/providers/activate", post(activate_provider))
            .route("/v1/providers/remove", post(remove_provider))
            .route("/v1/ccswitch", get(ccswitch_handler))
            .layer(axum::extract::DefaultBodyLimit::max(256 * 1024))
            .with_state(self)
    }

    pub async fn turn(&self, request: TurnRequest) -> Result<TurnResponse, String> {
        if !valid_session(&request.session_id) {
            return Err("session id must be 1–64 letters, numbers, - or _".into());
        }
        let provider = self.inner.providers.read().await.active().cloned().ok_or("no active provider")?;
        let prior = self.inner.sessions.read().await.get(&request.session_id).cloned().unwrap_or_default();
        let earlier = if prior.is_empty() {
            request.history.join("\n")
        } else {
            prior.iter().filter_map(|item| match item {
                TurnItem::UserMessage { text, .. } => Some(text.as_str()),
                _ => None,
            }).collect::<Vec<_>>().join("\n")
        };
        let cancel = turn::new_cancel();
        self.inner.cancels.write().await.insert(request.session_id.clone(), Arc::clone(&cancel));
        let outcome = run_turn(&self.inner.http, &provider, &request.message, &earlier, &request.context, &prior, &cancel).await;
        self.inner.cancels.write().await.remove(&request.session_id);
        let outcome = outcome?;
        let mut stored = outcome.items.clone();
        if stored.len() > 48 {
            stored.drain(0..stored.len() - 48);
        }
        self.inner.sessions.write().await.insert(request.session_id.clone(), stored);
        let new_items = outcome.items[prior.len()..].to_vec();
        Ok(TurnResponse {
            session_id: request.session_id,
            skills: outcome.skills.iter().map(|skill| skill.as_str().to_string()).collect(),
            items: new_items,
            operations: outcome.operations,
            mutation_id: format!("agent-{}", uuid::Uuid::new_v4().simple()),
            assistant: outcome.assistant,
            target_page_id: outcome.target_page_id,
            summary: outcome.summary,
        })
    }

    pub async fn cancel(&self, session_id: &str) {
        if let Some(flag) = self.inner.cancels.read().await.get(session_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

fn valid_session(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

async fn health() -> Json<Value> {
    Json(json!({
        "ok": true,
        "service": "futureox-design-agent",
        "skills": skills::default_skills().iter().map(|skill| skill.as_str()).collect::<Vec<_>>(),
    }))
}

async fn turn_handler(State(core): State<AgentCore>, Json(request): Json<TurnRequest>) -> Result<Json<TurnResponse>, ApiError> {
    core.turn(request).await.map(Json).map_err(ApiError)
}

async fn cancel_handler(State(core): State<AgentCore>, Json(body): Json<Value>) -> Json<Value> {
    if let Some(id) = body.get("sessionId").and_then(Value::as_str) {
        core.cancel(id).await;
    }
    Json(json!({ "ok": true }))
}

async fn list_providers(State(core): State<AgentCore>) -> Json<Value> {
    let views = core.inner.providers.read().await.views();
    Json(json!({ "providers": views }))
}

async fn upsert_provider(State(core): State<AgentCore>, Json(provider): Json<Provider>) -> Result<Json<Value>, ApiError> {
    core.inner.providers.write().await.upsert(provider).map_err(ApiError)?;
    Ok(Json(json!({ "ok": true })))
}

async fn activate_provider(State(core): State<AgentCore>, Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let id = body.get("id").and_then(Value::as_str).unwrap_or("");
    core.inner.providers.write().await.activate(id).map_err(ApiError)?;
    Ok(Json(json!({ "ok": true })))
}

async fn remove_provider(State(core): State<AgentCore>, Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let id = body.get("id").and_then(Value::as_str).unwrap_or("");
    core.inner.providers.write().await.remove(id).map_err(ApiError)?;
    Ok(Json(json!({ "ok": true })))
}

async fn ccswitch_handler() -> Json<CcSwitchSnapshot> {
    Json(providers::read_ccswitch(&providers::ccswitch_db_path()).await)
}

struct ApiError(String);
impl axum::response::IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": self.0 }))).into_response()
    }
}

pub async fn serve(bind: &str) -> Result<(), String> {
    if !(bind.starts_with("127.0.0.1:") || bind.starts_with("localhost:")) {
        return Err("the agent only binds to loopback".into());
    }
    let listener = tokio::net::TcpListener::bind(bind).await.map_err(|error| error.to_string())?;
    let core = AgentCore::from_env();
    axum::serve(listener, core.router()).await.map_err(|error| error.to_string())
}
