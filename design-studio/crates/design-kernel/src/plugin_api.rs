//! Figma Plugin API mutations against the authored document.
//!
//! The Electron/TypeScript host owns the sandbox, manifest, and iframe channel.
//! Node creation, property edits, transforms, bounds, and hit-testing run here
//! so the editor does not keep a second scene graph. A flush returns only the
//! nodes and pages that changed; the host commits that patch through `Editor.change`.

use crate::facet::sample_node;
use crate::layout::{Align, Anchor, Flow, Layout, SizeMode, Sizing};
use crate::math::{Point, Transform};
use crate::scene::{Document, Effect, Node, Page, Paint, Stroke};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};


#[derive(Clone, Debug)]
pub struct PluginSession {
    document: Document,
    checkpoint: Document,
    plugin_id: String,
    page_id: String,
    checkpoint_page: String,
    selection: Vec<String>,
    checkpoint_selection: Vec<String>,
    fonts: BTreeSet<String>,
    dirty: BTreeSet<String>,
    removed: BTreeSet<String>,
    seq: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenOptions {
    plugin_id: String,
    page_id: String,
    #[serde(default)]
    selection: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Command {
    Create {
        #[serde(rename = "type")]
        kind: String,
        #[serde(default, rename = "parentId")]
        parent_id: Option<String>,
    },
    Get {
        id: String,
        prop: String,
    },
    Set {
        id: String,
        prop: String,
        value: Value,
    },
    Resize {
        id: String,
        width: f64,
        height: f64,
    },
    Remove {
        id: String,
    },
    Reparent {
        id: String,
        #[serde(rename = "parentId")]
        parent_id: String,
        #[serde(default)]
        index: Option<usize>,
    },
    Clone {
        id: String,
    },
    Group {
        ids: Vec<String>,
    },
    Ungroup {
        id: String,
    },
    SetSelection {
        ids: Vec<String>,
    },
    GetSelection,
    SetPage {
        id: String,
    },
    GetPage,
    List {
        id: String,
        #[serde(default)]
        deep: bool,
    },
    HitTest {
        x: f64,
        y: f64,
    },
    LoadFont {
        family: String,
        style: String,
    },
    PluginDataGet {
        id: String,
        key: String,
    },
    PluginDataSet {
        id: String,
        key: String,
        value: String,
    },
    Flush,
}

impl PluginSession {
    pub fn open(document_json: &str, options_json: &str) -> Result<Self, String> {
        if document_json.len() > 64 * 1024 * 1024 || options_json.len() > 64 * 1024 {
            return Err("Plugin document payload is too large".into());
        }
        let document: Document = serde_json::from_str(document_json).map_err(|e| e.to_string())?;
        document.validate()?;
        let options: OpenOptions = serde_json::from_str(options_json).map_err(|e| e.to_string())?;
        validate_plugin_id(&options.plugin_id)?;
        if !document.pages.iter().any(|page| page.id == options.page_id) {
            return Err("Plugin page is not in this document".into());
        }
        let selection: Vec<String> = options
            .selection
            .into_iter()
            .filter(|id| node_on_page(&document, &options.page_id, id))
            .take(500)
            .collect();
        Ok(Self {
            checkpoint: document.clone(),
            page_id: options.page_id.clone(),
            checkpoint_page: options.page_id,
            checkpoint_selection: selection.clone(),
            selection,
            document,
            plugin_id: options.plugin_id,
            fonts: BTreeSet::new(),
            dirty: BTreeSet::new(),
            removed: BTreeSet::new(),
            seq: 1,
        })
    }

    pub fn call(&mut self, command_json: &str) -> Result<String, String> {
        if command_json.len() > 1_000_000 {
            return Err("Plugin command is too large".into());
        }
        let command: Command = serde_json::from_str(command_json).map_err(|e| e.to_string())?;
        let value = self.dispatch(command)?;
        serde_json::to_string(&value).map_err(|e| e.to_string())
    }

    fn dispatch(&mut self, command: Command) -> Result<Value, String> {
        match command {
            Command::Create { kind, parent_id } => self.create(&kind, parent_id),
            Command::Get { id, prop } => self.get(&id, &prop),
            Command::Set { id, prop, value } => self.set(&id, &prop, value),
            Command::Resize { id, width, height } => {
                self.resize_node(&id, width, height)?;
                Ok(Value::Null)
            }
            Command::Remove { id } => {
                self.remove_node(&id)?;
                Ok(Value::Null)
            }
            Command::Reparent { id, parent_id, index } => {
                self.reparent(&id, &parent_id, index)?;
                Ok(Value::Null)
            }
            Command::Clone { id } => self.clone_tree(&id),
            Command::Group { ids } => self.group(&ids),
            Command::Ungroup { id } => self.ungroup(&id),
            Command::SetSelection { ids } => self.set_selection(ids),
            Command::GetSelection => Ok(json!(self.selection)),
            Command::SetPage { id } => self.set_page(&id),
            Command::GetPage => self.page_value(&self.page_id.clone()),
            Command::List { id, deep } => self.list(&id, deep),
            Command::HitTest { x, y } => self.hit_test(x, y),
            Command::LoadFont { family, style } => {
                self.remember_font(&family, &style)?;
                Ok(Value::Null)
            }
            Command::PluginDataGet { id, key } => self.plugin_data_get(&id, &key),
            Command::PluginDataSet { id, key, value } => self.plugin_data_set(&id, &key, &value),
            Command::Flush => self.flush(),
        }
    }

    fn create(&mut self, kind: &str, parent_id: Option<String>) -> Result<Value, String> {
        let figma = kind.to_ascii_uppercase();
        if figma == "PAGE" {
            return self.create_page();
        }
        let parent = parent_id.unwrap_or_else(|| self.page_id.clone());
        self.ensure_container(&parent)?;
        if self.document.nodes.len() >= 50_000 {
            return Err("Plugin create limit reached".into());
        }
        let id = self.alloc_id();
        let mut node = sample_node(&id, &kernel_kind(&figma)?);
        node.name = default_name(&figma);
        node.width = 100.;
        node.height = if figma == "LINE" { 0.01 } else { 100. };
        node.fills.clear();
        node.points = match figma.as_str() {
            "POLYGON" => 3,
            "STAR" => 5,
            _ => 0,
        };
        node.inner_radius = if figma == "STAR" { 0.45 } else { 0. };
        match figma.as_str() {
            "RECTANGLE" | "ELLIPSE" | "POLYGON" | "STAR" => {
                node.fills.push(solid("#d9d9d9", 1.));
            }
            "FRAME" => {
                node.fills.push(solid("#ffffff", 1.));
                node.clip = true;
            }
            "SECTION" => {
                node.fills.push(solid("#e7e8ef", 1.));
            }
            "TEXT" => {
                node.fills.push(solid("#222438", 1.));
                node.text.clear();
                node.font_size = 16.;
            }
            "LINE" => node.strokes.push(stroke(1., "#000000")),
            "GROUP" => {}
            _ => return Err(format!("Unsupported create type {figma}")),
        }
        self.document.nodes.insert(id.clone(), node);
        self.attach_child(&parent, &id, None)?;
        self.dirty.insert(id.clone());
        Ok(json!({ "id": id, "type": figma }))
    }

    fn create_page(&mut self) -> Result<Value, String> {
        if self.document.pages.len() >= 200 {
            return Err("Page limit reached".into());
        }
        let id = self.alloc_id();
        let background = self
            .document
            .pages
            .first()
            .map(|page| page.background.clone())
            .unwrap_or_else(|| "#f5f5f5".into());
        self.document.pages.push(Page {
            guides: Vec::new(),
            id: id.clone(),
            name: format!("Page {}", self.document.pages.len() + 1),
            children: Vec::new(),
            background,
        });
        Ok(json!({ "id": id, "type": "PAGE" }))
    }

    fn get(&self, id: &str, prop: &str) -> Result<Value, String> {
        if id == self.document.id {
            return self.get_document(prop);
        }
        if self.is_page(id) {
            return self.get_page(id, prop);
        }
        let node = self.node(id)?;
        match prop {
            "id" => Ok(json!(id)),
            "type" => Ok(json!(figma_type(node))),
            "name" => Ok(json!(node.name)),
            "removed" => Ok(json!(false)),
            "x" => Ok(json!(node.transform.0[4])),
            "y" => Ok(json!(node.transform.0[5])),
            "width" => Ok(json!(node.width)),
            "height" => Ok(json!(node.height)),
            "opacity" => Ok(json!(node.opacity)),
            "visible" => Ok(json!(node.visible)),
            "locked" => Ok(json!(node.locked)),
            "rotation" => Ok(json!(rotation_degrees(node.transform))),
            "relativeTransform" => Ok(matrix_json(node.transform)),
            "absoluteTransform" => Ok(matrix_json(self.world(id)?)),
            "absoluteBoundingBox" => self.absolute_box(id),
            "fills" => read_fills(node),
            "strokes" => read_strokes(node),
            "strokeWeight" => read_stroke_weight(node),
            "strokeAlign" => read_stroke_align(node),
            "cornerRadius" => read_corner_radius(node),
            "topLeftRadius" => Ok(json!(node.radii[0])),
            "topRightRadius" => Ok(json!(node.radii[1])),
            "bottomRightRadius" => Ok(json!(node.radii[2])),
            "bottomLeftRadius" => Ok(json!(node.radii[3])),
            "characters" => {
                if node.kind != "text" {
                    return Err("characters is only available on text".into());
                }
                Ok(json!(node.text))
            }
            "fontSize" => Ok(json!(node.font_size)),
            "fontName" => Ok(self.font_name_json(node)),
            "parent" => self.parent_value(id),
            "children" => self.child_values(&node.children),
            "layoutMode" => read_layout_mode(node),
            "itemSpacing" => Ok(json!(node.layout.as_ref().map(|l| l.gap).unwrap_or(0.))),
            "paddingTop" => Ok(json!(padding(node, 0))),
            "paddingRight" => Ok(json!(padding(node, 1))),
            "paddingBottom" => Ok(json!(padding(node, 2))),
            "paddingLeft" => Ok(json!(padding(node, 3))),
            "primaryAxisAlignItems" => Ok(json!(justify_name(node.layout.as_ref().map(|l| l.justify).unwrap_or(Align::Start)))),
            "counterAxisAlignItems" => Ok(json!(align_name(node.layout.as_ref().map(|l| l.align).unwrap_or(Align::Start)))),
            "layoutSizingHorizontal" => Ok(json!(size_name(node.sizing.as_ref().map(|s| s.width).unwrap_or(SizeMode::Fixed)))),
            "layoutSizingVertical" => Ok(json!(size_name(node.sizing.as_ref().map(|s| s.height).unwrap_or(SizeMode::Fixed)))),
            "constraints" => Ok(constraints_json(node)),
            "blendMode" => Ok(json!(blend_to_figma(&node.blend))),
            "effects" => read_effects(node),
            "pointCount" => Ok(json!(node.points)),
            "innerRadius" => Ok(json!(node.inner_radius)),
            "clipsContent" => Ok(json!(node.clip)),
            "textAlignHorizontal" => Ok(json!(text_align_h(node))),
            "textAlignVertical" => Ok(json!(text_align_v(node))),
            _ => Err(format!("Unsupported plugin property {prop}")),
        }
    }

    fn get_document(&self, prop: &str) -> Result<Value, String> {
        match prop {
            "id" => Ok(json!(self.document.id)),
            "type" => Ok(json!("DOCUMENT")),
            "name" => Ok(json!(self.document.name)),
            "children" => Ok(Value::Array(self.document.pages.iter().map(|page| json!({"id": page.id, "type": "PAGE"})).collect())),
            "parent" => Ok(Value::Null),
            "removed" => Ok(json!(false)),
            _ => Err(format!("Unsupported document property {prop}")),
        }
    }

    fn get_page(&self, id: &str, prop: &str) -> Result<Value, String> {
        let page = self.page(id)?;
        match prop {
            "id" => Ok(json!(id)),
            "type" => Ok(json!("PAGE")),
            "name" => Ok(json!(page.name)),
            "children" => self.child_values(&page.children),
            "parent" => Ok(json!({"id": self.document.id, "type": "DOCUMENT"})),
            "removed" => Ok(json!(false)),
            "selection" => Ok(json!(if id == self.page_id { self.selection.clone() } else { Vec::<String>::new() })),
            _ => Err(format!("Unsupported page property {prop}")),
        }
    }

    fn set(&mut self, id: &str, prop: &str, value: Value) -> Result<Value, String> {
        if id == self.document.id {
            if prop == "name" {
                self.document.name = read_name(&value)?;
                return Ok(Value::Null);
            }
            return Err(format!("Unsupported document property {prop}"));
        }
        if self.is_page(id) {
            if prop == "name" {
                self.page_mut(id)?.name = read_name(&value)?;
                return Ok(Value::Null);
            }
            if prop == "selection" && id == self.page_id {
                let ids = read_ids(&value)?;
                return self.set_selection(ids);
            }
            return Err(format!("Unsupported page property {prop}"));
        }
        match prop {
            "name" => {
                self.node_mut(id)?.name = read_name(&value)?;
            }
            "x" => self.set_translation(id, 4, read_f64(&value, "x")?)?,
            "y" => self.set_translation(id, 5, read_f64(&value, "y")?)?,
            "width" => {
                let height = self.node(id)?.height;
                self.resize_node(id, read_f64(&value, "width")?, height)?;
            }
            "height" => {
                let width = self.node(id)?.width;
                self.resize_node(id, width, read_f64(&value, "height")?)?;
            }
            "opacity" => {
                let opacity = read_f64(&value, "opacity")?;
                if !(0. ..=1.).contains(&opacity) {
                    return Err("opacity must be between 0 and 1".into());
                }
                self.node_mut(id)?.opacity = opacity;
            }
            "visible" => self.node_mut(id)?.visible = read_bool(&value, "visible")?,
            "locked" => self.node_mut(id)?.locked = read_bool(&value, "locked")?,
            "rotation" => self.set_rotation(id, read_f64(&value, "rotation")?)?,
            "relativeTransform" => self.set_transform(id, &value)?,
            "fills" => self.set_fills(id, &value)?,
            "strokes" => self.set_strokes(id, &value)?,
            "strokeWeight" => self.set_stroke_weight(id, read_f64(&value, "strokeWeight")?)?,
            "strokeAlign" => self.set_stroke_align(id, value.as_str().unwrap_or(""))?,
            "cornerRadius" => self.set_corner_radius(id, read_f64(&value, "cornerRadius")?)?,
            "topLeftRadius" => self.set_radius_index(id, 0, read_f64(&value, "topLeftRadius")?)?,
            "topRightRadius" => self.set_radius_index(id, 1, read_f64(&value, "topRightRadius")?)?,
            "bottomRightRadius" => self.set_radius_index(id, 2, read_f64(&value, "bottomRightRadius")?)?,
            "bottomLeftRadius" => self.set_radius_index(id, 3, read_f64(&value, "bottomLeftRadius")?)?,
            "characters" => self.set_characters(id, value.as_str().unwrap_or(""))?,
            "fontSize" => self.set_font_size(id, read_f64(&value, "fontSize")?)?,
            "fontName" => self.set_font_name(id, &value)?,
            "layoutMode" => self.set_layout_mode(id, value.as_str().unwrap_or(""))?,
            "itemSpacing" => self.set_gap(id, read_f64(&value, "itemSpacing")?)?,
            "paddingTop" => self.set_padding(id, 0, read_f64(&value, "paddingTop")?)?,
            "paddingRight" => self.set_padding(id, 1, read_f64(&value, "paddingRight")?)?,
            "paddingBottom" => self.set_padding(id, 2, read_f64(&value, "paddingBottom")?)?,
            "paddingLeft" => self.set_padding(id, 3, read_f64(&value, "paddingLeft")?)?,
            "primaryAxisAlignItems" => self.set_justify(id, value.as_str().unwrap_or(""))?,
            "counterAxisAlignItems" => self.set_align(id, value.as_str().unwrap_or(""))?,
            "layoutSizingHorizontal" => self.set_sizing(id, true, value.as_str().unwrap_or(""))?,
            "layoutSizingVertical" => self.set_sizing(id, false, value.as_str().unwrap_or(""))?,
            "constraints" => self.set_constraints(id, &value)?,
            "blendMode" => {
                let mode = blend_from_figma(value.as_str().unwrap_or(""))?;
                self.node_mut(id)?.blend = mode;
            }
            "effects" => self.set_effects(id, &value)?,
            "pointCount" => self.set_point_count(id, &value)?,
            "innerRadius" => self.set_inner_radius(id, read_f64(&value, "innerRadius")?)?,
            "clipsContent" => self.node_mut(id)?.clip = read_bool(&value, "clipsContent")?,
            "textAlignHorizontal" => self.set_text_align_h(id, value.as_str().unwrap_or(""))?,
            "textAlignVertical" => self.set_text_align_v(id, value.as_str().unwrap_or(""))?,
            _ => return Err(format!("Unsupported plugin property {prop}")),
        }
        self.dirty.insert(id.to_string());
        Ok(Value::Null)
    }

    fn resize_node(&mut self, id: &str, width: f64, height: f64) -> Result<(), String> {
        if !width.is_finite() || !height.is_finite() || width <= 0. || height <= 0. || width > 1e7 || height > 1e7 {
            return Err("width and height must be between 0 and 10000000".into());
        }
        let (old_w, old_h, children, boolean) = {
            let node = self.node(id)?;
            (node.width, node.height, node.children.clone(), node.boolean_operation.is_some())
        };
        if old_w <= 0. || old_h <= 0. {
            return Err("Cannot resize a degenerate node".into());
        }
        {
            let node = self.node_mut(id)?;
            crate::mutation::resize(node, width, height);
        }
        if boolean {
            crate::mutation::resize_boolean_children(&mut self.document.nodes, &children, width / old_w, height / old_h);
            self.dirty.extend(children);
        }
        self.dirty.insert(id.to_string());
        Ok(())
    }

    fn remove_node(&mut self, id: &str) -> Result<(), String> {
        if self.is_page(id) {
            return self.remove_page(id);
        }
        if !self.document.nodes.contains_key(id) {
            return Err("Unknown node".into());
        }
        let mut stack = vec![id.to_string()];
        let mut doomed = Vec::new();
        while let Some(current) = stack.pop() {
            if let Some(node) = self.document.nodes.get(&current) {
                stack.extend(node.children.iter().cloned());
            }
            doomed.push(current);
        }
        for current in &doomed {
            if let Some(parent) = self.parent_id(current) {
                self.detach_child(&parent, current)?;
            }
            self.document.nodes.remove(current);
            self.dirty.remove(current);
            self.removed.insert(current.clone());
            self.selection.retain(|id| id != current);
        }
        Ok(())
    }

    fn remove_page(&mut self, id: &str) -> Result<(), String> {
        if self.document.pages.len() <= 1 {
            return Err("Cannot remove the last page".into());
        }
        let page = self.page(id)?.clone();
        for child in page.children {
            self.remove_node(&child)?;
        }
        self.document.pages.retain(|page| page.id != id);
        if self.page_id == id {
            self.page_id = self.document.pages[0].id.clone();
            self.selection.clear();
        }
        Ok(())
    }

    fn reparent(&mut self, id: &str, parent_id: &str, index: Option<usize>) -> Result<(), String> {
        if id == parent_id || self.is_ancestor(id, parent_id)? {
            return Err("Cannot parent a node under itself".into());
        }
        self.ensure_container(parent_id)?;
        let old_world = self.world(id)?;
        if let Some(old) = self.parent_id(id) {
            self.detach_child(&old, id)?;
        }
        self.attach_child(parent_id, id, index)?;
        let parent_world = self.container_world(parent_id)?;
        let local = parent_world.inverse()?.concat(old_world);
        if local.0.iter().any(|v| !v.is_finite() || v.abs() > 1e7) || local.inverse().is_err() {
            return Err("Reparent produced a transform outside the admitted range".into());
        }
        self.node_mut(id)?.transform = local;
        self.dirty.insert(id.to_string());
        Ok(())
    }

    fn clone_tree(&mut self, id: &str) -> Result<Value, String> {
        let source = self.node(id)?.clone();
        if source.component.is_some() || source.instance.is_some() || source.component_set {
            return Err("Components and instances cannot be cloned by this plugin host".into());
        }
        let parent = self.parent_id(id).ok_or("Cannot clone a node without a parent")?;
        let index = self.child_index(&parent, id)?.map(|index| index + 1);
        let cloned = self.clone_node(&source)?;
        let cloned_id = cloned.clone();
        self.attach_child(&parent, &cloned, index)?;
        Ok(json!({ "id": cloned_id, "type": figma_type(self.node(&cloned_id)?) }))
    }

    fn clone_node(&mut self, source: &Node) -> Result<String, String> {
        let id = self.alloc_id();
        let mut node = source.clone();
        node.id = id.clone();
        node.children.clear();
        let children = source.children.clone();
        self.document.nodes.insert(id.clone(), node);
        self.dirty.insert(id.clone());
        for child_id in children {
            let child = self.node(&child_id)?.clone();
            if child.component.is_some() || child.instance.is_some() {
                return Err("Components and instances cannot be cloned by this plugin host".into());
            }
            let cloned = self.clone_node(&child)?;
            self.node_mut(&id)?.children.push(cloned);
        }
        Ok(id)
    }

    fn group(&mut self, ids: &[String]) -> Result<Value, String> {
        if ids.is_empty() || ids.len() > 500 {
            return Err("group requires 1 to 500 nodes".into());
        }
        let parent = self.parent_id(&ids[0]).ok_or("Cannot group the document root")?;
        let mut index = None;
        for id in ids {
            if self.parent_id(id).as_deref() != Some(parent.as_str()) {
                return Err("group requires nodes that share a parent".into());
            }
            let at = self.child_index(&parent, id)?.unwrap_or(0);
            index = Some(index.map_or(at, |current: usize| current.min(at)));
        }
        let (min_x, min_y, max_x, max_y) = self.children_bounds(&parent, ids)?;
        let width = (max_x - min_x).max(0.01);
        let height = (max_y - min_y).max(0.01);
        let created = self.create("GROUP", Some(parent.clone()))?;
        let group_id = created["id"].as_str().unwrap().to_string();
        {
            let node = self.node_mut(&group_id)?;
            node.transform = Transform([1., 0., 0., 1., min_x, min_y]);
            node.width = width;
            node.height = height;
            node.name = "Group".into();
        }
        if let Some(at) = index {
            self.detach_child(&parent, &group_id)?;
            self.attach_child(&parent, &group_id, Some(at))?;
        }
        for id in ids {
            self.reparent(id, &group_id, None)?;
        }
        Ok(json!({ "id": group_id, "type": "GROUP" }))
    }

    fn ungroup(&mut self, id: &str) -> Result<Value, String> {
        let kind = self.node(id)?.kind.clone();
        if kind != "group" && kind != "frame" {
            return Err("ungroup requires a group or frame".into());
        }
        let parent = self.parent_id(id).ok_or("Cannot ungroup a rootless node")?;
        let index = self.child_index(&parent, id)?.unwrap_or(0);
        let children = self.node(id)?.children.clone();
        for (offset, child) in children.iter().enumerate() {
            self.reparent(child, &parent, Some(index + offset))?;
        }
        self.remove_node(id)?;
        Ok(json!(children))
    }

    fn set_selection(&mut self, ids: Vec<String>) -> Result<Value, String> {
        if ids.len() > 500 {
            return Err("Selection is limited to 500 nodes".into());
        }
        for id in &ids {
            if !node_on_page(&self.document, &self.page_id, id) {
                return Err("Selection must be nodes on the current page".into());
            }
        }
        self.selection = ids;
        Ok(Value::Null)
    }

    fn set_page(&mut self, id: &str) -> Result<Value, String> {
        if !self.is_page(id) {
            return Err("Unknown page".into());
        }
        self.page_id = id.to_string();
        self.selection.clear();
        Ok(Value::Null)
    }

    fn list(&self, id: &str, deep: bool) -> Result<Value, String> {
        let mut out = Vec::new();
        self.append_descendants(id, deep, &mut out)?;
        Ok(Value::Array(out))
    }

    fn append_descendants(&self, id: &str, deep: bool, out: &mut Vec<Value>) -> Result<(), String> {
        let children = if self.is_page(id) {
            self.page(id)?.children.clone()
        } else {
            self.node(id)?.children.clone()
        };
        for child in children {
            let node = self.node(&child)?;
            out.push(json!({
                "id": child,
                "type": figma_type(node),
                "name": node.name,
                "parentId": id,
            }));
            if deep {
                self.append_descendants(&child, true, out)?;
            }
            if out.len() > 20_000 {
                return Err("Node query exceeded 20000 results".into());
            }
        }
        Ok(())
    }

    /// Top-most visible node whose geometry contains the parent-page point.
    /// Children are tested before their parents, using the same kernel hit
    /// test as canvas picking. Locked nodes remain hittable.
    pub fn hit_test(&self, x: f64, y: f64) -> Result<Value, String> {
        if !x.is_finite() || !y.is_finite() || x.abs() > 1e7 || y.abs() > 1e7 {
            return Err("Invalid hit-test point".into());
        }
        let page = self.page(&self.page_id)?.clone();
        let point = Point::new(x, y);
        for id in page.children.iter().rev() {
            if let Some(hit) = self.hit_node(id, Transform::default(), point)? {
                return Ok(json!({ "id": hit }));
            }
        }
        Ok(json!({ "id": Value::Null }))
    }

    fn hit_node(&self, id: &str, parent_world: Transform, point: Point) -> Result<Option<String>, String> {
        let (visible, opacity, transform, children) = {
            let node = self.node(id)?;
            (node.visible, node.opacity, node.transform, node.children.clone())
        };
        if !visible || opacity <= 0. {
            return Ok(None);
        }
        let world = parent_world.concat(transform);
        for child in children.iter().rev() {
            if let Some(hit) = self.hit_node(child, world, point)? {
                return Ok(Some(hit));
            }
        }
        let local = world.inverse()?.point(point);
        if crate::hit_test(self.node(id)?, local, 1.)? {
            return Ok(Some(id.to_string()));
        }
        Ok(None)
    }

    fn plugin_data_get(&self, id: &str, key: &str) -> Result<Value, String> {
        validate_data_key(key)?;
        let node = self.node(id)?;
        Ok(json!(node.plugin_data.get(&self.plugin_id).and_then(|entries| entries.get(key)).cloned().unwrap_or_default()))
    }

    fn plugin_data_set(&mut self, id: &str, key: &str, value: &str) -> Result<Value, String> {
        validate_data_key(key)?;
        if value.chars().count() > 10_000 {
            return Err("Plugin data value exceeds 10000 characters".into());
        }
        if self.plugin_id == FONT_PLUGIN {
            return Err("This plugin id is reserved".into());
        }
        let plugin_id = self.plugin_id.clone();
        let node = self.node_mut(id)?;
        let entries = node.plugin_data.entry(plugin_id).or_default();
        let exists = entries.contains_key(key);
        if !exists && entries.len() >= 50 {
            return Err("Plugin data is limited to 50 keys on a node".into());
        }
        entries.insert(key.to_string(), value.to_string());
        self.dirty.insert(id.to_string());
        Ok(Value::Null)
    }

    fn flush(&mut self) -> Result<Value, String> {
        self.selection.retain(|id| node_on_page(&self.document, &self.page_id, id));
        if let Err(error) = self.document.validate() {
            self.rollback();
            return Err(error);
        }
        let mut nodes = Map::new();
        for id in &self.dirty {
            if let Some(node) = self.document.nodes.get(id) {
                nodes.insert(id.clone(), serde_json::to_value(node).map_err(|e| e.to_string())?);
            }
        }
        let removed: Vec<_> = self
            .removed
            .iter()
            .filter(|id| self.checkpoint.nodes.contains_key(*id))
            .cloned()
            .collect();
        let mut page_children = Map::new();
        let mut added_pages = Vec::new();
        let mut removed_pages = Vec::new();
        let mut page_names = Map::new();
        for page in &self.document.pages {
            match self.checkpoint.pages.iter().find(|old| old.id == page.id) {
                None => added_pages.push(serde_json::to_value(page).map_err(|e| e.to_string())?),
                Some(old) => {
                    if old.children != page.children {
                        page_children.insert(page.id.clone(), Value::Array(page.children.iter().cloned().map(Value::String).collect()));
                    }
                    if old.name != page.name {
                        page_names.insert(page.id.clone(), Value::String(page.name.clone()));
                    }
                }
            }
        }
        for old in &self.checkpoint.pages {
            if self.document.pages.iter().all(|page| page.id != old.id) {
                removed_pages.push(Value::String(old.id.clone()));
            }
        }
        let document_name = (self.document.name != self.checkpoint.name).then(|| self.document.name.clone());
        let patch = json!({
            "pageId": self.page_id,
            "selection": self.selection,
            "schemaVersion": self.document.schema_version,
            "nodes": nodes,
            "removed": removed,
            "pageChildren": page_children,
            "addedPages": added_pages,
            "removedPages": removed_pages,
            "pageNames": page_names,
            "documentName": document_name,
        });
        self.checkpoint = self.document.clone();
        self.checkpoint_page = self.page_id.clone();
        self.checkpoint_selection = self.selection.clone();
        self.dirty.clear();
        self.removed.clear();
        Ok(patch)
    }

    fn rollback(&mut self) {
        self.document = self.checkpoint.clone();
        self.page_id = self.checkpoint_page.clone();
        self.selection = self.checkpoint_selection.clone();
        self.dirty.clear();
        self.removed.clear();
    }

    fn set_translation(&mut self, id: &str, index: usize, value: f64) -> Result<(), String> {
        if !value.is_finite() || value.abs() > 1e7 {
            return Err("Translation is outside the admitted range".into());
        }
        self.node_mut(id)?.transform.0[index] = value;
        Ok(())
    }

    fn set_rotation(&mut self, id: &str, degrees: f64) -> Result<(), String> {
        if !degrees.is_finite() {
            return Err("Invalid rotation".into());
        }
        let node = self.node_mut(id)?;
        let mut next = node.transform;
        apply_rotation(&mut next, wrap_degrees(degrees))?;
        node.transform = next;
        Ok(())
    }

    fn set_transform(&mut self, id: &str, value: &Value) -> Result<(), String> {
        let matrix = read_matrix(value)?;
        self.node_mut(id)?.transform = matrix;
        Ok(())
    }

    fn set_fills(&mut self, id: &str, value: &Value) -> Result<(), String> {
        let fills = read_solid_paints(value)?;
        self.node_mut(id)?.fills = fills;
        Ok(())
    }

    fn set_strokes(&mut self, id: &str, value: &Value) -> Result<(), String> {
        let paints = read_solid_paints(value)?;
        let previous = self.node(id)?.strokes.first().map(|stroke| stroke.width).unwrap_or(1.);
        let strokes = paints.into_iter().map(|paint| {
            let mut next = stroke(previous, &paint.color);
            next.paint = paint;
            next
        }).collect();
        self.node_mut(id)?.strokes = strokes;
        Ok(())
    }

    fn set_stroke_weight(&mut self, id: &str, weight: f64) -> Result<(), String> {
        if !weight.is_finite() || !(0. ..=10000.).contains(&weight) {
            return Err("Invalid stroke weight".into());
        }
        let empty = self.node(id)?.strokes.is_empty();
        if empty && weight > 0. {
            self.node_mut(id)?.strokes.push(stroke(weight, "#000000"));
        } else {
            for stroke in &mut self.node_mut(id)?.strokes {
                stroke.width = weight;
            }
        }
        Ok(())
    }

    fn set_stroke_align(&mut self, id: &str, align: &str) -> Result<(), String> {
        let align = match align {
            "CENTER" => "center",
            "INSIDE" => "inside",
            "OUTSIDE" => "outside",
            _ => return Err("Unsupported stroke align".into()),
        };
        for stroke in &mut self.node_mut(id)?.strokes {
            stroke.align = align.into();
        }
        Ok(())
    }

    fn set_corner_radius(&mut self, id: &str, radius: f64) -> Result<(), String> {
        check_radius(radius)?;
        let kind = self.node(id)?.kind.clone();
        if matches!(kind.as_str(), "polygon" | "star") {
            self.bump(7);
            self.node_mut(id)?.corner_radius = radius;
        } else if matches!(kind.as_str(), "rectangle" | "frame") {
            self.node_mut(id)?.radii = [radius; 4];
        } else {
            return Err("cornerRadius is not available on this node".into());
        }
        Ok(())
    }

    fn set_radius_index(&mut self, id: &str, index: usize, radius: f64) -> Result<(), String> {
        check_radius(radius)?;
        let kind = self.node(id)?.kind.clone();
        if !matches!(kind.as_str(), "rectangle" | "frame") {
            return Err("Individual corner radii are only available on rectangles and frames".into());
        }
        self.node_mut(id)?.radii[index] = radius;
        Ok(())
    }

    fn set_characters(&mut self, id: &str, text: &str) -> Result<(), String> {
        if self.node(id)?.kind != "text" {
            return Err("characters is only available on text".into());
        }
        if text.chars().count() > 100_000 {
            return Err("Text exceeds 100000 characters".into());
        }
        self.require_font(id)?;
        let node = self.node_mut(id)?;
        crate::mutation::replace_text(node, text.to_string());
        Ok(())
    }

    fn set_font_size(&mut self, id: &str, size: f64) -> Result<(), String> {
        if self.node(id)?.kind != "text" {
            return Err("fontSize is only available on text".into());
        }
        if !size.is_finite() || !(1. ..=4096.).contains(&size) {
            return Err("fontSize must be between 1 and 4096".into());
        }
        self.require_font(id)?;
        self.node_mut(id)?.font_size = size;
        Ok(())
    }

    fn set_font_name(&mut self, id: &str, value: &Value) -> Result<(), String> {
        if self.node(id)?.kind != "text" {
            return Err("fontName is only available on text".into());
        }
        let family = value.get("family").and_then(Value::as_str).unwrap_or("");
        let style = value.get("style").and_then(Value::as_str).unwrap_or("Regular");
        self.remember_font(family, style)?;
        if !self.fonts.contains(&font_key(family, style)) {
            return Err(format!("Call loadFontAsync before setting fontName {family} {style}"));
        }
        let node = self.node_mut(id)?;
        let font = node.plugin_data.entry(FONT_PLUGIN.into()).or_default();
        font.insert("family".into(), family.into());
        font.insert("style".into(), style.into());
        Ok(())
    }

    fn set_layout_mode(&mut self, id: &str, mode: &str) -> Result<(), String> {
        let flow = match mode {
            "NONE" => Flow::None,
            "HORIZONTAL" => Flow::Horizontal,
            "VERTICAL" => Flow::Vertical,
            "GRID" => return Err("GRID layout is not available".into()),
            _ => return Err("Unsupported layoutMode".into()),
        };
        let layout = self.ensure_layout(id)?;
        layout.mode = flow;
        Ok(())
    }

    fn set_gap(&mut self, id: &str, gap: f64) -> Result<(), String> {
        if !gap.is_finite() || !(0. ..=1e5).contains(&gap) {
            return Err("Invalid item spacing".into());
        }
        self.ensure_layout(id)?.gap = gap;
        Ok(())
    }

    fn set_padding(&mut self, id: &str, index: usize, value: f64) -> Result<(), String> {
        if !value.is_finite() || !(0. ..=1e5).contains(&value) {
            return Err("Invalid padding".into());
        }
        self.ensure_layout(id)?.padding[index] = value;
        Ok(())
    }

    fn set_justify(&mut self, id: &str, value: &str) -> Result<(), String> {
        let align = match value {
            "MIN" => Align::Start,
            "CENTER" => Align::Center,
            "MAX" => Align::End,
            "SPACE_BETWEEN" => Align::SpaceBetween,
            "SPACE_AROUND" => Align::SpaceAround,
            "SPACE_EVENLY" => Align::SpaceEvenly,
            _ => return Err("Unsupported primary axis alignment".into()),
        };
        self.ensure_layout(id)?.justify = align;
        Ok(())
    }

    fn set_align(&mut self, id: &str, value: &str) -> Result<(), String> {
        let align = match value {
            "MIN" => Align::Start,
            "CENTER" => Align::Center,
            "MAX" => Align::End,
            _ => return Err("Unsupported counter axis alignment".into()),
        };
        self.ensure_layout(id)?.align = align;
        Ok(())
    }

    fn set_sizing(&mut self, id: &str, horizontal: bool, value: &str) -> Result<(), String> {
        let mode = match value {
            "FIXED" => SizeMode::Fixed,
            "HUG" => SizeMode::Hug,
            "FILL" => SizeMode::Fill,
            _ => return Err("Unsupported layout sizing".into()),
        };
        if mode == SizeMode::Hug {
            let node = self.node(id)?;
            let laid_out = node.layout.as_ref().is_some_and(|layout| layout.mode != Flow::None);
            if node.kind != "text" && !laid_out {
                return Err("HUG sizing requires text or auto layout".into());
            }
        }
        let sizing = self.ensure_sizing(id);
        if horizontal {
            sizing.width = mode;
        } else {
            sizing.height = mode;
        }
        Ok(())
    }

    fn set_constraints(&mut self, id: &str, value: &Value) -> Result<(), String> {
        let horizontal = read_anchor(value.get("horizontal").and_then(Value::as_str).unwrap_or("MIN"))?;
        let vertical = read_anchor(value.get("vertical").and_then(Value::as_str).unwrap_or("MIN"))?;
        let node = self.node_mut(id)?;
        let mut constraints = node.constraints.clone().unwrap_or_default();
        constraints.horizontal = horizontal;
        constraints.vertical = vertical;
        node.constraints = Some(constraints);
        Ok(())
    }

    fn set_effects(&mut self, id: &str, value: &Value) -> Result<(), String> {
        let list = value.as_array().ok_or("effects must be an array")?;
        if list.len() > 16 {
            return Err("A node can have at most 16 effects".into());
        }
        let mut effects = Vec::new();
        for effect in list {
            effects.push(read_effect(effect)?);
        }
        self.node_mut(id)?.effects = effects;
        Ok(())
    }

    fn set_point_count(&mut self, id: &str, value: &Value) -> Result<(), String> {
        let count = value.as_u64().ok_or("pointCount must be an integer")? as usize;
        if !(3..=128).contains(&count) {
            return Err("pointCount must be from 3 to 128".into());
        }
        let kind = self.node(id)?.kind.clone();
        if kind != "polygon" && kind != "star" {
            return Err("pointCount is only available on polygons and stars".into());
        }
        self.node_mut(id)?.points = count;
        Ok(())
    }

    fn set_inner_radius(&mut self, id: &str, radius: f64) -> Result<(), String> {
        if self.node(id)?.kind != "star" {
            return Err("innerRadius is only available on stars".into());
        }
        if !radius.is_finite() || !(0.01..=1.).contains(&radius) {
            return Err("innerRadius must be from 0.01 to 1".into());
        }
        self.node_mut(id)?.inner_radius = radius;
        Ok(())
    }

    fn set_text_align_h(&mut self, id: &str, value: &str) -> Result<(), String> {
        if self.node(id)?.kind != "text" {
            return Err("textAlignHorizontal is only available on text".into());
        }
        let align = match value {
            "LEFT" => "start",
            "CENTER" => "center",
            "RIGHT" => "end",
            "JUSTIFIED" => "justify",
            _ => return Err("Unsupported text alignment".into()),
        };
        if align == "justify" {
            self.bump(4);
        }
        self.ensure_text_style(id)?.align = align.into();
        Ok(())
    }

    fn set_text_align_v(&mut self, id: &str, value: &str) -> Result<(), String> {
        if self.node(id)?.kind != "text" {
            return Err("textAlignVertical is only available on text".into());
        }
        let align = match value {
            "TOP" => "top",
            "CENTER" => "center",
            "BOTTOM" => "bottom",
            _ => return Err("Unsupported vertical text alignment".into()),
        };
        if align != "top" {
            self.bump(20);
        }
        self.ensure_text_style(id)?.vertical_align = align.into();
        Ok(())
    }

    fn ensure_layout(&mut self, id: &str) -> Result<&mut Layout, String> {
        let kind = self.node(id)?.kind.clone();
        if !matches!(kind.as_str(), "frame" | "group" | "section") {
            return Err("Auto layout is only available on frames, groups, and sections".into());
        }
        let node = self.node_mut(id)?;
        if node.layout.is_none() {
            node.layout = Some(Layout::default());
        }
        Ok(node.layout.as_mut().unwrap())
    }

    fn ensure_sizing(&mut self, id: &str) -> &mut Sizing {
        let node = self.node_mut(id).unwrap();
        if node.sizing.is_none() {
            node.sizing = Some(Sizing::default());
        }
        node.sizing.as_mut().unwrap()
    }

    fn ensure_text_style(&mut self, id: &str) -> Result<&mut crate::font::TextStyle, String> {
        let node = self.node_mut(id)?;
        if node.text_style.is_none() {
            node.text_style = Some(Box::new(crate::font::TextStyle::default()));
        }
        Ok(node.text_style.as_mut().unwrap())
    }

    fn require_font(&self, id: &str) -> Result<(), String> {
        let node = self.node(id)?;
        let (family, style) = font_pair(node);
        if !self.fonts.contains(&font_key(&family, &style)) {
            return Err(format!("Call loadFontAsync for {family} {style} before editing text"));
        }
        Ok(())
    }

    fn remember_font(&mut self, family: &str, style: &str) -> Result<(), String> {
        if family.trim().is_empty() || family.chars().count() > 200 || style.chars().count() > 80 {
            return Err("Invalid font name".into());
        }
        self.fonts.insert(font_key(family, style));
        Ok(())
    }

    fn font_name_json(&self, node: &Node) -> Value {
        let (family, style) = font_pair(node);
        json!({ "family": family, "style": style })
    }

    fn absolute_box(&self, id: &str) -> Result<Value, String> {
        let (width, height) = {
            let node = self.node(id)?;
            (node.width, node.height)
        };
        let world = self.world(id)?;
        let corners = [(0., 0.), (width, 0.), (width, height), (0., height)];
        let points: Vec<_> = corners.iter().map(|(x, y)| world.point(Point::new(*x, *y))).collect();
        let min_x = points.iter().map(|point| point.x).fold(f64::INFINITY, f64::min);
        let min_y = points.iter().map(|point| point.y).fold(f64::INFINITY, f64::min);
        let max_x = points.iter().map(|point| point.x).fold(f64::NEG_INFINITY, f64::max);
        let max_y = points.iter().map(|point| point.y).fold(f64::NEG_INFINITY, f64::max);
        Ok(json!({
            "x": min_x,
            "y": min_y,
            "width": (max_x - min_x).max(0.),
            "height": (max_y - min_y).max(0.),
        }))
    }

    fn children_bounds(&self, parent: &str, ids: &[String]) -> Result<(f64, f64, f64, f64), String> {
        let parent_world = self.container_world(parent)?;
        let inverse = parent_world.inverse()?;
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for id in ids {
            let (width, height) = {
                let node = self.node(id)?;
                (node.width, node.height)
            };
            let local = inverse.concat(self.world(id)?);
            for (x, y) in [(0., 0.), (width, 0.), (width, height), (0., height)] {
                let point = local.point(Point::new(x, y));
                min_x = min_x.min(point.x);
                min_y = min_y.min(point.y);
                max_x = max_x.max(point.x);
                max_y = max_y.max(point.y);
            }
        }
        if !min_x.is_finite() || !max_x.is_finite() {
            return Err("Cannot group nodes without finite bounds".into());
        }
        Ok((min_x, min_y, max_x, max_y))
    }

    fn world(&self, id: &str) -> Result<Transform, String> {
        let mut chain = Vec::new();
        let mut current = id.to_string();
        for _ in 0..65 {
            chain.push(self.node(&current)?.transform);
            match self.parent_id(&current) {
                Some(parent) if !self.is_page(&parent) => current = parent,
                _ => {
                    let mut world = Transform::default();
                    for transform in chain.iter().rev() {
                        world = world.concat(*transform);
                    }
                    return Ok(world);
                }
            }
        }
        Err("Node parent chain is too deep".into())
    }

    fn container_world(&self, id: &str) -> Result<Transform, String> {
        if self.is_page(id) {
            Ok(Transform::default())
        } else {
            self.world(id)
        }
    }

    fn parent_value(&self, id: &str) -> Result<Value, String> {
        match self.parent_id(id) {
            Some(parent) if self.is_page(&parent) => Ok(json!({"id": parent, "type": "PAGE"})),
            Some(parent) => Ok(json!({"id": parent, "type": figma_type(self.node(&parent)?)} )),
            None => Ok(Value::Null),
        }
    }

    fn page_value(&self, id: &str) -> Result<Value, String> {
        let page = self.page(id)?;
        Ok(json!({"id": page.id, "type": "PAGE", "name": page.name}))
    }

    fn child_values(&self, ids: &[String]) -> Result<Value, String> {
        let mut out = Vec::new();
        for id in ids {
            out.push(json!({"id": id, "type": figma_type(self.node(id)?)}));
        }
        Ok(Value::Array(out))
    }

    fn parent_id(&self, id: &str) -> Option<String> {
        for page in &self.document.pages {
            if page.children.iter().any(|child| child == id) {
                return Some(page.id.clone());
            }
        }
        self.document.nodes.iter().find_map(|(parent, node)| {
            node.children.iter().any(|child| child == id).then(|| parent.clone())
        })
    }

    fn is_ancestor(&self, id: &str, maybe_child: &str) -> Result<bool, String> {
        let mut current = maybe_child.to_string();
        for _ in 0..65 {
            if current == id {
                return Ok(true);
            }
            match self.parent_id(&current) {
                Some(parent) if !self.is_page(&parent) => current = parent,
                _ => return Ok(false),
            }
        }
        Err("Node parent chain is too deep".into())
    }

    fn child_index(&self, parent: &str, id: &str) -> Result<Option<usize>, String> {
        let children = if self.is_page(parent) {
            &self.page(parent)?.children
        } else {
            &self.node(parent)?.children
        };
        Ok(children.iter().position(|child| child == id))
    }

    fn attach_child(&mut self, parent: &str, id: &str, index: Option<usize>) -> Result<(), String> {
        if self.is_page(parent) {
            let page = self.page_mut(parent)?;
            let at = index.unwrap_or(page.children.len()).min(page.children.len());
            page.children.insert(at, id.to_string());
        } else {
            let node = self.node_mut(parent)?;
            let at = index.unwrap_or(node.children.len()).min(node.children.len());
            node.children.insert(at, id.to_string());
            self.dirty.insert(parent.to_string());
        }
        Ok(())
    }

    fn detach_child(&mut self, parent: &str, id: &str) -> Result<(), String> {
        if self.is_page(parent) {
            self.page_mut(parent)?.children.retain(|child| child != id);
        } else {
            self.node_mut(parent)?.children.retain(|child| child != id);
            self.dirty.insert(parent.to_string());
        }
        Ok(())
    }

    fn ensure_container(&self, id: &str) -> Result<(), String> {
        if self.is_page(id) {
            return Ok(());
        }
        let kind = &self.node(id)?.kind;
        if matches!(kind.as_str(), "frame" | "group" | "section") {
            Ok(())
        } else {
            Err("This node cannot have children".into())
        }
    }

    fn alloc_id(&mut self) -> String {
        loop {
            self.seq = self.seq.wrapping_add(1);
            let n = self.seq;
            let id = format!("{:08x}-{:04x}-4{:03x}-a{:03x}-{:012x}", (n ^ 0x5a17_c3e1) as u32, ((n >> 8) & 0xffff) as u16, (n & 0xfff) as u16, ((n >> 12) & 0xfff) as u16, n);
            if !self.document.nodes.contains_key(&id) && self.document.pages.iter().all(|page| page.id != id) && self.document.id != id {
                return id;
            }
        }
    }

    fn bump(&mut self, version: u32) {
        if self.document.schema_version < version {
            self.document.schema_version = version;
        }
    }

    fn is_page(&self, id: &str) -> bool {
        self.document.pages.iter().any(|page| page.id == id)
    }

    fn page(&self, id: &str) -> Result<&Page, String> {
        self.document.pages.iter().find(|page| page.id == id).ok_or_else(|| "Unknown page".into())
    }

    fn page_mut(&mut self, id: &str) -> Result<&mut Page, String> {
        self.document.pages.iter_mut().find(|page| page.id == id).ok_or_else(|| "Unknown page".into())
    }

    fn node(&self, id: &str) -> Result<&Node, String> {
        self.document.nodes.get(id).ok_or_else(|| "Unknown node".into())
    }

    fn node_mut(&mut self, id: &str) -> Result<&mut Node, String> {
        self.document.nodes.get_mut(id).ok_or_else(|| "Unknown node".into())
    }
}

fn node_on_page(document: &Document, page_id: &str, id: &str) -> bool {
    let mut parents = BTreeMap::new();
    if let Some(page) = document.pages.iter().find(|page| page.id == page_id) {
        let mut stack = page.children.clone();
        while let Some(current) = stack.pop() {
            if current == id {
                return true;
            }
            if let Some(node) = document.nodes.get(&current) {
                parents.insert(current.clone(), ());
                stack.extend(node.children.iter().cloned());
            }
            if parents.len() > 100_000 {
                return false;
            }
        }
    }
    false
}

fn kernel_kind(figma: &str) -> Result<String, String> {
    Ok(match figma {
        "RECTANGLE" => "rectangle",
        "ELLIPSE" => "ellipse",
        "FRAME" => "frame",
        "TEXT" => "text",
        "LINE" => "line",
        "POLYGON" => "polygon",
        "STAR" => "star",
        "SECTION" => "section",
        "GROUP" => "group",
        _ => return Err(format!("Unsupported node type {figma}")),
    }
    .into())
}

fn default_name(figma: &str) -> String {
    match figma {
        "RECTANGLE" => "Rectangle",
        "ELLIPSE" => "Ellipse",
        "FRAME" => "Frame",
        "TEXT" => "Text",
        "LINE" => "Line",
        "POLYGON" => "Polygon",
        "STAR" => "Star",
        "SECTION" => "Section",
        "GROUP" => "Group",
        _ => "Layer",
    }
    .into()
}

fn figma_type(node: &Node) -> String {
    if node.component_set {
        return "COMPONENT_SET".into();
    }
    if node.component.is_some() {
        return "COMPONENT".into();
    }
    if node.instance.is_some() {
        return "INSTANCE".into();
    }
    if node.boolean_operation.is_some() {
        return "BOOLEAN_OPERATION".into();
    }
    match node.kind.as_str() {
        "rectangle" => "RECTANGLE",
        "ellipse" => "ELLIPSE",
        "frame" => "FRAME",
        "text" => "TEXT",
        "line" => "LINE",
        "polygon" => "POLYGON",
        "star" => "STAR",
        "section" => "SECTION",
        "group" => "GROUP",
        "vector" => "VECTOR",
        "slice" => "SLICE",
        other => return other.to_ascii_uppercase(),
    }
    .into()
}

fn solid(color: &str, opacity: f64) -> Paint {
    Paint {
        transform: None,
        id: String::new(),
        kind: "solid".into(),
        color: color.into(),
        opacity,
        visible: true,
        angle: 0.,
        stops: Vec::new(),
        image: None,
        fit: "cover".into(),
        blend: "normal".into(),
        adjust: None,
        tile: None,
    }
}

fn stroke(width: f64, color: &str) -> Stroke {
    Stroke {
        start_marker: Default::default(),
        end_marker: Default::default(),
        id: String::new(),
        paint: solid(color, 1.),
        width,
        align: "center".into(),
        cap: "round".into(),
        join: "round".into(),
        dash: String::new(),
        dash_offset: 0.,
        visible: true,
        width_profile: Vec::new(),
    }
}

fn effect_shell(kind: &str) -> Effect {
    Effect {
        zoom_blur: None,
        motion_angle: 0.,
        color_controls: None,
        id: String::new(),
        kind: kind.into(),
        visible: true,
        radius: 0.,
        x: 0.,
        y: 0.,
        spread: 0.,
        color: "#000000".into(),
        opacity: 1.,
        amount: 0.,
        glass: None,
        texture: None,
        gradient_blur: None,
        show_shadow_behind_node: false,
    }
}

fn read_fills(node: &Node) -> Result<Value, String> {
    let mut paints = Vec::new();
    for paint in &node.fills {
        paints.push(paint_json(paint)?);
    }
    Ok(Value::Array(paints))
}

fn read_strokes(node: &Node) -> Result<Value, String> {
    let mut paints = Vec::new();
    for stroke in &node.strokes {
        paints.push(paint_json(&stroke.paint)?);
    }
    Ok(Value::Array(paints))
}

fn paint_json(paint: &Paint) -> Result<Value, String> {
    if paint.kind != "solid" || paint.transform.is_some() {
        return Err("Only SOLID paints can be read by this plugin host".into());
    }
    let (r, g, b, _) = parse_hex(&paint.color)?;
    Ok(json!({
        "type": "SOLID",
        "color": { "r": r, "g": g, "b": b },
        "opacity": paint.opacity,
        "visible": paint.visible,
    }))
}

fn read_solid_paints(value: &Value) -> Result<Vec<Paint>, String> {
    let list = value.as_array().ok_or("Paints must be an array")?;
    if list.len() > 16 {
        return Err("A node can have at most 16 paints".into());
    }
    list.iter().map(read_solid_paint).collect()
}

fn read_solid_paint(value: &Value) -> Result<Paint, String> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    if kind != "SOLID" {
        return Err("Only SOLID paints can be written by this plugin host".into());
    }
    let color = value.get("color").ok_or("SOLID paint requires a color")?;
    let r = read_f64(color.get("r").unwrap_or(&Value::Null), "r")?;
    let g = read_f64(color.get("g").unwrap_or(&Value::Null), "g")?;
    let b = read_f64(color.get("b").unwrap_or(&Value::Null), "b")?;
    let opacity = value.get("opacity").map(|v| read_f64(v, "opacity")).transpose()?.unwrap_or(1.);
    if !(0. ..=1.).contains(&opacity) {
        return Err("Paint opacity must be between 0 and 1".into());
    }
    let mut paint = solid(&hex_rgb(r, g, b)?, opacity);
    if let Some(visible) = value.get("visible") {
        paint.visible = read_bool(visible, "visible")?;
    }
    Ok(paint)
}

fn read_stroke_weight(node: &Node) -> Result<Value, String> {
    if node.strokes.is_empty() {
        return Ok(json!(0.));
    }
    let first = node.strokes[0].width;
    if node.strokes.iter().any(|stroke| stroke.width != first) {
        return Ok(json!({"mixed": true}));
    }
    Ok(json!(first))
}

fn read_stroke_align(node: &Node) -> Result<Value, String> {
    let Some(stroke) = node.strokes.first() else {
        return Ok(json!("CENTER"));
    };
    if node.strokes.iter().any(|item| item.align != stroke.align) {
        return Ok(json!({"mixed": true}));
    }
    Ok(json!(match stroke.align.as_str() {
        "inside" => "INSIDE",
        "outside" => "OUTSIDE",
        _ => "CENTER",
    }))
}

fn read_corner_radius(node: &Node) -> Result<Value, String> {
    if matches!(node.kind.as_str(), "polygon" | "star") {
        return Ok(json!(node.corner_radius));
    }
    if node.radii.iter().any(|radius| *radius != node.radii[0]) {
        return Ok(json!({"mixed": true}));
    }
    Ok(json!(node.radii[0]))
}

fn read_layout_mode(node: &Node) -> Result<Value, String> {
    let mode = node.layout.as_ref().map(|layout| layout.mode).unwrap_or(Flow::None);
    Ok(json!(match mode {
        Flow::None => "NONE",
        Flow::Horizontal => "HORIZONTAL",
        Flow::Vertical => "VERTICAL",
        Flow::Grid => return Err("GRID layout cannot be read".into()),
    }))
}

fn read_effects(node: &Node) -> Result<Value, String> {
    let mut out = Vec::new();
    for effect in &node.effects {
        if effect.glass.is_some() || effect.texture.is_some() || effect.gradient_blur.is_some() || effect.color_controls.is_some() || effect.zoom_blur.is_some() {
            return Err("This effect cannot be read by this plugin host".into());
        }
        let (r, g, b, _) = parse_hex(&effect.color)?;
        let kind = match effect.kind.as_str() {
            "shadow" => "DROP_SHADOW",
            "inner-shadow" => "INNER_SHADOW",
            "blur" => "LAYER_BLUR",
            "background-blur" => "BACKGROUND_BLUR",
            _ => return Err("This effect cannot be read by this plugin host".into()),
        };
        out.push(json!({
            "type": kind,
            "visible": effect.visible,
            "radius": effect.radius,
            "spread": effect.spread,
            "offset": { "x": effect.x, "y": effect.y },
            "color": { "r": r, "g": g, "b": b, "a": effect.opacity },
            "blendMode": "NORMAL",
        }));
    }
    Ok(Value::Array(out))
}

fn read_effect(value: &Value) -> Result<Effect, String> {
    let kind = match value.get("type").and_then(Value::as_str).unwrap_or("") {
        "DROP_SHADOW" => "shadow",
        "INNER_SHADOW" => "inner-shadow",
        "LAYER_BLUR" | "FOREGROUND_BLUR" => "blur",
        "BACKGROUND_BLUR" => "background-blur",
        _ => return Err("Only drop shadow, inner shadow, layer blur, and background blur can be written".into()),
    };
    let mut effect = effect_shell(kind);
    if let Some(visible) = value.get("visible") {
        effect.visible = read_bool(visible, "visible")?;
    }
    if let Some(radius) = value.get("radius") {
        effect.radius = read_f64(radius, "radius")?;
    }
    if let Some(spread) = value.get("spread") {
        effect.spread = read_f64(spread, "spread")?;
    }
    if let Some(offset) = value.get("offset") {
        effect.x = offset.get("x").map(|v| read_f64(v, "x")).transpose()?.unwrap_or(0.);
        effect.y = offset.get("y").map(|v| read_f64(v, "y")).transpose()?.unwrap_or(0.);
    }
    if let Some(color) = value.get("color") {
        let r = read_f64(color.get("r").unwrap_or(&Value::Null), "r")?;
        let g = read_f64(color.get("g").unwrap_or(&Value::Null), "g")?;
        let b = read_f64(color.get("b").unwrap_or(&Value::Null), "b")?;
        effect.color = hex_rgb(r, g, b)?;
        if let Some(alpha) = color.get("a") {
            effect.opacity = read_f64(alpha, "a")?;
        }
    }
    if !(0. ..=1000.).contains(&effect.radius) || !(0. ..=1.).contains(&effect.opacity) || !effect.x.is_finite() || !effect.y.is_finite() || !effect.spread.is_finite() {
        return Err("Invalid effect parameters".into());
    }
    Ok(effect)
}

fn padding(node: &Node, index: usize) -> f64 {
    node.layout.as_ref().map(|layout| layout.padding[index]).unwrap_or(0.)
}

fn justify_name(align: Align) -> &'static str {
    match align {
        Align::Center => "CENTER",
        Align::End => "MAX",
        Align::SpaceBetween => "SPACE_BETWEEN",
        Align::SpaceAround => "SPACE_AROUND",
        Align::SpaceEvenly => "SPACE_EVENLY",
        _ => "MIN",
    }
}

fn align_name(align: Align) -> &'static str {
    match align {
        Align::Center => "CENTER",
        Align::End => "MAX",
        _ => "MIN",
    }
}

fn size_name(mode: SizeMode) -> &'static str {
    match mode {
        SizeMode::Hug => "HUG",
        SizeMode::Fill => "FILL",
        SizeMode::Fixed => "FIXED",
    }
}

fn constraints_json(node: &Node) -> Value {
    let constraints = node.constraints.clone().unwrap_or_default();
    json!({
        "horizontal": anchor_name(constraints.horizontal),
        "vertical": anchor_name(constraints.vertical),
    })
}

fn anchor_name(anchor: Anchor) -> &'static str {
    match anchor {
        Anchor::Center => "CENTER",
        Anchor::End => "MAX",
        Anchor::Stretch => "STRETCH",
        Anchor::Scale => "SCALE",
        Anchor::Start => "MIN",
    }
}

fn read_anchor(value: &str) -> Result<Anchor, String> {
    Ok(match value {
        "MIN" => Anchor::Start,
        "CENTER" => Anchor::Center,
        "MAX" => Anchor::End,
        "STRETCH" => Anchor::Stretch,
        "SCALE" => Anchor::Scale,
        _ => return Err("Unsupported constraint".into()),
    })
}

fn blend_to_figma(mode: &str) -> String {
    if mode == "pass-through" {
        return "PASS_THROUGH".into();
    }
    mode.replace('-', "_").to_ascii_uppercase()
}

fn blend_from_figma(mode: &str) -> Result<String, String> {
    let mapped = match mode {
        "PASS_THROUGH" => "pass-through",
        "NORMAL" => "normal",
        "MULTIPLY" => "multiply",
        "SCREEN" => "screen",
        "OVERLAY" => "overlay",
        "DARKEN" => "darken",
        "LIGHTEN" => "lighten",
        "COLOR_DODGE" => "color-dodge",
        "COLOR_BURN" => "color-burn",
        "HARD_LIGHT" => "hard-light",
        "SOFT_LIGHT" => "soft-light",
        "DIFFERENCE" => "difference",
        "EXCLUSION" => "exclusion",
        "HUE" => "hue",
        "SATURATION" => "saturation",
        "COLOR" => "color",
        "LUMINOSITY" => "luminosity",
        "LINEAR_BURN" => "linear-burn",
        "LINEAR_DODGE" => "linear-dodge",
        _ => return Err("Unsupported blend mode".into()),
    };
    Ok(mapped.into())
}

fn text_align_h(node: &Node) -> &'static str {
    match node.text_style.as_ref().map(|style| style.align.as_str()).unwrap_or("start") {
        "center" => "CENTER",
        "end" => "RIGHT",
        "justify" => "JUSTIFIED",
        _ => "LEFT",
    }
}

fn text_align_v(node: &Node) -> &'static str {
    match node.text_style.as_ref().map(|style| style.vertical_align.as_str()).unwrap_or("top") {
        "center" => "CENTER",
        "bottom" => "BOTTOM",
        _ => "TOP",
    }
}

const FONT_PLUGIN: &str = "futureox.font";

fn font_pair(node: &Node) -> (String, String) {
    let font = node.plugin_data.get(FONT_PLUGIN);
    let family = font.and_then(|entries| entries.get("family")).cloned().unwrap_or_else(|| "Inter".into());
    let style = font.and_then(|entries| entries.get("style")).cloned().unwrap_or_else(|| "Regular".into());
    (family, style)
}

fn font_key(family: &str, style: &str) -> String {
    format!("{family}\n{style}")
}

fn matrix_json(transform: Transform) -> Value {
    let m = transform.0;
    json!([[m[0], m[2], m[4]], [m[1], m[3], m[5]]])
}

fn read_matrix(value: &Value) -> Result<Transform, String> {
    let rows = value.as_array().ok_or("relativeTransform must be a 2×3 matrix")?;
    if rows.len() != 2 {
        return Err("relativeTransform must be a 2×3 matrix".into());
    }
    let mut cells = [0.; 6];
    for (row_index, row) in rows.iter().enumerate() {
        let row = row.as_array().ok_or("relativeTransform must be a 2×3 matrix")?;
        if row.len() != 3 {
            return Err("relativeTransform must be a 2×3 matrix".into());
        }
        for (column, cell) in row.iter().enumerate() {
            let number = read_f64(cell, "relativeTransform")?;
            if number.abs() > 1e7 {
                return Err("Transform is outside the admitted range".into());
            }
            // [[a, c, tx], [b, d, ty]] -> [a, b, c, d, tx, ty]
            let index = match (row_index, column) {
                (0, 0) => 0,
                (1, 0) => 1,
                (0, 1) => 2,
                (1, 1) => 3,
                (0, 2) => 4,
                _ => 5,
            };
            cells[index] = number;
        }
    }
    let transform = Transform(cells);
    transform.inverse()?;
    Ok(transform)
}

fn rotation_degrees(transform: Transform) -> f64 {
    let m = transform.0;
    wrap_degrees(m[1].atan2(m[0]).to_degrees())
}

fn apply_rotation(transform: &mut Transform, degrees: f64) -> Result<(), String> {
    let m = transform.0;
    let sx = m[0].hypot(m[1]);
    let sy_abs = m[2].hypot(m[3]);
    if sx == 0. || sy_abs == 0. || !sx.is_finite() || !sy_abs.is_finite() {
        return Err("Cannot rotate a singular transform".into());
    }
    let det = m[0] * m[3] - m[1] * m[2];
    let sy = if det < 0. { -sy_abs } else { sy_abs };
    let (sin, cos) = degrees.to_radians().sin_cos();
    let next = Transform([sx * cos, sx * sin, -sy * sin, sy * cos, m[4], m[5]]);
    next.inverse()?;
    *transform = next;
    Ok(())
}

fn wrap_degrees(value: f64) -> f64 {
    let mut degrees = value % 360.;
    if degrees > 180. {
        degrees -= 360.;
    }
    if degrees < -180. {
        degrees += 360.;
    }
    degrees
}

fn hex_rgb(r: f64, g: f64, b: f64) -> Result<String, String> {
    Ok(format!("#{:02x}{:02x}{:02x}", channel(r)?, channel(g)?, channel(b)?))
}

fn channel(value: f64) -> Result<u8, String> {
    if !value.is_finite() || !(0. ..=1.).contains(&value) {
        return Err("Color channels must be between 0 and 1".into());
    }
    Ok((value * 255.).round() as u8)
}

fn parse_hex(value: &str) -> Result<(f64, f64, f64, f64), String> {
    let hex = value.trim().trim_start_matches('#');
    let byte = |index: usize| u8::from_str_radix(&hex[index..index + 2], 16).map(|channel| channel as f64 / 255.).map_err(|_| "Unsupported color".to_string());
    match hex.len() {
        6 => Ok((byte(0)?, byte(2)?, byte(4)?, 1.)),
        8 => Ok((byte(0)?, byte(2)?, byte(4)?, byte(6)?)),
        _ => Err("Unsupported color".into()),
    }
}

fn read_f64(value: &Value, name: &str) -> Result<f64, String> {
    value.as_f64().filter(|number| number.is_finite()).ok_or_else(|| format!("Invalid {name}"))
}

fn read_bool(value: &Value, name: &str) -> Result<bool, String> {
    value.as_bool().ok_or_else(|| format!("Invalid {name}"))
}

fn read_name(value: &Value) -> Result<String, String> {
    let name = value.as_str().ok_or("Name must be a string")?;
    if name.chars().count() > 200 || name.chars().any(|ch| ch.is_control()) {
        return Err("Name must be 200 characters or fewer and cannot contain control characters".into());
    }
    Ok(name.to_string())
}

fn read_ids(value: &Value) -> Result<Vec<String>, String> {
    let list = value.as_array().ok_or("Selection must be an array of node ids")?;
    list.iter().map(|item| {
        item.as_str().or_else(|| item.get("id").and_then(Value::as_str)).map(str::to_string).ok_or_else(|| "Selection entries must be node ids".to_string())
    }).collect()
}

fn check_radius(radius: f64) -> Result<(), String> {
    if radius.is_finite() && (0. ..=1e7).contains(&radius) { Ok(()) } else { Err("Invalid corner radius".into()) }
}

fn validate_plugin_id(id: &str) -> Result<(), String> {
    if (1..=80).contains(&id.chars().count()) && id.chars().all(|ch| ch.is_ascii_alphanumeric() || "._:-".contains(ch)) {
        Ok(())
    } else {
        Err("Plugin id must be 1–80 characters of letters, digits, '.', '_', ':', or '-'".into())
    }
}

fn validate_data_key(key: &str) -> Result<(), String> {
    if (1..=64).contains(&key.chars().count()) && !key.chars().any(|ch| ch.is_control()) {
        Ok(())
    } else {
        Err("Plugin data key must be 1–64 characters without control characters".into())
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn document() -> String {
        r##"{"schemaVersion":2,"id":"11111111-1111-4111-8111-111111111111","name":"Doc","pages":[{"id":"22222222-2222-4222-8222-222222222222","name":"Page 1","children":[],"background":"#f5f5f5"}],"nodes":{}}"##.into()
    }

    fn session() -> PluginSession {
        PluginSession::open(&document(), r#"{"pluginId":"futureox.sample","pageId":"22222222-2222-4222-8222-222222222222"}"#).unwrap()
    }

    fn call(session: &mut PluginSession, command: Value) -> Value {
        let raw = session.call(&command.to_string()).unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    #[test]
    fn create_resize_fill_selection_and_flush_validate() {
        let mut session = session();
        let created = call(&mut session, json!({"op":"create","type":"RECTANGLE"}));
        let id = created["id"].as_str().unwrap().to_string();
        call(&mut session, json!({"op":"resize","id":id,"width":120.0,"height":40.0}));
        call(&mut session, json!({"op":"set","id":id,"prop":"fills","value":[{"type":"SOLID","color":{"r":1.0,"g":0.0,"b":0.0},"opacity":1}]}));
        call(&mut session, json!({"op":"set","id":id,"prop":"name","value":"Label"}));
        call(&mut session, json!({"op":"setSelection","ids":[id]}));
        let patch = call(&mut session, json!({"op":"flush"}));
        let node = &patch["nodes"][&id];
        assert_eq!(node["kind"], "rectangle");
        assert_eq!(node["name"], "Label");
        assert_eq!(node["width"], 120.);
        assert_eq!(node["height"], 40.);
        assert_eq!(node["fills"][0]["color"], "#ff0000");
        assert_eq!(patch["selection"][0], id);
        assert_eq!(patch["pageChildren"]["22222222-2222-4222-8222-222222222222"][0], id);
        assert!(session.document.validate().is_ok());
    }

    #[test]
    fn rotation_is_clockwise_and_bounds_follow_the_transform() {
        let mut session = session();
        let id = call(&mut session, json!({"op":"create","type":"RECTANGLE"}))["id"].as_str().unwrap().to_string();
        call(&mut session, json!({"op":"resize","id":id,"width":100.0,"height":50.0}));
        call(&mut session, json!({"op":"set","id":id,"prop":"rotation","value":90.0}));
        let rotation = call(&mut session, json!({"op":"get","id":id,"prop":"rotation"}));
        assert!((rotation.as_f64().unwrap() - 90.).abs() < 1e-9);
        let bounds = call(&mut session, json!({"op":"get","id":id,"prop":"absoluteBoundingBox"}));
        assert!((bounds["x"].as_f64().unwrap() + 50.).abs() < 1e-6);
        assert!(bounds["y"].as_f64().unwrap().abs() < 1e-6);
        assert!((bounds["width"].as_f64().unwrap() - 50.).abs() < 1e-6);
        assert!((bounds["height"].as_f64().unwrap() - 100.).abs() < 1e-6);
        let matrix = call(&mut session, json!({"op":"get","id":id,"prop":"relativeTransform"}));
        assert!(matrix[0][1].as_f64().unwrap() < 0.);
        call(&mut session, json!({"op":"flush"})).as_object().unwrap();
    }

    #[test]
    fn reparent_preserves_world_position_and_hit_test_prefers_the_child() {
        let mut session = session();
        let frame = call(&mut session, json!({"op":"create","type":"FRAME"}))["id"].as_str().unwrap().to_string();
        call(&mut session, json!({"op":"set","id":frame,"prop":"x","value":10.0}));
        call(&mut session, json!({"op":"set","id":frame,"prop":"y","value":10.0}));
        call(&mut session, json!({"op":"resize","id":frame,"width":200.0,"height":200.0}));
        let rect = call(&mut session, json!({"op":"create","type":"RECTANGLE"}))["id"].as_str().unwrap().to_string();
        call(&mut session, json!({"op":"set","id":rect,"prop":"x","value":30.0}));
        call(&mut session, json!({"op":"set","id":rect,"prop":"y","value":40.0}));
        call(&mut session, json!({"op":"resize","id":rect,"width":20.0,"height":20.0}));
        call(&mut session, json!({"op":"reparent","id":rect,"parentId":frame}));
        assert!((call(&mut session, json!({"op":"get","id":rect,"prop":"x"})).as_f64().unwrap() - 20.).abs() < 1e-9);
        assert!((call(&mut session, json!({"op":"get","id":rect,"prop":"y"})).as_f64().unwrap() - 30.).abs() < 1e-9);
        let child_hit = call(&mut session, json!({"op":"hitTest","x":35.0,"y":45.0}));
        assert_eq!(child_hit["id"], rect);
        let frame_hit = call(&mut session, json!({"op":"hitTest","x":180.0,"y":180.0}));
        assert_eq!(frame_hit["id"], frame);
        let miss = call(&mut session, json!({"op":"hitTest","x":1000.0,"y":1000.0}));
        assert!(miss["id"].is_null());
        call(&mut session, json!({"op":"flush"})).as_object().unwrap();
    }

    #[test]
    fn text_requires_a_loaded_font_and_plugin_data_round_trips() {
        let mut session = session();
        let id = call(&mut session, json!({"op":"create","type":"TEXT"}))["id"].as_str().unwrap().to_string();
        let blocked = session.call(&json!({"op":"set","id":id,"prop":"characters","value":"Hello"}).to_string());
        assert!(blocked.unwrap_err().contains("loadFontAsync"));
        call(&mut session, json!({"op":"loadFont","family":"Inter","style":"Regular"}));
        call(&mut session, json!({"op":"set","id":id,"prop":"characters","value":"Hello"}));
        call(&mut session, json!({"op":"set","id":id,"prop":"fontSize","value":18.0}));
        call(&mut session, json!({"op":"pluginDataSet","id":id,"key":"label","value":"futureox"}));
        assert_eq!(call(&mut session, json!({"op":"pluginDataGet","id":id,"key":"label"})), "futureox");
        let patch = call(&mut session, json!({"op":"flush"}));
        assert_eq!(patch["nodes"][&id]["text"], "Hello");
        assert_eq!(patch["nodes"][&id]["fontSize"], 18.);
        assert_eq!(patch["nodes"][&id]["pluginData"]["futureox.sample"]["label"], "futureox");
    }

    #[test]
    fn group_uses_transformed_bounds_and_singular_matrices_fail() {
        let mut session = session();
        let a = call(&mut session, json!({"op":"create","type":"RECTANGLE"}))["id"].as_str().unwrap().to_string();
        let b = call(&mut session, json!({"op":"create","type":"RECTANGLE"}))["id"].as_str().unwrap().to_string();
        call(&mut session, json!({"op":"set","id":b,"prop":"x","value":150.0}));
        let grouped = call(&mut session, json!({"op":"group","ids":[a,b]}));
        let group = grouped["id"].as_str().unwrap();
        let width = call(&mut session, json!({"op":"get","id":group,"prop":"width"})).as_f64().unwrap();
        assert!(width >= 250.);
        let bad = session.call(&json!({"op":"set","id":group,"prop":"relativeTransform","value":[[0,0,0],[0,0,0]]}).to_string());
        assert!(bad.is_err());
        call(&mut session, json!({"op":"flush"})).as_object().unwrap();
    }
}
