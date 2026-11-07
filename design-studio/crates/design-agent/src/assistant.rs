//! Model calls. The first choice is the active provider (Grok when configured).
//! Token-plan and generic API endpoints share the OpenAI chat wire; Anthropic
//! token plans use the Messages API. CC Switch is the local router at
//! `/v1/chat/completions`. If the network call fails, the same turn continues
//! on the in-process assistant so the page still changes.

use serde_json::{json, Value};

use crate::items::TurnItem;
use crate::operations::DesignContext;
use crate::providers::{anthropic_url, chat_url, tool_schema, Provider, ProviderKind, Wire};
use crate::skills::{route_skills, SkillId};

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone)]
pub struct ModelTurn {
    pub plan: Option<String>,
    pub message: Option<String>,
    pub tool_calls: Vec<ToolCall>,
}

pub fn local_turn(latest: &str, earlier: &str, items: &[TurnItem], skills: &[SkillId]) -> ModelTurn {
    let current_turn = items.iter().rev().take_while(|item| !matches!(item, TurnItem::UserMessage { .. }));
    if current_turn.clone().any(|item| matches!(item, TurnItem::FunctionCallOutput { .. })) {
        let notes = current_turn.filter_map(|item| match item {
            TurnItem::McpToolCall { result: Some(result), .. } => result.get("summary").and_then(Value::as_str),
            _ => None,
        }).collect::<Vec<_>>();
        let summary = if notes.is_empty() { "这一轮没有新的画布改动。".into() } else { notes.into_iter().rev().collect::<Vec<_>>().join(" ") };
        return ModelTurn { plan: None, message: Some(summary), tool_calls: Vec::new() };
    }
    let plan = skills.iter().map(|skill| format!("- {}", skill.guide())).collect::<Vec<_>>().join("\n");
    let tool_calls = crate::operations::tools_for(skills)
        .into_iter()
        .map(|name| ToolCall { id: format!("local-{name}"), name: name.into(), arguments: json!({}) })
        .collect();
    let _ = (latest, earlier);
    ModelTurn { plan: Some(plan), message: Some("按对话里选中的技能执行。".into()), tool_calls }
}

pub async fn remote_turn(http: &reqwest::Client, provider: &Provider, latest: &str, skills: &[SkillId], items: &[TurnItem]) -> Result<ModelTurn, String> {
    if provider.kind == ProviderKind::Local || provider.base_url.is_empty() {
        return Err("local provider has no endpoint".into());
    }
    let system = format!(
        "你是 Futureox 的页面设计助手。只通过工具改画布。技能已经按这段对话选好：{}。\n{}",
        skills.iter().map(|skill| skill.as_str()).collect::<Vec<_>>().join(", "),
        skills.iter().map(|skill| skill.guide()).collect::<Vec<_>>().join("\n")
    );
    match provider.wire {
        Wire::OpenaiChat => openai_turn(http, provider, &system, latest, items).await,
        Wire::Anthropic => anthropic_turn(http, provider, &system, latest, items).await,
    }
}

async fn openai_turn(http: &reqwest::Client, provider: &Provider, system: &str, latest: &str, items: &[TurnItem]) -> Result<ModelTurn, String> {
    let mut messages = vec![json!({ "role": "system", "content": system }), json!({ "role": "user", "content": latest })];
    for item in items {
        match item {
            TurnItem::FunctionCallOutput { name, output, .. } => {
                messages.push(json!({ "role": "tool", "tool_call_id": name, "content": output }));
            }
            TurnItem::AgentMessage { text, .. } => messages.push(json!({ "role": "assistant", "content": text })),
            _ => {}
        }
    }
    let response = http
        .post(chat_url(&provider.base_url))
        .bearer_auth(&provider.secret)
        .json(&json!({ "model": provider.model, "messages": messages, "tools": tool_schema(), "tool_choice": "auto" }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("provider status {}", response.status()));
    }
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    let message = body.pointer("/choices/0/message").cloned().unwrap_or(json!({}));
    let text = message.get("content").and_then(Value::as_str).map(str::to_string);
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|calls| calls.iter().filter_map(parse_openai_call).collect())
        .unwrap_or_default();
    Ok(ModelTurn { plan: None, message: text, tool_calls })
}

fn parse_openai_call(value: &Value) -> Option<ToolCall> {
    let name = value.pointer("/function/name")?.as_str()?.to_string();
    let arguments = value.pointer("/function/arguments").and_then(Value::as_str).and_then(|text| serde_json::from_str(text).ok()).unwrap_or_else(|| json!({}));
    Some(ToolCall { id: value.get("id").and_then(Value::as_str).unwrap_or("call").to_string(), name, arguments })
}

async fn anthropic_turn(http: &reqwest::Client, provider: &Provider, system: &str, latest: &str, items: &[TurnItem]) -> Result<ModelTurn, String> {
    let mut messages = vec![json!({ "role": "user", "content": latest })];
    for item in items {
        if let TurnItem::FunctionCallOutput { name, output, .. } = item {
            messages.push(json!({ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": name, "content": output }] }));
        }
    }
    let tools = tool_schema()
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|tool| {
            Some(json!({
                "name": tool.pointer("/function/name")?.as_str()?,
                "description": tool.pointer("/function/description")?.as_str()?,
                "input_schema": tool.pointer("/function/parameters")?.clone()
            }))
        })
        .collect::<Vec<_>>();
    let response = http
        .post(anthropic_url(&provider.base_url))
        .header("x-api-key", &provider.secret)
        .header("anthropic-version", "2023-06-01")
        .json(&json!({ "model": provider.model, "max_tokens": 1024, "system": system, "messages": messages, "tools": tools }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("provider status {}", response.status()));
    }
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    let blocks = body.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
    let text = blocks
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                block.get("text").and_then(Value::as_str)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let tool_calls = blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
        .map(|block| ToolCall {
            id: block.get("id").and_then(Value::as_str).unwrap_or("tool").into(),
            name: block.get("name").and_then(Value::as_str).unwrap_or_default().into(),
            arguments: block.get("input").cloned().unwrap_or_else(|| json!({})),
        })
        .collect();
    Ok(ModelTurn { plan: None, message: (!text.is_empty()).then_some(text), tool_calls })
}

pub fn skills_for(latest: &str, earlier: &str, _ctx: &DesignContext) -> Vec<SkillId> {
    route_skills(latest, earlier)
}
