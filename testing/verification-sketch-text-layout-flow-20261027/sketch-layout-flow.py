exec(open('/tmp/sketch-text-impl.py').read().split("p='design-studio")[0])
def interop(s):
 # hotspot represented by existing paintless rectangle; native source class retained as receipt.
 s=s.replace('"hotspot" => "hotspot", // Limited mapping: raw prototype payload kept in bindings.','"hotspot" => "rectangle", // Paintless hit region; prototype actions use the shared player.')
 s=s.replace('''            "hotspot" => {
''','''            "hotspot" => {
                node.fills.clear(); node.strokes.clear(); node.effects.clear();
                node.bindings.insert("sketchSourceHotspot".into(), "true".into());
''',1)
 s=s.replace('''        if node.kind == "hotspot"
            || node
                .bindings''','''        if node
                .bindings''',1)
 s=s.replace('''        if n.instance.is_some() {''','''        if n.bindings.contains_key("sketchSourceHotspot") && n.kind == "rectangle" && n.fills.is_empty() && n.strokes.is_empty() && n.effects.is_empty() && n.children.is_empty() { class = "hotspot"; }
        if n.instance.is_some() {''',1)
 s=s.replace('if n.kind == "hotspot" {','if class == "hotspot" {',1)
 # Don't restore removed prototype flow from raw layer after user deletes action.
 s=s.replace('if key != "layers" && !layer.contains_key(&key) {','if key != "layers" && key != "flow" && !layer.contains_key(&key) {',1)
 s=s.replace('''        let destination = payload
''','''        let back = payload.get("destinationArtboardID").and_then(Value::as_str)==Some("back");
        let destination = payload
''',1)
 s=s.replace('''        if destination.is_none()
''','''        if !back && destination.is_none()
''',1)
 s=s.replace('''            "maintainScrollPosition",
''','',1)
 s=s.replace('''        if let Some(target) = destination {
''','''        if destination.is_some() || back {
''',1)
 s=s.replace('''kind: if overlay { "overlay" } else { "navigate" }.into(),
                        target: Some(target),''','''kind: if back { "back" } else if overlay { "overlay" } else { "navigate" }.into(),
                        target: destination,
                        transition_preserve_scroll: payload.get("maintainScrollPosition").and_then(Value::as_bool),''',1)
 s=s.replace('''matches!(a.kind.as_str(), "navigate" | "overlay")
                        && a.target''','''a.kind == "back" || (matches!(a.kind.as_str(), "navigate" | "overlay")
                        && a.target''',1)
 s=s.replace('''is_some_and(|t| doc.nodes.get(t).is_some_and(|n| n.kind == "frame"))
                })''','''is_some_and(|t| doc.nodes.get(t).is_some_and(|n| n.kind == "frame")))
                })''',1)
 s=s.replace('json!(action.target.as_deref().map(sketch_id)),','json!(if action.kind=="back" {Some("back".into())} else {action.target.as_deref().map(sketch_id)}),',1)
 s=s.replace('flow.insert("maintainScrollPosition".into(), json!(false));','flow.insert("maintainScrollPosition".into(), json!(action.transition_preserve_scroll.unwrap_or(false)));',1)
 # TextStyle canonical field (source native parser consults both).
 a=s.index('                layer.insert(\n                    "attributedString"')
 s=s[:a]+'''                if let Some(native_style) = layer.get_mut("style").and_then(Value::as_object_mut) {
                    native_style.insert("textStyle".into(), json!({"_class":"textStyle","verticalAlignment":vertical_alignment.unwrap_or(0)}));
                }
'''+s[a:]
 # Modern explicit enum mapping, source receipt kept for exact unknown values/spelling.
 needle='''                import_lossy.push("modern-layout-fields-not-translated;source-retained".into());'''
 s=s.replace(needle,'''                let mut modeled = Vec::<String>::new();
                for (spelling,value) in &modern {
                    let key = spelling.trim_start_matches('_');
                    let Some(code) = value.as_u64() else { continue };
                    let axis = key.starts_with("vertical");
                    if key.ends_with("Sizing") {
                        let mode = match code { 0=>Some(crate::layout::SizeMode::Fixed), 1=>Some(crate::layout::SizeMode::Hug), 2=>Some(crate::layout::SizeMode::Fill), _=>None };
                        if let Some(mode)=mode {
                            // Hug is meaningful only for text/container contents.
                            if mode == crate::layout::SizeMode::Hug && !matches!(node.kind.as_str(),"text"|"frame"|"group"|"section") {continue}
                            let sizing=node.sizing.get_or_insert_with(Default::default);
                            if axis {sizing.height=mode} else {sizing.width=mode}
                            modeled.push(spelling.clone());
                        }
                    } else if key.ends_with("Pins") {
                        let anchor=match code {1=>Some(crate::layout::Anchor::Start),4=>Some(crate::layout::Anchor::End),5=>Some(crate::layout::Anchor::Stretch),_=>None};
                        if let Some(anchor)=anchor {
                            let c=node.constraints.get_or_insert_with(Default::default);
                            if axis {c.vertical=anchor} else {c.horizontal=anchor}
                            modeled.push(spelling.clone());
                        }
                    }
                }
                if modeled.len()!=modern.len() {import_lossy.push("modern-layout-untranslated-fields-retained".into());}
                if !modeled.is_empty() {node.bindings.insert("sketchModernLayoutModeled".into(),json!(modeled).to_string());}''',1)
 # json!(modern) moves? serde_json macro borrows yes but clone to ensure.
 s=s.replace('json!(modern).to_string(),','json!(&modern).to_string(),',1)
 needle='''            for (spelling, value) in fields {
                layer.insert(spelling.clone(), value.clone());
            }'''
 repl='''            let modeled: Vec<String> = n.bindings.get("sketchModernLayoutModeled").and_then(|v|serde_json::from_str(v).ok()).unwrap_or_default();
            for (spelling, value) in fields {
                let mut value=value.clone();
                if modeled.contains(spelling) {
                    let key=spelling.trim_start_matches('_'); let vertical=key.starts_with("vertical");
                    if key.ends_with("Sizing") {
                        let z=n.sizing_value(); let mode=if vertical {z.height}else{z.width};
                        value=json!(match mode {crate::layout::SizeMode::Fixed=>0,crate::layout::SizeMode::Hug=>1,crate::layout::SizeMode::Fill=>2});
                    } else if key.ends_with("Pins") {
                        let c=n.constraints.clone().unwrap_or_default(); let a=if vertical {c.vertical}else{c.horizontal};
                        value=json!(match a {crate::layout::Anchor::Start=>1,crate::layout::Anchor::End=>4,crate::layout::Anchor::Stretch=>5,_=>0});
                    }
                }
                layer.insert(spelling.clone(), value);
            }'''
 assert needle in s;s=s.replace(needle,repl,1)
 # Fix new required field in old explicit test literals.
 s=s.replace('crate::font::TextRun {\n                text_case:', 'crate::font::TextRun {\n                paragraph: None,\n                text_case:')
 return s
edit('design-studio/crates/design-kernel/src/interop.rs',interop)
