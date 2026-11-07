//! Session compaction adapted from Codex context compaction: when the live
//! item list passes the window, older turns become one summary item. Recent
//! user, assistant, and tool records stay verbatim so tool-call ids still pair.

use crate::items::{item_id, TurnItem};

pub const COMPACT_AT: usize = 48;
pub const KEEP_RECENT: usize = 24;

pub fn compact_session(items: Vec<TurnItem>) -> Vec<TurnItem> {
    if items.len() <= COMPACT_AT {
        return items;
    }
    let mut split = items.len().saturating_sub(KEEP_RECENT);
    while split > 0 && !matches!(items[split], TurnItem::UserMessage { .. } | TurnItem::ContextCompaction { .. }) {
        split -= 1;
    }
    if split == 0 {
        return items;
    }
    let summary = summarize(&items[..split]);
    let mut kept = Vec::with_capacity(items.len() - split + 1);
    kept.push(TurnItem::ContextCompaction { id: item_id(), summary });
    kept.extend(items.into_iter().skip(split));
    if kept.len() > COMPACT_AT {
        return compact_session(kept);
    }
    kept
}

fn summarize(items: &[TurnItem]) -> String {
    let mut lines = Vec::new();
    for item in items {
        match item {
            TurnItem::ContextCompaction { summary, .. } => lines.push(format!("更早的摘要：{summary}")),
            TurnItem::UserMessage { text, .. } => lines.push(format!("用户：{}", clip(text, 240))),
            TurnItem::AgentMessage { text, .. } => lines.push(format!("助手：{}", clip(text, 240))),
            TurnItem::Plan { text, .. } => lines.push(format!("计划：{}", clip(text, 180))),
            TurnItem::McpToolCall { tool, id, result, error, .. } => {
                let brief = result.as_ref().and_then(|value| value.get("summary")).and_then(|value| value.as_str()).unwrap_or(error.as_deref().unwrap_or("完成"));
                lines.push(format!("工具 {tool}（调用 {id}）：{}", clip(brief, 180)));
            }
            TurnItem::FunctionCallOutput { .. } => {}
        }
    }
    let mut text = lines.join("\n");
    if text.chars().count() > 4000 {
        text = text.chars().take(4000).collect();
    }
    if text.is_empty() { "（较早的对话没有可保留的文字）".into() } else { text }
}

fn clip(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::items::MessagePhase;

    #[test]
    fn compaction_keeps_a_summary_of_dropped_turns() {
        let mut items = Vec::new();
        for index in 0..30 {
            items.push(TurnItem::UserMessage { id: format!("u{index}"), text: format!("旧需求 {index} 咖啡海报") });
            items.push(TurnItem::AgentMessage { id: format!("a{index}"), text: format!("已处理 {index}"), phase: MessagePhase::Final });
        }
        items.push(TurnItem::UserMessage { id: "latest".into(), text: "最新：把标题改成暖季".into() });
        assert!(items.len() > COMPACT_AT);
        let compacted = compact_session(items);
        assert!(compacted.len() <= COMPACT_AT, "{}", compacted.len());
        let TurnItem::ContextCompaction { summary, .. } = &compacted[0] else { panic!("missing summary") };
        assert!(summary.contains("旧需求 0"), "{summary}");
        assert!(summary.contains("咖啡海报"), "{summary}");
        assert!(compacted.iter().any(|item| matches!(item, TurnItem::UserMessage { text, .. } if text.contains("暖季"))));
        assert!(!compacted.iter().skip(1).any(|item| matches!(item, TurnItem::UserMessage { text, .. } if text.contains("旧需求 0"))));
    }
}
