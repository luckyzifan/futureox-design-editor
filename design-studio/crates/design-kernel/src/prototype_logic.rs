//! Bounded, closed prototype expression AST. Runtime interpretation is local to preview.
use crate::{prototype::Action, scene::Document};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Expr {
    Literal {
        value: Value,
    },
    Variable {
        id: String,
    },
    Unary {
        op: String,
        arg: Box<Expr>,
    },
    Binary {
        op: String,
        left: Box<Expr>,
        right: Box<Expr>,
    },
}
fn scalar(value: &Value) -> Result<&'static str, String> {
    if value.is_boolean() {
        Ok("boolean")
    } else if value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n.abs() <= 1e12)
    {
        Ok("number")
    } else if value.as_str().is_some_and(|s| s.len() <= 4096) {
        Ok("string")
    } else {
        Err("Prototype scalar exceeds finite number/string limits".into())
    }
}
fn expression_type<'a>(
    doc: &Document,
    e: &'a Expr,
    depth: usize,
    nodes: &mut usize,
) -> Result<&'a str, String> {
    *nodes += 1;
    if depth > 16 || *nodes > 256 {
        return Err("Prototype expression depth/node budget".into());
    }
    match e {
        Expr::Literal { value } => scalar(value),
        Expr::Variable { id } => match doc
            .design_system
            .as_ref()
            .and_then(|s| s.variables.get(id))
            .map(|v| v.kind.as_str())
        {
            Some("number") => Ok("number"),
            Some("string") => Ok("string"),
            Some("boolean") => Ok("boolean"),
            _ => Err("Prototype expression variable missing or unsupported".into()),
        },
        Expr::Unary { op, arg } => {
            let t = expression_type(doc, arg, depth + 1, nodes)?;
            let want = match op.as_str() {
                "not" => "boolean",
                "negate" => "number",
                _ => "",
            };
            if t != want {
                Err("Prototype unary type mismatch".into())
            } else {
                Ok(t)
            }
        }
        Expr::Binary { op, left, right } => {
            let l = expression_type(doc, left, depth + 1, nodes)?;
            let r = expression_type(doc, right, depth + 1, nodes)?;
            let want = match op.as_str() {
                "and" | "or" => "boolean",
                "concat" => "string",
                "add" | "subtract" | "multiply" | "divide" | "lt" | "lte" | "gt" | "gte" => {
                    "number"
                }
                "eq" | "ne" => l,
                _ => "",
            };
            if l != r || l != want {
                return Err("Prototype binary type mismatch".into());
            }
            if matches!(
                op.as_str(),
                "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "and" | "or"
            ) {
                Ok("boolean")
            } else {
                Ok(l)
            }
        }
    }
}
pub fn validate_actions(
    doc: &Document,
    actions: &[Action],
    depth: usize,
    nodes: &mut usize,
) -> Result<(), String> {
    if actions.len() > 32 || depth > 16 {
        return Err("Prototype action depth/list budget".into());
    }
    for a in actions {
        *nodes += 1;
        if *nodes > 256 {
            return Err("Prototype action node budget".into());
        }
        let advanced = a.kind == "if"
            || a.expression.is_some()
            || a.then_actions.is_some()
            || a.else_actions.is_some();
        if advanced && doc.schema_version < 15 {
            return Err("Prototype logic requires schema 15".into());
        }
        if a.kind == "if" {
            let expr = a
                .expression
                .as_ref()
                .ok_or("Prototype if requires expression")?;
            if expression_type(doc, expr, 0, nodes)? != "boolean" {
                return Err("Prototype if requires boolean".into());
            }
            validate_actions(
                doc,
                a.then_actions
                    .as_deref()
                    .ok_or("Prototype if requires thenActions")?,
                depth + 1,
                nodes,
            )?;
            validate_actions(
                doc,
                a.else_actions
                    .as_deref()
                    .ok_or("Prototype if requires elseActions")?,
                depth + 1,
                nodes,
            )?;
        } else {
            if a.then_actions.is_some() || a.else_actions.is_some() {
                return Err("Branches require if action".into());
            }
            if let Some(e) = &a.expression {
                if a.kind != "set-variable" || a.value.is_some() {
                    return Err("Expression requires assignment without literal value".into());
                }
                let id = a
                    .target_variable
                    .as_deref()
                    .or_else(|| a.target_variable_data.as_ref()?.get("id")?.as_str())
                    .or(a.target.as_deref())
                    .ok_or("Missing prototype variable")?;
                let variable = doc
                    .design_system
                    .as_ref()
                    .and_then(|s| s.variables.get(id))
                    .ok_or("Missing prototype variable")?;
                if expression_type(doc, e, 0, nodes)? != variable.kind {
                    return Err("Prototype assignment expression type mismatch".into());
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
    fn document(action: Value) -> Document {
        serde_json::from_value(json!({"schemaVersion":15,"id":"d","name":"Logic","pages":[{"id":"p","name":"P","background":"#fff","children":["a"]}],"nodes":{"a":{"id":"a","kind":"frame","width":10,"height":10}},"designSystem":{"collections":{"c":{"name":"C","modes":["m"],"defaultMode":"m"}},"variables":{"count":{"name":"Count","collection":"c","kind":"number","values":{"m":0}}}},"prototype":{"interactions":{"a":[{"trigger":"click","actions":[action]}]}}})).unwrap()
    }
    fn branch() -> Value {
        json!({"kind":"if","expression":{"kind":"literal","value":true},"thenActions":[{"kind":"set-variable","target":"count","expression":{"kind":"binary","op":"add","left":{"kind":"variable","id":"count"},"right":{"kind":"literal","value":1}}}],"elseActions":[]})
    }
    #[test]
    fn nested_logic_roundtrip_and_schema_gate() {
        let d = document(branch());
        assert!(crate::prototype::validate(&d).is_ok());
        let loaded: Document = serde_json::from_str(&serde_json::to_string(&d).unwrap()).unwrap();
        assert_eq!(loaded.prototype, d.prototype);
        let bytes = crate::binfmt::encode(&d);
        let reopened = crate::binfmt::decode(&bytes).unwrap();
        assert_eq!(reopened.prototype, d.prototype);
        assert!(crate::prototype::validate(&reopened).is_ok());
        let mut legacy = d.clone();
        legacy.schema_version = 14;
        assert!(
            crate::prototype::validate(&legacy)
                .unwrap_err()
                .contains("schema 15")
        );
    }
    #[test]
    fn unselected_bad_types_and_unknown_ids_fail() {
        let mut a = branch();
        a["thenActions"][0]["expression"] = json!({"kind":"literal","value":false});
        assert!(
            crate::prototype::validate(&document(a))
                .unwrap_err()
                .contains("type")
        );
        let mut a = branch();
        a["thenActions"][0]["expression"] = json!({"kind":"variable","id":"missing"});
        assert!(crate::prototype::validate(&document(a)).is_err());
    }
    #[test]
    fn finite_scalar_depth_and_action_limits() {
        for value in [json!(1e13), json!("x".repeat(4097)), json!(null)] {
            let a = json!({"kind":"set-variable","target":"count","expression":{"kind":"literal","value":value}});
            assert!(crate::prototype::validate(&document(a)).is_err());
        }
        let mut a = branch();
        for _ in 0..18 {
            a = json!({"kind":"if","expression":{"kind":"literal","value":true},"thenActions":[a],"elseActions":[]});
        }
        assert!(crate::prototype::validate(&document(a)).is_err());
        let mut a = branch();
        a["thenActions"] = json!(vec![json!({"kind":"back"}); 33]);
        assert!(crate::prototype::validate(&document(a)).is_err());
    }
    #[test]
    fn unknown_ast_fields_and_ops_fail() {
        let mut a = branch();
        a["expression"]["source"] = json!("alert(1)");
        assert!(serde_json::from_value::<Action>(a).is_err());
        let a = json!({"kind":"set-variable","target":"count","expression":{"kind":"binary","op":"eval","left":{"kind":"literal","value":1},"right":{"kind":"literal","value":2}}});
        assert!(crate::prototype::validate(&document(a)).is_err());
    }
}
