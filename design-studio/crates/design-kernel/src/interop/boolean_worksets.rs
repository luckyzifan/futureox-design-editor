//! Compile large imported boolean groups into the existing bounded CSG tree.
//! Every operator still has at most 64 inputs. No curves are flattened here.
use super::*;
use std::borrow::Cow;

const MIXED:&str="sketchMixedBooleanGroups";
const ROOT: &str = "sketchBooleanWorkset";
const HELPER: &str = "sketchBooleanWorksetRoot";
const MAX_SOURCE_OPERANDS: usize = 4096;

fn binding<'a>(doc: &'a Document, node: &'a Node, key: &str) -> Option<&'a str> {
    node.bindings.get(key).map(String::as_str).or_else(|| {
        doc.design_system
            .as_ref()?
            .sketch_containers
            .get("nodeMetadata")?
            .get(&node.id)?
            .get("bindings")?
            .get(key)?
            .as_str()
    })
}
fn helper(
    doc: &mut Document,
    root: &Node,
    children: Vec<String>,
    op: crate::boolean::Operation,
    serial: &mut usize,
) -> Result<String> {
    let id = sketch_id(&format!(
        "futureox.boolean-workset.v1:{}:{}",
        root.id, *serial
    ));
    *serial += 1;
    if doc.nodes.contains_key(&id) {
        return Err(Error::Unsupported(
            "Boolean working-set identity collides with a source node".into(),
        ));
    }
    let mut node = crate::facet::sample_node(&id, "vector");
    node.name = "组合".into();
    node.width = root.width;
    node.height = root.height;
    node.children = children;
    node.boolean_operation = Some(op);
    node.fills.clear();
    node.strokes.clear();
    node.effects.clear();
    node.clip = false;
    node.bindings.insert(HELPER.into(), root.id.clone());
    doc.nodes.insert(id.clone(), node);
    Ok(id)
}
pub(super) fn bound(doc: &mut Document, roots: &[String]) -> Result<()> {
    for id in roots {
        let root = doc.nodes[id].clone();
        let operation = root
            .boolean_operation
            .ok_or_else(|| Error::InvalidDocument("Missing source boolean operation".into()))?;
        if root.children.len() > MAX_SOURCE_OPERANDS {
            return Err(Error::Unsupported(
                "Source boolean conversion exceeds 4096 operands".into(),
            ));
        }
        let subtract = operation == crate::boolean::Operation::Subtract;
        let inner = if subtract {
            crate::boolean::Operation::Union
        } else {
            operation
        };
        let mut children = if subtract {
            root.children[1..].to_vec()
        } else {
            root.children.clone()
        };
        let mut serial = 0;
        while children.len() > 64 {
            children = children
                .chunks(64)
                .map(|chunk| helper(doc, &root, chunk.to_vec(), inner, &mut serial))
                .collect::<Result<Vec<_>>>()?;
        }
        if subtract {
            let right = helper(doc, &root, children, inner, &mut serial)?;
            children = vec![root.children[0].clone(), right];
        }
        let node = doc.nodes.get_mut(id).unwrap();
        node.children = children;
        node.bindings.insert(
            ROOT.into(),
            serde_json::to_string(&operation).map_err(|e| Error::MalformedJson(e.to_string()))?,
        );
    }
    Ok(())
}
/// Sketch applies each operand to the accumulated result, back to front.
pub(super) fn mixed(doc:&mut Document, id:&str, operations:&[crate::boolean::Operation])->Result<()> {
    let root=doc.nodes[id].clone();
    if root.children.len()!=operations.len()+1 || operations.is_empty() {return Err(Error::InvalidDocument("Invalid mixed Sketch boolean operands".into()));}
    let mut children=vec![root.children[0].clone()];
    let mut current=operations[0];let mut serial=0;let mut plan=BTreeMap::new();
    for (&op,child) in operations.iter().zip(&root.children[1..]){
        if op!=current || children.len()==64 {
            // Do not manufacture a helper tree beyond the shared model's bounded depth.
            if serial>=64{return Err(Error::Unsupported("Mixed boolean exceeds the bounded CSG nesting depth".into()));}
            let group=helper(doc,&root,children.clone(),current,&mut serial)?;
            plan.insert(group.clone(),(current,children));children=vec![group];current=op;
        }
        children.push(child.clone());
    }
    plan.insert(id.to_owned(),(current,children.clone()));
    let node=doc.nodes.get_mut(id).unwrap();
    node.children=children;node.boolean_operation=Some(current);
    node.bindings.insert(ROOT.into(),json!(current).to_string());
    node.bindings.insert(MIXED.into(),json!(plan).to_string());Ok(())
}
/// Restore source hierarchy for compatibility serialization. Generated nodes
/// may carry placement, but never paints, effects, layout or a different CSG
/// operation. Unsupported edits fail before any file is published.
pub(super) fn source_view(doc: &Document) -> Result<Cow<'_, Document>> {
    let roots = doc
        .nodes
        .values()
        .filter(|n| binding(doc, n, ROOT).is_some())
        .map(|n| n.id.clone())
        .collect::<Vec<_>>();
    if roots.is_empty() {
        return Ok(Cow::Borrowed(doc));
    }
    let mut result = doc.clone();
    let mut removed = std::collections::HashSet::new();
    let mut resolved = None;
    for id in roots {
        let root = result.nodes[&id].clone();
        let operation: crate::boolean::Operation =
            serde_json::from_str(binding(doc, &doc.nodes[&id], ROOT).unwrap())
                .map_err(|e| Error::MalformedJson(e.to_string()))?;
        if root.boolean_operation != Some(operation) {
            return Err(Error::Unsupported(
                "Keep source boolean workset operators unchanged for Sketch export".into(),
            ));
        }
        let plan:Option<BTreeMap<String,(crate::boolean::Operation,Vec<String>)>>=binding(doc,&doc.nodes[&id],MIXED)
            .map(serde_json::from_str).transpose().map_err(|e|Error::MalformedJson(e.to_string()))?;
        if let Some(plan)=&plan && (!plan.contains_key(&id)||plan.iter().any(|(key,(op,children))|{
            result.nodes.get(key).is_none_or(|n|n.boolean_operation!=Some(*op)||n.children!=*children)
        })){return Err(Error::Unsupported("Edited mixed operand topology cannot be flattened to its source sequence".into()));}
        let inner = if operation == crate::boolean::Operation::Subtract {
            crate::boolean::Operation::Union
        } else {
            operation
        };
        let mut stack = root
            .children
            .iter()
            .rev()
            .map(|id| (id.clone(), Transform::default()))
            .collect::<Vec<_>>();
        let mut children = Vec::new();
        let mut visited = std::collections::HashSet::new();
        while let Some((child, parent)) = stack.pop() {
            if !visited.insert(child.clone()) {
                return Err(Error::InvalidDocument(
                    "Repeated node in source boolean workset".into(),
                ));
            }
            let node = result
                .nodes
                .get(&child)
                .ok_or_else(|| Error::MissingPart("Boolean workset child".into()))?;
            if binding(doc, doc.nodes.get(&child).unwrap_or(node), HELPER) == Some(id.as_str()) {
                if node.kind != "vector"
                    || node.boolean_operation != Some(plan.as_ref().and_then(|p|p.get(&child)).map_or(inner,|(op,_)|*op))
                    || node.opacity != 1.
                    || node.blend != "normal"
                    || !node.visible
                    || node.mask
                    || node.clip
                    || !node.fills.is_empty()
                    || !node.strokes.is_empty()
                    || !node.effects.is_empty()
                    || node.layout.is_some()
                    || node.sizing.is_some()
                    || node.constraints.is_some()
                    || node.component.is_some()
                    || node.instance.is_some()
                    || node.repeat.is_some()
                    || node.vector_brush.is_some()
                    || node.path_offset != 0.
                    || node.connector.is_some()
                    || node.board.is_some()
                    || node.text_path.is_some()
                    || !node.variable_modes.is_empty()
                    || !node.style_refs.is_empty()
                    || node.bindings.keys().any(|key| key != HELPER)
                    || node.locked
                    || !node.export_settings.is_empty()
                    || !node.guides.is_empty()
                    || node.width != root.width
                    || node.height != root.height
                {
                    return Err(Error::Unsupported("This source boolean grouping has edits that require the native document format".into()));
                }
                // The editor stores a preview outline on boolean nodes. Verify
                // it against the operand tree before removing this helper.
                if node.network.is_some() || node.vector_geometry.is_some() {
                    let (root_id, reference) = resolved.get_or_insert_with(|| (String::new(), doc.clone()));
                    if root_id != &id {
                        crate::curve_boolean::resolve_subtrees(reference, vec![id.clone()])
                            .map_err(Error::InvalidDocument)?;
                        *root_id = id.clone();
                    }
                    let expected = &reference.nodes[&child];
                    if node.network != expected.network || node.vector_geometry != expected.vector_geometry {
                        return Err(Error::Unsupported("This source boolean grouping has edits that require the native document format".into()));
                    }
                }
                let transform = parent.concat(node.transform);
                stack.extend(node.children.iter().rev().map(|id| (id.clone(), transform)));
                removed.insert(child);
            } else {
                if children.len() >= MAX_SOURCE_OPERANDS {
                    return Err(Error::Unsupported(
                        "Boolean source export exceeds its workset".into(),
                    ));
                }
                let transform = parent.concat(node.transform);
                result.nodes.get_mut(&child).unwrap().transform = transform;
                children.push(child);
            }
        }
        result.nodes.get_mut(&id).unwrap().children = children;
    }
    for id in removed {
        result.nodes.remove(&id);
    }
    // This view is used only by the Sketch codec: its source boolean lists can
    // exceed live CSG admission. It is never installed as a live scene.
    Ok(Cow::Owned(result))
}
