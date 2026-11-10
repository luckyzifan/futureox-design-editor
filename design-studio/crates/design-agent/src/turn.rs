//! One user turn. The loop follows Codex `RegularTask::run_turns`
//! (`codex-rs/core/src/tasks/regular.rs`) and `run_turn` / `needs_follow_up`
//! (`codex-rs/core/src/session/turn.rs`) at commit
//! `c4f0e09912fd4c1173258ccd17e33284a876e826`: sample the model, run tool
//! calls, append the outputs, and sample again while a follow-up is needed.
//! Independent read-only tools in one model step run together. Mutations stay
//! in order because later operations share one document batch.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::json;
use tokio::task::JoinSet;

use crate::assistant::{local_turn, remote_turn, ModelTurn, ProviderFailure, ToolCall};
use crate::items::{item_id, McpToolCallStatus, MessagePhase, TurnItem};
use crate::operations::{expand_tool, DesignContext, Operation};
use crate::providers::{Provider, ProviderKind};
use crate::skills::SkillId;

#[derive(Debug)]
pub struct TurnOutcome {
    pub items: Vec<TurnItem>,
    pub operations: Vec<Operation>,
    pub skills: Vec<SkillId>,
    pub target_page_id: String,
    pub assistant: String,
    pub summary: String,
    pub failure: Option<ProviderFailure>,
}

pub async fn run_turn(
    http: &reqwest::Client,
    provider: &Provider,
    message: &str,
    earlier: &str,
    ctx: &DesignContext,
    prior: &[TurnItem],
    cancel: &AtomicBool,
    use_local_rules: bool,
) -> Result<TurnOutcome, String> {
    run_turn_db(http, provider, message, earlier, ctx, prior, cancel, &crate::ccswitch::default_db(), use_local_rules).await
}

pub async fn run_turn_db(
    http: &reqwest::Client,
    provider: &Provider,
    message: &str,
    earlier: &str,
    ctx: &DesignContext,
    prior: &[TurnItem],
    cancel: &AtomicBool,
    switch_db: &std::path::Path,
    use_local_rules: bool,
) -> Result<TurnOutcome, String> {
    if message.trim().is_empty() || message.chars().count() > 4000 {
        return Err("message must be 1–4000 characters".into());
    }
    let skills = crate::assistant::skills_for(message, earlier, ctx);
    let mut items = prior.to_vec();
    items.push(TurnItem::UserMessage { id: item_id(), text: message.to_string() });
    let mut operations = Vec::new();
    let mut assistant_name = if use_local_rules { "local-rules".to_string() } else { assistant_label(provider) };
    let mut target = ctx.target_page_id.clone().unwrap_or_else(|| ctx.current_page_id.clone());
    let mut summary = String::new();
    let mut active = provider.clone();
    if use_local_rules {
        active.kind = ProviderKind::Local;
    }
    let mut primed = None;
    if !use_local_rules && provider.kind == ProviderKind::CcSwitch {
        let mut connected = false;
        let mut last_failure = None;
        for candidate in crate::ccswitch::candidate_providers(provider, switch_db) {
            if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
            match sample(http, &candidate, message, earlier, &items, &skills, ctx).await {
                Ok(turn) => {
                    assistant_name = format!("ccswitch:{}:{}", assistant_label(&candidate), candidate.name);
                    active = candidate;
                    primed = Some(turn);
                    connected = true;
                    break;
                }
                Err(error) => last_failure = Some(error),
            }
        }
        if !connected {
            return Ok(failure_outcome(items, skills, assistant_name, target, last_failure.unwrap_or_else(ProviderFailure::unreachable)));
        }
    }
    for _step in 0..4 {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let sampled = if let Some(turn) = primed.take() { Ok(turn) } else { sample(http, &active, message, earlier, &items, &skills, ctx).await };
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let turn = match sampled {
            Ok(turn) => turn,
            Err(failure) => return Ok(failure_outcome(items, skills, assistant_name, target, failure)),
        };
        if let Some(plan) = turn.plan {
            items.push(TurnItem::Plan { id: item_id(), text: plan });
        }
        if let Some(text) = turn.message.clone() {
            items.push(TurnItem::AgentMessage {
                id: item_id(),
                text: text.clone(),
                phase: if turn.tool_calls.is_empty() { MessagePhase::Final } else { MessagePhase::Commentary },
            });
            summary = text;
        }
        if turn.tool_calls.is_empty() {
            break;
        }
        let (expanded_items, expanded_ops, next_target, next_summary) = execute_calls(&turn.tool_calls, message, ctx, cancel).await?;
        if let Some(page) = next_target {
            target = page;
        }
        if !next_summary.is_empty() {
            summary = next_summary;
        }
        items.extend(expanded_items);
        operations.extend(expanded_ops);
    }
    Ok(TurnOutcome { items, operations, skills, target_page_id: target, assistant: assistant_name, summary, failure: None })
}

fn failure_outcome(mut items: Vec<TurnItem>, skills: Vec<SkillId>, assistant: String, target: String, failure: ProviderFailure) -> TurnOutcome {
    let summary = failure.message.clone();
    items.push(TurnItem::AgentMessage { id: item_id(), text: summary.clone(), phase: MessagePhase::Final });
    TurnOutcome {
        items,
        operations: Vec::new(),
        skills,
        target_page_id: target,
        assistant,
        summary,
        failure: Some(failure),
    }
}

async fn sample(http: &reqwest::Client, provider: &Provider, message: &str, earlier: &str, items: &[TurnItem], skills: &[SkillId], ctx: &DesignContext) -> Result<ModelTurn, ProviderFailure> {
    if provider.kind == ProviderKind::Local {
        return Ok(local_turn(message, earlier, items, skills, ctx));
    }
    remote_turn(http, provider, message, skills, items, ctx).await
}

async fn execute_calls(calls: &[ToolCall], message: &str, ctx: &DesignContext, cancel: &AtomicBool) -> Result<(Vec<TurnItem>, Vec<Operation>, Option<String>, String), String> {
    let mut index = 0;
    let mut items = Vec::new();
    let mut operations = Vec::new();
    let mut target = None;
    let mut summary = String::new();
    while index < calls.len() {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        if is_read_only(&calls[index].name) {
            let mut batch = Vec::new();
            while index < calls.len() && is_read_only(&calls[index].name) {
                batch.push(calls[index].clone());
                index += 1;
            }
            let parallel = run_parallel(&batch, message, ctx).await;
            for (call, result) in parallel {
                let (item_pair, ops, page, text) = finish_call(&call, result);
                items.extend(item_pair);
                operations.extend(ops);
                target = page.or(target);
                if !text.is_empty() {
                    summary = text;
                }
            }
        } else {
            let call = &calls[index];
            index += 1;
            let result = expand_tool(&call.name, &call.arguments, message, ctx);
            let (item_pair, ops, page, text) = finish_call(call, result);
            items.extend(item_pair);
            operations.extend(ops);
            target = page.or(target);
            if !text.is_empty() {
                summary = text;
            }
        }
    }
    Ok((items, operations, target, summary))
}

async fn run_parallel(calls: &[ToolCall], message: &str, ctx: &DesignContext) -> Vec<(ToolCall, Result<crate::operations::ToolExpansion, String>)> {
    let message = message.to_string();
    let ctx = ctx.clone();
    let mut set = JoinSet::new();
    for (index, call) in calls.iter().cloned().enumerate() {
        let message = message.clone();
        let ctx = ctx.clone();
        set.spawn(async move {
            let result = expand_tool(&call.name, &call.arguments, &message, &ctx);
            (index, call, result)
        });
    }
    let mut finished = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(item) = joined {
            finished.push(item);
        }
    }
    finished.sort_by_key(|(index, _, _)| *index);
    finished.into_iter().map(|(_, call, result)| (call, result)).collect()
}

fn finish_call(call: &ToolCall, result: Result<crate::operations::ToolExpansion, String>) -> (Vec<TurnItem>, Vec<Operation>, Option<String>, String) {
    match result {
        Ok(expanded) => {
            let output = json!({ "summary": expanded.summary, "operations": expanded.operations.len(), "readOnly": expanded.read_only });
            (
                vec![
                    TurnItem::McpToolCall {
                        id: call.id.clone(),
                        server: "futureox-design".into(),
                        tool: call.name.clone(),
                        arguments: call.arguments.clone(),
                        status: McpToolCallStatus::Completed,
                        result: Some(output.clone()),
                        error: None,
                    },
                    TurnItem::FunctionCallOutput { id: item_id(), call_id: call.id.clone(), name: call.name.clone(), output: output.to_string() },
                ],
                expanded.operations,
                Some(expanded.target_page_id),
                expanded.summary,
            )
        }
        Err(error) => (
            vec![
                TurnItem::McpToolCall {
                    id: call.id.clone(),
                    server: "futureox-design".into(),
                    tool: call.name.clone(),
                    arguments: call.arguments.clone(),
                    status: McpToolCallStatus::Failed,
                    result: None,
                    error: Some(error.clone()),
                },
                TurnItem::FunctionCallOutput { id: item_id(), call_id: call.id.clone(), name: call.name.clone(), output: error.clone() },
            ],
            Vec::new(),
            None,
            error,
        ),
    }
}

fn is_read_only(name: &str) -> bool {
    matches!(name, "design_agent_read" | "design_agent_critique")
}

fn assistant_label(provider: &Provider) -> String {
    match provider.kind {
        ProviderKind::Local => "本机模式".into(),
        ProviderKind::Api => "api".into(),
        ProviderKind::TokenPlan => "token-plan".into(),
        ProviderKind::CcSwitch => "ccswitch".into(),
    }
}

pub fn new_cancel() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{Provider, Wire};
    use std::sync::atomic::AtomicUsize;

    fn local() -> Provider {
        Provider {
            id: "local".into(),
            name: "local".into(),
            kind: ProviderKind::Local,
            base_url: String::new(),
            secret: String::new(),
            model: "grok-local".into(),
            wire: Wire::OpenaiChat,
            profile_id: String::new(),
        }
    }

    #[tokio::test]
    async fn local_turn_plans_and_generates_a_page() {
        let http = reqwest::Client::new();
        let outcome = run_turn(
            &http,
            &local(),
            "做一个咖啡品牌落地页，标题秋日特惠，副标题手冲咖啡本周上新，卖点：产地、烘焙、门店",
            "",
            &DesignContext::default(),
            &[],
            &AtomicBool::new(false),
            false,
        )
        .await
        .unwrap();
        assert!(outcome.items.iter().any(|item| matches!(item, TurnItem::Plan { .. })));
        assert!(outcome.items.iter().any(|item| matches!(item, TurnItem::McpToolCall { status: McpToolCallStatus::Completed, .. })));
        assert!(outcome.operations.iter().any(|op| op.method == "page.create"));
        assert!(outcome.summary.contains("秋日特惠") || outcome.items.iter().any(|item| matches!(item, TurnItem::AgentMessage { text, .. } if text.contains("秋日") || text.contains("技能"))));
        assert_eq!(outcome.assistant, "本机模式");
    }

    #[tokio::test]
    async fn remote_openai_and_token_plan_are_contacted_in_parallel() {
        let hits = Arc::new(AtomicUsize::new(0));
        let app_hits = hits.clone();
        let app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(move |headers: axum::http::HeaderMap, body: String| {
                let hits = app_hits.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    let auth = headers.get(axum::http::header::AUTHORIZATION).and_then(|value| value.to_str().ok()).unwrap_or("").to_string();
                    let _ = body;
                    axum::Json(json!({
                        "choices": [{ "message": { "role": "assistant", "content": format!("auth:{auth}"), "tool_calls": [] } }]
                    }))
                }
            }),
        );
        let listener_a = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let listener_b = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr_a = listener_a.local_addr().unwrap();
        let addr_b = listener_b.local_addr().unwrap();
        let second = app.clone();
        tokio::spawn(async move { axum::serve(listener_a, app).await.unwrap() });
        tokio::spawn(async move { axum::serve(listener_b, second).await.unwrap() });
        let http = reqwest::Client::new();
        let api = Provider {
            id: "api".into(),
            name: "API".into(),
            kind: ProviderKind::Api,
            base_url: format!("http://{addr_a}/v1"),
            secret: "api-key".into(),
            model: "m".into(),
            wire: Wire::OpenaiChat,
            profile_id: String::new(),
        };
        let plan = Provider {
            id: "plan".into(),
            name: "Plan".into(),
            kind: ProviderKind::TokenPlan,
            base_url: format!("http://{addr_b}/v1"),
            secret: "plan-token".into(),
            model: "m".into(),
            wire: Wire::OpenaiChat,
            profile_id: String::new(),
        };
        let empty = DesignContext::default();
        let cancel_a = AtomicBool::new(false);
        let cancel_b = AtomicBool::new(false);
        let (left, right) = tokio::join!(
            run_turn(&http, &api, "评价一下这一页", "", &empty, &[], &cancel_a, false),
            run_turn(&http, &plan, "评价一下这一页", "", &empty, &[], &cancel_b, false),
        );
        let left = left.unwrap();
        assert_eq!(left.assistant, "api");
        assert!(left.summary.contains("api-key"), "{}", left.summary);
        let right = right.unwrap();
        assert_eq!(right.assistant, "token-plan");
        assert!(right.summary.contains("plan-token"));
        assert!(hits.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test]
    async fn switching_the_proxy_sends_the_design_turn_to_that_endpoint_only() {
        async fn listen(label: &'static str) -> (std::net::SocketAddr, Arc<AtomicUsize>) {
            let hits = Arc::new(AtomicUsize::new(0));
            let seen = hits.clone();
            let app = axum::Router::new().route("/v1/chat/completions", axum::routing::post(move |headers: axum::http::HeaderMap| {
                let seen = seen.clone();
                async move {
                    seen.fetch_add(1, Ordering::SeqCst);
                    let auth = headers.get(axum::http::header::AUTHORIZATION).and_then(|value| value.to_str().ok()).unwrap_or("");
                    axum::Json(json!({ "choices": [{ "message": { "role": "assistant", "content": format!("{label}:{auth}"), "tool_calls": [] } }] }))
                }
            }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            (address, hits)
        }
        let (api_addr, api_hits) = listen("api").await;
        let (plan_addr, plan_hits) = listen("plan").await;
        let dir = std::env::temp_dir().join(format!("ccswitch-turn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("cc-switch.db");
        let sql = format!(
            r#"CREATE TABLE providers (
                id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL,
                meta TEXT NOT NULL DEFAULT '{{}}', is_current INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (id, app_type));
            INSERT INTO providers VALUES ('api','codex','Shop API','{{"base_url":"http://{api_addr}/v1","api_key":"api-secret","model":"api-model"}}','{{}}',1);
            INSERT INTO providers VALUES ('plan','codex','Shop plan','{{"base_url":"http://{plan_addr}/v1","api_key":"plan-secret","model":"plan-model"}}','{{"usageScript":{{"templateType":"token_plan"}}}}',0);"#
        );
        assert!(std::process::Command::new("sqlite3").arg(&db).arg(sql).status().unwrap().success());
        let mut switch = Provider {
            id: "ccswitch".into(), name: "CC Switch".into(), kind: ProviderKind::CcSwitch,
            base_url: String::new(), secret: String::new(), model: "unused".into(),
            wire: Wire::OpenaiChat, profile_id: "codex:api".into(),
        };
        let http = reqwest::Client::new();
        let empty = DesignContext::default();
        let api_turn = run_turn_db(&http, &switch, "评价一下这一页", "", &empty, &[], &AtomicBool::new(false), &db, false).await.unwrap();
        assert!(api_turn.assistant.contains("api"), "{}", api_turn.assistant);
        assert!(api_turn.summary.contains("api:Bearer api-secret"), "{}", api_turn.summary);
        assert_eq!(api_hits.load(Ordering::SeqCst), 1);
        assert_eq!(plan_hits.load(Ordering::SeqCst), 0);
        switch.profile_id = "codex:plan".into();
        let plan_turn = run_turn_db(&http, &switch, "评价一下这一页", "", &empty, &[], &AtomicBool::new(false), &db, false).await.unwrap();
        assert!(plan_turn.assistant.contains("token-plan"), "{}", plan_turn.assistant);
        assert!(plan_turn.summary.contains("plan:Bearer plan-secret"), "{}", plan_turn.summary);
        assert!(!plan_turn.summary.contains("api-secret"));
        assert_eq!(api_hits.load(Ordering::SeqCst), 1);
        assert_eq!(plan_hits.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(dir).ok();
    }

    fn api(base: String) -> Provider {
        Provider {
            id: "api".into(), name: "API".into(), kind: ProviderKind::Api, base_url: base,
            secret: "k".into(), model: "m".into(), wire: Wire::OpenaiChat, profile_id: String::new(),
        }
    }

    async fn status_server(status: axum::http::StatusCode, body: &'static str) -> String {
        let app = axum::Router::new().route("/v1/chat/completions", axum::routing::post(move || async move { (status, body) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}/v1")
    }

    #[tokio::test]
    async fn configured_provider_failures_do_not_generate_or_fall_back() {
        let http = reqwest::Client::new();
        let message = "一键出图：做一个页面，标题 NETWORK_SHOULD_FAIL";
        for (status, code) in [(axum::http::StatusCode::SERVICE_UNAVAILABLE, "unavailable"), (axum::http::StatusCode::UNAUTHORIZED, "unauthorized"), (axum::http::StatusCode::TOO_MANY_REQUESTS, "rate_limited")] {
            let base = status_server(status, "no").await;
            let outcome = run_turn(&http, &api(base), message, "", &DesignContext::default(), &[], &AtomicBool::new(false), false).await.unwrap();
            assert!(outcome.operations.is_empty(), "{status} {:?}", outcome.operations);
            let failure = outcome.failure.expect("failure");
            assert_eq!(failure.code, code);
            assert_eq!(failure.status, Some(status.as_u16()));
            assert!(outcome.summary.contains(&status.as_u16().to_string()), "{}", outcome.summary);
            assert!(!outcome.assistant.contains("fallback"), "{}", outcome.assistant);
            assert!(!outcome.summary.contains("已生成"), "{}", outcome.summary);
        }
        let invalid = status_server(axum::http::StatusCode::OK, "not-json").await;
        let invalid_turn = run_turn(&http, &api(invalid), message, "", &DesignContext::default(), &[], &AtomicBool::new(false), false).await.unwrap();
        assert!(invalid_turn.operations.is_empty());
        assert_eq!(invalid_turn.failure.unwrap().code, "invalid_response");

        let hits = Arc::new(AtomicUsize::new(0));
        let seen = hits.clone();
        let app = axum::Router::new().route("/v1/chat/completions", axum::routing::post(move || {
            let seen = seen.clone();
            async move {
                seen.fetch_add(1, Ordering::SeqCst);
                (axum::http::StatusCode::SERVICE_UNAVAILABLE, "busy")
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let explicit = run_turn(&http, &api(format!("http://{address}/v1")), message, "", &DesignContext::default(), &[], &AtomicBool::new(false), true).await.unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        assert_eq!(explicit.assistant, "local-rules");
        assert!(explicit.failure.is_none());
        assert!(explicit.operations.iter().any(|op| op.method == "page.create"));
        assert!(explicit.summary.contains("NETWORK_SHOULD_FAIL") || explicit.operations.iter().any(|op| op.params.get("text").and_then(|value| value.as_str()) == Some("NETWORK_SHOULD_FAIL")));

        let slow = axum::Router::new().route("/v1/chat/completions", axum::routing::post(|| async {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            axum::Json(json!({"choices":[{"message":{"role":"assistant","content":"late"}}]}))
        }));
        let slow_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let slow_address = slow_listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(slow_listener, slow).await.unwrap() });
        let short = reqwest::Client::builder().timeout(std::time::Duration::from_millis(200)).build().unwrap();
        let timed = run_turn(&short, &api(format!("http://{slow_address}/v1")), message, "", &DesignContext::default(), &[], &AtomicBool::new(false), false).await.unwrap();
        assert!(timed.operations.is_empty());
        assert_eq!(timed.failure.unwrap().code, "timeout");
        assert!(timed.summary.contains("超时"));
    }
}
