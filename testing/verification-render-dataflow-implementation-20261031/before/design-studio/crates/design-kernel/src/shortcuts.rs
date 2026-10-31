//! Layout-aware keyboard shortcut schema.
//!
//! Bindings are authored once per action with OS and keyboard-layout
//! variants; consumers resolve the active layout to a display string so a
//! `Meta+Z` chord still renders as `Cmd+Z` labels on every physical layout.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutTable {
    pub schema_version: u32,
    pub actions: BTreeMap<String, ActionShortcuts>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionShortcuts {
    #[serde(default)]
    pub edit_modes: Vec<String>,
    #[serde(default)]
    pub bindings: Vec<Binding>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    /// Chord in `Meta+Shift+=` form; physical, layout independent.
    pub combo: String,
    pub os: String,
    /// Keyboard layout the display hint targets (`us_qwerty`, `dvorak`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
    /// Layout-specific display string; falls back to `combo`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
}

#[derive(Debug)]
pub enum Error {
    Malformed(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Malformed(message) => write!(f, "shortcut table error: {message}"),
        }
    }
}

impl ShortcutTable {
    pub fn parse(json: &str) -> Result<Self, Error> {
        let table: ShortcutTable =
            serde_json::from_str(json).map_err(|e| Error::Malformed(e.to_string()))?;
        table.validate()?;
        Ok(table)
    }

    pub fn validate(&self) -> Result<(), Error> {
        if self.schema_version != 1 {
            return Err(Error::Malformed("unsupported schema version".into()));
        }
        for (action, shortcuts) in &self.actions {
            if action.is_empty() {
                return Err(Error::Malformed("empty action name".into()));
            }
            for binding in &shortcuts.bindings {
                if binding.combo.is_empty() {
                    return Err(Error::Malformed(format!(
                        "action {action} has an empty combo"
                    )));
                }
                if binding.os != "mac" && binding.os != "windows" && binding.os != "linux" {
                    return Err(Error::Malformed(format!(
                        "action {action} has unknown os `{}`",
                        binding.os
                    )));
                }
            }
        }
        Ok(())
    }

    /// Resolve the display string for an action on the given OS and layout.
    /// Layout-agnostic bindings win over the fallback, never the reverse.
    pub fn display(&self, action: &str, os: &str, layout: Option<&str>) -> Option<String> {
        let shortcuts = self.actions.get(action)?;
        let fallback = shortcuts
            .bindings
            .iter()
            .find(|b| b.os == os && b.layout.is_none())
            .map(|b| b.combo.clone());
        if let Some(layout) = layout
            && let Some(binding) = shortcuts
                .bindings
                .iter()
                .find(|b| b.os == os && b.layout.as_deref() == Some(layout))
        {
            return Some(binding.display.clone().unwrap_or(binding.combo.clone()));
        }
        fallback
    }

    /// Actions whose chord matches `combo` on this OS, for keymap-driven
    /// dispatch instead of per-action lookup.
    pub fn actions_for_combo(&self, combo: &str, os: &str) -> Vec<String> {
        self.actions
            .iter()
            .filter(|(_, shortcuts)| {
                shortcuts
                    .bindings
                    .iter()
                    .any(|b| b.os == os && b.combo == combo)
            })
            .map(|(action, _)| action.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> ShortcutTable {
        ShortcutTable {
            schema_version: 1,
            actions: BTreeMap::from([
                (
                    "zoom-in".into(),
                    ActionShortcuts {
                        edit_modes: vec!["GLOBAL".into()],
                        bindings: vec![
                            Binding {
                                combo: "Meta+Shift+=".into(),
                                os: "mac".into(),
                                layout: None,
                                display: None,
                            },
                            Binding {
                                combo: "Meta+Shift+=".into(),
                                os: "mac".into(),
                                layout: Some("us_qwerty".into()),
                                display: Some("⌘⇧+".into()),
                            },
                        ],
                    },
                ),
                (
                    "delete-selection".into(),
                    ActionShortcuts {
                        edit_modes: vec!["GLOBAL".into(), "!TEXT".into()],
                        bindings: vec![Binding {
                            combo: "Backspace".into(),
                            os: "mac".into(),
                            layout: None,
                            display: None,
                        }],
                    },
                ),
            ]),
        }
    }

    #[test]
    fn layout_specific_display_wins() {
        let table = table();
        assert_eq!(
            table
                .display("zoom-in", "mac", Some("us_qwerty"))
                .as_deref(),
            Some("⌘⇧+")
        );
        assert_eq!(
            table.display("zoom-in", "mac", Some("dvorak")).as_deref(),
            Some("Meta+Shift+=")
        );
        assert_eq!(
            table.display("zoom-in", "mac", None).as_deref(),
            Some("Meta+Shift+=")
        );
    }

    #[test]
    fn combo_dispatch_finds_actions() {
        let table = table();
        assert_eq!(
            table.actions_for_combo("Backspace", "mac"),
            vec!["delete-selection"]
        );
        assert!(table.actions_for_combo("Backspace", "windows").is_empty());
    }

    #[test]
    fn unknown_os_is_rejected() {
        let mut table = table();
        table.actions.get_mut("delete-selection").unwrap().bindings[0].os = "amiga".into();
        assert!(table.validate().is_err());
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(ShortcutTable::parse("{ nope").is_err());
    }
}
