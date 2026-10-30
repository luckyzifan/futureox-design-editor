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
    let lower = text.to_lowercase();
    let mut lowered = lower.chars();
    // Title casing needs a word-boundary memory that spans runs: a word
    // continues across a style switch, so "he|llo" titles as "He|Llo", not
    // "He|llo" followed by a fresh capital.
    let mut in_word = false;
    for c in text.chars() {
        while run < runs.len() && runs[run].end <= source {
            run += 1;
        }
        let case = runs
            .get(run)
            .filter(|r| r.start <= source)
            .and_then(|r| r.text_case)
            .unwrap_or(case);
        let lower_piece: String = lowered.by_ref().take(c.to_lowercase().count()).collect();
        let displayed: String = match case {
            TextCase::Original => c.to_string(),
            TextCase::Upper => c.to_uppercase().collect(),
            TextCase::Lower => lower_piece,
            // First cased letter of each word uppercase, the rest lowercase.
            TextCase::Title if in_word => lower_piece,
            TextCase::Title if c.is_alphanumeric() => c.to_uppercase().collect(),
            TextCase::Title => c.to_string(),
            // Small caps are an OpenType shaping feature (smcp / +c2sc); the
            // display string keeps the authored code points until the font
            // layer applies it, so authored offsets survive verbatim.
            TextCase::SmallCaps | TextCase::SmallCapsForced => c.to_string(),
        };
        // Word-boundary memory is maintained from the authored character for
        // every variant, so a style switch mid-word never mints a fresh
        // capital in a neighbouring Title run.
        in_word = c.is_alphanumeric();
        let length = displayed.encode_utf16().count();
        positions[source] = starts.len();
        for _ in 0..length {
            starts.push(source);
            ends.push(source + c.len_utf16());
        }
        output.push_str(&displayed);
        source += c.len_utf16();
        positions[source] = starts.len();
    }
    starts.push(source);
    let runs = runs
        .iter()
        .map(|r| {
            let mut r = r.clone();
            r.start = positions[r.start];
            r.end = positions[r.end];
            r.text_case = None;
            r
        })
        .collect();
    DisplayText {
        text: output,
        runs,
        starts,
        ends,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expansion_and_context_keep_authored_offsets() {
        let upper = display_text("aß😀", TextCase::Upper, &[]);
        assert_eq!(upper.text, "ASS😀");
        assert_eq!(upper.starts, vec![0, 1, 1, 2, 2, 4]);
        assert_eq!(upper.ends, vec![0, 1, 2, 2, 4, 4]);
        assert_eq!(display_text("ΟΣ", TextCase::Lower, &[]).text, "ος");
        let mixed = display_text(
            "aßZ",
            TextCase::Upper,
            &[TextRun {
                start: 1,
                end: 2,
                text_case: Some(TextCase::Original),
                ..Default::default()
            }],
        );
        assert_eq!(mixed.text, "AßZ");
        assert_eq!(mixed.runs[0].end, 2);
    }
    #[test]
    fn title_casing_capitalizes_each_word_and_lowers_the_rest() {
        let t = display_text("hello wORLD-42ö", TextCase::Title, &[]);
        assert_eq!(t.text, "Hello World-42ö");
        // UTF-16 offsets stay 1:1 per source character here, like Original
        // (plus the final closing entry the offset table always carries).
        assert_eq!(t.starts, (0..16).collect::<Vec<_>>());
        // a word continues across a style-run boundary: no fresh capital
        let split = display_text(
            "he|llo",
            TextCase::Title,
            &[TextRun {
                start: 2,
                end: 5,
                text_case: Some(TextCase::Lower),
                ..Default::default()
            }],
        );
        assert_eq!(split.text, "He|llo");
    }
    #[test]
    fn small_caps_keep_authored_code_points_until_shaping() {
        // smcp/c2sc are OpenType features: the display string is verbatim so
        // authored UTF-16 identities survive for the font layer.
        let sc = display_text("Small Caps", TextCase::SmallCaps, &[]);
        assert_eq!(sc.text, "Small Caps");
        assert_eq!(sc.starts, (0..11).collect::<Vec<_>>());
        assert_eq!(
            display_text("Aa", TextCase::SmallCapsForced, &[]).text,
            "Aa"
        );
    }
}
