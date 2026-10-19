//! Bounded lexical highlighting; code is plain authored text and is never executed.
use crate::{font::TextRun, scene::Document};
fn run(start: usize, end: usize, color: &str) -> TextRun {
    serde_json::from_value(serde_json::json!({"start":start,"end":end,"color":color}))
        .expect("fixed text run")
}
pub fn highlight(text: &str, language: &str) -> Result<Vec<TextRun>, String> {
    if !matches!(
        language,
        "plain" | "javascript" | "typescript" | "rust" | "python" | "json"
    ) {
        return Err("Unsupported code language".into());
    }
    if text.len() > 400000 {
        return Err("Code text budget exceeded".into());
    }
    if language == "plain" {
        return Ok(vec![]);
    }
    let chars: Vec<char> = text.chars().collect();
    let mut offsets = vec![0];
    for c in &chars {
        offsets.push(offsets.last().unwrap() + c.len_utf16())
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let start = i;
        let mut color = None;
        if (language == "python" && chars[i] == '#')
            || (chars[i] == '/' && chars.get(i + 1) == Some(&'/'))
        {
            while i < chars.len() && chars[i] != '\n' {
                i += 1
            }
            color = Some("#8b949e")
        } else if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i < chars.len() {
                if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    i += 2;
                    break;
                }
                i += 1
            }
            color = Some("#8b949e")
        } else if matches!(chars[i], '\'' | '"' | '`') {
            let quote = chars[i];
            i += 1;
            while i < chars.len() {
                if chars[i] == '\\' {
                    i = (i + 2).min(chars.len());
                    continue;
                }
                let c = chars[i];
                i += 1;
                if c == quote {
                    break;
                }
            }
            color = Some("#a5d6ff")
        } else if chars[i].is_ascii_digit() {
            i += 1;
            while i < chars.len()
                && (chars[i].is_ascii_alphanumeric() || matches!(chars[i], '.' | '_'))
            {
                i += 1
            }
            color = Some("#79c0ff")
        } else if chars[i].is_alphabetic() || chars[i] == '_' {
            i += 1;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1
            }
            let word: String = chars[start..i].iter().collect();
            if matches!(
                word.as_str(),
                "fn" | "let"
                    | "mut"
                    | "pub"
                    | "use"
                    | "struct"
                    | "enum"
                    | "impl"
                    | "match"
                    | "if"
                    | "else"
                    | "for"
                    | "while"
                    | "return"
                    | "async"
                    | "await"
                    | "const"
                    | "function"
                    | "class"
                    | "import"
                    | "export"
                    | "from"
                    | "def"
                    | "in"
                    | "try"
                    | "except"
                    | "true"
                    | "false"
                    | "null"
                    | "None"
                    | "True"
                    | "False"
                    | "type"
                    | "interface"
            ) {
                color = Some("#ff7b72")
            }
        } else {
            i += 1
        }
        if let Some(color) = color {
            out.push(run(offsets[start], offsets[i], color));
            if out.len() > 4096 {
                return Err("Code highlighting exceeds 4096 ranges".into());
            }
        }
    }
    use unicode_segmentation::UnicodeSegmentation;
    let mut boundaries = vec![0];
    for g in text.graphemes(true) {
        boundaries.push(boundaries.last().unwrap() + g.encode_utf16().count())
    }
    let mut normalized: Vec<TextRun> = Vec::new();
    for mut r in out {
        r.start = boundaries[boundaries
            .partition_point(|b| *b <= r.start)
            .saturating_sub(1)];
        r.end = *boundaries
            .iter()
            .find(|b| **b >= r.end)
            .unwrap_or(boundaries.last().unwrap());
        if let Some(last) = normalized.last_mut()
            && last.end > r.start
        {
            last.end = last.end.max(r.end);
            continue;
        }
        normalized.push(r)
    }
    Ok(normalized)
}
pub fn resolve(doc: &mut Document) -> Result<(), String> {
    let blocks: Vec<_> = doc
        .nodes
        .values()
        .filter_map(|n| {
            n.board
                .as_ref()
                .filter(|b| b.kind == "code-block")
                .and_then(|b| b.language.as_ref())
                .map(|language| (language.clone(), n.children.clone()))
        })
        .collect();
    for (language, children) in blocks {
        for id in children {
            let child = doc.nodes.get_mut(&id).ok_or("Missing code content")?;
            if child.kind == "text" {
                child.text_runs = highlight(&child.text, &language)?
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn code_is_preserved_and_ranges_use_utf16() {
        let source = "// 中文😀\nfn main() { let x = 42; }";
        let runs = highlight(source, "rust").unwrap();
        assert_eq!(runs[0].start, 0);
        assert_eq!(runs[0].end, 7);
        assert!(runs.iter().any(|r| r.start == 8 && r.end == 10));
        assert!(highlight(source, "plain").unwrap().is_empty());
        assert!(highlight(source, "shell-execute").is_err())
    }
}
