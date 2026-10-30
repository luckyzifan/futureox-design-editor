//! Rebuild the small, synthetic interoperability fixtures (no external images).
use futureox_design_kernel::{
    blend::Pixel,
    color::{ColorOutput, ColorSettings, ColorSpace, ToneMap},
    export::encode_color_png,
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::path::PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("Usage: color_assets OUTPUT_DIRECTORY")?,
    );
    std::fs::create_dir_all(&path)?;
    let settings = ColorSettings::default();
    for (name, space) in [
        ("pq-highlights", ColorSpace::Pq),
        ("hlg-highlights", ColorSpace::Hlg),
    ] {
        std::fs::write(
            path.join(format!("{name}.png")),
            encode_color_png(
                4,
                4,
                &[Pixel([4., 2., 1., 1.]); 16],
                settings,
                ColorOutput {
                    space,
                    tone_map: ToneMap::None,
                },
            )?,
        )?;
    }
    let mut profile = moxcms::ColorProfile::new_display_p3();
    profile.creation_date_time = moxcms::ColorDateTime {
        year: 2000,
        month: 1,
        day_of_the_month: 1,
        hours: 0,
        minutes: 0,
        seconds: 0,
    };
    let mut info = png::Info::with_size(4, 4);
    info.color_type = png::ColorType::Rgba;
    info.bit_depth = png::BitDepth::Eight;
    info.icc_profile = Some(std::borrow::Cow::Owned(
        futureox_design_kernel::export::canonical_icc(&profile)?,
    ));
    let mut bytes = Vec::new();
    {
        let mut writer = png::Encoder::with_info(&mut bytes, info)?.write_header()?;
        writer.write_image_data(&[255, 0, 0, 128].repeat(16))?;
        writer.finish()?;
    }
    std::fs::write(path.join("p3-red-icc.png"), bytes)?;
    Ok(())
}
