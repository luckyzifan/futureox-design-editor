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

pub fn local_turn(latest: &str, earlier: &str, items: &[TurnItem], skills: &[SkillId], ctx: &DesignContext) -> ModelTurn {
    let current_turn = items.iter().rev().take_while(|item| !matches!(item, TurnItem::UserMessage { .. }));
    if skills.iter().all(|skill| *skill == SkillId::Critique) && !crate::skills::looks_like_mutation(latest) {
        return ModelTurn {
            plan: None,
            message: Some(answer_design_question(latest, items, ctx)),
            tool_calls: Vec::new(),
        };
    }
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
    let _ = (latest, earlier, ctx);
    ModelTurn { plan: Some(plan), message: Some("按对话里选中的技能执行。".into()), tool_calls }
}

pub async fn remote_turn(http: &reqwest::Client, provider: &Provider, latest: &str, skills: &[SkillId], items: &[TurnItem], ctx: &DesignContext) -> Result<ModelTurn, String> {
    if provider.kind == ProviderKind::Local || provider.base_url.is_empty() {
        return Err("local provider has no endpoint".into());
    }
    let system = format!(
        "你是 Futureox 的页面设计助手。只回答和修改设计：页面、画板、文字、颜色、字体、布局。不要写程序，不要建议代码。技能已经按这段对话选好：{}。\n{}\n{}",
        skills.iter().map(|skill| skill.as_str()).collect::<Vec<_>>().join(", "),
        skills.iter().map(|skill| skill.guide()).collect::<Vec<_>>().join("\n"),
        design_context_text(ctx)
    );
    let _ = latest;
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

/// Codex `clone_history` sends the stored session back to the model. This is
/// the design-only slice of that: prior turns plus the live page, selection,
/// and node fields. It is not a coding transcript.
pub fn design_context_text(ctx: &DesignContext) -> String {
    let page_name = ctx.pages.iter().find(|page| page.id == ctx.current_page_id).map(|page| page.name.as_str()).unwrap_or("未命名");
    let target_id = ctx.target_page_id.clone().filter(|id| !id.is_empty()).unwrap_or_else(|| ctx.current_page_id.clone());
    let target_name = ctx.pages.iter().find(|page| page.id == target_id).map(|page| page.name.as_str()).unwrap_or(page_name);
    let selection = if ctx.selection.is_empty() {
        "无".into()
    } else {
        ctx.selection.iter().map(|id| ctx.nodes.iter().find(|node| &node.id == id).map(|node| node.name.as_str()).unwrap_or(id.as_str())).collect::<Vec<_>>().join("、")
    };
    let layers = ctx.nodes.iter().take(24).map(|node| {
        format!(
            "{}（{}）{}{}{}{}{}{}{}",
            node.name,
            node.kind,
            node.text.as_ref().map(|text| format!(" 文字「{text}」")).unwrap_or_default(),
            node.fill.as_ref().map(|fill| format!(" 填充 {fill}")).unwrap_or_default(),
            node.opacity.map(|opacity| format!(" 不透明度 {opacity}")).unwrap_or_default(),
            node.corner_radius.as_ref().map(|radius| format!(" 圆角 {radius}")).unwrap_or_default(),
            node.font_size.map(|size| format!(" 字号 {size}")).unwrap_or_default(),
            node.font_id.as_ref().map(|font| format!(" 字体 {font}")).unwrap_or_default(),
            node.stroke.as_ref().map(|stroke| format!(
                " 描边 {stroke}{}{}{}{}{}",
                node.stroke_width.map(|width| format!(" {width}px")).unwrap_or_default(),
                node.stroke_align.as_ref().map(|align| format!(" {align}")).unwrap_or_default(),
                node.stroke_cap.as_ref().map(|cap| format!(" {cap}")).unwrap_or_default(),
                node.stroke_join.as_ref().map(|join| format!(" {join}")).unwrap_or_default(),
                node.stroke_dash.as_ref().map(|dash| format!(" {dash}")).unwrap_or_default()
            )).unwrap_or_default()
        )
    }).collect::<Vec<_>>().join("；");
    format!("当前页「{page_name}」。目标页「{target_name}」。选中：{selection}。图层：{layers}")
}

pub fn answer_design_question(latest: &str, items: &[TurnItem], ctx: &DesignContext) -> String {
    let prior_users = items.iter().filter_map(|item| match item {
        TurnItem::UserMessage { text, .. } if text != latest => Some(text.as_str()),
        _ => None,
    }).collect::<Vec<_>>();
    let prior_assistants = items.iter().filter_map(|item| match item {
        TurnItem::AgentMessage { text, .. } => Some(text.as_str()),
        TurnItem::Plan { text, .. } => Some(text.as_str()),
        TurnItem::FunctionCallOutput { output, .. } => Some(output.as_str()),
        TurnItem::McpToolCall { result: Some(result), .. } => result.get("summary").and_then(Value::as_str),
        _ => None,
    }).collect::<Vec<_>>();
    let mentioned = ctx.nodes.iter().find(|node| latest.contains(node.name.as_str()) || (latest.contains("按钮") && node.name.contains("按钮")) || (latest.contains("标题") && (node.name.contains("标题") || node.kind == "text")));
    let about = if let Some(node) = mentioned {
        format!(
            "提到的图层是「{}」，类型 {}{}{}{}{}{}{}{}。",
            node.name,
            node.kind,
            node.text.as_ref().map(|text| format!("，文字「{text}」")).unwrap_or_default(),
            node.fill.as_ref().map(|fill| format!("，填充 {fill}")).unwrap_or_default(),
            node.opacity.map(|opacity| format!("，不透明度 {opacity}")).unwrap_or_default(),
            node.corner_radius.as_ref().map(|radius| format!("，圆角 {radius}")).unwrap_or_default(),
            node.font_size.map(|size| format!("，字号 {size}")).unwrap_or_default(),
            node.font_id.as_ref().map(|font| format!("，字体 {font}")).unwrap_or_default(),
            node.stroke.as_ref().map(|stroke| format!(
                "，描边 {stroke}{}{}{}{}{}",
                node.stroke_width.map(|width| format!(" {width}px")).unwrap_or_default(),
                node.stroke_align.as_ref().map(|align| format!(" {align}")).unwrap_or_default(),
                node.stroke_cap.as_ref().map(|cap| format!(" {cap}")).unwrap_or_default(),
                node.stroke_join.as_ref().map(|join| format!(" {join}")).unwrap_or_default(),
                node.stroke_dash.as_ref().map(|dash| format!(" {dash}")).unwrap_or_default()
            )).unwrap_or_default()
        )
    } else {
        "当前上下文里没有和这句话同名的图层。".into()
    };
    let earlier = if prior_users.is_empty() { "这是这次会话的第一句。".into() } else { format!("之前你说过：{}。", prior_users.join(" / ")) };
    let said = if prior_assistants.is_empty() { String::new() } else { format!("助手说过：{}。", prior_assistants.join(" / ")) };
    format!("{earlier}{said}{} {about}这只讨论设计，不写代码。", design_context_text(ctx))
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

    #[test]
    fn a_follow_up_design_question_uses_earlier_turns_and_the_live_canvas() {
        let ctx = crate::operations::DesignContext {
            current_page_id: "page-1".into(),
            target_page_id: Some("page-1".into()),
            pages: vec![crate::operations::PageRef { id: "page-1".into(), name: "秋日特惠".into() }],
            nodes: vec![crate::operations::NodeRef {
                id: "button".into(), page_id: "page-1".into(), parent_id: None, name: "按钮".into(), kind: "rectangle".into(),
                x: 0.0, y: 0.0, width: 80.0, height: 32.0, text: None, fill: Some("#3459d4".into()), stroke: Some("#e05634".into()), stroke_width: Some(2.0), stroke_align: Some("inside".into()), stroke_cap: Some("round".into()), stroke_join: Some("miter".into()), stroke_dash: Some("4 2".into()), opacity: Some(0.5), corner_radius: Some("8".into()), font_size: Some(16.0), font_id: Some("sans".into()),
            }],
            selection: vec!["button".into()],
        };
        let items = vec![
            TurnItem::UserMessage { id: "u1".into(), text: "标题先用秋日特惠".into() },
            TurnItem::AgentMessage { id: "a1".into(), text: "已把标题写成秋日特惠。".into(), phase: MessagePhase::Final },
            TurnItem::UserMessage { id: "u2".into(), text: "这个按钮是什么颜色？".into() },
        ];
        let turn = local_turn("这个按钮是什么颜色？", "标题先用秋日特惠", &items, &[crate::skills::SkillId::Critique], &ctx);
        assert!(turn.tool_calls.is_empty());
        let message = turn.message.unwrap();
        assert!(message.contains("标题先用秋日特惠"), "{message}");
        assert!(message.contains("已把标题写成秋日特惠"), "{message}");
        assert!(message.contains("#3459d4"), "{message}");
        assert!(message.contains("#e05634"), "{message}");
        assert!(message.contains("2px"), "{message}");
        assert!(message.contains("inside"), "{message}");
        assert!(message.contains("round"), "{message}");
        assert!(message.contains("miter"), "{message}");
        assert!(message.contains("4 2"), "{message}");
        assert!(message.contains("不透明度 0.5"), "{message}");
        assert!(message.contains("圆角 8"), "{message}");
        assert!(message.contains("字号 16"), "{message}");
        assert!(message.contains("字体 sans"), "{message}");
        assert!(message.contains("秋日特惠"), "{message}");
        let with_tool = {
            let mut items = items.clone();
            items.insert(2, TurnItem::Plan { id: "p1".into(), text: "先改标题，再看按钮。".into() });
            items.insert(3, TurnItem::McpToolCall {
                id: "call_style_1".into(), server: "design".into(), tool: "design_agent_adjust".into(),
                arguments: json!({}), status: crate::items::McpToolCallStatus::Completed,
                result: Some(json!({ "summary": "按钮填充已写成 #3459d4" })), error: None,
            });
            items.insert(4, TurnItem::FunctionCallOutput { id: "out".into(), call_id: "call_style_1".into(), name: "design_agent_adjust".into(), output: "按钮填充已写成 #3459d4".into() });
            items
        };
        let followed = local_turn("这个按钮是什么颜色？", "标题先用秋日特惠", &with_tool, &[crate::skills::SkillId::Critique], &ctx);
        assert!(followed.tool_calls.is_empty());
        let followed_message = followed.message.unwrap();
        assert!(followed_message.contains("先改标题，再看按钮"), "{followed_message}");
        assert!(followed_message.contains("按钮填充已写成 #3459d4"), "{followed_message}");
        assert!(!message.contains("fn ") && !message.contains("function "), "{message}");
        let system = design_context_text(&ctx);
        assert!(openai_messages(&system, &with_tool).iter().any(|message| message["tool_call_id"] == "call_style_1"));
        let messages = openai_messages(&system, &items);
        let blob = serde_json::to_string(&messages).unwrap();
        assert!(blob.contains("标题先用秋日特惠") && blob.contains("这个按钮是什么颜色") && blob.contains("#3459d4"), "{blob}");
    }
}
