//! Expands agent tool calls into the shared design operation methods
//! (`page.create`, `node.create`, `text.set`, `style.set`, `node.update`,
//! `selection.set`, `page.setCurrent`). The editor applies them with one
//! `batch.apply`, the same transaction the MCP operation backend executes.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::skills::SkillId;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeRef {
    pub id: String,
    pub page_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub fill: Option<String>,
    /// Visible solid stroke color, when the page snapshot has one.
    #[serde(default)]
    pub stroke: Option<String>,
    /// Width of that stroke, in the node's units.
    #[serde(default)]
    pub stroke_width: Option<f64>,
    /// Stroke alignment: inside, center, or outside.
    #[serde(default)]
    pub stroke_align: Option<String>,
    /// Stroke cap: butt, round, or square.
    #[serde(default)]
    pub stroke_cap: Option<String>,
    /// Stroke join: miter, round, or bevel.
    #[serde(default)]
    pub stroke_join: Option<String>,
    /// Dash pattern of that stroke, when one is authored.
    #[serde(default)]
    pub stroke_dash: Option<String>,
    /// Layer opacity when it is not fully opaque.
    #[serde(default)]
    pub opacity: Option<f64>,
    /// Corner radius when any corner is rounded. One number when all four
    /// match, otherwise the four values separated by commas.
    #[serde(default)]
    pub corner_radius: Option<String>,
    /// Font size of a text layer, in the node's units.
    #[serde(default)]
    pub font_size: Option<f64>,
    /// Font id of a text layer, when the snapshot has one.
    #[serde(default)]
    pub font_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DesignContext {
    pub current_page_id: String,
    #[serde(default)]
    pub target_page_id: Option<String>,
    #[serde(default)]
    pub pages: Vec<PageRef>,
    #[serde(default)]
    pub nodes: Vec<NodeRef>,
    /// Node ids the user has selected on the canvas. Empty means nothing selected.
    #[serde(default)]
    pub selection: Vec<String>,
    /// Human-readable bounds notes. Omitted layers are not the same as an empty page.
    #[serde(default)]
    pub omissions: Vec<String>,
    /// Editor document id observed when the request was built.
    #[serde(default)]
    pub document_id: String,
    /// Editor session generation observed when the request was built.
    #[serde(default)]
    pub session: u64,
    /// Editor revision observed when the request was built.
    #[serde(default)]
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Operation {
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone)]
pub struct ToolExpansion {
    pub summary: String,
    pub operations: Vec<Operation>,
    pub target_page_id: String,
    pub read_only: bool,
}

pub fn expand_tool(name: &str, arguments: &Value, message: &str, ctx: &DesignContext) -> Result<ToolExpansion, String> {
    let target = resolve_target(message, ctx);
    match name {
        "design_agent_read" | "design_agent_critique" => Ok(ToolExpansion {
            summary: describe(name, ctx, &target),
            operations: Vec::new(),
            target_page_id: target,
            read_only: true,
        }),
        "design_agent_generate" | "design_agent_iterate" => Ok(build_page(&spec_from(arguments, message))),
        "design_agent_adjust" | "design_agent_style" | "design_agent_layout" => {
            if !target.is_empty() && !ctx.pages.iter().any(|page| page.id == target) {
                return Err(format!("Page {target} does not exist"));
            }
            Ok(build_adjust(name, arguments, message, ctx, &target))
        }
        other => Err(format!("unknown agent tool {other}")),
    }
}

pub fn tools_for(skills: &[SkillId]) -> Vec<&'static str> {
    let mut names = vec!["design_agent_read"];
    for skill in skills {
        let name = match skill {
            SkillId::OneClickGenerate | SkillId::Iterate => "design_agent_generate",
            SkillId::DetailAdjust => "design_agent_adjust",
            SkillId::Layout => "design_agent_layout",
            SkillId::Style => "design_agent_style",
            SkillId::Critique => "design_agent_critique",
        };
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

pub fn resolve_target(message: &str, ctx: &DesignContext) -> String {
    let fallback = ctx
        .target_page_id
        .clone()
        .filter(|id| !id.is_empty())
        .or_else(|| {
            let id = ctx.current_page_id.clone();
            (!id.is_empty()).then_some(id)
        })
        .unwrap_or_default();
    for page in &ctx.pages {
        if page.name.chars().count() >= 2 && page.id != fallback && message.contains(page.name.as_str()) {
            return page.id.clone();
        }
    }
    fallback
}

struct PageSpec {
    title: String,
    subtitle: String,
    features: Vec<String>,
    accent: String,
    paper: String,
}

fn spec_from(arguments: &Value, message: &str) -> PageSpec {
    let arg = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let title = arg("title").unwrap_or_else(|| title_from(message));
    let subtitle = arg("subtitle").unwrap_or_else(|| subtitle_from(message, &title));
    let features = arguments
        .get("features")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::trim).filter(|item| !item.is_empty()).map(str::to_string))
                .take(3)
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| features_from(message));
    let (accent, paper) = palette(message, arg("accent").as_deref());
    PageSpec { title, subtitle, features, accent, paper }
}

fn build_page(spec: &PageSpec) -> ToolExpansion {
    let page_id = new_id();
    let frame = new_id();
    let mut operations = vec![
        op("page.create", json!({ "id": page_id, "name": clip(&spec.title, 40), "makeCurrent": true })),
        shape("frame", &frame, &page_id, 80.0, 72.0, 1280.0, 900.0, "画板", &spec.paper, 28.0),
        shape("rectangle", &new_id(), &frame, 0.0, 0.0, 1280.0, 72.0, "导航", "#fffcf9", 0.0),
    ];
    push_text(&mut operations, &frame, 48.0, 22.0, 280.0, 32.0, "品牌", "Futureox", 16.0, "#3459d4");
    push_text(&mut operations, &frame, 72.0, 140.0, 900.0, 88.0, "标题", &spec.title, 56.0, "#1c1917");
    push_text(&mut operations, &frame, 72.0, 244.0, 760.0, 72.0, "副标题", &spec.subtitle, 22.0, "#746c64");
    for (index, feature) in spec.features.iter().enumerate() {
        let card = new_id();
        let x = 72.0 + index as f64 * 392.0;
        operations.push(shape("rectangle", &card, &frame, x, 360.0, 360.0, 180.0, &format!("卖点 {}", index + 1), "#ffffff", 16.0));
        let _ = card;
        push_text(&mut operations, &frame, x + 24.0, 424.0, 312.0, 56.0, &format!("卖点 {} 标题", index + 1), feature, 22.0, "#1c1917");
    }
    let cta = new_id();
    operations.push(shape("rectangle", &cta, &frame, 72.0, 600.0, 220.0, 52.0, "按钮", &spec.accent, 12.0));
    let _ = cta;
    push_text(&mut operations, &frame, 96.0, 612.0, 172.0, 28.0, "按钮文字", "继续编辑", 16.0, "#ffffff");
    push_text(&mut operations, &frame, 72.0, 820.0, 720.0, 32.0, "页脚", "可继续用对话改这一页，或点名其他页面。", 14.0, "#746c64");
    operations.push(op("selection.set", json!({ "ids": [frame], "pageId": page_id })));
    ToolExpansion {
        summary: format!("已生成页面「{}」。", spec.title),
        operations,
        target_page_id: page_id,
        read_only: false,
    }
}

fn build_adjust(tool: &str, arguments: &Value, message: &str, ctx: &DesignContext, target: &str) -> ToolExpansion {
    let nodes: Vec<&NodeRef> = ctx.nodes.iter().filter(|node| target.is_empty() || node.page_id == target).collect();
    let title_node = nodes.iter().copied().find(|node| node.kind == "text" && (node.name == "标题" || node.name.contains("标题")));
    let frame = nodes.iter().copied().find(|node| node.name == "画板" || node.kind == "frame");
    let requested_text = arguments
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .or_else(|| title_change(message));
    // A named title that is not in the bounded context must not become an unrelated edit.
    if title_node.is_none() && (requested_text.is_some() || message.contains("标题")) {
        return report_missing_title(ctx, target);
    }
    let mut operations = Vec::new();
    if !target.is_empty() && target != ctx.current_page_id {
        operations.push(op("page.setCurrent", json!({ "id": target })));
    }
    let mut notes = Vec::new();
    if tool != "design_agent_layout" {
        if let Some(text) = requested_text.clone() {
            if let Some(node) = title_node {
                operations.push(replace_text(node, &clip(&text, 80)));
                notes.push(format!("标题改为「{text}」"));
            }
        }
    }
    if tool != "design_agent_layout" {
        if let Some(color) = arguments.get("fill").and_then(Value::as_str).and_then(normalize_color).or_else(|| color_from(message)) {
            if let Some(node) = frame {
                operations.push(op("style.set", json!({ "ids": [node.id], "fills": [solid(&color)] })));
                notes.push(format!("画板填充改为 {color}"));
            }
        }
    }
    if let Some(radius) = arguments.get("radius").and_then(Value::as_f64).or_else(|| radius_from(message)) {
        if let Some(node) = frame {
            let radius = radius.clamp(0.0, 200.0);
            operations.push(patch_radii(node, radius));
            notes.push(format!("圆角改为 {radius}"));
        }
    }
    if tool == "design_agent_layout" {
        for node in nodes.iter().copied().filter(|node| node.kind == "text").take(4) {
            let y = snap(node.y) + if message.contains('松') { 16.0 } else { 0.0 };
            operations.push(op(
                "node.update",
                json!({ "ids": [node.id], "patch": { "transform": [1, 0, 0, 1, snap(node.x), y] } }),
            ));
        }
        notes.push("已按 8px 节奏调整文字位置".into());
    }
    if notes.is_empty() {
        if let Some(node) = title_node {
            if let Some(size) = node.font_size {
                operations.push(op(
                    "node.patch",
                    json!({ "ids": [node.id], "patch": { "fontSize": 64.0 }, "expected": { "fontSize": size } }),
                ));
                notes.push("没有更具体的句子，先把标题字号调到 64".into());
            }
        } else if let Some(node) = frame.filter(|_| !message.contains("标题")) {
            operations.push(patch_radii(node, 20.0));
            notes.push("没有更具体的句子，先把画板圆角调到 20".into());
        }
    }
    if let Some(node) = frame {
        operations.push(op("selection.set", json!({ "ids": [node.id], "pageId": target })));
    }
    let page_name = ctx.pages.iter().find(|page| page.id == target).map(|page| page.name.as_str()).unwrap_or("目标页");
    let summary = if notes.is_empty() {
        format!("「{page_name}」上没有可改的标题或画板。")
    } else {
        format!("正在修改「{page_name}」：{}", notes.join("，"))
    };
    ToolExpansion { summary, operations, target_page_id: target.to_string(), read_only: false }
}

fn report_missing_title(ctx: &DesignContext, target: &str) -> ToolExpansion {
    let page_name = ctx.pages.iter().find(|page| page.id == target).map(|page| page.name.as_str()).unwrap_or("目标页");
    let omitted = ctx.omissions.iter().filter(|item| !item.is_empty()).cloned().collect::<Vec<_>>().join("");
    let summary = if ctx.omissions.iter().any(|item| item.contains('标')) {
        format!("「{page_name}」的标题没有进入这次有限上下文，所以没有修改。{omitted}")
    } else if omitted.is_empty() {
        format!("「{page_name}」里没有可改的标题，没有改圆角或其他属性。")
    } else {
        format!("「{page_name}」的标题不在这次送出的图层里，没有改圆角或其他属性。{omitted}")
    };
    ToolExpansion { summary, operations: Vec::new(), target_page_id: target.to_string(), read_only: true }
}

fn replace_text(node: &NodeRef, text: &str) -> Operation {
    let previous = node.text.clone().unwrap_or_default();
    op(
        "text.replaceRange",
        json!({
            "nodeId": node.id,
            "start": 0,
            "end": utf16_len(&previous),
            "text": text,
            "expectedText": previous,
        }),
    )
}

fn patch_radii(node: &NodeRef, radius: f64) -> Operation {
    op(
        "node.patch",
        json!({
            "ids": [node.id],
            "patch": { "radii": corner_object(radius, radius, radius, radius) },
            "expected": { "radii": radii_object(node.corner_radius.as_deref()) },
        }),
    )
}

fn corner_object(top_left: f64, top_right: f64, bottom_right: f64, bottom_left: f64) -> Value {
    json!({ "topLeft": top_left, "topRight": top_right, "bottomRight": bottom_right, "bottomLeft": bottom_left })
}

fn radii_object(value: Option<&str>) -> Value {
    let mut parts = value.unwrap_or("0").split(',').map(|part| part.trim().parse::<f64>().unwrap_or(0.0));
    let top_left = parts.next().unwrap_or(0.0);
    let top_right = parts.next().unwrap_or(top_left);
    let bottom_right = parts.next().unwrap_or(top_left);
    let bottom_left = parts.next().unwrap_or(top_left);
    corner_object(top_left, top_right, bottom_right, bottom_left)
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn describe(name: &str, ctx: &DesignContext, target: &str) -> String {
    let titles: Vec<&str> = ctx
        .nodes
        .iter()
        .filter(|node| node.page_id == target && node.kind == "text")
        .filter_map(|node| node.text.as_deref())
        .take(6)
        .collect();
    if name == "design_agent_read" {
        return format!(
            "页面 {} 个，目标页文字：{}",
            ctx.pages.len(),
            if titles.is_empty() { "（空）".to_string() } else { titles.join(" / ") }
        );
    }
    if titles.is_empty() {
        "这一页还没有文字。生成一页之后再评价。".into()
    } else {
        format!("读到「{}」。要改的话直接说改哪一句。", titles[0])
    }
}

fn push_text(operations: &mut Vec<Operation>, parent: &str, x: f64, y: f64, width: f64, height: f64, name: &str, text: &str, font_size: f64, fill: &str) {
    let id = new_id();
    operations.push(op("node.create", json!({
        "id": id, "kind": "text", "parentId": parent, "x": x, "y": y, "width": width, "height": height,
        "patch": { "name": name, "fills": [solid(fill)] }
    })));
    operations.push(op("text.set", json!({ "ids": [id], "text": clip(text, 200), "fontSize": font_size })));
}

fn shape(kind: &str, id: &str, parent: &str, x: f64, y: f64, width: f64, height: f64, name: &str, fill: &str, radius: f64) -> Operation {
    op("node.create", json!({
        "id": id, "kind": kind, "parentId": parent, "x": x, "y": y, "width": width, "height": height,
        "patch": { "name": name, "fills": [solid(fill)], "radii": [radius, radius, radius, radius] }
    }))
}

fn op(method: &str, params: Value) -> Operation {
    Operation { method: method.to_string(), params }
}

fn solid(color: &str) -> Value {
    json!({
        "id": new_id(),
        "kind": "solid",
        "color": color,
        "opacity": 1,
        "visible": true,
        "angle": 90,
        "stops": [{ "offset": 0, "color": color }, { "offset": 1, "color": color }],
        "fit": "cover",
        "blend": "normal"
    })
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn snap(value: f64) -> f64 {
    (value / 8.0).round() * 8.0
}

fn clip(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

fn title_from(message: &str) -> String {
    field(message, &["标题", "题目", "title"])
        .or_else(|| quoted(message))
        .filter(|value| value.chars().count() <= 40)
        .unwrap_or_else(|| "新页面".into())
}

fn subtitle_from(message: &str, title: &str) -> String {
    if let Some(value) = field(message, &["副标题", "副题", "subtitle"]) {
        return clip(&value, 80);
    }
    let cleaned = message
        .replace("一键出图", "")
        .replace("生成", "")
        .replace("做一个", "")
        .replace("做个", "")
        .replace(title, "");
    let cleaned = cleaned.trim().trim_matches(|ch: char| ch == '，' || ch == '。' || ch == '：' || ch == ':' || ch.is_whitespace());
    if cleaned.chars().count() >= 4 {
        clip(cleaned, 80)
    } else {
        "把完整需求写在对话里，这一页可以继续改。".into()
    }
}

fn features_from(message: &str) -> Vec<String> {
    for marker in ["卖点", "功能", "要点"] {
        if let Some(index) = message.find(marker) {
            let rest = message[index + marker.len()..].trim_start_matches(|ch: char| ch == '：' || ch == ':' || ch.is_whitespace());
            let items: Vec<String> = rest
                .split(|ch: char| ['、', '，', ',', '；', ';', '\n'].contains(&ch))
                .map(str::trim)
                .filter(|item| !item.is_empty() && item.chars().count() <= 16)
                .take(3)
                .map(str::to_string)
                .collect();
            if items.len() >= 2 {
                return items;
            }
        }
    }
    vec!["清晰层级".into(), "可继续修改".into(), "留在本机".into()]
}

fn field(message: &str, labels: &[&str]) -> Option<String> {
    for label in labels {
        let Some(index) = message.find(label) else { continue };
        let rest = message[index + label.len()..].trim_start_matches(|ch: char| ['：', ':', '为', '是', ' '].contains(&ch));
        let end = rest.find(['，', '。', '\n', '；']).unwrap_or(rest.len());
        let value = rest[..end].trim();
        if !value.is_empty() {
            return Some(clip(value, 80));
        }
    }
    None
}

fn quoted(message: &str) -> Option<String> {
    let pairs = [('「', '」'), ('"', '"'), ('“', '”')];
    for (open, close) in pairs {
        let Some(start) = message.find(open) else { continue };
        let rest = &message[start + open.len_utf8()..];
        let Some(end) = rest.find(close) else { continue };
        let value = rest[..end].trim();
        if !value.is_empty() {
            return Some(clip(value, 40));
        }
    }
    None
}

fn title_change(message: &str) -> Option<String> {
    if message.contains("标题") {
        return field(message, &["标题改成", "标题改为", "标题换成", "标题是", "标题为", "标题：", "标题:"]);
    }
    None
}

fn palette(message: &str, explicit: Option<&str>) -> (String, String) {
    if let Some(color) = explicit.and_then(normalize_color) {
        return (color, "#f6f1ea".into());
    }
    if message.contains("暖") || message.contains("咖啡") || message.contains("棕") {
        return ("#6f4e37".into(), "#f3e6d8".into());
    }
    ("#3459d4".into(), "#f6f1ea".into())
}

fn color_from(message: &str) -> Option<String> {
    if let Some(index) = message.find('#') {
        return normalize_color(&message[index..]);
    }
    const NAMED: &[(&str, &str)] = &[
        ("暖棕", "#6f4e37"),
        ("深蓝", "#3459d4"),
        ("白色", "#ffffff"),
        ("黑色", "#1c1917"),
        ("红色", "#b63a42"),
        ("绿色", "#2f6b4f"),
        ("橙色", "#d97706"),
        ("米色", "#f6f1ea"),
    ];
    NAMED.iter().find(|(name, _)| message.contains(name)).map(|(_, color)| (*color).to_string())
}

fn normalize_color(value: &str) -> Option<String> {
    let hex = value.trim().trim_start_matches('#');
    let hex = hex.chars().take_while(|ch| ch.is_ascii_hexdigit()).collect::<String>();
    if hex.len() == 6 { Some(format!("#{hex}")) } else { None }
}

fn radius_from(message: &str) -> Option<f64> {
    if !message.contains("圆角") {
        return None;
    }
    let digits: String = message.chars().skip_while(|ch| !ch.is_ascii_digit()).take_while(|ch| ch.is_ascii_digit()).collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_brief_becomes_a_real_page() {
        let message = "做一个咖啡品牌落地页，标题秋日特惠，副标题手冲咖啡本周上新，卖点：产地、烘焙、门店";
        let expanded = expand_tool("design_agent_generate", &json!({}), message, &DesignContext::default()).unwrap();
        let methods: Vec<_> = expanded.operations.iter().map(|op| op.method.as_str()).collect();
        assert!(methods.contains(&"page.create"));
        assert!(methods.contains(&"node.create"));
        assert!(methods.contains(&"text.set"));
        let texts: Vec<_> = expanded
            .operations
            .iter()
            .filter(|op| op.method == "text.set")
            .filter_map(|op| op.params.get("text").and_then(Value::as_str))
            .collect();
        assert!(texts.contains(&"秋日特惠"));
        assert!(texts.contains(&"手冲咖啡本周上新"));
        assert!(texts.contains(&"产地"));
        assert!(texts.contains(&"烘焙"));
        assert!(texts.contains(&"门店"));
    }

    #[test]
    fn adjust_defaults_to_the_target_page_and_can_name_another() {
        let home = "10000000-0000-4000-8000-000000000001";
        let settings = "10000000-0000-4000-8000-000000000002";
        let title = "10000000-0000-4000-8000-000000000003";
        let ctx = DesignContext {
            current_page_id: home.into(),
            target_page_id: Some(home.into()),
            pages: vec![
                PageRef { id: home.into(), name: "首页".into() },
                PageRef { id: settings.into(), name: "设置".into() },
            ],
            nodes: vec![NodeRef {
                id: title.into(),
                page_id: settings.into(),
                parent_id: None,
                name: "标题".into(),
                kind: "text".into(),
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 40.0,
                text: Some("旧标题".into()),
                fill: None,
                stroke: None,
                stroke_width: None,
                stroke_align: None,
                stroke_cap: None,
                stroke_join: None,
                stroke_dash: None,
                opacity: None,
                corner_radius: None,
                font_size: None,
                font_id: None,
            }],
            selection: Vec::new(),
            ..DesignContext::default()
        };
        let expanded = expand_tool("design_agent_adjust", &json!({}), "把设置页的标题改成账户", &ctx).unwrap();
        assert_eq!(expanded.target_page_id, settings);
        assert_eq!(expanded.operations[0].method, "page.setCurrent");
        let text = expanded.operations.iter().find(|op| op.method == "text.replaceRange").unwrap();
        assert_eq!(text.params["text"], "账户");
        assert_eq!(text.params["expectedText"], "旧标题");
        assert_eq!(text.params["nodeId"], title);
        assert_eq!(text.params["start"], 0);
        assert_eq!(text.params["end"], 3);
    }

    #[test]
    fn a_missing_target_page_is_rejected() {
        let ctx = DesignContext {
            current_page_id: "page-1".into(),
            target_page_id: Some("missing-page".into()),
            pages: vec![PageRef { id: "page-1".into(), name: "当前".into() }],
            ..DesignContext::default()
        };
        let error = expand_tool("design_agent_adjust", &json!({}), "细节调整：把标题改成 QA_NEW_TITLE", &ctx).unwrap_err();
        assert!(error.contains("missing-page"), "{error}");
        assert!(error.contains("does not exist"), "{error}");
    }

    #[test]
    fn a_title_outside_the_bounded_context_does_not_change_frame_radius() {
        let ctx = DesignContext {
            current_page_id: "page-2".into(),
            target_page_id: Some("page-2".into()),
            pages: vec![PageRef { id: "page-2".into(), name: "Target QA".into() }],
            nodes: vec![NodeRef {
                id: "frame".into(),
                page_id: "page-2".into(),
                parent_id: None,
                name: "画板".into(),
                kind: "frame".into(),
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 80.0,
                text: None,
                fill: None,
                stroke: None,
                stroke_width: None,
                stroke_align: None,
                stroke_cap: None,
                stroke_join: None,
                stroke_dash: None,
                opacity: None,
                corner_radius: Some("4".into()),
                font_size: None,
                font_id: None,
            }],
            omissions: vec!["目标页的标题没有全部进入这次上下文。被省略不等于页面里没有标题。".into()],
            ..DesignContext::default()
        };
        let expanded = expand_tool("design_agent_adjust", &json!({}), "细节调整：把标题改成 QA_NEW_TITLE", &ctx).unwrap();
        assert!(expanded.operations.is_empty(), "{:?}", expanded.operations);
        assert!(expanded.summary.contains("标题"), "{}", expanded.summary);
        assert!(expanded.summary.contains("没有修改"), "{}", expanded.summary);
        assert!(!expanded.summary.contains("圆角改为"), "{}", expanded.summary);
    }
}
