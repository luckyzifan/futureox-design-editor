//! Grayscale glyph masks from system FreeType.
//!
//! The load flags match Poppler 24.02 `SplashFTFont`: no hinting, no embedded
//! bitmap, normal (grayscale) render, and a horizontal 26.6 offset of
//! `x_frac * 16` where `x_frac` is a quarter-pixel numerator in 0..4.
//! The kernel has `forbid(unsafe_code)`, so the FreeType calls stay here.
use freetype::freetype::{
    FT_Done_Face, FT_Done_FreeType, FT_Face, FT_Init_FreeType, FT_LOAD_NO_BITMAP,
    FT_LOAD_NO_HINTING, FT_Library, FT_Load_Glyph, FT_Matrix, FT_New_Memory_Face, FT_Pixel_Mode,
    FT_Render_Glyph, FT_Render_Mode, FT_Set_Char_Size, FT_Set_Transform, FT_Vector,
};
use std::cell::RefCell;
use std::ptr;

pub struct GlyphBitmap {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub rows: i32,
    pub coverage: Vec<u8>,
}

struct Entry {
    // FreeType keeps a pointer into this buffer for the life of `face`.
    #[allow(dead_code)]
    bytes: Vec<u8>,
    face: FT_Face,
}

impl Drop for Entry {
    fn drop(&mut self) {
        if !self.face.is_null() {
            unsafe { FT_Done_Face(self.face) };
            self.face = ptr::null_mut();
        }
    }
}

struct Cache {
    library: FT_Library,
    faces: Vec<([u8; 32], u32, Box<Entry>)>,
}

impl Drop for Cache {
    fn drop(&mut self) {
        self.faces.clear();
        if !self.library.is_null() {
            unsafe { FT_Done_FreeType(self.library) };
            self.library = ptr::null_mut();
        }
    }
}

thread_local! {
    static CACHE: RefCell<Option<Cache>> = const { RefCell::new(None) };
}

fn with_face<T>(
    bytes: &[u8],
    digest: [u8; 32],
    index: u32,
    body: impl FnOnce(FT_Face) -> Option<T>,
) -> Option<T> {
    CACHE.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            let mut library = ptr::null_mut();
            let err = unsafe { FT_Init_FreeType(&mut library) };
            if err != 0 || library.is_null() {
                return None;
            }
            *slot = Some(Cache {
                library,
                faces: Vec::new(),
            });
        }
        let cache = slot.as_mut()?;
        if let Some(pos) = cache
            .faces
            .iter()
            .position(|(found, found_index, _)| *found == digest && *found_index == index)
        {
            return body(cache.faces[pos].2.face);
        }
        let mut owned = bytes.to_vec();
        let mut face = ptr::null_mut();
        let err = unsafe {
            FT_New_Memory_Face(
                cache.library,
                owned.as_mut_ptr(),
                owned.len() as _,
                index as _,
                &mut face,
            )
        };
        if err != 0 || face.is_null() {
            return None;
        }
        cache
            .faces
            .push((digest, index, Box::new(Entry { bytes: owned, face })));
        body(cache.faces.last()?.2.face)
    })
}

pub fn rasterize(
    bytes: &[u8],
    digest: [u8; 32],
    index: u32,
    glyph: u32,
    size_px: f64,
    x_frac: i32,
) -> Option<GlyphBitmap> {
    if bytes.is_empty() || !(0..4).contains(&x_frac) || !(0.5..512.0).contains(&size_px) {
        return None;
    }
    let width_26 = (size_px * 64.0).round();
    if !(32.0..32768.0).contains(&width_26) {
        return None;
    }
    with_face(bytes, digest, index, |face| unsafe {
        if FT_Set_Char_Size(face, width_26 as _, width_26 as _, 72, 72) != 0 {
            return None;
        }
        let mut matrix = FT_Matrix {
            xx: 0x10000,
            xy: 0,
            yx: 0,
            yy: 0x10000,
        };
        let mut delta = FT_Vector {
            x: i64::from(x_frac) * 16,
            y: 0,
        };
        FT_Set_Transform(face, &mut matrix, &mut delta);
        let flags = (FT_LOAD_NO_HINTING | FT_LOAD_NO_BITMAP) as i32;
        if FT_Load_Glyph(face, glyph, flags) != 0 {
            return None;
        }
        let slot = (*face).glyph;
        if slot.is_null() || FT_Render_Glyph(slot, FT_Render_Mode::FT_RENDER_MODE_NORMAL) != 0 {
            return None;
        }
        let bitmap = &(*slot).bitmap;
        if bitmap.pixel_mode != FT_Pixel_Mode::FT_PIXEL_MODE_GRAY as u8 {
            return None;
        }
        let width = i32::try_from(bitmap.width).ok()?;
        let rows = i32::try_from(bitmap.rows).ok()?;
        if width < 0 || rows < 0 || width > 4096 || rows > 4096 {
            return None;
        }
        let mut coverage = vec![0u8; (width.max(0) * rows.max(0)) as usize];
        if width > 0 && rows > 0 {
            if bitmap.buffer.is_null() {
                return None;
            }
            let pitch = bitmap.pitch;
            for row in 0..rows {
                let src_offset = if pitch >= 0 {
                    row * pitch
                } else {
                    (rows - 1 - row) * pitch.abs()
                };
                if src_offset < 0 {
                    return None;
                }
                let src = bitmap.buffer.add(src_offset as usize);
                let dst = (row * width) as usize;
                ptr::copy_nonoverlapping(src, coverage.as_mut_ptr().add(dst), width as usize);
            }
        }
        Some(GlyphBitmap {
            left: (*slot).bitmap_left,
            top: (*slot).bitmap_top,
            width,
            rows,
            coverage,
        })
    })
}
