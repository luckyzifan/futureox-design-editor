//! The 15 recovered Figma action-schema fields (figma-wasm-analysis/
//! FULL-RE.md §六) on `prototype::Action`: serde round trips, legacy
//! compatibility, Figma `ID`-casing aliases, and the conservative
//! admission rules in `prototype::validate_schema_extras`. Every field is
//! schema passthrough — these tests pin the shape contract, not runtime
//! semantics (there are none yet).

use futureox_design_kernel::prototype::{self, Action, Interaction};
use futureox_design_kernel::scene::Document;
use serde_json::{Value, json};

fn doc(version: u32, action: Value) -> Document {
    serde_json::from_value(json!({
        "schemaVersion": version, "id": "d", "name": "P",
        "pages": [{"id": "p", "name": "Page", "background": "#ffffff",
                    "children": ["a", "o"]}],
        "nodes": {
            "a": {"id": "a", "kind": "frame", "width": 10., "height": 10.},
            "o": {"id": "o", "kind": "frame", "width": 10., "height": 10.}
        },
        "designSystem": {
            "collections": {"c1": {"name": "C", "modes": ["m1", "m2"],
                                    "defaultMode": "m1"}},
            "variables": {
                "var-num": {"name": "n", "collection": "c1", "kind": "number",
                             "values": {"m1": 300., "m2": 500.}},
                "var-str": {"name": "s", "collection": "c1", "kind": "string",
                             "values": {"m1": "ease-in"}}
            }
        },
        "prototype": {"interactions": {"a": [
            {"trigger": "click", "actions": [action]}
        ]}}
    }))
    .unwrap()
}

fn fully_loaded_action() -> Value {
    json!({
        "kind": "navigate", "target": "o", "durationMs": 200,
        "targetVariable": "var-num",
        "targetVariableModeId": "m1",
        "targetVariableSetId": "set-7",
        "targetVariableSetKey": "density",
        "targetVariableData": {"id": "var-num", "modeId": "m1"},
        "mediaAction": "play",
        "mediaSkipByAmount": 1.5,
        "mediaSkipToTime": 90.,
        "transitionShouldSmartAnimate": true,
        "transitionOverridesEnabled": true,
        "transitionPreserveScroll": false,
        "transitionResetScrollPosition": true,
        "transitionResetInteractiveComponents": false,
        "transitionDurationVar": "var-num",
        "transitionEasingVar": "var-str"
    })
}

#[test]
fn fifteen_fields_round_trip_in_camel_case() {
    let action: Action = serde_json::from_value(fully_loaded_action()).unwrap();
    assert_eq!(action.target_variable.as_deref(), Some("var-num"));
    assert_eq!(action.target_variable_mode_id.as_deref(), Some("m1"));
    assert_eq!(action.target_variable_set_id.as_deref(), Some("set-7"));
    assert_eq!(action.target_variable_set_key.as_deref(), Some("density"));
    assert_eq!(
        action.target_variable_data,
        Some(json!({"id": "var-num", "modeId": "m1"}))
    );
    assert_eq!(action.media_action.as_deref(), Some("play"));
    assert_eq!(action.media_skip_by_amount, Some(1.5));
    assert_eq!(action.media_skip_to_time, Some(90.));
    assert_eq!(action.transition_should_smart_animate, Some(true));
    assert_eq!(action.transition_overrides_enabled, Some(true));
    assert_eq!(action.transition_preserve_scroll, Some(false));
    assert_eq!(action.transition_reset_scroll_position, Some(true));
    assert_eq!(action.transition_reset_interactive_components, Some(false));
    assert_eq!(action.transition_duration_var.as_deref(), Some("var-num"));
    assert_eq!(action.transition_easing_var.as_deref(), Some("var-str"));
    // every field serializes under its recovered Figma name (camelCase)
    let out = serde_json::to_value(&action).unwrap();
    for key in [
        "targetVariable",
        "targetVariableModeId",
        "targetVariableSetId",
        "targetVariableSetKey",
        "targetVariableData",
        "mediaAction",
        "mediaSkipByAmount",
        "mediaSkipToTime",
        "transitionShouldSmartAnimate",
        "transitionOverridesEnabled",
        "transitionPreserveScroll",
        "transitionResetScrollPosition",
        "transitionResetInteractiveComponents",
        "transitionDurationVar",
        "transitionEasingVar",
    ] {
        assert!(out.get(key).is_some(), "missing serialized key {key}");
    }
    // explicit false survives the round trip (not skipped as absent)
    assert_eq!(out["transitionPreserveScroll"], json!(false));
    let back: Action = serde_json::from_value(out).unwrap();
    assert_eq!(back, action);
}

#[test]
fn figma_id_casing_aliases_deserialize() {
    // Figma's kiwi names use trailing "ID"; ours serialize as "Id" — both
    // spellings must load.
    let action: Action = serde_json::from_value(json!({
        "kind": "navigate", "target": "o",
        "targetVariableModeID": "m1",
        "targetVariableSetID": "set-7"
    }))
    .unwrap();
    assert_eq!(action.target_variable_mode_id.as_deref(), Some("m1"));
    assert_eq!(action.target_variable_set_id.as_deref(), Some("set-7"));
}

#[test]
fn legacy_actions_are_byte_compatible() {
    // a pre-extension document: no new keys deserialize, none serialize
    let action: Action =
        serde_json::from_value(json!({"kind": "navigate", "target": "o", "durationMs": 200}))
            .unwrap();
    assert!(!action.has_schema_extras());
    assert!(!action.smart_animate());
    assert_eq!(action.duration_var(), None);
    assert_eq!(action.easing_var(), None);
    assert_eq!(action.target_variable_id(), None);
    assert_eq!(action.media_command(), None);
    let out = serde_json::to_string(&action).unwrap();
    for banned in [
        "targetVariable",
        "mediaAction",
        "mediaSkip",
        "transitionShould",
        "transitionDurationVar",
    ] {
        assert!(!out.contains(banned), "legacy output leaked {banned}: {out}");
    }
    let back: Action = serde_json::from_str(&out).unwrap();
    assert_eq!(back, action);
    // and it still validates on schema 12
    assert!(prototype::validate(&doc(12, json!({"kind": "navigate", "target": "o"}))).is_ok());
}

#[test]
fn extras_require_schema_12() {
    assert_eq!(
        prototype::validate(&doc(
            11,
            json!({"kind": "navigate", "target": "o",
                    "transitionShouldSmartAnimate": true})
        ))
        .unwrap_err(),
        "Prototype action fields need schema 12"
    );
    assert!(prototype::validate(&doc(12, fully_loaded_action())).is_ok());
}

#[test]
fn variable_references_must_resolve() {
    assert_eq!(
        prototype::validate(&doc(
            12,
            json!({"kind": "navigate", "target": "o", "targetVariable": "ghost"})
        ))
        .unwrap_err(),
        "Missing prototype target variable"
    );
    // duration binds to number variables only
    assert_eq!(
        prototype::validate(&doc(
            12,
            json!({"kind": "navigate", "target": "o",
                    "transitionDurationVar": "var-str"})
        ))
        .unwrap_err(),
        "Prototype duration variable not a number"
    );
    assert!(prototype::validate(&doc(
        12,
        json!({"kind": "navigate", "target": "o", "transitionDurationVar": "var-num"})
    ))
    .is_ok());
    // easing variables have no kind gate (Figma's EASING kind is unmodeled)
    assert!(prototype::validate(&doc(
        12,
        json!({"kind": "navigate", "target": "o", "transitionEasingVar": "var-num"})
    ))
    .is_ok());
    assert_eq!(
        prototype::validate(&doc(
            12,
            json!({"kind": "navigate", "target": "o", "transitionEasingVar": "ghost"})
        ))
        .unwrap_err(),
        "Missing prototype easing variable"
    );
    // empty references are rejected outright
    assert_eq!(
        prototype::validate(&doc(
            12,
            json!({"kind": "navigate", "target": "o", "targetVariableSetKey": ""})
        ))
        .unwrap_err(),
        "Empty prototype variable reference"
    );
}

#[test]
fn mode_must_belong_to_the_variable_collection() {
    assert!(prototype::validate(&doc(
        12,
        json!({"kind": "navigate", "target": "o",
                "targetVariable": "var-num", "targetVariableModeId": "m2"})
    ))
    .is_ok());
    assert_eq!(
        prototype::validate(&doc(
            12,
            json!({"kind": "navigate", "target": "o",
                    "targetVariable": "var-num", "targetVariableModeId": "m9"})
        ))
        .unwrap_err(),
        "Unknown prototype variable mode"
    );
    // a mode without its qualifying variable is shape-checked only
    assert!(prototype::validate(&doc(
        12,
        json!({"kind": "navigate", "target": "o", "targetVariableModeId": "anything"})
    ))
    .is_ok());
}

#[test]
fn variable_data_is_an_object_with_string_ids() {
    assert_eq!(
        prototype::validate(&doc(
            12,
            json!({"kind": "navigate", "target": "o", "targetVariableData": 42})
        ))
        .unwrap_err(),
        "Invalid prototype variable data"
    );
    assert_eq!(
        prototype::validate(&doc(
            12,
            json!({"kind": "navigate", "target": "o",
                    "targetVariableData": {"id": 7}})
        ))
        .unwrap_err(),
        "Invalid prototype variable data"
    );
    assert!(prototype::validate(&doc(
        12,
        json!({"kind": "navigate", "target": "o",
                "targetVariableData": {"id": "v", "modeId": "m", "extra": true}})
    ))
    .is_ok());
}

#[test]
fn media_fields_are_a_closed_enum_and_bounded_times() {
    for valid in ["play", "pause", "toggle", "stop", "previous", "next", "forward", "rewind"] {
        assert!(prototype::valid_media_action(valid), "{valid}");
    }
    assert_eq!(
        prototype::validate(&doc(
            12,
            json!({"kind": "navigate", "target": "o", "mediaAction": "dance"})
        ))
        .unwrap_err(),
        "Invalid prototype media action"
    );
    for bad in [-1., 2e6] {
        assert_eq!(
            prototype::validate(&doc(
                12,
                json!({"kind": "navigate", "target": "o", "mediaSkipByAmount": bad})
            ))
            .unwrap_err(),
            "Invalid prototype media time"
        );
    }
    assert!(prototype::validate(&doc(
        12,
        json!({"kind": "navigate", "target": "o",
                "mediaAction": "rewind", "mediaSkipByAmount": 1.5,
                "mediaSkipToTime": 90.})
    ))
    .is_ok());
}

#[test]
fn document_level_round_trip_preserves_the_extras() {
    let original = doc(12, fully_loaded_action());
    let reloaded: Document =
        serde_json::from_value(serde_json::to_value(&original).unwrap()).unwrap();
    assert_eq!(reloaded, original);
    let action = &reloaded.prototype.as_ref().unwrap().interactions["a"][0].actions[0];
    assert!(action.smart_animate());
    assert_eq!(action.duration_var(), Some("var-num"));
    assert_eq!(action.target_variable_id(), Some("var-num"));
    assert_eq!(action.media_command(), Some("play"));
}

#[test]
fn interaction_json_parses_whole_events() {
    let events: Vec<Interaction> = serde_json::from_value(json!([
        {"trigger": "click", "actions": [fully_loaded_action()],
         "condition": {"variable": "var-num", "equals": 300.}}
    ]))
    .unwrap();
    let out = serde_json::to_value(&events).unwrap();
    let back: Vec<Interaction> = serde_json::from_value(out).unwrap();
    assert_eq!(back, events);
    assert!(back[0].actions[0].has_schema_extras());
}
