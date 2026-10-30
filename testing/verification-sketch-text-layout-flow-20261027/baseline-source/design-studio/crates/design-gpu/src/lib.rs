//! Native execution of our vector scene and shared WGSL, without a browser.
//! wgpu supplies device access; geometry, coverage and compositing remain ours.
#![forbid(unsafe_code)]
mod compositor;
mod device;
pub mod tile_cache;
pub mod tiled_host;

pub use device::{AdapterDescription, NativeGpu, RenderedFrame};
pub use tile_cache::{TileCache, TileCacheStats};
pub use tiled_host::{TiledFrameHost, TiledHostStats};
pub use wgpu::Backends;

/// Encode straight-alpha RGBA8 with an explicit sRGB PNG tag.
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    futureox_design_kernel::export::validate_size(width, height)?;
    if rgba.len() != width as usize * height as usize * 4 {
        return Err("RGBA length does not match dimensions".into());
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
        encoder
            .write_header()
            .map_err(|e| e.to_string())?
            .write_image_data(rgba)
            .map_err(|e| e.to_string())?;
    }
    Ok(bytes)
}
