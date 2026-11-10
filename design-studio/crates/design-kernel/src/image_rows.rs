//! Native-resolution PNG rows for GPU uploads without a complete float image.
//! Source dimensions/encoded length are not cache-capacity quotas. The upload
//! destination still checks the actual device's dimensions and residency.
use crate::{blend::Pixel, color::{ColorSettings, ColorSpace}, image_color};
use base64::Engine as _;
use std::io::Cursor;

pub const ROW_PIXELS: usize = 262_144; // at most 4 MiB returned RGBA32F
pub struct Decoder {
    reader: png::Reader<Cursor<Vec<u8>>>, settings: Option<ColorSettings>,
    space: Option<ColorSpace>, profile: Option<Vec<u8>>,
    width: u32, height: u32, row: u32, color: png::ColorType, depth: png::BitDepth, failed: bool,
    transform: Option<image_color::WorkingTransform>,
}
impl Decoder {
    /// `null` is an unmanaged document. Parsing it as `ColorSettings` is the
    /// tile failure `invalid type: null, expected struct ColorSettings`.
    pub fn from_settings_json(uri: &str, settings: &str) -> Result<Self, String> {
        let settings = serde_json::from_str(settings).map_err(|e| e.to_string())?;
        Self::new(uri, settings)
    }
    pub fn new(uri: &str, settings: Option<ColorSettings>) -> Result<Self, String> {
        if let Some(settings) = settings {
            settings.validate()?;
        }
        let data = uri.strip_prefix("data:image/png;base64,").ok_or("Row decoding requires PNG")?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "Invalid image data")?;
        let space = image_color::png_space(&bytes)?;
        let (profile, orientation) = {
            // Metadata inspection does not allocate a full decoded surface.
            // A whole-image allocation allowance must not reject row streaming.
            let mut decoder = image::codecs::png::PngDecoder::with_limits(Cursor::new(bytes.as_slice()), image::Limits::no_limits()).map_err(|e| e.to_string())?;
            let profile = if space.is_none() { image_color::icc(&mut decoder)? } else { None };
            (profile, image_color::orientation(&mut decoder)?)
        };
        if orientation != image::metadata::Orientation::NoTransforms {
            return Err("PNG row decoding requires unrotated source pixels".into());
        }
        let mut png = png::Decoder::new_with_limits(Cursor::new(bytes), png::Limits { bytes: usize::MAX });
        // Match image::PngDecoder: palette/tRNS/low-bit gray expansion, no 16-bit stripping.
        png.set_transformations(png::Transformations::EXPAND);
        let reader = png.read_info().map_err(|e| e.to_string())?;
        let info = reader.info(); let (width, height) = (info.width, info.height);
        if width == 0 || height == 0 || (width as usize).checked_mul(4 * std::mem::size_of::<f32>()).is_none() {
            return Err("PNG row source dimensions are not addressable".into());
        }
        if info.interlaced || info.animation_control.is_some() {
            return Err("PNG row decoding requires a noninterlaced still image".into());
        }
        let (color, depth) = reader.output_color_type();
        if !matches!(depth, png::BitDepth::Eight | png::BitDepth::Sixteen) || color == png::ColorType::Indexed {
            return Err("PNG rows require expanded 8-bit or 16-bit channels".into());
        }
        if settings.is_none() && matches!(space, Some(ColorSpace::Pq | ColorSpace::Hlg)) {
            return Err("HDR bitmap requires a color-managed document; source bytes retained".into());
        }
        if settings.is_none() && depth == png::BitDepth::Sixteen {
            return Err("High-precision bitmap requires a color-managed document; source bytes retained".into());
        }
        Ok(Self { reader, settings, space, profile, width, height, row: 0, color, depth, failed: false, transform: None })
    }
    pub fn width(&self) -> u32 { self.width }
    pub fn height(&self) -> u32 { self.height }
    /// Original unassociated integer texels for the sRGB display sampler.
    /// Other profiles, orientations and channel depths keep the float decoder.
    pub fn straight_srgb8(&mut self)->Result<Vec<u8>,String>{
        if self.failed||self.row!=0{return Err("PNG row decoder already consumed".into())}
        if self.depth!=png::BitDepth::Eight||self.profile.is_some()||self.space.is_some_and(|v|v!=ColorSpace::Srgb)||
            self.settings.is_some_and(|s| s.document_space!=ColorSpace::Srgb)||u64::from(self.width)*u64::from(self.height)>16_777_216{return Ok(Vec::new())}
        self.failed=true;
        let mut pixels=Vec::new();pixels.try_reserve_exact(self.width as usize*self.height as usize*4).map_err(|e|e.to_string())?;
        while self.row<self.height{
            let row=self.reader.next_row().map_err(|e|e.to_string())?.ok_or("Truncated PNG rows")?;
            if row.data().len()!=self.width as usize*self.color.samples(){return Err("Unexpected PNG row width".into())}
            match self.color{
                png::ColorType::Rgba=>pixels.extend_from_slice(row.data()),
                png::ColorType::Rgb=>for p in row.data().chunks_exact(3){pixels.extend_from_slice(&[p[0],p[1],p[2],255])},
                png::ColorType::GrayscaleAlpha=>for p in row.data().chunks_exact(2){pixels.extend_from_slice(&[p[0],p[0],p[0],p[1]])},
                png::ColorType::Grayscale=>for &v in row.data(){pixels.extend_from_slice(&[v,v,v,255])},
                _=>return Err("Unsupported PNG source channels".into()),
            }
            self.row+=1;
        }
        self.reader.finish().map_err(|e|e.to_string())?;self.failed=false;Ok(pixels)
    }
    pub fn next_rows(&mut self) -> Result<Vec<f32>, String> {
        if self.failed { return Err("PNG row decoder failed".into()); }
        if self.row == self.height { return Ok(Vec::new()); }
        let result = self.read_rows(); if result.is_err() { self.failed = true; } result
    }
    fn read_rows(&mut self) -> Result<Vec<f32>, String> {
        let height = (ROW_PIXELS / self.width as usize).max(1).min((self.height - self.row) as usize) as u32;
        let sample_bytes = if self.depth == png::BitDepth::Sixteen { 2 } else { 1 };
        let stride = (self.width as usize).checked_mul(self.color.samples()).and_then(|n| n.checked_mul(sample_bytes)).ok_or("PNG row byte overflow")?;
        let count = stride.checked_mul(height as usize).ok_or("PNG strip byte overflow")?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(count).map_err(|e| format!("Cannot allocate PNG strip: {e}"))?;
        for _ in 0..height {
            let row = self.reader.next_row().map_err(|e| e.to_string())?.ok_or("Truncated PNG rows")?;
            if row.data().len() != stride { return Err("Unexpected PNG row width".into()); }
            bytes.extend_from_slice(row.data());
        }
        let pixels=self.convert(bytes,self.width,height)?;
        self.row += height;
        // A bad trailing chunk rejects the last strip; the uploader must destroy
        // its unpublished partial texture, never certify an incomplete asset.
        if self.row == self.height { self.reader.finish().map_err(|e| e.to_string())?; }
        Ok(pixels)
    }
    /// A crop consumes the same validated PNG stream. Only sampled texels
    /// undergo ICC conversion and premultiplication; row filters and CRCs
    /// are still checked through the final chunk.
    pub fn window(&mut self,x:u32,y:u32,w:u32,h:u32)->Result<Vec<f32>,String>{
        if self.failed || self.row!=0 || w==0 || h==0 || u64::from(w)*u64::from(h)>524288 ||
            x.checked_add(w).is_none_or(|v|v>self.width)||y.checked_add(h).is_none_or(|v|v>self.height){
            return Err("Invalid PNG sample window".into())
        }
        self.failed=true;
        let step=self.color.samples()*if self.depth==png::BitDepth::Sixteen{2}else{1};
        let stride=self.width as usize*step;let left=x as usize*step;let right=(x+w)as usize*step;
        let mut bytes=Vec::new();bytes.try_reserve_exact((right-left)*h as usize).map_err(|e|e.to_string())?;
        while self.row<self.height{
            let row=self.reader.next_row().map_err(|e|e.to_string())?.ok_or("Truncated PNG rows")?;
            if row.data().len()!=stride{return Err("Unexpected PNG row width".into())}
            if self.row>=y&&self.row<y+h{bytes.extend_from_slice(&row.data()[left..right])}
            self.row+=1;
        }
        self.reader.finish().map_err(|e|e.to_string())?;
        let pixels=self.convert(bytes,w,h)?;self.failed=false;Ok(pixels)
    }
    fn convert(&mut self,bytes:Vec<u8>,width:u32,height:u32)->Result<Vec<f32>,String>{
        // Same integer-to-float conversion, color transform and premultiplication
        // as the complete decoder. None of these operations crosses a row boundary.
        let decoded = if self.depth == png::BitDepth::Sixteen {
            // PNG scanline samples are big endian. Preserve all source bits;
            // DynamicImage performs exactly the full decoder's float conversion.
            let mut words = Vec::new(); words.try_reserve_exact(bytes.len()/2).map_err(|e| e.to_string())?;
            words.extend(bytes.chunks_exact(2).map(|b|u16::from_be_bytes([b[0],b[1]])));
            match self.color {
                png::ColorType::Grayscale => image::DynamicImage::ImageLuma16(image::ImageBuffer::from_raw(width, height, words).unwrap()),
                png::ColorType::GrayscaleAlpha => image::DynamicImage::ImageLumaA16(image::ImageBuffer::from_raw(width, height, words).unwrap()),
                png::ColorType::Rgb => image::DynamicImage::ImageRgb16(image::ImageBuffer::from_raw(width, height, words).unwrap()),
                png::ColorType::Rgba => image::DynamicImage::ImageRgba16(image::ImageBuffer::from_raw(width, height, words).unwrap()),
                _ => return Err("Unsupported PNG row channels".into()),
            }
        } else { match self.color {
            png::ColorType::Grayscale => image::DynamicImage::ImageLuma8(image::ImageBuffer::from_raw(width, height, bytes).unwrap()),
            png::ColorType::GrayscaleAlpha => image::DynamicImage::ImageLumaA8(image::ImageBuffer::from_raw(width, height, bytes).unwrap()),
            png::ColorType::Rgb => image::DynamicImage::ImageRgb8(image::ImageBuffer::from_raw(width, height, bytes).unwrap()),
            png::ColorType::Rgba => image::DynamicImage::ImageRgba8(image::ImageBuffer::from_raw(width, height, bytes).unwrap()),
            _ => return Err("Unsupported PNG row channels".into()),
        }};
        let mut image = decoded.into_rgba32f();
        if let Some(settings) = self.settings {
            if self.transform.is_none() {
                self.transform=Some(image_color::WorkingTransform::new(settings,self.space,self.profile.as_deref())?);
                // The compiled transform owns its tables; keep no second raw ICC
                // buffer for the remainder of this row decoder's lifetime.
                self.profile=None;
            }
            self.transform.as_mut().unwrap().apply(&mut image)?;
            for p in image.pixels_mut() { p.0 = Pixel::rgba(p[0], p[1], p[2], p[3]).0; }
        } else {
            // Same unmanaged boundary as paint::decode_bytes: tagged sources
            // encode back to sRGB, then every texel is quantized to RGBA8.
            if self.space.is_some() || self.profile.is_some() {
                if self.transform.is_none() {
                    self.transform=Some(image_color::WorkingTransform::new(ColorSettings::default(),self.space,self.profile.as_deref())?);
                    self.profile=None;
                }
                self.transform.as_mut().unwrap().apply(&mut image)?;
                let settings = ColorSettings::default();
                for pixel in image.pixels_mut() {
                    let rgb = settings.from_working([f64::from(pixel[0]), f64::from(pixel[1]), f64::from(pixel[2])], ColorSpace::Srgb);
                    for channel in 0..3 { pixel[channel] = rgb[channel].clamp(0., 1.) as f32; }
                }
            }
            for p in image.pixels_mut() { p.0 = Pixel::rgba(p[0], p[1], p[2], p[3]).rgba8_quantized().0; }
        }
        Ok(image.into_raw())
    }
}

/// Decode ordinary SDR JPEG through the same native codec as the full float
/// path. Profiled/oriented imagery retains its usual colour-managed decoder.
pub fn source_jpeg_srgb8(uri: &str) -> Result<Vec<u8>, String> {
    use image::ImageDecoder;
    let Some(data) = uri.strip_prefix("data:image/jpeg;base64,") else {
        return Ok(Vec::new());
    };
    if uri.len() > 12 * 1024 * 1024 {
        return Err("Image exceeds 12 MB encoded limit".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "Invalid image data")?;
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Jpeg);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(320 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let (w, h) = decoder.dimensions();
    if u64::from(w) * u64::from(h) > 8_388_608
        || decoder.color_type() != image::ColorType::Rgb8
        || image_color::icc(&mut decoder)?.is_some()
        || image_color::orientation(&mut decoder)? != image::metadata::Orientation::NoTransforms
    {
        return Ok(Vec::new());
    }
    let image = image::DynamicImage::from_decoder(decoder)
        .map_err(|e| e.to_string())?
        .into_rgba8();
    let mut out = Vec::with_capacity(image.as_raw().len() + 8);
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(image.as_raw());
    Ok(out)
}
/// Table words come from the same 8-bit conversion and working transform as a
/// full RGBA32F upload. The shader premultiplies each texel before bilinear filtering.
pub(crate) fn srgb8_channels() -> &'static [[f32; 256]; 2] {
    static CHANNELS: std::sync::OnceLock<[[f32; 256]; 2]> = std::sync::OnceLock::new();
    CHANNELS.get_or_init(|| {
        // Use image's own byte-to-float conversion before the same working
        // transfer as full decode, including its exact normalization order.
        let image = image::RgbaImage::from_fn(256, 1, |x, _| image::Rgba([x as u8; 4]));
        let image = image::DynamicImage::ImageRgba8(image).into_rgba32f();
        let mut table = [[0.; 256]; 2];
        let settings = ColorSettings::default();
        for (i, pixel) in image.pixels().enumerate() {
            table[0][i] = settings.to_working([f64::from(pixel[0]); 3], ColorSpace::Srgb)[0] as f32;
            table[1][i] = pixel[3];
        }
        table
    })
}
pub fn straight_srgb8_table() -> Result<Vec<u8>, String> {
    Ok(srgb8_channels()
        .iter()
        .flatten()
        .flat_map(|c| c.to_le_bytes())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_jpeg_bytes_reconstruct_the_native_float_decode() {
        let mut input=Vec::new();
        let pixels=(0..769*3).map(|i|((i*43+i/7)%256) as u8).collect::<Vec<_>>();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut input,92)
            .encode(&pixels,769,1,image::ExtendedColorType::Rgb8).unwrap();
        let uri=format!("data:image/jpeg;base64,{}",base64::engine::general_purpose::STANDARD.encode(&input));
        let packed=source_jpeg_srgb8(&uri).unwrap();
        assert_eq!(u32::from_le_bytes(packed[..4].try_into().unwrap()),769);
        let mut reference=image::load_from_memory_with_format(&input,image::ImageFormat::Jpeg).unwrap().into_rgba32f();
        image_color::to_working(&mut reference,ColorSettings::default(),None,None).unwrap();
        let [rgb,alpha]=srgb8_channels();
        for (raw,pixel) in packed[8..].chunks_exact(4).zip(reference.pixels()){
            let from_row=Pixel::rgba(rgb[raw[0] as usize],rgb[raw[1] as usize],rgb[raw[2] as usize],alpha[raw[3] as usize]);
            assert_eq!(from_row.0.map(f32::to_bits),Pixel::rgba(pixel[0],pixel[1],pixel[2],pixel[3]).0.map(f32::to_bits));
        }
        assert!(source_jpeg_srgb8("data:image/jpeg;base64,invalid").is_err());
        assert!(source_jpeg_srgb8("data:image/png;base64,AAAA").unwrap().is_empty());
    }
    fn uri(width: u32, height: u32, color: png::ColorType) -> String {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(color); encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            let data: Vec<_> = (0..width as usize * height as usize * color.samples()).map(|i| ((i * 19 + 3) % 256) as u8).collect();
            writer.write_image_data(&data).unwrap();
        }
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
    }
    #[test]
    fn streamed_rows_match_full_native_color_and_premultiplication_bits() {
        for color in [png::ColorType::Grayscale, png::ColorType::GrayscaleAlpha, png::ColorType::Rgb, png::ColorType::Rgba] {
            let data = uri(1025, 513, color);
            for space in [ColorSpace::Srgb, ColorSpace::DisplayP3] {
                let settings = ColorSettings { document_space: space, reference_white_nits: 203., peak_luminance_nits: 1000. };
                let mut images = crate::paint::Images::default(); images.set_color_settings(Some(settings));
                let expected = images.image(&data).unwrap();
                let mut rows = Decoder::new(&data, Some(settings)).unwrap(); let mut actual = Vec::new();
                loop { let part = rows.next_rows().unwrap(); if part.is_empty() { break; } assert!(part.len() <= ROW_PIXELS * 4); actual.extend(part); }
                let expected: Vec<_> = expected.pixels.iter().flat_map(|p| p.0).map(f32::to_bits).collect();
                assert_eq!(actual.into_iter().map(f32::to_bits).collect::<Vec<_>>(), expected);
            }
        }
    }

    #[test]
    fn source_windows_and_straight_srgb_table_reconstruct_the_full_float_upload() {
        let input=uri(17,11,png::ColorType::Rgba);
        let settings=ColorSettings::default();
        let mut full=Decoder::new(&input, Some(settings)).unwrap();
        let reference=full.next_rows().unwrap();
        let mut crop=Decoder::new(&input, Some(settings)).unwrap();
        let pixels=crop.window(3,4,6,2).unwrap();
        for y in 0..2 {assert_eq!(&pixels[y*24..(y+1)*24],&reference[((y+4)*17+3)*4..((y+4)*17+9)*4]);}
        let raw=Decoder::new(&input, Some(settings)).unwrap().straight_srgb8().unwrap();
        let table=straight_srgb8_table().unwrap();
        let value=|index:usize|f32::from_le_bytes(table[index*4..index*4+4].try_into().unwrap());
        for(i,p)in raw.chunks_exact(4).enumerate(){
            let a=value(256+usize::from(p[3]));assert_eq!(a.to_bits(),reference[i*4+3].to_bits());
            for c in 0..3{assert_eq!((value(usize::from(p[c]))*a).to_bits(),reference[i*4+c].to_bits());}
        }
    }
    #[test]
    fn large_image_stream_keeps_full_dimensions_without_lifting_full_decode_guard() {
        let data = uri(4096, 2304, png::ColorType::Rgba);
        let settings = ColorSettings { document_space: ColorSpace::Srgb, reference_white_nits: 203., peak_luminance_nits: 1000. };
        let mut images = crate::paint::Images::default(); images.set_color_settings(Some(settings));
        assert!(images.image(&data).err().unwrap().contains("Decoded image budget exceeded"));
        let mut decoder = Decoder::new(&data, Some(settings)).unwrap(); let mut pixels = 0;
        loop { let part = decoder.next_rows().unwrap(); if part.is_empty() { break; } assert!(part.len() <= ROW_PIXELS * 4); pixels += part.len() / 4; }
        assert_eq!(pixels, 4096 * 2304);
    }
    #[test]
    fn encoded_payload_over_twelve_mib_is_a_stream_not_an_admission_failure() {
        let mut encoded = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut encoded, 3072, 1024);
            encoder.set_color(png::ColorType::Rgba); encoder.set_depth(png::BitDepth::Eight);
            encoder.set_compression(png::Compression::NoCompression);
            encoder.write_header().unwrap().write_image_data(&[127, 63, 31, 255].repeat(3072 * 1024)).unwrap();
        }
        let data = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(encoded));
        assert!(data.len() > 12 * 1024 * 1024);
        let settings = ColorSettings { document_space: ColorSpace::Srgb, reference_white_nits: 203., peak_luminance_nits: 1000. };
        let mut decoder = Decoder::new(&data, Some(settings)).unwrap(); let mut count = 0;
        loop {
            let strip = decoder.next_rows().unwrap(); if strip.is_empty() { break; }
            assert!(strip.len() <= ROW_PIXELS * 4);
            assert!(strip.chunks_exact(4).all(|p|p[0]>p[1]&&p[1]>p[2]&&p[2]>0.&&p[3]==1.));
            count += strip.len()/4;
        }
        assert_eq!(count, 3072 * 1024);
    }
    #[test]
    fn multiple_icc_strips_prepare_once_and_match_the_complete_decoder() {
        let profile=moxcms::ColorProfile::new_display_p3().encode().unwrap();
        let mut info=png::Info::with_size(1024,513);info.color_type=png::ColorType::Rgba;info.bit_depth=png::BitDepth::Eight;
        info.icc_profile=Some(std::borrow::Cow::Owned(profile));
        let mut encoded=Vec::new();
        png::Encoder::with_info(&mut encoded,info).unwrap().write_header().unwrap()
            .write_image_data(&[127,63,31,191].repeat(1024*513)).unwrap();
        let uri=format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(encoded));
        let settings=ColorSettings::default();let mut images=crate::paint::Images::default();images.set_color_settings(Some(settings));
        let reference=images.image(&uri).unwrap();let before=image_color::icc_preparations();
        let mut decoder=Decoder::new(&uri, Some(settings)).unwrap();let mut offset=0;let mut strips=0;
        loop {let strip=decoder.next_rows().unwrap();if strip.is_empty(){break}strips+=1;
            for (actual,expected) in strip.chunks_exact(4).zip(&reference.pixels[offset..]) {
                assert_eq!(actual.iter().map(|v|v.to_bits()).collect::<Vec<_>>(),expected.0.map(f32::to_bits));
            }
            offset+=strip.len()/4;
        }
        assert_eq!(offset,1024*513);assert!(strips>1);assert_eq!(image_color::icc_preparations()-before,1);
    }
    #[test]
    fn sixteen_bit_rows_keep_original_channel_and_alpha_precision() {
        for color in [png::ColorType::Grayscale, png::ColorType::GrayscaleAlpha, png::ColorType::Rgb, png::ColorType::Rgba] {
            let mut encoded = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut encoded, 1025, 257);
                encoder.set_color(color); encoder.set_depth(png::BitDepth::Sixteen);
                let data: Vec<_> = (0..1025 * 257 * color.samples()).flat_map(|i| ((i * 19 + 3) as u16).to_be_bytes()).collect();
                encoder.write_header().unwrap().write_image_data(&data).unwrap();
            }
            let data = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(encoded));
            let settings = ColorSettings { document_space: ColorSpace::DisplayP3, reference_white_nits: 203., peak_luminance_nits: 1000. };
            let mut images = crate::paint::Images::default(); images.set_color_settings(Some(settings));
            let reference = images.image(&data).unwrap();
            let mut decoder = Decoder::new(&data, Some(settings)).unwrap(); let mut offset = 0;
            loop {
                let strip = decoder.next_rows().unwrap(); if strip.is_empty() { break; }
                for (actual, expected) in strip.chunks_exact(4).zip(&reference.pixels[offset..]) {
                    assert_eq!(actual.iter().map(|n|n.to_bits()).collect::<Vec<_>>(), expected.0.map(f32::to_bits));
                }
                offset += strip.len()/4;
            }
            assert_eq!(offset, reference.pixels.len());
        }
    }
    #[test]
    fn row_stream_has_no_whole_image_pixel_or_8192_dimension_quota() {
        let settings = ColorSettings { document_space: ColorSpace::Srgb, reference_white_nits: 203., peak_luminance_nits: 1000. };
        let mut images = crate::paint::Images::default(); images.set_color_settings(Some(settings));
        let reference = images.image(&uri(256, 1, png::ColorType::Grayscale)).unwrap();
        for (width, height) in [(17, 8193), (4097, 4096)] {
            let data = uri(width, height, png::ColorType::Grayscale);
            let mut decoder = Decoder::new(&data, Some(settings)).unwrap();
            assert_eq!((decoder.width(), decoder.height()), (width, height));
            let mut count = 0;
            loop {
                let strip = decoder.next_rows().unwrap();
                if strip.is_empty() { break; }
                assert!(strip.len() <= ROW_PIXELS * 4);
                // The source generator is deterministic, so verify every
                // decoded pixel across strip boundaries without a full image.
                for pixel in strip.chunks_exact(4) {
                    for (actual, expected) in pixel.iter().zip(reference.pixels[count % 256].0) {
                        assert_eq!(actual.to_bits(), expected.to_bits());
                    }
                    count += 1;
                }
            }
            assert_eq!(count, width as usize * height as usize);
        }
    }
    #[test]
    fn truncated_source_never_returns_a_successful_final_strip() {
        let original = uri(3, 3, png::ColorType::Rgba);
        let mut bytes = base64::engine::general_purpose::STANDARD.decode(original.split_once(',').unwrap().1).unwrap();
        bytes.truncate(bytes.len() - 9);
        let data = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
        let settings = ColorSettings { document_space: ColorSpace::Srgb, reference_white_nits: 203., peak_luminance_nits: 1000. };
        let mut decoder = Decoder::new(&data, Some(settings)).unwrap();
        assert!(decoder.next_rows().is_err());
        assert!(decoder.next_rows().is_err());
    }
    #[test]
    fn null_color_settings_json_opens_unmanaged_rows_and_does_not_linearize() {
        let data = uri(8, 4, png::ColorType::Rgba);
        let rejected = serde_json::from_str::<ColorSettings>("null").unwrap_err().to_string();
        assert!(
            rejected.contains("invalid type: null, expected struct ColorSettings"),
            "{rejected}"
        );
        let mut unmanaged = Decoder::from_settings_json(&data, "null").unwrap();
        let mut actual = Vec::new();
        loop {
            let part = unmanaged.next_rows().unwrap();
            if part.is_empty() { break; }
            actual.extend(part);
        }
        let mut images = crate::paint::Images::default();
        images.set_color_settings(None);
        let expected = images.image(&data).unwrap();
        assert_eq!(
            actual.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            expected.pixels.iter().flat_map(|p| p.0).map(f32::to_bits).collect::<Vec<_>>()
        );
        let mut managed = Decoder::new(&data, Some(ColorSettings::default())).unwrap();
        let mut linear = Vec::new();
        loop {
            let part = managed.next_rows().unwrap();
            if part.is_empty() { break; }
            linear.extend(part);
        }
        assert_ne!(
            actual.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            linear.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
        );
        let straight = Decoder::from_settings_json(&data, "null").unwrap().straight_srgb8().unwrap();
        assert_eq!(straight.len(), 8 * 4 * 4);
        assert!(Decoder::from_settings_json(&data, "null").unwrap().window(1, 1, 2, 2).is_ok());
    }
}
