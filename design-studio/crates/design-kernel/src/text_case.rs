//! Display casing preserves authored text and UTF-16 edit identities. Work and
//! temporary storage are linear in text length plus the number of style runs.
use crate::font::{TextCase, TextRun};

pub(crate) struct DisplayText {
    pub text: String,
    pub runs: Vec<TextRun>,
    pub starts: Vec<usize>,
    pub ends: Vec<usize>,
}
pub(crate) fn display_text(text: &str, case: TextCase, runs: &[TextRun]) -> DisplayText {
    let mut output = String::new();
    let mut positions = vec![0; text.encode_utf16().count() + 1];
    let (mut starts, mut ends) = (Vec::new(), vec![0]);
    let (mut source, mut run) = (0, 0);
    // Whole-string lowercase retains context-sensitive Greek final sigma.
    let lower = text.to_lowercase(); let mut lowered = lower.chars();
    for c in text.chars() {
        while run < runs.len() && runs[run].end <= source { run += 1; }
        let case = runs.get(run).filter(|r| r.start <= source).and_then(|r| r.text_case).unwrap_or(case);
        let lower_piece: String = lowered.by_ref().take(c.to_lowercase().count()).collect();
        let displayed: String = match case { TextCase::Original => c.to_string(), TextCase::Upper => c.to_uppercase().collect(), TextCase::Lower => lower_piece };
        let length = displayed.encode_utf16().count();
        positions[source] = starts.len();
        for _ in 0..length { starts.push(source); ends.push(source + c.len_utf16()); }
        output.push_str(&displayed); source += c.len_utf16();
        positions[source] = starts.len();
    }
    starts.push(source);
    let runs = runs.iter().map(|r| { let mut r = r.clone(); r.start = positions[r.start]; r.end = positions[r.end]; r.text_case = None; r }).collect();
    DisplayText { text: output, runs, starts, ends }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expansion_and_context_keep_authored_offsets() {
        let upper=display_text("aß😀",TextCase::Upper,&[]);
        assert_eq!(upper.text,"ASS😀");
        assert_eq!(upper.starts,vec![0,1,1,2,2,4]);
        assert_eq!(upper.ends,vec![0,1,2,2,4,4]);
        assert_eq!(display_text("ΟΣ",TextCase::Lower,&[]).text,"ος");
        let mixed=display_text("aßZ",TextCase::Upper,&[TextRun {start:1,end:2,text_case:Some(TextCase::Original),..Default::default()}]);
        assert_eq!(mixed.text,"AßZ"); assert_eq!(mixed.runs[0].end,2);
    }
}
