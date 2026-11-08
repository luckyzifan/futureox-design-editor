//! Multiple model endpoints. API keys and token-plan tokens use the same
//! outbound HTTP client with different `kind` values. CC Switch
//! (https://github.com/farion1231/cc-switch) is read from `~/.cc-switch/cc-switch.db`
//! and its local router, default `http://127.0.0.1:15721`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Api,
    TokenPlan,
    CcSwitch,
    Local,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Wire {
    OpenaiChat,
    Anthropic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    #[serde(default)]
    pub secret: String,
    pub model: String,
    pub wire: Wire,
    /// `app_type:provider_id` inside a CC Switch database. Empty for API and token-plan rows saved here.
    #[serde(default)]
    pub profile_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderView {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub model: String,
    pub base_url: String,
    pub active: bool,
    pub has_secret: bool,
}

#[derive(Debug, Clone)]
pub struct ProviderSet {
    pub items: Vec<Provider>,
    pub active: String,
}

impl ProviderSet {
    pub fn from_env() -> Self {
        let mut items = vec![Provider {
            id: "local".into(),
            name: "当前 Grok / Cursor 助手（本机）".into(),
            kind: ProviderKind::Local,
            base_url: String::new(),
            secret: String::new(),
            model: "grok-local".into(),
            wire: Wire::OpenaiChat,
            profile_id: String::new(),
        }];
        if let Some(provider) = env_provider(
            "grok",
            "Grok",
            ProviderKind::Api,
            "GROK_ASSISTANT_BASE_URL",
            "GROK_ASSISTANT_API_KEY",
            "GROK_ASSISTANT_MODEL",
            "grok-4",
        ) {
            items.push(provider);
        }
        if let Some(provider) = env_provider(
            "api",
            "API",
            ProviderKind::Api,
            "DESIGN_AGENT_API_BASE_URL",
            "DESIGN_AGENT_API_KEY",
            "DESIGN_AGENT_API_MODEL",
            "gpt-4.1",
        ) {
            items.push(provider);
        }
        if let Some(provider) = env_provider(
            "token-plan",
            "Token plan",
            ProviderKind::TokenPlan,
            "DESIGN_AGENT_TOKEN_PLAN_URL",
            "DESIGN_AGENT_TOKEN_PLAN_TOKEN",
            "DESIGN_AGENT_TOKEN_PLAN_MODEL",
            "token-plan",
        ) {
            items.push(provider);
        }
        items.push(Provider {
            id: "ccswitch".into(),
            name: "CC Switch".into(),
            kind: ProviderKind::CcSwitch,
            base_url: std::env::var("CCSWITCH_PROXY_URL").unwrap_or_else(|_| "http://127.0.0.1:15721/v1".into()),
            secret: std::env::var("CCSWITCH_PROXY_TOKEN").unwrap_or_default(),
            model: std::env::var("CCSWITCH_MODEL").unwrap_or_else(|_| "gpt-5.4".into()),
            wire: Wire::OpenaiChat,
            profile_id: String::new(),
        });
        let active = startup_active(&items).to_string();
        Self { items, active: active.into() }
    }

    pub fn active(&self) -> Option<&Provider> {
        self.items.iter().find(|item| item.id == self.active)
    }

    pub fn views(&self) -> Vec<ProviderView> {
        self.items
            .iter()
            .map(|item| ProviderView {
                id: item.id.clone(),
                name: item.name.clone(),
                kind: item.kind,
                model: item.model.clone(),
                base_url: item.base_url.clone(),
                active: item.id == self.active,
                has_secret: !item.secret.is_empty(),
            })
            .collect()
    }

    pub fn upsert(&mut self, mut provider: Provider) -> Result<(), String> {
        validate(&provider)?;
        if provider.kind == ProviderKind::Local {
            provider.secret.clear();
            provider.base_url.clear();
        }
        let id = provider.id.clone();
        if let Some(existing) = self.items.iter_mut().find(|item| item.id == id) {
            if provider.secret.is_empty() {
                provider.secret = existing.secret.clone();
            }
            *existing = provider;
        } else {
            self.items.push(provider);
        }
        if self.active.is_empty() {
            self.active = id;
        }
        Ok(())
    }

    pub fn activate(&mut self, id: &str) -> Result<(), String> {
        self.activate_with_profile(id, "")
    }

    pub fn activate_with_profile(&mut self, id: &str, profile_id: &str) -> Result<(), String> {
        let Some(item) = self.items.iter_mut().find(|item| item.id == id) else {
            return Err(format!("unknown provider {id}"));
        };
        if !profile_id.is_empty() {
            if item.kind != ProviderKind::CcSwitch {
                return Err("a CC Switch profile can only be selected on the CC Switch connection".into());
            }
            if !profile_id.contains(':') || profile_id.len() > 160 {
                return Err("CC Switch profile id must look like app:provider".into());
            }
            item.profile_id = profile_id.to_string();
        }
        self.active = id.to_string();
        Ok(())
    }

    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        if id == "local" {
            return Err("the local assistant stays available".into());
        }
        let before = self.items.len();
        self.items.retain(|item| item.id != id);
        if self.items.len() == before {
            return Err(format!("unknown provider {id}"));
        }
        if self.active == id {
            self.active = "local".into();
        }
        Ok(())
    }
}

fn env_provider(id: &str, name: &str, kind: ProviderKind, url_key: &str, secret_key: &str, model_key: &str, default_model: &str) -> Option<Provider> {
    let secret = std::env::var(secret_key).unwrap_or_default();
    let base_url = std::env::var(url_key).unwrap_or_default();
    if secret.is_empty() || base_url.is_empty() {
        return None;
    }
    Some(Provider {
        id: id.into(),
        name: name.into(),
        kind,
        base_url,
        secret,
        model: std::env::var(model_key).unwrap_or_else(|_| default_model.into()),
        wire: Wire::OpenaiChat,
        profile_id: String::new(),
    })
}

pub(crate) fn startup_active(items: &[Provider]) -> &'static str {
    if items.iter().any(|item| item.id == "grok") { "grok" } else { "local" }
}

pub fn validate(provider: &Provider) -> Result<(), String> {
    if !provider.id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_') || provider.id.is_empty() || provider.id.len() > 64 {
        return Err("provider id must be 1–64 letters, numbers, - or _".into());
    }
    if provider.name.trim().is_empty() || provider.name.chars().count() > 80 {
        return Err("provider name must be 1–80 characters".into());
    }
    if provider.model.trim().is_empty() || provider.model.len() > 120 {
        return Err("model name must be 1–120 characters".into());
    }
    if provider.secret.len() > 512 || provider.secret.chars().any(|ch| ch.is_control()) {
        return Err("secret must be a single line of at most 512 characters".into());
    }
    if provider.kind != ProviderKind::Local {
        let url = &provider.base_url;
        if !(url.starts_with("http://") || url.starts_with("https://")) || url.len() > 300 || url.chars().any(|ch| ch.is_control()) {
            return Err("base URL must be an http(s) URL".into());
        }
    }
    Ok(())
}

pub fn chat_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/v1") { format!("{base}/chat/completions") } else { format!("{base}/v1/chat/completions") }
}

pub fn anthropic_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/v1") { format!("{base}/messages") } else { format!("{base}/v1/messages") }
}

pub fn tool_schema() -> Value {
    json!([
        { "type": "function", "function": { "name": "design_agent_read", "description": "Read page names and text already on the target page.", "parameters": { "type": "object", "properties": {}, "additionalProperties": false } } },
        { "type": "function", "function": { "name": "design_agent_generate", "description": "Create one editable page with nav, title, subtitle, three points, button and footer.", "parameters": { "type": "object", "properties": { "title": { "type": "string" }, "subtitle": { "type": "string" }, "features": { "type": "array", "items": { "type": "string" } }, "accent": { "type": "string" } }, "additionalProperties": false } } },
        { "type": "function", "function": { "name": "design_agent_adjust", "description": "Change text, fill, or corner radius on the target page. Name another page in the user message to switch.", "parameters": { "type": "object", "properties": { "text": { "type": "string" }, "fill": { "type": "string" }, "radius": { "type": "number" } }, "additionalProperties": false } } },
        { "type": "function", "function": { "name": "design_agent_layout", "description": "Snap existing text on the target page to an 8px rhythm.", "parameters": { "type": "object", "properties": {}, "additionalProperties": false } } },
        { "type": "function", "function": { "name": "design_agent_style", "description": "Recolor the target page frame.", "parameters": { "type": "object", "properties": { "fill": { "type": "string" } }, "additionalProperties": false } } },
        { "type": "function", "function": { "name": "design_agent_critique", "description": "Comment on the target page text without writing.", "parameters": { "type": "object", "properties": {}, "additionalProperties": false } } }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn views_hide_secrets_and_ccswitch_url_matches_the_documented_port() {
        let mut set = ProviderSet::from_env();
        set.upsert(Provider {
            id: "plan".into(),
            name: "Plan".into(),
            kind: ProviderKind::TokenPlan,
            base_url: "https://plan.example.test/v1".into(),
            secret: "super-secret-token".into(),
            model: "plan-model".into(),
            wire: Wire::OpenaiChat,
            profile_id: String::new(),
        })
        .unwrap();
        let json = serde_json::to_string(&set.views()).unwrap();
        assert!(!json.contains("super-secret-token"));
        assert!(json.contains("\"has_secret\":true"));
        assert_eq!(chat_url("http://127.0.0.1:15721/v1"), "http://127.0.0.1:15721/v1/chat/completions");
        assert_eq!(chat_url("https://api.example.test"), "https://api.example.test/v1/chat/completions");
        assert_eq!(startup_active(&set.items), "local");
        set.items.insert(1, Provider { id: "grok".into(), name: "Grok".into(), kind: ProviderKind::Api, base_url: "https://grok.example/v1".into(), secret: "g".into(), model: "grok-4".into(), wire: Wire::OpenaiChat, profile_id: String::new() });
        assert_eq!(startup_active(&set.items), "grok");
    }

    #[test]
    fn reads_a_real_ccswitch_shaped_database_without_returning_the_key() {
        let dir = std::env::temp_dir().join(format!("ccswitch-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let db = dir.join("cc-switch.db");
        let sql = r#"CREATE TABLE providers (id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL, is_current BOOLEAN NOT NULL DEFAULT 0, PRIMARY KEY (id, app_type));
INSERT INTO providers VALUES ('grok-plan','codex','Grok plan','{"api_key":"do-not-leak"}',1);
CREATE TABLE proxy_config (app_type TEXT PRIMARY KEY, listen_address TEXT NOT NULL, listen_port INTEGER NOT NULL, enabled INTEGER NOT NULL, proxy_enabled INTEGER NOT NULL);
INSERT INTO proxy_config VALUES ('codex','127.0.0.1',15721,1,1);"#;
        let status = std::process::Command::new("sqlite3").arg(&db).arg(sql).status().unwrap();
        assert!(status.success());
        let snapshot = crate::ccswitch::load_catalog(&db).snapshot();
        assert_eq!(snapshot.providers[0].name, "Grok plan");
        assert!(snapshot.providers[0].current);
        let dumped = serde_json::to_string(&snapshot).unwrap();
        assert!(!dumped.contains("do-not-leak"));
        assert_eq!(snapshot.proxy.as_deref(), Some("http://127.0.0.1:15721/v1"));
        fs::remove_dir_all(dir).ok();
    }
}
