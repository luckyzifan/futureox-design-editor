//! Original ZIP pixels are copied once, to files owned by the open source.
//! Only opening thumbnails use a reduced raster. Neither editing nor Sketch
//! export replaces the bitmap in the archive.
use super::*;
use std::sync::atomic::AtomicUsize;

fn publish(path: &Path, write: impl FnOnce(&mut File) -> Result<()>) -> Result<()> {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    if path.is_file() {
        return Ok(());
    }
    let tmp = path.with_extension(format!(
        "{}-{}.part",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(issue)?;
        write(&mut f)?;
        drop(f);
        if let Err(e) = fs::rename(&tmp, path)
            && !path.is_file()
        {
            return Err(issue(e));
        }
        Ok(())
    })();
    let _ = fs::remove_file(tmp);
    result
}
pub(super) fn project(
    archive: &Path,
    name: &str,
    length: u64,
    entry: &mut impl Read,
    thumbnail: bool,
) -> Result<Option<(String, [u32; 2])>> {
    let dir = archive
        .parent()
        .ok_or_else(|| issue("Missing source folder"))?;
    let owner = dir
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| s.len() <= 160 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        .ok_or_else(|| issue("Invalid source image owner"))?;
    let assets = dir.join("bitmaps");
    fs::create_dir_all(&assets).map_err(issue)?;
    let mut header = [0u8; 33];
    entry.read_exact(&mut header).map_err(issue)?;
    if &header[..8] != b"\x89PNG\r\n\x1a\n" || &header[12..16] != b"IHDR" {
        return Err(issue("Invalid Sketch PNG header"));
    }
    let w = u32::from_be_bytes(header[16..20].try_into().unwrap());
    let h = u32::from_be_bytes(header[20..24].try_into().unwrap());
    if w == 0 || h == 0 {
        return Err(issue("Empty Sketch bitmap"));
    }
    let key = format!("{}-{w}x{h}", digest(name.as_bytes()));
    // Opening thumbnails and editable snapshots can request the same entry concurrently.
    static WRITERS: [Mutex<()>; 16] = [const { Mutex::new(()) }; 16];
    let _writer = WRITERS[usize::from(key.as_bytes()[0]) % 16]
        .lock()
        .map_err(issue)?;
    let original = assets.join(format!("{key}.png"));
    publish(&original, |f| {
        capacity::require_space(&assets, length)?;
        f.write_all(&header).map_err(issue)?;
        if io::copy(entry, f)
            .map_err(issue)?
            .checked_add(header.len() as u64)
            != Some(length)
        {
            return Err(issue("Truncated Sketch source image"));
        }
        Ok(())
    })?;
    let uri = if thumbnail {
        let small = assets.join(format!("{key}.thumb"));
        publish(&small, |out| preview(&original, out))?;
        let bytes = fs::read(small).map_err(issue)?;
        futureox_design_kernel::interop::image_data_uri_public(&bytes)
    } else {
        let raw = assets.join(format!("{key}.rgba"));
        let eligible = u64::from(w) * u64::from(h) > 8_388_608 || w.max(h) > 8192;
        let grid = eligible && (raw.is_file() || write_sampling_rows(&original, &raw, w, h)?);
        format!(
            "design-app://app/source-image/{owner}/{key}.png{}",
            if grid { "?samples=1" } else { "" }
        )
    };
    Ok(Some((uri, [w, h])))
}
fn preview(path: &Path, out: &mut File) -> Result<()> {
    let mut decoder = png::Decoder::new(BufReader::new(File::open(path).map_err(issue)?));
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder.read_info().map_err(issue)?;
    let i = reader.info();
    let (w, h) = (i.width, i.height);
    if i.interlaced || i.animation_control.is_some() {
        return Err(issue(
            "Opening thumbnail requires a noninterlaced still PNG",
        ));
    }
    let side = 192u64;
    let max = u64::from(w.max(h)).max(side);
    let tw = (u64::from(w) * side / max).max(1) as usize;
    let th = (u64::from(h) * side / max).max(1) as usize;
    let (color, depth) = reader.output_color_type();
    let step = color.samples()
        * match depth {
            png::BitDepth::Eight => 1,
            png::BitDepth::Sixteen => 2,
            _ => return Err(issue("Unsupported thumbnail sample depth")),
        };
    let mut info = png::Info::with_size(tw as u32, th as u32);
    info.color_type = color;
    info.bit_depth = depth;
    info.srgb = i.srgb;
    info.icc_profile = i.icc_profile.clone();
    info.coding_independent_code_points = i.coding_independent_code_points;
    info.source_gamma = i.source_gamma;
    info.source_chromaticities = i.source_chromaticities;
    info.exif_metadata = i.exif_metadata.clone();
    let mut pixels = vec![0; tw * th * step];
    let mut dy = 0;
    for y in 0..u64::from(h) {
        let row = reader
            .next_row()
            .map_err(issue)?
            .ok_or_else(|| issue("Truncated thumbnail PNG"))?;
        if row.data().len() != w as usize * step {
            return Err(issue("Invalid thumbnail row"));
        }
        if dy < th && y == ((2 * dy + 1) as u64 * u64::from(h) / (2 * th) as u64) {
            for x in 0..tw {
                let src = (((2 * x + 1) as u64 * u64::from(w) / (2 * tw) as u64) as usize) * step;
                pixels[(dy * tw + x) * step..(dy * tw + x + 1) * step]
                    .copy_from_slice(&row.data()[src..src + step]);
            }
            dy += 1;
        }
    }
    reader.finish().map_err(issue)?;
    if dy != th {
        return Err(issue("Incomplete Sketch thumbnail"));
    }
    let mut writer = png::Encoder::with_info(out, info)
        .map_err(issue)?
        .write_header()
        .map_err(issue)?;
    writer.write_image_data(&pixels).map_err(issue)?;
    writer.finish().map_err(issue)
}

/// Native resolution, straight unassociated texels. Limit each working row,
/// not the length of a photograph. No profile/depth/orientation conversion is
/// inferred: other formats stay on the original managed decoder.
fn write_sampling_rows(original: &Path, raw: &Path, w: u32, h: u32) -> Result<bool> {
    if w > 262144 {
        return Ok(false);
    }
    let mut reader = png::Decoder::new(BufReader::new(File::open(original).map_err(issue)?))
        .read_info()
        .map_err(issue)?;
    let info = reader.info();
    if info.interlaced
        || info.animation_control.is_some()
        || info.bit_depth != png::BitDepth::Eight
        || info.icc_profile.is_some()
        || info
            .exif_metadata
            .as_deref()
            .map(futureox_design_kernel::interop::source_bitmap_upright)
            .transpose()
            .map_err(issue)?
            == Some(false)
        || info.coding_independent_code_points.is_some()
        || info.trns.is_some()
        || !matches!(info.color_type, png::ColorType::Rgb | png::ColorType::Rgba)
    {
        return Ok(false);
    }
    let rgb = info.color_type == png::ColorType::Rgb;
    capacity::require_space(raw.parent().unwrap(), u64::from(w) * u64::from(h) * 4)?;
    publish(raw, |f| {
        let mut writer = BufWriter::with_capacity(256 * 1024, f);
        let mut rgba = vec![255u8; w as usize * 4];
        for _ in 0..h {
            let row = reader
                .next_row()
                .map_err(issue)?
                .ok_or_else(|| issue("Truncated source bitmap"))?;
            if rgb {
                for (q, p) in rgba.chunks_exact_mut(4).zip(row.data().chunks_exact(3)) {
                    q[..3].copy_from_slice(p);
                }
                writer.write_all(&rgba).map_err(issue)?;
            } else {
                writer.write_all(row.data()).map_err(issue)?;
            }
        }
        reader.finish().map_err(issue)?;
        writer.flush().map_err(issue)
    })?;
    Ok(true)
}
