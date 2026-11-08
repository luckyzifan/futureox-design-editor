//! Default design skills for this editor. They are always loaded.
//! Routing uses the conversation and the current page's nodes (names, kinds, text).
//! It does not use pointer strokes or pixels.
//! The wording is written for Futureox pages, frames, and the shared operation API.
//! It is not a copy of an upstream skill file.

use serde::{Deserialize, Serialize};

use crate::operations::DesignContext;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillId {
    OneClickGenerate,
    DetailAdjust,
    Layout,
    Style,
    Critique,
    Iterate,
}

impl SkillId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OneClickGenerate => "one-click-generate",
            Self::DetailAdjust => "detail-adjust",
            Self::Layout => "layout",
            Self::Style => "style",
            Self::Critique => "critique",
            Self::Iterate => "iterate",
        }
    }

    pub fn guide(self) -> &'static str {
        match self {
            Self::OneClickGenerate => {
                "一键出图：在当前文档新建一页可编辑画板，而不是一张位图。结构对齐常见 Figma/Sketch 模板页：导航、标题、副标题、三个卖点、行动按钮、页脚。颜色用文档强调色 #3459d4，暖色需求改用暖棕。文字必须来自用户原话，不要另造品牌。坐标是父级文档单位，8 的倍数。一次 batch.apply。"
            }
            Self::DetailAdjust => {
                "细节调整：默认只改对话指定的目标页（悬停或当前页）。用户点名了另一页的名称时，改那一页，并在回复里说明。用 text.set / style.set 改已有文字、填充和圆角，不重建整页，不改没提到的句子。"
            }
            Self::Layout => {
                "布局：只动目标页已有图层的位置，让标题、副标题和卖点保持左对齐和 8px 节奏。不新增页面。"
            }
            Self::Style => {
                "样式：只改目标页画板和按钮的填充、圆角。主色默认 #3459d4。用户给出的颜色词或 #hex 优先。不改文案，除非同一句对话也要求改字。"
            }
            Self::Critique => {
                "评论：读目标页上真实的标题和卖点，指出一个具体问题（层级、对比或句子是否没说完）。不要声称看过像素。用户没要求修改时不要写入。"
            }
            Self::Iterate => {
                "再来一版：再生成一页，标题保留，副标题或卖点换成对话里的新要求。旧页留在文档里。"
            }
        }
    }
}

pub fn default_skills() -> &'static [SkillId] {
    &[
        SkillId::OneClickGenerate,
        SkillId::DetailAdjust,
        SkillId::Layout,
        SkillId::Style,
        SkillId::Critique,
        SkillId::Iterate,
    ]
}

/// Pick skills from the latest utterance, earlier turns, then the page the
/// user is looking at. A short edit on a page that already has a frame is
/// detail adjustment, not a new page.
pub fn route_skills(latest: &str, earlier: &str, ctx: &DesignContext) -> Vec<SkillId> {
    let mut picked = matches_in(latest);
    if picked.is_empty() {
        picked = matches_in(&format!("{earlier}\n{latest}"));
    }
    let has_design = target_has_design(ctx);
    if looks_like_question(latest) && !looks_like_mutation(latest) {
        return vec![SkillId::Critique];
    }
    if has_design {
        if latest.contains('色') && !picked.contains(&SkillId::Style) && !picked.contains(&SkillId::OneClickGenerate) {
            picked.push(SkillId::Style);
        }
        if picked.is_empty() && (latest.contains('改') || latest.contains('调') || latest.contains("这个") || latest.contains("这一页") || latest.contains("它")) {
            picked.push(SkillId::DetailAdjust);
        }
    }
    if picked.is_empty() {
        if looks_like_question(latest) {
            picked.push(SkillId::Critique);
        } else if has_design {
            picked.push(SkillId::DetailAdjust);
        } else {
            picked.push(SkillId::OneClickGenerate);
        }
    }
    picked.truncate(3);
    picked
}

fn target_has_design(ctx: &DesignContext) -> bool {
    let target = ctx.target_page_id.clone().filter(|id| !id.is_empty()).unwrap_or_else(|| ctx.current_page_id.clone());
    ctx.nodes.iter().any(|node| {
        (target.is_empty() || node.page_id == target)
            && (node.kind == "frame" || node.kind == "text" || node.name.contains("标题") || node.name == "画板")
    })
}

fn matches_in(text: &str) -> Vec<SkillId> {
    let mut out = Vec::new();
    let lower = text.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| lower.contains(&needle.to_lowercase()));
    if has(&["一键出图", "生成", "出图", "做一页", "做个", "做一个", "落地页", "海报", "poster", "generate", "新页面"]) {
        out.push(SkillId::OneClickGenerate);
    }
    if has(&["细节", "调整", "改成", "换成", "修改", "定向", "字号", "圆角", "标题改", "adjust", "tweak"]) {
        out.push(SkillId::DetailAdjust);
    }
    if has(&["布局", "对齐", "间距", "边距", "排列", "layout", "align", "padding"]) {
        out.push(SkillId::Layout);
    }
    if has(&["配色", "风格", "主色", "背景色", "字体颜色", "palette", "recolor"]) {
        out.push(SkillId::Style);
    }
    if has(&["评价", "看看", "审查", "好不好", "问题", "critique", "review"]) {
        out.push(SkillId::Critique);
    }
    if has(&["再来", "另一版", "继续做一页", "重做一页", "迭代", "iterate", "another version"]) {
        out.push(SkillId::Iterate);
    }
    out
}

pub(crate) fn looks_like_mutation(text: &str) -> bool {
    ["改成", "换成", "修改", "生成", "出图", "做一页", "做个", "做一个", "调整", "新建", "删除", "对齐"]
        .iter()
        .any(|needle| text.contains(needle))
}

pub(crate) fn looks_like_question(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.ends_with('?')
        || trimmed.ends_with('？')
        || ["为什么", "怎么", "什么", "哪个", "哪些", "吗", "解释", "介绍", "说明一下"]
            .iter()
            .any(|needle| trimmed.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_from_the_latest_conversation_line() {
        let skills = route_skills("细节调整：把标题改成秋日特惠", "一键出图 咖啡", &DesignContext::default());
        assert_eq!(skills, vec![SkillId::DetailAdjust]);
    }

    #[test]
    fn falls_back_to_earlier_turns_when_the_latest_line_is_vague() {
        let skills = route_skills("再具体一点", "帮我一键出图一张咖啡落地页", &DesignContext::default());
        assert!(skills.contains(&SkillId::OneClickGenerate));
    }

    #[test]
    fn critique_does_not_use_pointer_strokes() {
        let skills = route_skills("评价一下这一页", "", &DesignContext::default());
        assert_eq!(skills, vec![SkillId::Critique]);
    }

    #[test]
    fn an_existing_frame_turns_a_short_edit_into_detail_adjust() {
        let ctx = DesignContext {
            current_page_id: "page-1".into(),
            target_page_id: Some("page-1".into()),
            pages: vec![crate::operations::PageRef { id: "page-1".into(), name: "秋日特惠".into() }],
            nodes: vec![crate::operations::NodeRef {
                id: "frame".into(),
                page_id: "page-1".into(),
                parent_id: None,
                name: "画板".into(),
                kind: "frame".into(),
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
                text: None,
                fill: Some("#f3e6d8".into()),
                stroke: None,
                stroke_width: None,
                stroke_align: None,
                stroke_cap: None,
                stroke_join: None,
                stroke_dash: None,
            }],
            selection: vec!["frame".into()],
        };
        let skills = route_skills("改一下", "", &ctx);
        assert!(skills.contains(&SkillId::DetailAdjust), "{skills:?}");
        let question = route_skills("这个按钮是什么颜色？", "", &ctx);
        assert_eq!(question, vec![SkillId::Critique]);
        assert!(!skills.contains(&SkillId::OneClickGenerate));
        let empty = route_skills("改一下", "", &DesignContext::default());
        assert_eq!(empty, vec![SkillId::OneClickGenerate]);
    }
}
