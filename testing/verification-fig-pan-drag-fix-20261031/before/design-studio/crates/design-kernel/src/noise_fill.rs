//! Original local grain preset expressed as an ordinary tiled image paint.
//! Modern Sketch noise presets use image fills. Legacy noiseIndex values do not
//! identify a portable procedural formula and are never mapped to this preset.
use crate::scene::Paint;
pub fn preset() -> Result<Paint, String> {
    const SIZE: u32 = 64;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let value = (crate::effects::noise(x as i32, y as i32, 0x4e4f4953) * 255.)
                .round_ties_even() as u8;
            rgba.extend_from_slice(&[value, value, value, 255]);
        }
    }
    let png = crate::export::encode_rgba(SIZE, SIZE, &rgba)?;
    serde_json::from_value(
        serde_json::json!({"id":"","kind":"image","color":"#808080","opacity":0.18,"visible":true,
        "image":crate::interop::image_data_uri_public(&png),"fit":"stretch","blend":"normal",
        "tile":{"mode":"grid","size":[0.,0.],"offset":[0.,0.],"alignment":["start","start"]}}),
    )
    .map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_preset_is_deterministic_and_native_image_data() {
        let a = preset().unwrap();
        let b = preset().unwrap();
        assert_eq!(a, b);
        assert!(
            a.image
                .as_ref()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
        assert_eq!(a.tile.unwrap().size, [0., 0.]);
        assert_eq!(a.opacity, 0.18);
    }
}
