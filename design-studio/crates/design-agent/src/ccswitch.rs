//! Provider profiles and route order adapted from farion1231/cc-switch
//! `b184a88c99428571d718d10d1a1403e9502cd28b` (MIT, Copyright (c) 2025 Jason Young).
//!
//! The pieces kept are the provider row (`settings_config` + `meta`), the
//! current-versus-failover order from `ProviderRouter::select_providers`, and
//! the credential shapes from `Provider::resolve_usage_credentials`. This
//! process calls the resolved API or token-plan endpoint itself. The CC Switch
//! desktop UI, local proxy, circuit breaker, and OAuth injection are not included.

use std::collections::BTreeSet;
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
    pub in_failover_queue: bool,
    pub sort_index: i64,
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
    pub proxy: Option<String>,
    pub failover_apps: BTreeSet<String>,
    pub profiles: Vec<Profile>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SwitchView {
    pub id: String,
    pub app_type: String,
    pub name: String,
    pub current: bool,
    pub in_failover_queue: bool,
    pub kind: String,
    pub model: String,
    pub base_url: String,
    pub has_secret: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SwitchSnapshot {
    pub database: String,
    pub present: bool,
    pub proxy: Option<String>,
    pub failover: bool,
    pub providers: Vec<SwitchView>,
    pub detail: String,
}

impl Catalog {
    pub fn snapshot(&self) -> SwitchSnapshot {
        SwitchSnapshot {
            database: self.database.clone(),
            present: self.detail.is_empty() || !self.profiles.is_empty() || self.proxy.is_some(),
            proxy: self.proxy.clone().filter(|value| value.starts_with("http")),
            failover: !self.failover_apps.is_empty(),
            providers: self.profiles.iter().map(|profile| SwitchView {
                id: profile.id.clone(),
                app_type: profile.app_type.clone(),
                name: profile.name.clone(),
                current: profile.current,
                in_failover_queue: profile.in_failover_queue,
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
        Ok((profiles, proxy, failover_apps)) => Catalog { database, proxy, failover_apps, profiles, detail: String::new() },
        Err(detail) => Catalog { database, detail, ..Catalog::default() },
    }
}

/// Explicit profile first, then the failover queue for that app when the
/// database enabled it. With no selection, failover uses only the queue;
/// otherwise the current rows.
pub fn select_profiles<'a>(catalog: &'a Catalog, profile_id: &str) -> Vec<&'a Profile> {
    let ready = |profile: &&Profile| profile.routed();
    if !profile_id.is_empty() {
        let mut ordered = Vec::new();
        if let Some(chosen) = catalog.profiles.iter().find(|profile| profile.key() == profile_id && profile.routed()) {
            ordered.push(chosen);
            let app = chosen.app_type.clone();
            if catalog.failover_apps.contains(&app) {
                let mut rest: Vec<_> = catalog.profiles.iter().filter(|profile| profile.app_type == app && profile.in_failover_queue && profile.key() != profile_id && profile.routed()).collect();
                rest.sort_by_key(|profile| (profile.sort_index, profile.id.clone()));
                ordered.extend(rest);
            }
        }
        return ordered;
    }
    let mut current: Vec<_> = catalog.profiles.iter().filter(|profile| profile.current && ready(profile)).collect();
    if current.iter().any(|profile| catalog.failover_apps.contains(&profile.app_type)) {
        current = catalog.profiles.iter().filter(|profile| profile.in_failover_queue && catalog.failover_apps.contains(&profile.app_type) && ready(profile)).collect();
        current.sort_by_key(|profile| (profile.sort_index, profile.id.clone()));
    }
    current
}

pub fn candidate_providers(active: &Provider, db: &Path) -> Vec<Provider> {
    let catalog = load_catalog(db);
    let selected = select_profiles(&catalog, &active.profile_id);
    if !selected.is_empty() {
        return selected.into_iter().map(Profile::as_provider).collect();
    }
    if !active.base_url.is_empty() && !active.secret.is_empty() {
        return vec![Provider { kind: ProviderKind::Api, ..active.clone() }];
    }
    Vec::new()
}

fn read_rows(db: &Path) -> Result<(Vec<Profile>, Option<String>, BTreeSet<String>), String> {
    let columns = table_columns(db, "providers")?;
    if !columns.contains("id") || !columns.contains("name") {
        return Err("providers table is missing id and name".into());
    }
    let settings = if columns.contains("settings_config") { "settings_config" } else { "''" };
    let meta = if columns.contains("meta") { "meta" } else { "''" };
    let app = if columns.contains("app_type") { "app_type" } else { "''" };
    let current = if columns.contains("is_current") { "is_current" } else { "0" };
    let queue = if columns.contains("in_failover_queue") { "in_failover_queue" } else { "0" };
    let sort = if columns.contains("sort_index") { "sort_index" } else { "0" };
    let sql = format!(
        "SELECT id, {app} AS app_type, name, {settings} AS settings_config, {meta} AS meta, {current} AS is_current, {queue} AS in_failover_queue, {sort} AS sort_index FROM providers ORDER BY app_type, COALESCE(sort_index, 999999), name LIMIT 80"
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
            in_failover_queue: flag(&row, "in_failover_queue"),
            sort_index: row.get("sort_index").and_then(Value::as_i64).unwrap_or(0),
            base_url: resolved.base_url,
            secret: resolved.secret,
            model: resolved.model,
            wire: resolved.wire,
            kind: resolved.kind,
        });
    }
    let (proxy, failover_apps) = proxy_state(db);
    Ok((profiles, proxy, failover_apps))
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
    if secret.is_empty() {
        secret = settings.pointer("/auth/OPENAI_API_KEY").and_then(Value::as_str).unwrap_or("").trim().to_string();
    }
    if base_url.is_empty() {
        if let Some(config) = settings.get("config").and_then(Value::as_str) {
            base_url = codex_base_url(config).unwrap_or_default();
        }
    }
    if secret.is_empty() {
        secret = settings.pointer("/provider/api_key").and_then(Value::as_str).unwrap_or("").trim().to_string();
    }
    if base_url.is_empty() {
        base_url = settings.pointer("/provider/base_url").and_then(Value::as_str).unwrap_or("").trim().trim_end_matches('/').to_string();
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

/// Active `[model_providers.<model_provider>].base_url`, then a top-level `base_url`.
fn codex_base_url(config: &str) -> Option<String> {
    let mut active = None;
    let mut section = String::new();
    let mut top = None;
    let mut in_active = false;
    for raw in config.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() { continue; }
        if let Some(name) = line.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
            section = name.trim().to_string();
            in_active = active.as_ref().is_some_and(|provider| section == format!("model_providers.{provider}"));
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        let value = value.trim().trim_matches('"').trim_matches('\'').trim().to_string();
        if key == "model_provider" && section.is_empty() {
            active = Some(value);
        } else if key == "base_url" && section.is_empty() {
            top = Some(value);
        } else if key == "base_url" && in_active {
            return Some(value);
        }
    }
    if let Some(provider) = active {
        let header = format!("[model_providers.{provider}]");
        let mut inside = false;
        for raw in config.lines() {
            let line = raw.split('#').next().unwrap_or("").trim();
            if line.starts_with('[') {
                inside = line == header;
                continue;
            }
            if inside && let Some((_, value)) = line.split_once('=') && line.starts_with("base_url") {
                return Some(value.trim().trim_matches('"').trim().to_string());
            }
        }
    }
    top
}

fn proxy_state(db: &Path) -> (Option<String>, BTreeSet<String>) {
    let Ok(columns) = table_columns(db, "proxy_config") else { return (None, BTreeSet::new()) };
    if columns.is_empty() { return (None, BTreeSet::new()) }
    let failover_col = if columns.contains("auto_failover_enabled") { "auto_failover_enabled" } else { "0" };
    let app = if columns.contains("app_type") { "app_type" } else { "''" };
    let address = if columns.contains("listen_address") { "listen_address" } else { "'127.0.0.1'" };
    let port = if columns.contains("listen_port") { "listen_port" } else { "15721" };
    let enabled = if columns.contains("enabled") { "enabled" } else { "1" };
    let rows = sqlite_json(db, &format!("SELECT {app} AS app_type, {address} AS listen_address, {port} AS listen_port, {enabled} AS enabled, {failover_col} AS auto_failover_enabled FROM proxy_config LIMIT 8")).unwrap_or_default();
    let mut proxy = None;
    let mut apps = BTreeSet::new();
    for row in rows {
        if flag(&row, "auto_failover_enabled") {
            let app = text(&row, "app_type");
            if !app.is_empty() { apps.insert(app); }
        }
        if proxy.is_none() && flag(&row, "enabled") {
            let address = text(&row, "listen_address");
            let address = if address.is_empty() { "127.0.0.1".into() } else { address };
            let port = row.get("listen_port").and_then(Value::as_i64).unwrap_or(15721);
            proxy = Some(format!("http://{address}:{port}/v1"));
        }
    }
    (proxy, apps)
}

fn table_columns(db: &Path, table: &str) -> Result<BTreeSet<String>, String> {
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
        let codex = resolve_route(
            &json!({"auth":{"OPENAI_API_KEY":"codex-key"},"config":"model_provider = \"openai\"\n[model_providers.openai]\nbase_url = \"https://codex.example/v1\"\n"}),
            &json!({}),
        );
        assert_eq!(codex.base_url, "https://codex.example/v1");
        assert_eq!(codex.secret, "codex-key");
    }

    #[test]
    fn selected_profile_stays_first_and_failover_appends_the_queue() {
        let plan = Profile { id: "plan".into(), app_type: "codex".into(), name: "Plan".into(), current: false, in_failover_queue: true, sort_index: 2, base_url: "https://plan".into(), secret: "p".into(), model: "m".into(), wire: Wire::OpenaiChat, kind: ProviderKind::TokenPlan };
        let api = Profile { id: "api".into(), app_type: "codex".into(), name: "API".into(), current: true, in_failover_queue: true, sort_index: 1, base_url: "https://api".into(), secret: "a".into(), model: "m".into(), wire: Wire::OpenaiChat, kind: ProviderKind::Api };
        let catalog = Catalog { failover_apps: BTreeSet::from(["codex".into()]), profiles: vec![plan, api], ..Catalog::default() };
        let selected = select_profiles(&catalog, "codex:plan");
        assert_eq!(selected[0].id, "plan");
        assert_eq!(selected[1].id, "api");
        let queued = select_profiles(&catalog, "");
        assert_eq!(queued[0].id, "api");
        assert_eq!(queued[1].id, "plan");
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
            in_failover_queue INTEGER NOT NULL DEFAULT 0, sort_index INTEGER,
            PRIMARY KEY (id, app_type));
        INSERT INTO providers VALUES ('api','codex','Shop API','{"env":{"OPENAI_BASE_URL":"https://api.example/v1","OPENAI_API_KEY":"do-not-leak"}}','{}',1,1,1);
        INSERT INTO providers VALUES ('plan','codex','Shop plan','{"base_url":"https://plan.example/v1","api_key":"plan-secret","model":"plan-model"}','{"usageScript":{"templateType":"token_plan"}}',0,1,2);
        CREATE TABLE proxy_config (app_type TEXT PRIMARY KEY, listen_address TEXT, listen_port INTEGER, enabled INTEGER, auto_failover_enabled INTEGER);
        INSERT INTO proxy_config VALUES ('codex','127.0.0.1',15721,1,1);"#;
        assert!(Command::new("sqlite3").arg(&db).arg(sql).status().unwrap().success());
        let catalog = load_catalog(&db);
        let snapshot = catalog.snapshot();
        let dumped = serde_json::to_string(&snapshot).unwrap();
        assert!(!dumped.contains("do-not-leak"));
        assert!(!dumped.contains("plan-secret"));
        assert_eq!(snapshot.proxy.as_deref(), Some("http://127.0.0.1:15721/v1"));
        assert!(snapshot.failover);
        assert_eq!(snapshot.providers.iter().find(|item| item.id == "plan").unwrap().kind, "token_plan");
        assert!(snapshot.providers.iter().all(|item| item.has_secret));
        std::fs::remove_dir_all(dir).ok();
    }
}
