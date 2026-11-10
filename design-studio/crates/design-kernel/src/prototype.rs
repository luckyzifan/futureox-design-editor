//! Persisted interaction contracts; runtime navigation is local to the preview.
use crate::scene::Document;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Prototype {
    pub start_node: Option<String>,
    pub interactions: BTreeMap<String, Vec<Interaction>>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Interaction {
    pub trigger: String,
    pub actions: Vec<Action>,
    #[serde(default)]
    pub delay_ms: u32,
    #[serde(default)]
    pub condition: Option<Condition>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Action {
    /// Explicit directional transition; absent retains existing smart animation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_style: Option<String>,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expression: Option<crate::prototype_logic::Expr>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub then_actions: Option<Vec<Action>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub else_actions: Option<Vec<Action>>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub duration_ms: u32,
    /// Transition easing shared with the animation module's curve set:
    /// "linear" | "ease-in" | "ease-out" | "ease-in-out" | "spring".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub easing_curve: Option<String>,
    /// Overlay placement for `overlay` actions (kiwi OverlayPositionType:
    /// nine-grid + MANUAL with a relative offset).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlay_position: Option<OverlayPosition>,
    // --- Figma action-schema passthrough fields.
    // Every field below is schema passthrough only: it is persisted and
    // shape-validated, but no runtime semantics consume it yet. ---

    /// `targetVariable`: id of the variable an action binds. Schema
    /// passthrough only — `set-variable` still reads `target`/`value`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_variable: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "targetVariableModeID"
    )]
    pub target_variable_mode_id: Option<String>,
    /// `targetVariableSetID`: variable-set membership. The design system
    /// does not model variable sets, so this is shape-validated only.
    /// Schema passthrough only.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "targetVariableSetID"
    )]
    pub target_variable_set_id: Option<String>,
    /// `targetVariableSetKey`: stable key of a variable set. Schema
    /// passthrough only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_variable_set_key: Option<String>,
    /// `targetVariableData`: Figma VariableData alias (`{id, modeId}`)
    /// carried inline. Object shape-validated, unknown keys tolerated.
    /// Schema passthrough only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_variable_data: Option<Value>,
    /// `mediaAction`: media command enum. The closed set follows the public
    /// fig-kiwi action schema (see `valid_media_action`). No media action
    /// `kind` exists yet. Schema passthrough only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_action: Option<String>,
    /// `mediaSkipByAmount`: seconds to seek by. Schema passthrough only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_skip_by_amount: Option<f64>,
    /// `mediaSkipToTime`: absolute seek target in seconds. Schema
    /// passthrough only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_skip_to_time: Option<f64>,
    /// `transitionShouldSmartAnimate`: opt the transition into smart
    /// animate. Schema passthrough only — branching to the smart-animate
    /// plan belongs to the planner (animation_plan.rs), not this struct.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_should_smart_animate: Option<bool>,
    /// `transitionOverridesEnabled`: per-action transition overrides gate.
    /// Schema passthrough only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_overrides_enabled: Option<bool>,
    /// `transitionPreserveScroll`: keep scroll position across the
    /// transition. Schema passthrough only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_preserve_scroll: Option<bool>,
    /// `transitionResetScrollPosition`: reset scroll on transition. Schema
    /// passthrough only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_reset_scroll_position: Option<bool>,
    /// `transitionResetInteractiveComponents`: reset interactive component
    /// state on transition. Schema passthrough only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_reset_interactive_components: Option<bool>,
    /// `transitionDurationVar`: number variable supplying the duration
    /// (Figma binds durations to number variables only). Schema
    /// passthrough only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_duration_var: Option<String>,
    /// `transitionEasingVar`: variable supplying the easing curve (Figma
    /// has a dedicated EASING variable kind this design system does not
    /// model, so no kind gate). Schema passthrough only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_easing_var: Option<String>,
}
impl Action {
    pub fn has_schema_extras(&self) -> bool {
        self.target_variable.is_some()
            || self.target_variable_mode_id.is_some()
            || self.target_variable_set_id.is_some()
            || self.target_variable_set_key.is_some()
            || self.target_variable_data.is_some()
            || self.media_action.is_some()
            || self.media_skip_by_amount.is_some()
            || self.media_skip_to_time.is_some()
            || self.transition_should_smart_animate.is_some()
            || self.transition_overrides_enabled.is_some()
            || self.transition_preserve_scroll.is_some()
            || self.transition_reset_scroll_position.is_some()
            || self.transition_reset_interactive_components.is_some()
            || self.transition_duration_var.is_some()
            || self.transition_easing_var.is_some()
    }
    /// `transitionShouldSmartAnimate` resolved to a bool. Read accessor
    /// only: no planner or preview branches on it yet.
    pub fn smart_animate(&self) -> bool {
        self.transition_should_smart_animate.unwrap_or(false)
    }
    /// `transitionDurationVar` as a variable id. Read accessor only.
    pub fn duration_var(&self) -> Option<&str> {
        self.transition_duration_var.as_deref()
    }
    /// `transitionEasingVar` as a variable id. Read accessor only.
    pub fn easing_var(&self) -> Option<&str> {
        self.transition_easing_var.as_deref()
    }
    /// `targetVariable` as a variable id. Read accessor only.
    pub fn target_variable_id(&self) -> Option<&str> {
        self.target_variable.as_deref()
    }
    /// `mediaAction` as a command name. Read accessor only.
    pub fn media_command(&self) -> Option<&str> {
        self.media_action.as_deref()
    }
}
/// Placement of an overlay relative to the base frame. `origin` follows the
/// fig kiwi `OverlayPositionType` names (kebab-case); manual placement adds
/// a frame-space offset.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverlayPosition {
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default)]
    pub padding: f64,
    #[serde(default)]
    pub background: bool,
}
pub fn valid_easing(curve: &str) -> bool {
    matches!(
        curve,
        "linear" | "ease-in" | "ease-out" | "ease-in-out" | "spring"
            | "ease-in-sine" | "ease-out-sine" | "ease-in-out-sine"
            | "ease-in-quad" | "ease-out-quad" | "ease-in-out-quad"
            | "ease-in-cubic" | "ease-out-cubic" | "ease-in-out-cubic"
            | "ease-in-quart" | "ease-out-quart" | "ease-in-out-quart"
            | "ease-in-quint" | "ease-out-quint" | "ease-in-out-quint"
            | "ease-in-expo" | "ease-out-expo" | "ease-in-out-expo"
            | "ease-in-circ" | "ease-out-circ" | "ease-in-out-circ"
            // Spring presets from its JS schema.
            | "gentle-spring" | "custom-spring" | "custom-cubic"
    )
}
pub fn valid_overlay_origin(origin: &str) -> bool {
    matches!(
        origin,
        "center"
            | "top-left"
            | "top-center"
            | "top-right"
            | "bottom-left"
            | "bottom-center"
            | "bottom-right"
            | "middle-left"
            | "middle-right"
            | "manual"
    )
}
/// `mediaAction` value set. The field name comes from the fig-kiwi action
/// schema, whose membership is not public; this closed set follows the
/// publicly known values. Conservative by design — if a wider value set is
/// confirmed, widen here and nowhere else.
pub fn valid_media_action(action: &str) -> bool {
    matches!(
        action,
        "play" | "pause" | "toggle" | "stop" | "previous" | "next" | "forward" | "rewind"
    )
}
fn resolved_variable<'a>(doc: &'a Document, id: &str) -> Option<&'a crate::design_system::Variable> {
    doc.design_system.as_ref()?.variables.get(id)
}
fn validate_schema_extras(doc: &Document, a: &Action) -> Result<(), String> {
    if !a.has_schema_extras() {
        return Ok(());
    }
    if doc.schema_version < 12 {
        return Err("Prototype action fields need schema 12".into());
    }
    for id in [
        a.target_variable.as_deref(),
        a.target_variable_mode_id.as_deref(),
        a.target_variable_set_id.as_deref(),
        a.target_variable_set_key.as_deref(),
        a.transition_duration_var.as_deref(),
        a.transition_easing_var.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if id.is_empty() {
            return Err("Empty prototype variable reference".into());
        }
    }
    // References must resolve exactly like `condition` and `set-variable`.
    if let Some(id) = &a.target_variable
        && resolved_variable(doc, id).is_none()
    {
        return Err("Missing prototype target variable".into());
    }
    if let Some(id) = &a.transition_duration_var {
        let v = resolved_variable(doc, id).ok_or("Missing prototype duration variable")?;
        // Figma binds transition durations to number variables only.
        if v.kind != "number" {
            return Err("Prototype duration variable not a number".into());
        }
    }
    if let Some(id) = &a.transition_easing_var
        && resolved_variable(doc, id).is_none()
    {
        return Err("Missing prototype easing variable".into());
    }
    // Mode may only be cross-checked when the variable it qualifies is
    // present and resolvable (Figma modes live on the collection).
    if let (Some(var), Some(mode)) = (&a.target_variable, &a.target_variable_mode_id)
        && let Some(v) = resolved_variable(doc, var)
        && !doc
            .design_system
            .as_ref()
            .and_then(|s| s.collections.get(&v.collection))
            .is_some_and(|c| c.modes.iter().any(|m| m == mode))
    {
        return Err("Unknown prototype variable mode".into());
    }
    if let Some(data) = &a.target_variable_data {
        let str_field =
            |k: &str| data.get(k).map_or(true, |v| v.as_str().is_some_and(|s| !s.is_empty()));
        if !data.is_object() || !str_field("id") || !str_field("modeId") {
            return Err("Invalid prototype variable data".into());
        }
    }
    if let Some(m) = &a.media_action
        && !valid_media_action(m)
    {
        return Err("Invalid prototype media action".into());
    }
    for t in [a.media_skip_by_amount, a.media_skip_to_time].into_iter().flatten() {
        if !t.is_finite() || !(0. ..=1e6).contains(&t) {
            return Err("Invalid prototype media time".into());
        }
    }
    Ok(())
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    pub variable: String,
    pub equals: Value,
}
pub fn validate(doc: &Document) -> Result<(), String> {
    let Some(p) = &doc.prototype else {
        return Ok(());
    };
    if p.start_node
        .as_ref()
        .is_some_and(|id| !doc.nodes.contains_key(id))
        || p.interactions.len() > 20000
    {
        return Err("Invalid prototype start or budget".into());
    }
    for (id, events) in &p.interactions {
        if !doc.nodes.contains_key(id) || events.len() > 32 {
            return Err("Invalid prototype event target".into());
        }
        for e in events {
            if !matches!(
                e.trigger.as_str(),
                "click" | "hover" | "leave" | "after-delay"
            ) || e.delay_ms > 3600000
                || e.actions.len() > 32
            {
                return Err("Invalid prototype trigger".into());
            }
            if let Some(c) = &e.condition
                && !doc
                    .design_system
                    .as_ref()
                    .is_some_and(|s| s.variables.contains_key(&c.variable))
            {
                return Err("Missing condition variable".into());
            }
            crate::prototype_logic::validate_actions(doc, &e.actions, 0, &mut 0)?;
            let mut pending: Vec<&Action> = e.actions.iter().collect();
            while let Some(a) = pending.pop() {
                if let Some(branch) = &a.then_actions { pending.extend(branch); }
                if let Some(branch) = &a.else_actions { pending.extend(branch); }
                if a.transition_style.as_deref().is_some_and(|v|doc.schema_version<20 || !["none","dissolve","slide-left","slide-right","slide-top","slide-bottom"].contains(&v) || !matches!(a.kind.as_str(),"navigate"|"back")) {return Err("Invalid directional prototype transition".into());}
                if a.duration_ms > 10000 {
                    return Err("Prototype transition too long".into());
                }
                if a.easing_curve
                    .as_deref()
                    .is_some_and(|c| doc.schema_version < 12 || !valid_easing(c))
                {
                    return Err("Invalid prototype easing curve".into());
                }
                if let Some(p) = &a.overlay_position
                    && (doc.schema_version < 12
                        || a.kind != "overlay"
                        || !valid_overlay_origin(&p.origin)
                        || !p.padding.is_finite()
                        || !(0. ..=1e7).contains(&p.padding)
                        || [p.x, p.y]
                            .into_iter()
                            .flatten()
                            .any(|v| !v.is_finite() || v.abs() > 1e7)
                        || (p.origin == "manual" && (p.x.is_none() || p.y.is_none())))
                {
                    return Err("Invalid prototype overlay position".into());
                }
                validate_schema_extras(doc, a)?;
                match a.kind.as_str() {
                    "navigate" | "overlay" | "scroll-to" => {
                        if !a.target.as_ref().is_some_and(|t| doc.nodes.contains_key(t)) {
                            return Err("Missing prototype destination".into());
                        }
                    }
                    "back" | "close-overlay" | "if" => {}
                    "set-variable" => {
                        let v = a.target_variable.as_deref()
                            .or_else(|| a.target_variable_data.as_ref()?.get("id")?.as_str())
                            .or(a.target.as_deref())
                            .and_then(|id| doc.design_system.as_ref()?.variables.get(id))
                            .ok_or("Missing prototype variable")?;
                        if a.expression.is_some() { continue; }
                        let x = a.value.as_ref().ok_or("Missing prototype value")?;
                        if !match v.kind.as_str() {
                            "number" => x.as_f64().is_some_and(f64::is_finite),
                            "boolean" => x.is_boolean(),
                            "color" => x.as_str().is_some_and(|c| {
                                crate::color::pixel(doc.color_management, c, 1.).is_ok()
                            }),
                            _ => x.is_string(),
                        } {
                            return Err("Prototype value type mismatch".into());
                        }
                    }
                    _ => return Err("Unknown prototype action".into()),
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc(version: u32) -> Document {
        let doc: Document = serde_json::from_value(json!({
            "schemaVersion": version, "id": "d", "name": "P",
            "pages": [{"id": "p", "name": "Page", "background": "#ffffff",
                        "children": ["a", "o"]}],
            "nodes": {
                "a": {"id": "a", "kind": "frame", "width": 10., "height": 10.},
                "o": {"id": "o", "kind": "frame", "width": 10., "height": 10.}
            },
            "prototype": {"interactions": {"a": [
                {"trigger": "click", "actions": [
                    {"kind": "overlay", "target": "o", "durationMs": 200,
                     "easingCurve": "ease-in-out",
                     "overlayPosition": {"origin": "top-left", "padding": 12.,
                                          "background": true}}
                ]}
            ]}}
        }))
        .unwrap();
        doc
    }

    #[test]
    fn overlay_position_and_easing_validate_on_schema_12() {
        let mut d = doc(12);
        d.prototype.as_mut().unwrap().start_node = Some("a".into());
        assert!(validate(&d).is_ok(), "{:?}", validate(&d).err());
    }

    #[test]
    fn overlay_position_and_easing_require_schema_12() {
        assert_eq!(
            validate(&doc(11)).unwrap_err(),
            "Invalid prototype easing curve"
        );
        let mut d = doc(12);
        d.prototype
            .as_mut()
            .unwrap()
            .interactions
            .get_mut("a")
            .unwrap()[0]
            .actions[0]
            .easing_curve = None;
        assert!(validate(&d).is_ok());
        let mut d = doc(11);
        d.prototype
            .as_mut()
            .unwrap()
            .interactions
            .get_mut("a")
            .unwrap()[0]
            .actions[0]
            .easing_curve = None;
        assert_eq!(
            validate(&d).unwrap_err(),
            "Invalid prototype overlay position"
        );
    }

    #[test]
    fn overlay_origins_and_curves_are_closed_sets() {
        let mut d = doc(12);
        d.prototype
            .as_mut()
            .unwrap()
            .interactions
            .get_mut("a")
            .unwrap()[0]
            .actions[0]
            .overlay_position
            .as_mut()
            .unwrap()
            .origin = "diagonal".into();
        assert_eq!(
            validate(&d).unwrap_err(),
            "Invalid prototype overlay position"
        );
        let mut d = doc(12);
        d.prototype
            .as_mut()
            .unwrap()
            .interactions
            .get_mut("a")
            .unwrap()[0]
            .actions[0]
            .easing_curve = Some("bounce".into());
        assert_eq!(validate(&d).unwrap_err(), "Invalid prototype easing curve");
        // manual placement requires an explicit offset
        let mut d = doc(12);
        let action = &mut d
            .prototype
            .as_mut()
            .unwrap()
            .interactions
            .get_mut("a")
            .unwrap()[0]
            .actions[0];
        action.overlay_position.as_mut().unwrap().origin = "manual".into();
        assert_eq!(
            validate(&d).unwrap_err(),
            "Invalid prototype overlay position"
        );
        let action = &mut d
            .prototype
            .as_mut()
            .unwrap()
            .interactions
            .get_mut("a")
            .unwrap()[0]
            .actions[0];
        action.overlay_position.as_mut().unwrap().x = Some(4.);
        action.overlay_position.as_mut().unwrap().y = Some(-2.);
        assert!(validate(&d).is_ok());
        // overlay placement only exists on overlay actions
        let mut d = doc(12);
        d.prototype
            .as_mut()
            .unwrap()
            .interactions
            .get_mut("a")
            .unwrap()[0]
            .actions[0]
            .kind = "navigate".into();
        assert_eq!(
            validate(&d).unwrap_err(),
            "Invalid prototype overlay position"
        );
    }
}
