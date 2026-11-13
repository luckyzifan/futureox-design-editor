//! Admission for embedded raster paints.
//!
//! GIF animation is static on import: only the first frame is decoded, and the
//! original file bytes stay in the data URI. TIFF import admits one classic
//! (not BigTIFF) page. A later IFD, including a thumbnail, is rejected instead
//! of silently showing another page. Orientation tag 274 is applied with the
//! same 1–8 rule as EXIF; invalid values fail closed. Neither path resamples
//! or re-encodes the stored bytes.
use image::metadata::Orientation;

pub const EMBEDDED_IMAGE_PREFIXES: [&str; 5] = [
    "data:image/png;base64,",
    "data:image/jpeg;base64,",
    "data:image/webp;base64,",
    "data:image/gif;base64,",
    "data:image/tiff;base64,",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RasterKind {
    Png,
    Jpeg,
    Webp,
    Gif,
    Tiff,
}

pub fn declared_kind(uri: &str) -> Option<RasterKind> {
    const KINDS: [RasterKind; 5] = [
        RasterKind::Png,
        RasterKind::Jpeg,
        RasterKind::Webp,
        RasterKind::Gif,
        RasterKind::Tiff,
    ];
    EMBEDDED_IMAGE_PREFIXES
        .iter()
        .zip(KINDS)
        .find(|(prefix, _)| uri.starts_with(**prefix))
        .map(|(_, kind)| kind)
}

pub fn has_embedded_image_prefix(uri: &str) -> bool {
    declared_kind(uri).is_some()
}

pub(crate) struct Container {
    pub gif: bool,
    pub tiff_orientation: Option<Orientation>,
}

/// Reject a declared GIF/TIFF whose bytes are a different format, and reject a
/// PNG/JPEG/WebP declaration that is actually a GIF or TIFF. Other corrupt
/// PNG/JPEG/WebP bytes keep the existing decoder error.
pub(crate) fn admit_declared_bytes(kind: RasterKind, bytes: &[u8]) -> Result<(), String> {
    if is_bigtiff(bytes) {
        return Err("BigTIFF is not a supported single-page TIFF".into());
    }
    let gif = is_gif(bytes);
    let tiff = is_classic_tiff(bytes);
    match kind {
        RasterKind::Gif if gif => Ok(()),
        RasterKind::Gif => Err("GIF bytes do not match the declared image type".into()),
        RasterKind::Tiff if tiff => Ok(()),
        RasterKind::Tiff => Err("TIFF bytes do not match the declared image type".into()),
        RasterKind::Png | RasterKind::Jpeg | RasterKind::Webp if gif || tiff => {
            Err("Image bytes do not match the declared type".into())
        }
        RasterKind::Png | RasterKind::Jpeg | RasterKind::Webp => Ok(()),
    }
}

pub(crate) fn inspect_container(bytes: &[u8]) -> Result<Container, String> {
    if is_bigtiff(bytes) {
        return Err("BigTIFF is not a supported single-page TIFF".into());
    }
    if is_gif(bytes) {
        return Ok(Container {
            gif: true,
            tiff_orientation: None,
        });
    }
    if is_classic_tiff(bytes) {
        return Ok(Container {
            gif: false,
            tiff_orientation: Some(tiff_single_page(bytes)?),
        });
    }
    Ok(Container {
        gif: false,
        tiff_orientation: None,
    })
}

pub(crate) fn decode_failure(container: &Container, error: impl std::fmt::Display) -> String {
    if container.gif {
        format!("GIF decode failed: {error}")
    } else if container.tiff_orientation.is_some() {
        format!("TIFF decode failed: {error}")
    } else {
        error.to_string()
    }
}

fn is_gif(bytes: &[u8]) -> bool {
    bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")
}

fn is_classic_tiff(bytes: &[u8]) -> bool {
    bytes.starts_with(b"II*\x00") || bytes.starts_with(b"MM\x00*")
}

fn is_bigtiff(bytes: &[u8]) -> bool {
    bytes.starts_with(b"II+\x00") || bytes.starts_with(b"MM\x00+")
}

/// Walk only the primary IFD. A non-zero next-IFD pointer is a further page
/// and is rejected before any pixel buffer is allocated.
pub(crate) fn tiff_single_page(bytes: &[u8]) -> Result<Orientation, String> {
    if !is_classic_tiff(bytes) {
        return Err("TIFF bytes do not match the declared image type".into());
    }
    let little = bytes.starts_with(b"II*\x00");
    let u16_at = |at: usize| -> Result<u16, String> {
        let raw: [u8; 2] = bytes
            .get(at..at + 2)
            .ok_or("Truncated TIFF directory")?
            .try_into()
            .unwrap();
        Ok(if little {
            u16::from_le_bytes(raw)
        } else {
            u16::from_be_bytes(raw)
        })
    };
    let u32_at = |at: usize| -> Result<u32, String> {
        let raw: [u8; 4] = bytes
            .get(at..at + 4)
            .ok_or("Truncated TIFF directory")?
            .try_into()
            .unwrap();
        Ok(if little {
            u32::from_le_bytes(raw)
        } else {
            u32::from_be_bytes(raw)
        })
    };
    let offset = u32_at(4)? as usize;
    if offset < 8 {
        return Err("TIFF image has no readable page".into());
    }
    let count = usize::from(u16_at(offset)?);
    if count > 1024 {
        return Err("TIFF directory is not a supported single page".into());
    }
    let entries = offset
        .checked_add(2)
        .and_then(|start| start.checked_add(count.checked_mul(12)?))
        .ok_or("Truncated TIFF directory")?;
    let next = u32_at(entries)?;
    if next != 0 {
        return Err("Multi-page TIFF is not imported; only a single page is supported".into());
    }
    let mut orientation = None;
    for index in 0..count {
        let at = offset + 2 + index * 12;
        if u16_at(at)? != 274 {
            continue;
        }
        if u16_at(at + 2)? != 3 || u32_at(at + 4)? != 1 {
            return Err("Invalid TIFF orientation type or count".into());
        }
        let value = u16_at(at + 8)?;
        let current = u8::try_from(value)
            .ok()
            .and_then(Orientation::from_exif)
            .ok_or("Invalid TIFF orientation value (expected 1 through 8)")?;
        if orientation.is_some_and(|previous| previous != current) {
            return Err("Conflicting TIFF orientation values".into());
        }
        orientation = Some(current);
    }
    Ok(orientation.unwrap_or(Orientation::NoTransforms))
}
