from pathlib import Path
root=Path('/Users/Apple/.codex/worktrees/sketch-canvas-support/design-kernel')
def edit(p,f):
 p=root/p;s=p.read_text();n=f(s);assert n!=s,p;p.write_text(n)
p='design-studio/crates/design-kernel/src/font.rs'
def font(s):
 s=s.replace('pub struct TextStyle {','pub struct TextStyle {\n    #[serde(skip_serializing_if = "is_top")]\n    pub vertical_align: String,',1)
 s=s.replace('impl Default for TextStyle {','fn is_top(s: &str) -> bool { s == "top" }\nimpl Default for TextStyle {',1).replace('text_case: TextCase::Original,','vertical_align: "top".into(),\n            text_case: TextCase::Original,',1)
 s=s.replace('pub struct TextRun {','''pub struct TextRun {
    /// Paragraph attributes at the first character of each paragraph. UTF-16
    /// ranges stay with their text through editing, case mapping and overrides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paragraph: Option<TextParagraph>,''',1)
 at=s.index('#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]\n#[serde(rename_all = "camelCase")]\npub struct TextRun')
 s=s[:at]+'''#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TextParagraph {
    pub align: String,
    /// Absolute document units; zero means unconstrained font-based height.
    pub minimum_line_height: f64,
    pub maximum_line_height: f64,
    pub spacing: f64,
    pub indent: f64,
}
impl Default for TextParagraph {
    fn default() -> Self { Self { align: "start".into(), minimum_line_height: 0., maximum_line_height: 0., spacing: 0., indent: 0. } }
}
impl TextParagraph {
    pub fn validate(&self) -> Result<(), String> {
        if !["start", "center", "end", "justify"].contains(&self.align.as_str())
            || [self.minimum_line_height, self.maximum_line_height, self.spacing].iter().any(|v| !v.is_finite() || !(0. ..=10000.).contains(v))
            || !self.indent.is_finite() || self.indent.abs() > 10000.
            || (self.maximum_line_height > 0. && self.minimum_line_height > self.maximum_line_height) {
            return Err("Invalid paragraph style".into());
        }
        Ok(())
    }
}
'''+s[at:]
 s=s.replace('if !valid_font_id(&self.font_id)','if !["top", "center", "bottom"].contains(&self.vertical_align.as_str())\n            || !valid_font_id(&self.font_id)',1)
 s=s.replace('for run in &node.text_runs {','for run in &node.text_runs {\n        if let Some(p) = &run.paragraph { p.validate()?; }',1)
 # Placement affects all path consumers and caret geometry, never intrinsic sizing.
 start=s.index('    fn node_outline_layout(');end=s.index('    pub fn node_measure',start)
 sub=s[start:end];sub=sub.replace('        self.layout(','        let mut result = self.layout(',1)
 sub=sub.replace('            node.text_path.as_ref(),\n        )','''            node.text_path.as_ref(),
        )?;
        if style.writing_mode == "horizontal" && node.text_path.is_none() {
            let offset = (node.height - result.height).max(0.) * match style.vertical_align.as_str() { "center" => 0.5, "bottom" => 1., _ => 0. };
            if offset != 0. {
                let matrix = crate::math::Transform([1.,0.,0.,1.,0.,offset]);
                crate::text_path::transform_outline(&mut result.path, matrix);
                for span in &mut result.spans {
                    crate::text_path::transform_outline(&mut span.outline, matrix);
                    if output == OutlineOutput::Svg { span.path = span.outline.svg_data(); }
                }
                for glyph in &mut result.glyphs { glyph.y += offset; }
                for line in &mut result.lines { line.y += offset; }
                if output == OutlineOutput::Svg { result.bounds = crate::bounds::path_bounds(&result.path, crate::math::Transform::default()); }
            }
        }
        Ok(result)''')
 s=s[:start]+sub+s[end:]
 s=s.replace('node.width.to_bits(),\n            &node.text_style,','node.width.to_bits(),\n            node.height.to_bits(),\n            &node.text_style,',1)
 s=s.replace('        for paragraph in paragraphs {\n            let value', '''        for paragraph in paragraphs {
            let attributes = runs.iter().find(|r| r.start <= utf16[paragraph.start] && utf16[paragraph.start] < r.end).and_then(|r| r.paragraph.as_ref());
            let mut paragraph_style;
            let style = if let Some(p) = attributes {
                p.validate()?;
                paragraph_style = style.clone();
                paragraph_style.align = p.align.clone();
                paragraph_style.paragraph_spacing = p.spacing;
                paragraph_style.paragraph_indent = p.indent;
                &paragraph_style
            } else { style };
            let value''',1)
 s=s.replace('                let line_width = (shaped', '''                if let Some(p) = attributes {
                    height = height.max(p.minimum_line_height);
                    if p.maximum_line_height > 0. { height = height.min(p.maximum_line_height); }
                }
                let line_width = (shaped''',1)
 return s
edit(p,font)
# schema gates include overrides and shared text styles without serializing the document.
def scene(s):
 at=s.index('    pub fn requires_schema19(')
 s=s[:at]+'''    pub fn requires_schema20(&self) -> bool {
        let style = |v: &serde_json::Value| v.get("verticalAlign").and_then(|v|v.as_str()).is_some_and(|v|v!="top");
        let runs = |v: &serde_json::Value| v.as_array().is_some_and(|r|r.iter().any(|v|v.get("paragraph").is_some_and(|p|!p.is_null())));
        self.nodes.values().any(|n| n.text_style.as_ref().is_some_and(|s|s.vertical_align!="top") || n.text_runs.iter().any(|r|r.paragraph.is_some())
            || n.instance.as_ref().is_some_and(|i|i.overrides.values().any(|o|o.get("textStyle").is_some_and(style)||o.get("textRuns").is_some_and(runs))))
            || self.design_system.as_ref().is_some_and(|d|d.styles.values().any(|s|s.kind=="text" && style(&s.value)))
    }
'''+s[at:]
 s=s.replace('if self.schema_version<19','if self.schema_version<20 && self.requires_schema20() {return Err("Paragraph and vertical text layout require schema 20".into());}\n        if self.schema_version<19',1)
 s=s.replace('16, 17, 18, 19].contains','16, 17, 18, 19, 20].contains')
 return s
edit('design-studio/crates/design-kernel/src/scene.rs',scene)
