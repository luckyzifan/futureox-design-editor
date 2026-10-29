exec(open('/tmp/sketch-text-impl.py').read().split("p='design-studio")[0])
def interop(s):
 s=s.replace('node.text_runs.push(crate::font::TextRun {\n                            text_case,','''let paragraph = a.get("textStyleBasicParagraphStyle").or_else(||a.get("paragraphStyle")).and_then(|p| {
                            let value = crate::font::TextParagraph {
                                align: alignment_from_code(p.get("alignment").and_then(Value::as_i64).unwrap_or(0)).into(),
                                minimum_line_height: p.get("minimumLineHeight").and_then(Value::as_f64).unwrap_or(0.),
                                maximum_line_height: p.get("maximumLineHeight").and_then(Value::as_f64).unwrap_or(0.),
                                spacing: p.get("paragraphSpacing").and_then(Value::as_f64).unwrap_or(0.),
                                indent: p.get("firstLineHeadIndent").and_then(Value::as_f64).unwrap_or(0.),
                            };
                            if value.validate().is_ok() { Some(value) } else { import_lossy.push("paragraph-values-outside-supported-range".into()); None }
                        });
                        node.text_runs.push(crate::font::TextRun {
                            paragraph,
                            text_case,''',1)
 s=s.replace('if let Some(px) = line_px\n                                    && node.font_size >= 1.','if let Some(px) = line_px\n                                    && px > 0. && node.font_size >= 1.',1)
 s=s.replace('''                                if let (Some(lo), Some(hi)) = (''','''                                if let (Some(lo), Some(hi)) = (''',1)
 s=s.replace('''                                    import_lossy
                                        .push("paragraph-line-height-range-collapsed".into());''','''                                    // Both limits live on the paragraph run and are applied by Fonts.
                                    let _ = (lo, hi);''',1)
 # vertical canonical layer style, fallback run field; no binding for supported enum (avoid stale resurrection).
 a=s.index('                            if let Some(vertical) = a\n');b=s.index('                            if let Some(transform)',a)
 s=s[:a]+'''                            if let Some(vertical) = layer.pointer("/style/textStyle/verticalAlignment")
                                .or_else(||a.get("textStyleVerticalAlignmentKey")).and_then(Value::as_i64) {
                                match vertical {
                                    0 => style.vertical_align = "top".into(),
                                    1 => style.vertical_align = "center".into(),
                                    2 => style.vertical_align = "bottom".into(),
                                    _ => { node.bindings.insert("sketchTextVerticalAlignment".into(), vertical.to_string()); import_lossy.push("text-vertical-alignment-value-not-modeled".into()); }
                                }
                            }
'''+s[b:]
 s=s.replace('if doc.requires_schema19()', 'if doc.requires_schema20() { version=version.max(20); }\n    if doc.requires_schema19()',1)
 a=s.index('                let vertical_alignment = ');b=s.index('                let text_transform',a)
 s=s[:a]+'''                let vertical_alignment = Some(match style.map(|s|s.vertical_align.as_str()).unwrap_or("top") { "center"=>1, "bottom"=>2, _=>0 });
'''+s[b:]
 s=s.replace('case: Option<&crate::font::TextCase>|','case: Option<&crate::font::TextCase>,\n                                     paragraph: Option<&crate::font::TextParagraph>|',1)
 at=s.index('                    attrs.insert("textStyleBasicParagraphStyle"')
 s=s[:at]+'''                    if let Some(p) = paragraph {
                        para.insert("alignment".into(), json!(paragraph_alignment(&p.align)));
                        para.insert("minimumLineHeight".into(), json!(p.minimum_line_height));
                        para.insert("maximumLineHeight".into(), json!(p.maximum_line_height));
                        para.insert("paragraphSpacing".into(), json!(p.spacing));
                        para.insert("firstLineHeadIndent".into(), json!(p.indent));
                    }
'''+s[at:]
 # Only three local calls.
 a=s.index('                let total = utf16_len(&n.text);',at);b=s.index('                layer.insert(',a)
 sub=s[a:b].replace('                            None,\n                        )?','                            None,\n                            None,\n                        )?').replace('                        run.text_case.as_ref(),','                        run.text_case.as_ref(),\n                        run.paragraph.as_ref(),').replace('                        None,\n                    )?','                        None,\n                        None,\n                    )?')
 s=s[:a]+sub+s[b:]
 # Native layer textStyle must agree with run key.
 s=s.replace('"verticalAlignment":0,','"verticalAlignment":match s.vertical_align.as_str() { "center"=>1,"bottom"=>2,_=>0 },',1)
 # hotspot now existing invisible model entity gets native flow.
 s=s.replace('''                node.bindings.insert(
                    "interopLimited".into(),
                    "sketch-hotspot:prototype-flow-preserved-as-raw;no-kernel-entity".into(),
                );''','',1)
 s=s.replace('''        if class != "hotspot"
            && let Some(flow) = layer.get("flow").filter(|f| !f.is_null())''','''        if let Some(flow) = layer.get("flow").filter(|f| !f.is_null())''',1)
 return s
edit('design-studio/crates/design-kernel/src/interop.rs',interop)
