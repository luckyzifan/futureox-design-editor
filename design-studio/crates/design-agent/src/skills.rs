//! Default design skills for this editor. They are always loaded.
//! Routing uses the conversation text only (not pointer drawing, pixels, or a separate mode flag).
//! The wording is written for Futureox pages, frames, and the shared operation API.
//! It is not a copy of an upstream skill file.

use serde::{Deserialize, Serialize};

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

/// Pick skills from the latest user utterance, then the rest of the conversation
/// if the latest line is only a follow-up fragment.
pub fn route_skills(latest: &str, earlier: &str) -> Vec<SkillId> {
    let mut picked = matches_in(latest);
    if picked.is_empty() {
        picked = matches_in(&format!("{earlier}\n{latest}"));
    }
    if picked.is_empty() {
        if looks_like_question(latest) {
            picked.push(SkillId::Critique);
        } else {
            picked.push(SkillId::OneClickGenerate);
        }
    }
    picked.truncate(3);
    picked
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

fn looks_like_question(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.ends_with('?') || trimmed.ends_with('？') || trimmed.starts_with("为什么") || trimmed.starts_with("怎么")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_from_the_latest_conversation_line() {
        let skills = route_skills("细节调整：把标题改成秋日特惠", "一键出图 咖啡");
        assert_eq!(skills, vec![SkillId::DetailAdjust]);
    }

    #[test]
    fn falls_back_to_earlier_turns_when_the_latest_line_is_vague() {
        let skills = route_skills("再具体一点", "帮我一键出图一张咖啡落地页");
        assert!(skills.contains(&SkillId::OneClickGenerate));
    }

    #[test]
    fn does_not_read_a_drawing_signal() {
        let skills = route_skills("评价一下这一页", "");
        assert_eq!(skills, vec![SkillId::Critique]);
    }
}
