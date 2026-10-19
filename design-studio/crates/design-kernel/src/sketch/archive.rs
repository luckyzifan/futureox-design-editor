use crate::sketch::{Error, Result};
use std::collections::{BTreeMap, HashSet};
use std::io::{Cursor, Read, Write};

pub(crate) const MAX_ENTRIES: usize = 4096;
pub(crate) const MAX_ENTRY_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RATIO: u64 = 200;
const RATIO_FLOOR: u64 = 4096;

pub(crate) fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.starts_with('/')
        && !path.contains(['\\', ':', '\0'])
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}

// zip 2.x indexes files by decoded name, hiding duplicate central records.
// Count the bounded ZIP32 records before trusting that deduplicated index.
fn central_record_count(bytes: &[u8], start: u64) -> Result<usize> {
    let mut at = usize::try_from(start).map_err(|_| Error::Limit("directory offset"))?;
    let mut count = 0;
    while bytes.get(at..at.saturating_add(4)) == Some(b"PK\x01\x02") {
        let header = bytes
            .get(at..at.checked_add(46).ok_or(Error::Limit("directory size"))?)
            .ok_or_else(|| Error::Invalid("truncated central directory".into()))?;
        let length = |offset| u16::from_le_bytes([header[offset], header[offset + 1]]) as usize;
        at = at
            .checked_add(46 + length(28) + length(30) + length(32))
            .ok_or(Error::Limit("directory size"))?;
        if at > bytes.len() {
            return Err(Error::Invalid("truncated central entry".into()));
        }
        count += 1;
        if count > MAX_ENTRIES {
            return Err(Error::Limit("archive entries"));
        }
    }
    if bytes.get(at..at.saturating_add(4)) != Some(b"PK\x05\x06") {
        return Err(Error::Unsupported(
            "non-ZIP32 or unsupported central directory trailer".into(),
        ));
    }
    Ok(count)
}

pub(crate) fn read(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>> {
    if bytes.len() as u64 > MAX_TOTAL_BYTES {
        return Err(Error::Limit("archive input"));
    }
    let mut zip =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| Error::Archive(e.to_string()))?;
    if central_record_count(bytes, zip.central_directory_start())? != zip.len() {
        return Err(Error::Ambiguous(
            "duplicate central directory identity".into(),
        ));
    }
    if zip.len() > MAX_ENTRIES {
        return Err(Error::Limit("archive entries"));
    }
    let mut files = BTreeMap::new();
    let mut names = HashSet::new();
    let mut total = 0u64;
    for index in 0..zip.len() {
        let mut file = zip
            .by_index(index)
            .map_err(|e| Error::Archive(e.to_string()))?;
        let name = file.name().to_owned();
        let path = name.strip_suffix('/').unwrap_or(&name);
        if !safe_path(path) || !names.insert(path.to_owned()) {
            return Err(Error::Invalid(format!(
                "unsafe/duplicate archive path: {name}"
            )));
        }
        if file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err(Error::Invalid("archive symlink".into()));
        }
        if file.is_dir() {
            continue;
        }
        let size = file.size();
        if size > MAX_ENTRY_BYTES {
            return Err(Error::Limit("entry bytes"));
        }
        if size > RATIO_FLOOR && size > file.compressed_size().max(1).saturating_mul(MAX_RATIO) {
            return Err(Error::Limit("compression ratio"));
        }
        total = total.checked_add(size).ok_or(Error::Limit("total bytes"))?;
        if total > MAX_TOTAL_BYTES {
            return Err(Error::Limit("total bytes"));
        }
        let mut data = Vec::new();
        file.by_ref()
            .take(MAX_ENTRY_BYTES + 1)
            .read_to_end(&mut data)
            .map_err(|e| Error::Archive(e.to_string()))?;
        if data.len() as u64 != size {
            return Err(Error::Invalid("entry length mismatch".into()));
        }
        files.insert(name, data);
    }
    Ok(files)
}

pub(crate) fn write(files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>> {
    if files.len() > MAX_ENTRIES {
        return Err(Error::Limit("archive entries"));
    }
    let mut total = 0u64;
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    // Stored entries avoid producing an archive our expansion-ratio gate rejects.
    // Native payload bytes are preserved; ZIP compression/layout is not identity.
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, data) in files {
        if !safe_path(name) {
            return Err(Error::Invalid("unsafe archive path".into()));
        }
        if data.len() as u64 > MAX_ENTRY_BYTES {
            return Err(Error::Limit("entry bytes"));
        }
        total += data.len() as u64;
        if total > MAX_TOTAL_BYTES {
            return Err(Error::Limit("total bytes"));
        }
        writer
            .start_file(name, options)
            .map_err(|e| Error::Archive(e.to_string()))?;
        writer
            .write_all(data)
            .map_err(|e| Error::Archive(e.to_string()))?;
    }
    let bytes = writer
        .finish()
        .map_err(|e| Error::Archive(e.to_string()))?
        .into_inner();
    if bytes.len() as u64 > MAX_TOTAL_BYTES {
        return Err(Error::Limit("archive output"));
    }
    Ok(bytes)
}
