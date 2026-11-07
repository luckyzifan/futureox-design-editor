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

async fn openai_turn(http: &reqwest::Client, provider: &Provider, system: &str, _latest: &str, items: &[TurnItem]) -> Result<ModelTurn, String> {
    let messages = openai_messages(system, items);
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

async fn anthropic_turn(http: &reqwest::Client, provider: &Provider, system: &str, _latest: &str, items: &[TurnItem]) -> Result<ModelTurn, String> {
    let messages = anthropic_messages(items);
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

pub fn skills_for(latest: &str, earlier: &str, ctx: &DesignContext) -> Vec<SkillId> {
    route_skills(latest, earlier, ctx)
}

/// Full session transcript for OpenAI Chat Completions. Tool results use the
/// MCP tool-call id, and the preceding assistant message carries `tool_calls`.
pub fn openai_messages(system: &str, items: &[TurnItem]) -> Vec<Value> {
    let mut messages = vec![json!({ "role": "system", "content": system })];
    let mut index = 0;
    let mut pending_plan = String::new();
    while index < items.len() {
        match &items[index] {
            TurnItem::ContextCompaction { summary, .. } => {
                messages.push(json!({ "role": "user", "content": format!("更早的对话摘要：\n{summary}") }));
                index += 1;
            }
            TurnItem::UserMessage { text, .. } => {
                messages.push(json!({ "role": "user", "content": text }));
                index += 1;
            }
            TurnItem::Plan { text, .. } => {
                pending_plan = text.clone();
                index += 1;
            }
            TurnItem::AgentMessage { text, .. } => {
                let calls = tool_calls_after(items, index + 1);
                let content = join_plan(&pending_plan, text);
                pending_plan.clear();
                if calls.is_empty() {
                    messages.push(json!({ "role": "assistant", "content": content }));
                    index += 1;
                } else {
                    messages.push(json!({
                        "role": "assistant",
                        "content": content,
                        "tool_calls": calls.iter().map(|(id, tool, arguments, _, _)| json!({
                            "id": id,
                            "type": "function",
                            "function": { "name": tool, "arguments": arguments.to_string() }
                        })).collect::<Vec<_>>()
                    }));
                    for (id, tool, _, result, error) in &calls {
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": id,
                            "content": tool_result_text(items, id, tool, result, error)
                        }));
                    }
                    index = calls_end(items, index + 1);
                }
            }
            TurnItem::McpToolCall { id, tool, arguments, result, error, .. } => {
                messages.push(json!({
                    "role": "assistant",
                    "content": pending_plan,
                    "tool_calls": [{
                        "id": id,
                        "type": "function",
                        "function": { "name": tool, "arguments": arguments.to_string() }
                    }]
                }));
                pending_plan.clear();
                messages.push(json!({ "role": "tool", "tool_call_id": id, "content": tool_result_text(items, id, tool, result, error) }));
                index += 1;
            }
            TurnItem::FunctionCallOutput { .. } => index += 1,
        }
    }
    if !pending_plan.is_empty() {
        messages.push(json!({ "role": "assistant", "content": format!("计划:\n{pending_plan}") }));
    }
    messages
}

pub fn anthropic_messages(items: &[TurnItem]) -> Vec<Value> {
    let mut messages = Vec::new();
    let mut index = 0;
    let mut pending_plan = String::new();
    while index < items.len() {
        match &items[index] {
            TurnItem::ContextCompaction { summary, .. } => {
                push_role(&mut messages, "user", json!(format!("更早的对话摘要：\n{summary}")));
                index += 1;
            }
            TurnItem::UserMessage { text, .. } => {
                push_role(&mut messages, "user", json!(text));
                index += 1;
            }
            TurnItem::Plan { text, .. } => {
                pending_plan = text.clone();
                index += 1;
            }
            TurnItem::AgentMessage { text, .. } => {
                let calls = tool_calls_after(items, index + 1);
                let mut blocks = vec![json!({ "type": "text", "text": join_plan(&pending_plan, text) })];
                pending_plan.clear();
                for (id, tool, arguments, _, _) in &calls {
                    blocks.push(json!({ "type": "tool_use", "id": id, "name": tool, "input": arguments }));
                }
                push_role(&mut messages, "assistant", Value::Array(blocks));
                if !calls.is_empty() {
                    let results = calls.iter().map(|(id, tool, _, result, error)| json!({
                        "type": "tool_result",
                        "tool_use_id": id,
                        "content": tool_result_text(items, id, tool, result, error)
                    })).collect::<Vec<_>>();
                    push_role(&mut messages, "user", Value::Array(results));
                    index = calls_end(items, index + 1);
                } else {
                    index += 1;
                }
            }
            TurnItem::McpToolCall { id, tool, arguments, result, error, .. } => {
                push_role(&mut messages, "assistant", json!([{ "type": "tool_use", "id": id, "name": tool, "input": arguments }]));
                push_role(&mut messages, "user", json!([{ "type": "tool_result", "tool_use_id": id, "content": tool_result_text(items, id, tool, result, error) }]));
                index += 1;
            }
            TurnItem::FunctionCallOutput { .. } => index += 1,
        }
    }
    messages
}

fn join_plan(plan: &str, text: &str) -> String {
    if plan.is_empty() { text.to_string() } else { format!("计划:\n{plan}\n{text}") }
}

fn tool_calls_after(items: &[TurnItem], start: usize) -> Vec<(String, String, Value, Option<Value>, Option<String>)> {
    let mut calls = Vec::new();
    for item in items.iter().skip(start) {
        match item {
            TurnItem::McpToolCall { id, tool, arguments, result, error, status, .. } if *status != crate::items::McpToolCallStatus::InProgress => {
                calls.push((id.clone(), tool.clone(), arguments.clone(), result.clone(), error.clone()));
            }
            TurnItem::FunctionCallOutput { .. } => {}
            _ => break,
        }
    }
    calls
}

fn calls_end(items: &[TurnItem], start: usize) -> usize {
    let mut index = start;
    while index < items.len() && matches!(items[index], TurnItem::McpToolCall { .. } | TurnItem::FunctionCallOutput { .. }) {
        index += 1;
    }
    index
}

fn tool_result_text(items: &[TurnItem], call_id: &str, tool: &str, result: &Option<Value>, error: &Option<String>) -> String {
    if let Some(TurnItem::FunctionCallOutput { output, .. }) = items.iter().find(|item| matches!(item, TurnItem::FunctionCallOutput { call_id: id, .. } if id == call_id)) {
        return output.clone();
    }
    if let Some(error) = error {
        return error.clone();
    }
    result.as_ref().map(|value| value.to_string()).unwrap_or_else(|| format!("{tool} 完成"))
}

fn push_role(messages: &mut Vec<Value>, role: &str, content: Value) {
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(Value::as_str) == Some(role) {
            let previous = last.get("content").cloned().unwrap_or(Value::Null);
            last["content"] = merge_content(previous, content);
            return;
        }
    }
    messages.push(json!({ "role": role, "content": content }));
}

fn merge_content(previous: Value, next: Value) -> Value {
    let mut blocks = content_blocks(previous);
    blocks.extend(content_blocks(next));
    Value::Array(blocks)
}

fn content_blocks(value: Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items,
        Value::String(text) => vec![json!({ "type": "text", "text": text })],
        other => vec![json!({ "type": "text", "text": other.to_string() })],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::items::{MessagePhase, McpToolCallStatus};

    fn sample_items() -> Vec<TurnItem> {
        vec![
            TurnItem::UserMessage { id: "u1".into(), text: "先做咖啡页".into() },
            TurnItem::AgentMessage { id: "a1".into(), text: "开始生成。".into(), phase: MessagePhase::Commentary },
            TurnItem::McpToolCall {
                id: "call_gen_1".into(),
                server: "futureox-design".into(),
                tool: "design_agent_generate".into(),
                arguments: json!({ "title": "秋日" }),
                status: McpToolCallStatus::Completed,
                result: Some(json!({ "summary": "已生成" })),
                error: None,
            },
            TurnItem::FunctionCallOutput { id: "out1".into(), call_id: "call_gen_1".into(), name: "design_agent_generate".into(), output: "{\"summary\":\"已生成\"}".into() },
            TurnItem::AgentMessage { id: "a2".into(), text: "页面好了。".into(), phase: MessagePhase::Final },
            TurnItem::UserMessage { id: "u2".into(), text: "把标题改成暖季".into() },
        ]
    }

    #[test]
    fn openai_history_pairs_the_tool_call_id_and_keeps_both_user_turns() {
        let messages = openai_messages("sys", &sample_items());
        let blob = serde_json::to_string(&messages).unwrap();
        assert!(blob.contains("先做咖啡页"));
        assert!(blob.contains("把标题改成暖季"));
        assert!(blob.contains("call_gen_1"));
        let tool = messages.iter().find(|message| message["role"] == "tool").unwrap();
        assert_eq!(tool["tool_call_id"], "call_gen_1");
        assert_ne!(tool["tool_call_id"], "design_agent_generate");
        let assistant = messages.iter().find(|message| message["tool_calls"].is_array()).unwrap();
        assert_eq!(assistant["tool_calls"][0]["id"], "call_gen_1");
        assert_eq!(assistant["tool_calls"][0]["function"]["name"], "design_agent_generate");
    }

    #[test]
    fn anthropic_history_includes_tool_use_and_the_matching_tool_result() {
        let messages = anthropic_messages(&sample_items());
        let blob = serde_json::to_string(&messages).unwrap();
        assert!(blob.contains("先做咖啡页"));
        assert!(blob.contains("把标题改成暖季"));
        let assistant = messages.iter().find(|message| message["role"] == "assistant" && message["content"].as_array().is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "tool_use"))).unwrap();
        let tool_use = assistant["content"].as_array().unwrap().iter().find(|block| block["type"] == "tool_use").unwrap();
        assert_eq!(tool_use["id"], "call_gen_1");
        let user = messages.iter().find(|message| message["role"] == "user" && message["content"].as_array().is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "tool_result"))).unwrap();
        let tool_result = user["content"].as_array().unwrap().iter().find(|block| block["type"] == "tool_result").unwrap();
        assert_eq!(tool_result["tool_use_id"], "call_gen_1");
    }
}
