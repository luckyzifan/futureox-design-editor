exec(open('/tmp/sketch-text-impl.py').read().split("p='design-studio")[0])
def font(s):
 s=s.replace('''                let mut height = size * style.line_height;
                for glyph in &shaped {''','''                let mut height = size * style.line_height;
                let mut natural = 0f64;
                for glyph in &shaped {''',1)
 s=s.replace('''                    height = height.max(glyph.size * style.line_height);
                }
                if let Some(p) = attributes {
                    height = height.max(p.minimum_line_height);''','''                    height = height.max(glyph.size * style.line_height);
                    natural = natural.max((face.ascender() as f64 - face.descender() as f64 + face.line_gap() as f64) * glyph.size / face.units_per_em() as f64);
                }
                if let Some(p) = attributes {
                    if shaped.is_empty() {
                        let face = self.face(&style.font_id, style.weight)?;
                        let face = face.borrow_face();
                        natural = (face.ascender() as f64 - face.descender() as f64 + face.line_gap() as f64) * size / face.units_per_em() as f64;
                        ascent = face.ascender() as f64 * size / face.units_per_em() as f64;
                    }
                    height = natural.max(p.minimum_line_height);''',1)
 s=s.replace('''if p.maximum_line_height > 0. { height = height.min(p.maximum_line_height); }
                }
                let line_width''','''if p.maximum_line_height > 0. { height = height.min(p.maximum_line_height); }
                    // Center the font metrics in the constrained line box.
                    // Keep unrounded document-space values; raster sampling stays unchanged.
                    ascent += (height - natural) / 2.;
                }
                let line_width''',1)
 return s
edit('design-studio/crates/design-kernel/src/font.rs',font)
def interop(s):
 s=s.replace('a.get("textStyleBasicParagraphStyle").or_else(||a.get("paragraphStyle"))','a.get("paragraphStyle").or_else(||a.get("textStyleBasicParagraphStyle"))',1)
 s=s.replace('.get("textStyleBasicParagraphStyle")\n                                .or_else(|| a.get("paragraphStyle"))','.get("paragraphStyle")\n                                .or_else(|| a.get("textStyleBasicParagraphStyle"))',1)
 s=s.replace('attrs.insert("textStyleBasicParagraphStyle".into(), Value::Object(para));','attrs.insert("paragraphStyle".into(), Value::Object(para));',1)
 # Node-local receipt preserves existing FD baseline/line-height semantics if native fields were not edited.
 s=s.replace('''                node.text_style = Some(style);
''','''                node.text_style = Some(style);
                if let Some(receipt) = user_ns.get("textModel")
                    && receipt.get("native") == Some(&native_text_projection(layer)) {
                    if let (Ok(saved_style),Ok(saved_runs)) = (
                        serde_json::from_value::<Option<crate::font::TextStyle>>(receipt["style"].clone()),
                        serde_json::from_value::<Vec<crate::font::TextRun>>(receipt["runs"].clone())) {
                        node.text_style=saved_style; node.text_runs=saved_runs;
                    }
                }
''',1)
 s=s.replace('''        if n.kind == "text" {
            let behaviour''','''        if n.kind == "text" {
            user_info.insert("textModel".into(),json!({"native":native_text_projection(&Value::Object(layer.clone())),"style":n.text_style,"runs":n.text_runs}));
            let behaviour''',1)
 at=s.index('fn text_layout_signature(')
 s=s[:at]+'''fn native_text_projection(layer: &Value) -> Value {
    json!({"attributedString":layer.get("attributedString"),"verticalAlignment":layer.pointer("/style/textStyle/verticalAlignment"),"textBehaviour":layer.get("textBehaviour"),"lineSpacingBehaviour":layer.get("lineSpacingBehaviour")})
}
'''+s[at:]
 # tests for canonical exported keys (fallback old source is independently exercised elsewhere).
 test=s.index('#[cfg(test)]')
 s=s[:test]+s[test:].replace('["textStyleBasicParagraphStyle"]','["paragraphStyle"]')
 return s
edit('design-studio/crates/design-kernel/src/interop.rs',interop)
