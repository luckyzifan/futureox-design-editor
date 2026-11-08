//! Switch the design agent's AI endpoint. Adapted from the provider row in
//! farion1231/cc-switch `b184a88c99428571d718d10d1a1403e9502cd28b`
//! (MIT, Copyright (c) 2025 Jason Young).
//!
//! A saved profile is a base URL, a key, and whether that key is an API key or
//! a token plan. Selecting one profile is the whole switch: the next design
//! turn calls that endpoint. Failover queues, the local proxy, circuit
//! breakers, OAuth, and the CC Switch app UI are not included.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::Value;

use crate::providers::{Provider, ProviderKind, Wire};

#[derive(Clone)]
pub struct Profile {
    pub id: String,
    pub app_type: String,
    pub name: String,
    pub current: bool,
    pub base_url: String,
    pub secret: String,
    pub model: String,
    pub wire: Wire,
    pub kind: ProviderKind,
}

impl Profile {
    pub fn key(&self) -> String {
        format!("{}:{}", self.app_type, self.id)
    }

    pub fn routed(&self) -> bool {
        !self.base_url.is_empty() && !self.secret.is_empty()
    }

    pub fn as_provider(&self) -> Provider {
        Provider {
            id: format!("ccswitch-{}", self.key().replace(':', "-")),
            name: self.name.clone(),
            kind: self.kind,
            base_url: self.base_url.clone(),
            secret: self.secret.clone(),
            model: self.model.clone(),
            wire: self.wire,
            profile_id: self.key(),
        }
    }
}

#[derive(Clone, Default)]
pub struct Catalog {
    pub database: String,
    pub profiles: Vec<Profile>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SwitchView {
    pub id: String,
    pub app_type: String,
    pub name: String,
    pub current: bool,
    pub kind: String,
    pub model: String,
    pub base_url: String,
    pub has_secret: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SwitchSnapshot {
    pub database: String,
    pub present: bool,
    pub providers: Vec<SwitchView>,
    pub detail: String,
}

impl Catalog {
    pub fn snapshot(&self) -> SwitchSnapshot {
        SwitchSnapshot {
            database: self.database.clone(),
            present: self.detail.is_empty() || !self.profiles.is_empty(),
            providers: self.profiles.iter().map(|profile| SwitchView {
                id: profile.id.clone(),
                app_type: profile.app_type.clone(),
                name: profile.name.clone(),
                current: profile.current,
                kind: match profile.kind {
                    ProviderKind::TokenPlan => "token_plan".into(),
                    ProviderKind::Api => "api".into(),
                    ProviderKind::CcSwitch => "ccswitch".into(),
                    ProviderKind::Local => "local".into(),
                },
                model: profile.model.clone(),
                base_url: profile.base_url.clone(),
                has_secret: !profile.secret.is_empty(),
            }).collect(),
            detail: self.detail.clone(),
        }
    }
}

pub fn default_db() -> PathBuf {
    if let Ok(path) = std::env::var("CCSWITCH_DB") {
        return PathBuf::from(path);
    }
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(".")).join(".cc-switch").join("cc-switch.db")
}

pub fn load_catalog(db: &Path) -> Catalog {
    let database = db.display().to_string();
    if !db.exists() {
        return Catalog { database, detail: format!("CC Switch database is not at {}", db.display()), ..Catalog::default() };
    }
    match read_rows(db) {
        Ok(profiles) => Catalog { database, profiles, detail: String::new() },
        Err(detail) => Catalog { database, detail, ..Catalog::default() },
    }
}

/// One endpoint. A named profile wins. Otherwise the current row that has an address and a key.
pub fn select_profile<'a>(catalog: &'a Catalog, profile_id: &str) -> Option<&'a Profile> {
    if !profile_id.is_empty() {
        return catalog.profiles.iter().find(|profile| profile.key() == profile_id && profile.routed());
    }
    catalog.profiles.iter().find(|profile| profile.current && profile.routed())
}

pub fn candidate_providers(active: &Provider, db: &Path) -> Vec<Provider> {
    let catalog = load_catalog(db);
    if let Some(profile) = select_profile(&catalog, &active.profile_id) {
        return vec![profile.as_provider()];
    }
    if active.profile_id.is_empty() && !active.base_url.is_empty() && !active.secret.is_empty() {
        return vec![Provider { kind: ProviderKind::Api, ..active.clone() }];
    }
    Vec::new()
}

fn read_rows(db: &Path) -> Result<Vec<Profile>, String> {
    let columns = table_columns(db, "providers")?;
    if !columns.contains("id") || !columns.contains("name") {
        return Err("providers table is missing id and name".into());
    }
    let settings = if columns.contains("settings_config") { "settings_config" } else { "''" };
    let meta = if columns.contains("meta") { "meta" } else { "''" };
    let app = if columns.contains("app_type") { "app_type" } else { "''" };
    let current = if columns.contains("is_current") { "is_current" } else { "0" };
    let sql = format!(
        "SELECT id, {app} AS app_type, name, {settings} AS settings_config, {meta} AS meta, {current} AS is_current FROM providers ORDER BY app_type, name LIMIT 80"
    );
    let rows = sqlite_json(db, &sql)?;
    let mut profiles = Vec::new();
    for row in rows {
        let settings = parse_json_cell(row.get("settings_config"));
        let meta = parse_json_cell(row.get("meta"));
        let resolved = resolve_route(&settings, &meta);
        profiles.push(Profile {
            id: text(&row, "id"),
            app_type: text(&row, "app_type"),
            name: text(&row, "name"),
            current: flag(&row, "is_current"),
            base_url: resolved.base_url,
            secret: resolved.secret,
            model: resolved.model,
            wire: resolved.wire,
            kind: resolved.kind,
        });
    }
    Ok(profiles)
}

struct Resolved {
    base_url: String,
    secret: String,
    model: String,
    wire: Wire,
    kind: ProviderKind,
}

fn resolve_route(settings: &Value, meta: &Value) -> Resolved {
    let env = settings.get("env");
    let pick = |keys: &[&str]| -> String {
        for key in keys {
            if let Some(value) = env.and_then(|env| env.get(*key)).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()) {
                return value.to_string();
            }
            if let Some(value) = settings.get(*key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()) {
                return value.to_string();
            }
        }
        String::new()
    };
    let mut base_url = pick(&["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "base_url", "baseUrl"]);
    let mut secret = pick(&["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "api_key", "apiKey"]);
    if base_url.is_empty() {
        base_url = settings.pointer("/options/baseURL").and_then(Value::as_str).unwrap_or("").trim().trim_end_matches('/').to_string();
    }
    if secret.is_empty() {
        secret = settings.pointer("/options/apiKey").and_then(Value::as_str).unwrap_or("").trim().to_string();
    }
    base_url = base_url.trim_end_matches('/').to_string();
    let model = ["model", "ANTHROPIC_MODEL", "OPENAI_MODEL"].iter().find_map(|key| {
        settings.get(*key).or_else(|| env.and_then(|env| env.get(*key))).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
    }).unwrap_or_else(|| "design".into());
    let anthropic = secret_from_anthropic(settings) || base_url.to_ascii_lowercase().contains("anthropic");
    let token_plan = meta.pointer("/usageScript/templateType").and_then(Value::as_str) == Some("token_plan")
        || meta.get("templateType").and_then(Value::as_str) == Some("token_plan")
        || meta.get("category").and_then(Value::as_str) == Some("token_plan");
    Resolved {
        base_url,
        secret,
        model,
        wire: if anthropic { Wire::Anthropic } else { Wire::OpenaiChat },
        kind: if token_plan { ProviderKind::TokenPlan } else { ProviderKind::Api },
    }
}

fn secret_from_anthropic(settings: &Value) -> bool {
    settings.pointer("/env/ANTHROPIC_AUTH_TOKEN").and_then(Value::as_str).is_some_and(|value| !value.trim().is_empty())
        || settings.pointer("/env/ANTHROPIC_API_KEY").and_then(Value::as_str).is_some_and(|value| !value.trim().is_empty())
}

fn table_columns(db: &Path, table: &str) -> Result<std::collections::BTreeSet<String>, String> {
    if !table.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') { return Err("invalid table".into()); }
    let rows = sqlite_json(db, &format!("PRAGMA table_info({table})"))?;
    Ok(rows.into_iter().filter_map(|row| row.get("name").and_then(Value::as_str).map(str::to_string)).collect())
}

fn parse_json_cell(value: Option<&Value>) -> Value {
    let Some(value) = value else { return Value::Null };
    if let Some(text) = value.as_str() {
        return serde_json::from_str(text).unwrap_or(Value::Null);
    }
    value.clone()
}

fn text(row: &Value, key: &str) -> String {
    row.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn flag(row: &Value, key: &str) -> bool {
    row.get(key).and_then(Value::as_i64).unwrap_or(0) == 1 || row.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn sqlite_json(db: &Path, sql: &str) -> Result<Vec<Value>, String> {
    let output = Command::new("sqlite3").arg("-json").arg(db).arg(sql).output().map_err(|error| format!("sqlite3: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let text = text.trim();
    if text.is_empty() { return Ok(Vec::new()); }
    serde_json::from_str(text).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn token_plan_and_api_credentials_resolve_without_keeping_the_secret_in_the_view() {
        let plan = resolve_route(
            &json!({"base_url":"https://plan.example.test/v1","api_key":"plan-secret","model":"plan-model"}),
            &json!({"usageScript":{"templateType":"token_plan"}}),
        );
        assert_eq!(plan.kind, ProviderKind::TokenPlan);
        assert_eq!(plan.wire, Wire::OpenaiChat);
        assert_eq!(plan.base_url, "https://plan.example.test/v1");
        assert_eq!(plan.secret, "plan-secret");
        let api = resolve_route(
            &json!({"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com","ANTHROPIC_AUTH_TOKEN":"sk-ant","ANTHROPIC_MODEL":"claude"}}),
            &json!({}),
        );
        assert_eq!(api.kind, ProviderKind::Api);
        assert_eq!(api.wire, Wire::Anthropic);
        assert_eq!(api.model, "claude");
    }

    #[test]
    fn switching_selects_only_the_named_endpoint() {
        let plan = Profile { id: "plan".into(), app_type: "codex".into(), name: "Plan".into(), current: false, base_url: "https://plan".into(), secret: "p".into(), model: "m".into(), wire: Wire::OpenaiChat, kind: ProviderKind::TokenPlan };
        let api = Profile { id: "api".into(), app_type: "codex".into(), name: "API".into(), current: true, base_url: "https://api".into(), secret: "a".into(), model: "m".into(), wire: Wire::OpenaiChat, kind: ProviderKind::Api };
        let catalog = Catalog { profiles: vec![plan, api], ..Catalog::default() };
        assert_eq!(select_profile(&catalog, "codex:plan").unwrap().id, "plan");
        assert_eq!(select_profile(&catalog, "").unwrap().id, "api");
        let view = serde_json::to_string(&catalog.snapshot()).unwrap();
        assert!(!view.contains("\"p\"") && !view.contains("plan-secret"));
        assert!(view.contains("token_plan"));
    }

    #[test]
    fn a_database_lists_profiles_and_hides_the_stored_key() {
        let dir = std::env::temp_dir().join(format!("ccswitch-route-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("cc-switch.db");
        let sql = r#"CREATE TABLE providers (
            id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL,
            meta TEXT NOT NULL DEFAULT '{}', is_current INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (id, app_type));
        INSERT INTO providers VALUES ('api','codex','Shop API','{"env":{"OPENAI_BASE_URL":"https://api.example/v1","OPENAI_API_KEY":"do-not-leak"}}','{}',1);
        INSERT INTO providers VALUES ('plan','codex','Shop plan','{"base_url":"https://plan.example/v1","api_key":"plan-secret","model":"plan-model"}','{"usageScript":{"templateType":"token_plan"}}',0);"#;
        assert!(Command::new("sqlite3").arg(&db).arg(sql).status().unwrap().success());
        let catalog = load_catalog(&db);
        let snapshot = catalog.snapshot();
        let dumped = serde_json::to_string(&snapshot).unwrap();
        assert!(!dumped.contains("do-not-leak"));
        assert!(!dumped.contains("plan-secret"));
        assert_eq!(snapshot.providers.iter().find(|item| item.id == "plan").unwrap().kind, "token_plan");
        assert_eq!(select_profile(&catalog, "codex:plan").unwrap().name, "Shop plan");
        assert_eq!(select_profile(&catalog, "").unwrap().name, "Shop API");
        assert!(snapshot.providers.iter().all(|item| item.has_secret));
        std::fs::remove_dir_all(dir).ok();
    }
}
