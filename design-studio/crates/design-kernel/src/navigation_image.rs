//! A disposable SDR navigation image for the immutable source browser.
//! The caller hands over its display copy only after publishing the exact store.
use crate::{
    Engine,
    color::ColorSpace,
    fidelity::RasterProfile,
    renderer::RenderOptions,
    scene::{Document, Paint},
};
use base64::Engine as _;
use image::{ImageDecoder, ImageEncoder};
use std::{collections::HashMap, io::Cursor, sync::Arc};

pub struct NavigationImage {
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub png: Vec<u8>,
}

fn image_lod(paint: &mut Paint, images: &mut HashMap<Arc<str>, Arc<str>>) -> Result<(), String> {
    let Some(uri) = &mut paint.image else {
        return Ok(());
    };
    if let Some(image) = images.get(uri) {
        *uri = image.clone();
        return Ok(());
    }
    if images.len() >= 128 || uri.len() > 32 * 1024 * 1024 {
        return Err("Navigation image working set exceeded".into());
    }
    let (_, payload) = uri.split_once(',').ok_or("Invalid navigation image URI")?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| e.to_string())?;
    let space = crate::image_color::png_space(&data)?;
    let mut reader = image::ImageReader::new(Cursor::new(data))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(80 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let (w, h) = decoder.dimensions();
    if w.max(h) <= 256 {
        images.insert(uri.clone(), uri.clone());
        return Ok(());
    }
    if u64::from(w) * u64::from(h) > 16_777_216
        || !matches!(paint.fit.as_str(), "cover" | "contain" | "stretch" | "crop")
        || !matches!(space, None | Some(ColorSpace::Srgb))
        || crate::image_color::icc(&mut decoder)?.is_some()
        || !matches!(
            decoder.color_type(),
            image::ColorType::Rgb8
                | image::ColorType::Rgba8
                | image::ColorType::L8
                | image::ColorType::La8
        )
    {
        // Keep the original coordinates, bit depth and profiles for all
        // unsupported cases. The CPU renderer may decline this optional view.
        images.insert(uri.clone(), uri.clone());
        return Ok(());
    }
    let decoded = image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    let small = decoded.thumbnail(256, 256).into_rgba8();
    let mut encoded = Vec::new();
    image::codecs::png::PngEncoder::new(&mut encoded)
        .write_image(
            &small,
            small.width(),
            small.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| e.to_string())?;
    let lod: Arc<str> = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(encoded)
    )
    .into();
    images.insert(uri.clone(), lod.clone());
    *uri = lod;
    Ok(())
}

pub fn render(document: Document, page_id: String, bounds: [f64; 4], font: &[u8]) -> Result<NavigationImage, String> {
    let mut engine=Engine::new();
    engine.load_font(font)?;
    render_fit(&mut engine,document,page_id,bounds,256)
}

pub fn render_fit(
    engine: &mut Engine,
    mut document: Document,
    page_id: String,
    bounds: [f64; 4],
    side: u32,
) -> Result<NavigationImage, String> {
    if document
        .color_management
        .is_some_and(|c| c.document_space != ColorSpace::Srgb)
        || !bounds.iter().all(|v| v.is_finite())
        || bounds[2] <= 0.
        || bounds[3] <= 0.
    {
        return Err("Unavailable SDR navigation view".into());
    }
    if !(1..=256).contains(&side) { return Err("Invalid navigation image size".into()); }
    let scale = (f64::from(side) / bounds[2].max(bounds[3])).min(1.);
    if scale < 0.001 {
        return Err("Navigation density is outside the supported range".into());
    }
    let width = (bounds[2] * scale).ceil().clamp(1., 256.) as u32;
    let height = (bounds[3] * scale).ceil().clamp(1., 256.) as u32;
    let mut images = HashMap::new();
    for node in document.nodes.values_mut() {
        crate::render_cancellation::checkpoint()?;
        for paint in node
            .fills
            .iter_mut()
            .chain(node.strokes.iter_mut().map(|stroke| &mut stroke.paint))
        {
            image_lod(paint, &mut images)?;
        }
    }
    drop(images);
    let managed = document.color_management.is_some();
    let options: RenderOptions=serde_json::from_value(serde_json::json!({
        "pageId":page_id,"width":width,"height":height,
        "view":{"x":-bounds[0]*scale,"y":-bounds[1]*scale,"zoom":scale},
        "grid":false,"transparent":false,"rasterProfile":if managed {RasterProfile::FigmaSubpixel}else{RasterProfile::Analytic}
    })).map_err(|e|e.to_string())?;
    let rgba = crate::capacity::with_source_storage_scope(true, || {
        engine.load_source_document(document)?;
        crate::render_cancellation::checkpoint()?;
        engine.render(&options)
    })?;
    crate::render_cancellation::checkpoint()?;
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(NavigationImage {
        width,
        height,
        scale,
        png,
    })
}
