//! Multiple model endpoints. API keys and token-plan tokens use the same
//! outbound HTTP client with different `kind` values. CC Switch
//! (https://github.com/farion1231/cc-switch) is read from `~/.cc-switch/cc-switch.db`
//! and its local router, default `http://127.0.0.1:15721`.

use std::path::{Path, PathBuf};
use std::process::Command;

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
        });
        let active = if items.iter().any(|item| item.id == "grok") { "grok" } else { "local" };
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
        if self.items.iter().any(|item| item.id == id) {
            self.active = id.to_string();
            Ok(())
        } else {
            Err(format!("unknown provider {id}"))
        }
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
    })
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

#[derive(Debug, Clone, Serialize)]
pub struct CcSwitchSnapshot {
    pub database: String,
    pub present: bool,
    pub proxy: Option<String>,
    pub providers: Vec<CcSwitchProvider>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CcSwitchProvider {
    pub id: String,
    pub app_type: String,
    pub name: String,
    pub current: bool,
}

pub fn ccswitch_db_path() -> PathBuf {
    if let Ok(path) = std::env::var("CCSWITCH_DB") {
        return PathBuf::from(path);
    }
    directories_home().join(".cc-switch").join("cc-switch.db")
}

fn directories_home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

pub async fn read_ccswitch(db: &Path) -> CcSwitchSnapshot {
    let db = db.to_path_buf();
    let path = db.display().to_string();
    let joined = tokio::join!(probe_listen(&db), read_db(db.clone()));
    let (proxy, providers) = joined;
    let present = providers.is_ok();
    let (providers, detail) = match providers {
        Ok(items) => (items, proxy.clone().unwrap_or_else(|| "proxy config unread".into())),
        Err(error) => (Vec::new(), error),
    };
    CcSwitchSnapshot { database: path, present, proxy: proxy.filter(|value| value.starts_with("http")), providers, detail }
}

async fn probe_listen(db: &Path) -> Option<String> {
    let db = db.to_path_buf();
    tokio::task::spawn_blocking(move || proxy_from_db(&db))
        .await
        .ok()
        .flatten()
}

async fn read_db(db: PathBuf) -> Result<Vec<CcSwitchProvider>, String> {
    tokio::task::spawn_blocking(move || providers_from_db(&db))
        .await
        .map_err(|error| error.to_string())?
}

fn providers_from_db(db: &Path) -> Result<Vec<CcSwitchProvider>, String> {
    if !db.exists() {
        return Err(format!("CC Switch database is not at {}", db.display()));
    }
    let rows = sqlite_json(db, "SELECT id, app_type, name, is_current FROM providers ORDER BY app_type, name LIMIT 80")?;
    let mut providers = Vec::new();
    for row in rows {
        providers.push(CcSwitchProvider {
            id: row.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            app_type: row.get("app_type").and_then(Value::as_str).unwrap_or_default().to_string(),
            name: row.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
            current: row.get("is_current").and_then(Value::as_i64).unwrap_or(0) == 1
                || row.get("is_current").and_then(Value::as_bool).unwrap_or(false),
        });
    }
    Ok(providers)
}

fn proxy_from_db(db: &Path) -> Option<String> {
    if !db.exists() {
        return None;
    }
    let rows = sqlite_json(
        db,
        "SELECT listen_address, listen_port, enabled, proxy_enabled FROM proxy_config WHERE enabled = 1 OR proxy_enabled = 1 LIMIT 1",
    )
    .ok()?;
    let row = rows.first()?;
    let address = row.get("listen_address").and_then(Value::as_str).unwrap_or("127.0.0.1");
    let port = row.get("listen_port").and_then(Value::as_i64).unwrap_or(15721);
    Some(format!("http://{address}:{port}/v1"))
}

fn sqlite_json(db: &Path, sql: &str) -> Result<Vec<Value>, String> {
    let output = Command::new("sqlite3")
        .arg("-json")
        .arg(db)
        .arg(sql)
        .output()
        .map_err(|error| format!("sqlite3: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(text).map_err(|error| error.to_string())
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
        })
        .unwrap();
        let json = serde_json::to_string(&set.views()).unwrap();
        assert!(!json.contains("super-secret-token"));
        assert!(json.contains("\"has_secret\":true"));
        assert_eq!(chat_url("http://127.0.0.1:15721/v1"), "http://127.0.0.1:15721/v1/chat/completions");
        assert_eq!(chat_url("https://api.example.test"), "https://api.example.test/v1/chat/completions");
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
        let status = Command::new("sqlite3").arg(&db).arg(sql).status().unwrap();
        assert!(status.success());
        let providers = providers_from_db(&db).unwrap();
        assert_eq!(providers[0].name, "Grok plan");
        assert!(providers[0].current);
        let dumped = format!("{providers:?}");
        assert!(!dumped.contains("do-not-leak"));
        assert_eq!(proxy_from_db(&db).as_deref(), Some("http://127.0.0.1:15721/v1"));
        fs::remove_dir_all(dir).ok();
    }
}
