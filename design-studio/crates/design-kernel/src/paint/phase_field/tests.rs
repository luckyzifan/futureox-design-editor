use super::*;
use serde_json::json;

fn tuple(code: u32) -> [u32; 4] {
    if code == 0x40a00000 {
        return [(-1_f32).to_bits(), (-1_f32).to_bits(), 0, 0];
    }
    if (0x40000000..=0x40800000).contains(&code) {
        let n = (code - 0x40000000) >> 22;
        return [(n as f32).to_bits(), (n as f32).to_bits(), 0, 0];
    }
    let a = code >> 31;
    [
        (a as f32).to_bits(),
        ((a + 1) as f32).to_bits(),
        code & 0x7fffffff,
        0,
    ]
}
fn base(words: &[u32], x: i32, y: i32) -> u32 {
    let w = words[1] as i32;
    let h = words[2] as i32;
    let x = x.clamp(0, w - 1) as usize;
    let y = y.clamp(0, h - 1) as usize;
    let header = words[HEADER + (y / 8) * words[3] as usize + x / 8];
    let mode = header >> 30;
    let at = (header & 0x3fffffff) as usize;
    let pixel = (y % 8) * 8 + x % 8;
    match mode {
        3 => words[at],
        2 => words[at + pixel * 4],
        _ => words[at + 2 + pixel],
    }
}
fn decode(words: &[u32], x: usize, y: usize, phase: usize) -> u32 {
    let header = words[HEADER + (y / 8) * words[3] as usize + x / 8];
    let mode = header >> 30;
    let at = (header & 0x3fffffff) as usize;
    let pixel = (y % 8) * 8 + x % 8;
    if mode == 3 {
        return words[at];
    }
    if mode == 2 {
        return words[at + pixel * 4 + phase];
    }
    if phase == 0 {
        return words[at + 2 + pixel];
    }
    let bits = if mode == 0 { 8 } else { 16 };
    let delta_words = if mode == 0 { 48 } else { 96 };
    let mask = words[at + pixel / 32];
    let bit = pixel % 32;
    if mask & (1 << bit) != 0 {
        let rank = if pixel >= 32 {
            words[at].count_ones()
        } else {
            0
        } + (mask & ((1 << bit) - 1)).count_ones();
        return words[at + 2 + 64 + delta_words + rank as usize * 3 + phase - 1];
    }
    let index = pixel * 3 + phase - 1;
    let packed = words[at + 2 + 64 + index / (32 / bits)] >> ((index % (32 / bits)) * bits);
    let residual = ((packed << (32 - bits)) as i32) >> (32 - bits);
    let x = x as i32;
    let y = y as i32;
    let q = base(words, x, y);
    let predicted = predict(
        q,
        [
            base(words, x + 1, y),
            base(words, x, y + 1),
            base(words, x + 1, y + 1),
            base(words, x - 1, y),
            base(words, x - 1, y + 1),
        ],
    )
    .unwrap()[phase - 1];
    (i64::from(predicted) + i64::from(residual)) as u32
}
fn paint(kind: &str, offsets: &[f64]) -> Paint {
    serde_json::from_value(json!({"kind":kind,"color":"#123456","angle":27.5,
        "stops":offsets.iter().map(|offset|json!({"offset":offset,"color":"#ffffff"})).collect::<Vec<_>>()})).unwrap()
}
#[test]
fn all_phases_roundtrip_original_parameter_bits_across_tiles_and_escapes() {
    for kind in ["linear", "radial", "angular", "diamond"] {
        for offsets in [
            vec![0., 1.],
            vec![0., 0.6971153616905212, 1.],
            vec![0.2, 0.2, 0.9],
            vec![0., 1e-300, 1.],
        ] {
            for rect in [
                Rect::new(-19, 23, 37, 29),
                Rect::new(40000, -1000, 17, 11),
                Rect::new(0, 0, 1, 19),
            ] {
                let paint = paint(kind, &offsets);
                let matrix =
                    Transform([1.2, 0.3, -0.15, 0.9, rect.x as f64 + 5., rect.y as f64 - 3.]);
                let size = [23.125, 21.75];
                let mut builder = Builder::new(rect, matrix, size, &paint).unwrap();
                assert!(builder.finish().is_err());
                while !builder.advance().unwrap() {}
                let encoded = builder.finish().unwrap();
                assert!(!encoded.is_empty());
                assert_eq!(encoded[0], MAGIC);
                assert_eq!(encoded.len() % WIDTH, 0);
                for phase in 0..4 {
                    let expected = super::super::gradient_sampling_grid(
                        rect,
                        matrix,
                        size,
                        &paint,
                        Some(phase),
                    )
                    .unwrap();
                    for y in 0..rect.h as usize {
                        for x in 0..rect.w as usize {
                            let at = (y * rect.w as usize + x) * 4;
                            assert_eq!(
                                tuple(decode(&encoded, x, y, phase)),
                                expected[at..at + 4]
                                    .iter()
                                    .map(|v| v.to_bits())
                                    .collect::<Vec<_>>()
                                    .as_slice(),
                                "{kind} {offsets:?} {rect:?} {phase} {x},{y}"
                            );
                        }
                    }
                }
                assert!(builder.finish().unwrap().is_empty());
            }
        }
    }
}
#[test]
fn constant_fields_share_words_and_over_budget_fields_decline_without_partial_publication() {
    let rect = Rect::new(0, 0, 128, 128);
    let paint = paint("linear", &[0., 1.]);
    let mut builder = Builder::new(
        rect,
        Transform([1., 0., 0., 1., 10000., 0.]),
        [10., 10.],
        &paint,
    )
    .unwrap();
    while !builder.advance().unwrap() {}
    let encoded = builder.finish().unwrap();
    assert_eq!(encoded.len(), WIDTH);
    assert!(encoded[HEADER..HEADER + 256].iter().all(|v| v >> 30 == 3));
    let mut bounded =
        Builder::with_limit(rect, Transform::default(), [128., 128.], &paint, 1024).unwrap();
    while !bounded.advance().unwrap() {}
    assert!(bounded.finish().unwrap().is_empty());
}
#[test]
fn original_parameter_admission_and_supported_stop_boundaries_are_preserved() {
    let p = paint("radial", &[0., 1.]);
    assert!(Builder::new(
        Rect::new(0, 0, 4097, 1024),
        Transform::default(),
        [1., 1.],
        &p
    )
    .is_err());
    assert!(Builder::new(
        Rect::new(i32::MAX, 0, 2, 2),
        Transform::default(),
        [1., 1.],
        &p
    )
    .is_err());
    assert!(Builder::new(
        Rect::new(0, 0, 1, 1),
        Transform::default(),
        [1., 1.],
        &paint("linear", &[0., 0.2, 0.6, 1.])
    )
    .is_err());
    assert_eq!(
        tuple(encode(Some((1, 2, 0.))).unwrap()),
        [1_f32.to_bits(), 2_f32.to_bits(), 0, 0]
    );
    assert!(encode(Some((1, 2, -0.))).is_err());
}
