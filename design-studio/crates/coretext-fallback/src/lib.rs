//! macOS system-UI font cascade.
//!
//! Sketch does not render a missing PostScript name with `CTFontCreateWithName`.
//! That call returns Times New Roman (`TimesNewRomanPSMT`), which has no glyphs
//! for the Chinese sample in issue 485. The system UI font plus
//! `CTFontCreateForString` is the cascade that yields `.PingFangUIDisplaySC-Regular`
//! on the owner's Mac. This crate only resolves a file and face index. The
//! kernel subsets it for rendering and does not embed it.
//!
//! Linux builds return no face. This VM has no CoreText, so the macOS branch
//! is not executed here.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocatedFace {
    pub bytes: Vec<u8>,
    pub index: u32,
    pub postscript: String,
}

/// Times is CoreText's stand-in when `CTFontCreateWithName` misses. It is not
/// a usable Chinese fallback.
pub fn is_coretext_name_lookup_fallback(postscript: &str) -> bool {
    matches!(
        postscript,
        "TimesNewRomanPSMT"
            | "Times-Roman"
            | "TimesNewRomanPS-BoldMT"
            | "TimesNewRomanPS-ItalicMT"
            | "TimesNewRomanPS-BoldItalicMT"
    )
}

pub fn locate(text: &str, size: f64) -> Result<Option<LocatedFace>, String> {
    if text.is_empty() || !size.is_finite() || !(1.0..=4096.0).contains(&size) {
        return Ok(None);
    }
    #[cfg(all(target_os = "macos", target_pointer_width = "64"))]
    {
        macos::locate(text, size)
    }
    #[cfg(not(all(target_os = "macos", target_pointer_width = "64")))]
    {
        Ok(None)
    }
}

#[cfg(all(target_os = "macos", target_pointer_width = "64"))]
mod macos {
    use super::{LocatedFace, is_coretext_name_lookup_fallback};
    use std::ffi::c_void;
    use std::path::PathBuf;
    use std::sync::Mutex;

    const UI_SYSTEM: u32 = 2;
    const UTF8: u32 = 0x0800_0100;
    const MAX_FILE: u64 = 128 * 1024 * 1024;

    #[repr(C)]
    struct Range {
        location: isize,
        length: isize,
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithBytes(
            allocator: *const c_void,
            bytes: *const u8,
            len: isize,
            encoding: u32,
            external: u8,
        ) -> *mut c_void;
        fn CFStringGetLength(string: *const c_void) -> isize;
        fn CFStringGetCString(
            string: *const c_void,
            buffer: *mut u8,
            size: isize,
            encoding: u32,
        ) -> u8;
        fn CFURLGetFileSystemRepresentation(
            url: *const c_void,
            resolve: u8,
            buffer: *mut u8,
            size: isize,
        ) -> u8;
        fn CFRelease(value: *const c_void);
    }

    #[link(name = "CoreText", kind = "framework")]
    unsafe extern "C" {
        fn CTFontCreateUIFontForLanguage(
            ui: u32,
            size: f64,
            language: *const c_void,
        ) -> *mut c_void;
        fn CTFontCreateForString(
            font: *const c_void,
            string: *const c_void,
            range: Range,
        ) -> *mut c_void;
        fn CTFontCopyPostScriptName(font: *const c_void) -> *mut c_void;
        fn CTFontCopyAttribute(font: *const c_void, attribute: *const c_void) -> *mut c_void;
        fn CTFontGetGlyphsForCharacters(
            font: *const c_void,
            characters: *const u16,
            glyphs: *mut u16,
            count: isize,
        ) -> u8;
        static kCTFontURLAttribute: *const c_void;
    }

    struct Owned(*mut c_void);
    impl Owned {
        fn new(value: *mut c_void) -> Option<Self> {
            if value.is_null() {
                None
            } else {
                Some(Self(value))
            }
        }
        fn as_ptr(&self) -> *const c_void {
            self.0
        }
    }
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) }
            }
        }
    }

    static FILE_CACHE: Mutex<Option<(PathBuf, Vec<u8>)>> = Mutex::new(None);

    pub(super) fn locate(text: &str, size: f64) -> Result<Option<LocatedFace>, String> {
        if text.chars().count() > 4096 {
            return Ok(None);
        }
        let utf16: Vec<u16> = text.encode_utf16().collect();
        if utf16.is_empty() || utf16.len() > 8192 {
            return Ok(None);
        }
        unsafe {
            let ui = Owned::new(CTFontCreateUIFontForLanguage(
                UI_SYSTEM,
                size,
                std::ptr::null(),
            ));
            let Some(ui) = ui else { return Ok(None) };
            let cf = Owned::new(CFStringCreateWithBytes(
                std::ptr::null(),
                text.as_ptr(),
                text.len() as isize,
                UTF8,
                0,
            ));
            let Some(cf) = cf else { return Ok(None) };
            let length = CFStringGetLength(cf.as_ptr());
            if length <= 0 {
                return Ok(None);
            }
            // CTFontCreateForString on the system UI font, not CTFontCreateWithName
            // of the missing source PostScript name.
            let resolved = Owned::new(CTFontCreateForString(
                ui.as_ptr(),
                cf.as_ptr(),
                Range {
                    location: 0,
                    length,
                },
            ));
            let Some(resolved) = resolved else {
                return Ok(None);
            };
            let mut glyphs = vec![0u16; utf16.len()];
            let covered = CTFontGetGlyphsForCharacters(
                resolved.as_ptr(),
                utf16.as_ptr(),
                glyphs.as_mut_ptr(),
                utf16.len() as isize,
            );
            if covered == 0 || glyphs.iter().any(|glyph| *glyph == 0) {
                return Ok(None);
            }
            let name_ref = Owned::new(CTFontCopyPostScriptName(resolved.as_ptr()));
            let Some(name_ref) = name_ref else {
                return Ok(None);
            };
            let mut name_bytes = [0u8; 256];
            if CFStringGetCString(
                name_ref.as_ptr(),
                name_bytes.as_mut_ptr(),
                name_bytes.len() as isize,
                UTF8,
            ) == 0
            {
                return Ok(None);
            }
            let postscript = std::ffi::CStr::from_ptr(name_bytes.as_ptr().cast())
                .to_string_lossy()
                .into_owned();
            if postscript.is_empty() || is_coretext_name_lookup_fallback(&postscript) {
                return Ok(None);
            }
            let url = Owned::new(CTFontCopyAttribute(resolved.as_ptr(), kCTFontURLAttribute));
            let Some(url) = url else { return Ok(None) };
            let mut path_bytes = [0u8; 1024];
            if CFURLGetFileSystemRepresentation(
                url.as_ptr(),
                1,
                path_bytes.as_mut_ptr(),
                path_bytes.len() as isize,
            ) == 0
            {
                return Ok(None);
            }
            let path = PathBuf::from(
                std::ffi::CStr::from_ptr(path_bytes.as_ptr().cast())
                    .to_string_lossy()
                    .as_ref(),
            );
            if !path.is_absolute() {
                return Ok(None);
            }
            let bytes = read_cached(&path)?;
            let Some(bytes) = bytes else { return Ok(None) };
            let index = face_index(&bytes, &postscript);
            let Some(index) = index else { return Ok(None) };
            Ok(Some(LocatedFace {
                bytes,
                index,
                postscript,
            }))
        }
    }

    fn read_cached(path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
        let mut cache = FILE_CACHE
            .lock()
            .map_err(|_| "System font cache is unavailable".to_string())?;
        if let Some((cached, bytes)) = cache.as_ref() {
            if cached == path {
                return Ok(Some(bytes.clone()));
            }
        }
        let meta =
            std::fs::metadata(path).map_err(|_| "System font file is unreadable".to_string())?;
        if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_FILE {
            return Ok(None);
        }
        let bytes =
            std::fs::read(path).map_err(|_| "System font file is unreadable".to_string())?;
        if bytes.len() as u64 > MAX_FILE {
            return Ok(None);
        }
        *cache = Some((path.to_path_buf(), bytes.clone()));
        Ok(Some(bytes))
    }

    fn face_index(bytes: &[u8], postscript: &str) -> Option<u32> {
        let count = ttf_parser::fonts_in_collection(bytes).unwrap_or(1).min(64);
        (0..count).find(|index| {
            ttf_parser::Face::parse(bytes, *index)
                .ok()
                .is_some_and(|face| {
                    face.names().into_iter().any(|name| {
                        name.name_id == ttf_parser::name_id::POST_SCRIPT_NAME
                            && name.to_string().is_some_and(|value| value == postscript)
                    })
                })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_from_name_lookup_is_not_a_chinese_fallback() {
        for name in [
            "TimesNewRomanPSMT",
            "Times-Roman",
            "TimesNewRomanPS-BoldMT",
            "TimesNewRomanPS-ItalicMT",
            "TimesNewRomanPS-BoldItalicMT",
        ] {
            assert!(is_coretext_name_lookup_fallback(name), "{name}");
        }
        assert!(!is_coretext_name_lookup_fallback(
            ".PingFangUIDisplaySC-Regular"
        ));
        assert!(!is_coretext_name_lookup_fallback("YouSheBiaoTiHei"));
    }

    #[test]
    fn this_host_does_not_invent_a_coretext_face() {
        if cfg!(all(target_os = "macos", target_pointer_width = "64")) {
            return;
        }
        assert!(locate("精品可视化", 46.).unwrap().is_none());
    }
}
