//! Futureox page-agent core. Tokio runs the turn loop, provider probes, and
//! CC Switch reads. The browser/Electron shell only displays the dialog and
//! commits the returned operation batch.

mod assistant;
mod ccswitch;
mod compact;
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
pub use ccswitch::SwitchSnapshot as CcSwitchSnapshot;
pub use providers::{Provider, ProviderKind, ProviderView, Wire};
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
    pub fn from_providers(set: ProviderSet) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(45))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            inner: Arc::new(Inner {
                providers: RwLock::new(set),
                sessions: RwLock::new(HashMap::new()),
                cancels: RwLock::new(HashMap::new()),
                http,
            }),
        }
    }

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
        let new_items = outcome.items[prior.len()..].to_vec();
        let stored = compact::compact_session(outcome.items);
        self.inner.sessions.write().await.insert(request.session_id.clone(), stored);
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
    let profile = body.get("profile_id").and_then(Value::as_str).unwrap_or("");
    core.inner.providers.write().await.activate_with_profile(id, profile).map_err(ApiError)?;
    Ok(Json(json!({ "ok": true })))
}

async fn remove_provider(State(core): State<AgentCore>, Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let id = body.get("id").and_then(Value::as_str).unwrap_or("");
    core.inner.providers.write().await.remove(id).map_err(ApiError)?;
    Ok(Json(json!({ "ok": true })))
}

async fn ccswitch_handler() -> Json<CcSwitchSnapshot> {
    Json(ccswitch::load_catalog(&ccswitch::default_db()).snapshot())
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

#[cfg(test)]
mod session_tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn provider(kind: ProviderKind, wire: Wire, base: String) -> Provider {
        Provider { id: "remote".into(), name: "remote".into(), kind, base_url: base, secret: "secret".into(), model: "m".into(), wire, profile_id: String::new() }
    }

    async fn serve_script(wire: Wire, bodies: Arc<Mutex<Vec<Value>>>) -> String {
        let recorded = bodies.clone();
        let app = Router::new().route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
            let recorded = recorded.clone();
            async move { recorded.lock().expect("bodies").push(body); axum::Json(scripted_openai(&recorded)) }
        })).route("/v1/messages", post(move |Json(body): Json<Value>| {
            let recorded = bodies.clone();
            async move { recorded.lock().expect("bodies").push(body); axum::Json(scripted_anthropic(&recorded)) }
        }));
        let _ = wire;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}/v1")
    }

    fn scripted_openai(bodies: &Arc<Mutex<Vec<Value>>>) -> Value {
        let n = bodies.lock().expect("bodies").len();
        if n == 1 {
            json!({ "choices": [{ "message": { "role": "assistant", "content": "我来读这一页。", "tool_calls": [{
                "id": "call_hist_1", "type": "function",
                "function": { "name": "design_agent_read", "arguments": "{}" }
            }] } }] })
        } else {
            json!({ "choices": [{ "message": { "role": "assistant", "content": "沿用上一轮。", "tool_calls": [] } }] })
        }
    }

    fn scripted_anthropic(bodies: &Arc<Mutex<Vec<Value>>>) -> Value {
        let n = bodies.lock().expect("bodies").len();
        if n == 1 {
            json!({ "content": [
                { "type": "text", "text": "我来读这一页。" },
                { "type": "tool_use", "id": "toolu_hist_1", "name": "design_agent_read", "input": {} }
            ] })
        } else {
            json!({ "content": [{ "type": "text", "text": "沿用上一轮。" }] })
        }
    }

    async fn two_turns(kind: ProviderKind, wire: Wire) -> Vec<Value> {
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let base = serve_script(wire, bodies.clone()).await;
        let core = AgentCore::from_providers(ProviderSet { items: vec![provider(kind, wire, base)], active: "remote".into() });
        let first = TurnRequest {
            session_id: "sess-history".into(),
            message: "先做咖啡页，标题秋日特惠".into(),
            history: vec![],
            context: DesignContext::default(),
        };
        core.turn(first).await.expect("first turn");
        let second = TurnRequest {
            session_id: "sess-history".into(),
            message: "把标题改成暖季菜单".into(),
            history: vec![],
            context: DesignContext {
                current_page_id: "page-1".into(),
                target_page_id: Some("page-1".into()),
                pages: vec![operations::PageRef { id: "page-1".into(), name: "秋日特惠".into() }],
                nodes: vec![operations::NodeRef {
                    id: "title".into(), page_id: "page-1".into(), parent_id: None, name: "标题".into(), kind: "text".into(),
                    x: 0.0, y: 0.0, width: 80.0, height: 40.0, text: Some("秋日特惠".into()), fill: None,
                }],
                selection: vec!["title".into()],
            },
        };
        core.turn(second).await.expect("second turn");
        bodies.lock().expect("bodies").clone()
    }

    #[tokio::test]
    async fn openai_follow_up_sends_the_whole_conversation_and_the_tool_call_id() {
        let bodies = two_turns(ProviderKind::Api, Wire::OpenaiChat).await;
        assert!(bodies.len() >= 3, "{}", bodies.len());
        let follow_up = bodies[1].to_string();
        assert!(follow_up.contains("先做咖啡页"));
        assert!(follow_up.contains("\"tool_call_id\":\"call_hist_1\""), "{follow_up}");
        assert!(follow_up.contains("\"id\":\"call_hist_1\""));
        let later = bodies[2].to_string();
        assert!(later.contains("先做咖啡页"), "{later}");
        assert!(later.contains("把标题改成暖季菜单"));
        assert!(later.contains("call_hist_1"));
    }

    #[tokio::test]
    async fn anthropic_follow_up_sends_tool_use_history() {
        let bodies = two_turns(ProviderKind::TokenPlan, Wire::Anthropic).await;
        assert!(bodies.len() >= 3, "{}", bodies.len());
        let follow_up = bodies[1].to_string();
        assert!(follow_up.contains("先做咖啡页"));
        assert!(follow_up.contains("\"tool_use_id\":\"toolu_hist_1\""), "{follow_up}");
        assert!(follow_up.contains("\"type\":\"tool_use\""));
        let later = bodies[2].to_string();
        assert!(later.contains("先做咖啡页") && later.contains("把标题改成暖季菜单"), "{later}");
        assert!(later.contains("toolu_hist_1"));
    }
}
