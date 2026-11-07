//! Conversation items adapted from OpenAI Codex `codex-rs/protocol/src/items.rs`
//! (`TurnItem`: UserMessage, AgentMessage, Plan, McpToolCall) at
//! `c4f0e09912fd4c1173258ccd17e33284a876e826`.
//! Shell, review, compaction, and image-generation items are not included.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum TurnItem {
    UserMessage {
        id: String,
        text: String,
    },
    AgentMessage {
        id: String,
        text: String,
        phase: MessagePhase,
    },
    Plan {
        id: String,
        text: String,
    },
    McpToolCall {
        id: String,
        server: String,
        tool: String,
        arguments: Value,
        status: McpToolCallStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    FunctionCallOutput {
        id: String,
        name: String,
        output: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum MessagePhase {
    Commentary,
    Final,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum McpToolCallStatus {
    InProgress,
    Completed,
    Failed,
}

pub fn item_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
