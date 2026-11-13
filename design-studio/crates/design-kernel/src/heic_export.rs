//! Lossless HEIC stills for the same PNG samples JPEG, WebP, PDF and TIFF
//! already consume.
//!
//! The payload is a real ISO/IEC 23008-12 image (`ftyp` major brand `heic`)
//! whose colour and straight alpha are each an HEVC Main 4:4:4 still coded
//! entirely with I_PCM. There is no quantisation and no 4:2:0 chroma
//! subsampling, so an independent HEVC decoder returns the source channels.
//! x265 is GPL and is not linked; the writer is pure Rust and runs in the
//! WASM export entry.
//!
//! Coding blocks are 32×32. The frame is padded with zeros and the HEVC
//! conformance window crops back to the PNG dimensions. Alpha is a hidden
//! auxiliary monochrome image (`urn:mpeg:mpegB:cicp:systems:auxiliary:alpha`),
//! straight / unassociated, not premultiplied. The colour item carries the
//! same sRGB or Display P3 ICC profile as TIFF, and the VUI is full-range
//! identity RGB (matrix coefficients 0, transfer 13).

const MAX_PIXELS: u64 = 16_777_216;
const CODING_BLOCK: u32 = 32;

pub(crate) fn encode(
    rgba: &[u8],
    width: u32,
    height: u32,
    icc: &[u8],
    primaries: u8,
) -> Result<Vec<u8>, String> {
    if icc.len() < 128 || &icc[36..40] != b"acsp" || &icc[16..20] != b"RGB " {
        return Err("HEIC ICC profile is missing or not an RGB profile".into());
    }
    if icc.len() > 8 * 1024 * 1024 {
        return Err("HEIC ICC profile is too large".into());
    }
    if !matches!(primaries, 1 | 12) {
        return Err(
            "HEIC tags sRGB (primaries 1) or Display P3 (primaries 12); export PNG for other color spaces"
                .into(),
        );
    }
    let pixels = u64::from(width) * u64::from(height);
    if width == 0 || height == 0 || pixels > MAX_PIXELS {
        return Err("HEIC export exceeds 16 million pixels; choose a smaller export scale".into());
    }
    let padded_w = pad_block(width)?;
    let padded_h = pad_block(height)?;
    if u64::from(padded_w) * u64::from(padded_h) > MAX_PIXELS {
        return Err(
            "HEIC 32×32 coding blocks would exceed 16 million pixels; choose a smaller export scale"
                .into(),
        );
    }
    if rgba.len() as u64 != pixels * 4 {
        return Err("HEIC RGBA buffer does not match dimensions".into());
    }

    let color = image_nals(rgba, width, height, padded_w, padded_h, false, primaries)?;
    let alpha = image_nals(rgba, width, height, padded_w, padded_h, true, primaries)?;
    assemble(width, height, icc, &color, &alpha)
}

fn pad_block(value: u32) -> Result<u32, String> {
    let padded = u64::from(value).div_ceil(u64::from(CODING_BLOCK)) * u64::from(CODING_BLOCK);
    u32::try_from(padded).map_err(|_| "HEIC dimensions overflow".to_string())
}

struct ImageNals {
    vps: Vec<u8>,
    sps: Vec<u8>,
    pps: Vec<u8>,
    slice: Vec<u8>,
    profile: [u8; 12],
    chroma: u8,
}

fn image_nals(
    rgba: &[u8],
    width: u32,
    height: u32,
    padded_w: u32,
    padded_h: u32,
    alpha: bool,
    primaries: u8,
) -> Result<ImageNals, String> {
    let chroma = if alpha { 0u8 } else { 3 };
    let profile = profile_tier_level(alpha);
    let vps = nal(32, &vps_rbsp(&profile)?);
    let sps = nal(
        33,
        &sps_rbsp(
            &profile,
            u32::from(chroma),
            padded_w,
            padded_h,
            width,
            height,
            alpha,
            primaries,
        )?,
    );
    let pps = nal(34, &pps_rbsp()?);
    let slice = nal(
        19,
        &slice_rbsp(rgba, width, height, padded_w, padded_h, alpha)?,
    );
    Ok(ImageNals {
        vps,
        sps,
        pps,
        slice,
        profile,
        chroma,
    })
}

fn assemble(
    width: u32,
    height: u32,
    icc: &[u8],
    color: &ImageNals,
    alpha: &ImageNals,
) -> Result<Vec<u8>, String> {
    let ftyp = iso_box(
        b"ftyp",
        &[
            b"heic".as_slice(),
            &0u32.to_be_bytes(),
            b"mif1",
            b"heic",
            b"miaf",
        ]
        .concat(),
    );
    let hdlr = hdlr_box();
    let pitm = full_box(b"pitm", 0, 0, &1u16.to_be_bytes());
    let iinf = iinf_box();
    let iref = iref_box();
    let ispe = ispe_box(width, height);
    let pixi_color = pixi_box(&[8, 8, 8]);
    let colr = iso_box(b"colr", &[b"prof".as_slice(), icc].concat());
    let hvcc_color = hvcc_box(
        &color.profile,
        color.chroma,
        &[&color.vps, &color.sps, &color.pps],
    )?;
    let pixi_alpha = pixi_box(&[8]);
    let hvcc_alpha = hvcc_box(
        &alpha.profile,
        alpha.chroma,
        &[&alpha.vps, &alpha.sps, &alpha.pps],
    )?;
    let aux = aux_box();
    let ipco = container(
        b"ipco",
        &[
            ispe, pixi_color, colr, hvcc_color, pixi_alpha, hvcc_alpha, aux,
        ],
    );
    // Property indexes are 1-based. Colour: ispe, pixi, colr, hvcC.
    // Alpha reuses ispe and adds its own pixi, hvcC and auxC.
    let ipma = ipma_box(&[(1, &[1, 2, 3, 4]), (2, &[1, 5, 6, 7])]);
    let iprp = container(b"iprp", &[ipco, ipma]);

    let color_extent = 4 + color.slice.len();
    let alpha_extent = 4 + alpha.slice.len();
    let iloc_template = iloc_box(&[(1, 0, color_extent as u32), (2, 0, alpha_extent as u32)]);
    let meta_body = [hdlr, pitm, iloc_template.clone(), iinf, iref, iprp].concat();
    let meta_len = 12 + meta_body.len();
    let color_at = ftyp.len() + meta_len + 8;
    let alpha_at = color_at + color_extent;
    if color_at > u32::MAX as usize || alpha_at > u32::MAX as usize {
        return Err("HEIC file exceeds 4 GiB".into());
    }
    let iloc = iloc_box(&[
        (1, color_at as u32, color_extent as u32),
        (2, alpha_at as u32, alpha_extent as u32),
    ]);
    if iloc.len() != iloc_template.len() {
        return Err("HEIC item location box changed size".into());
    }
    // `meta_body` sized the box with a zero offset. The final children are
    // the same boxes with the real file offsets patched into `iloc`.
    let meta = full_box(b"meta", 0, 0, &{
        let mut body = hdlr_box();
        body.extend(pitm_box());
        body.extend(iloc);
        body.extend(iinf_box());
        body.extend(iref_box());
        body.extend(iprp_box(width, height, icc, color, alpha)?);
        body
    });
    if meta.len() != meta_len {
        return Err(format!(
            "HEIC meta box is {} bytes, location math used {meta_len}",
            meta.len()
        ));
    }
    let mut mdat_payload = Vec::with_capacity(color_extent + alpha_extent);
    mdat_payload.extend_from_slice(&(color.slice.len() as u32).to_be_bytes());
    mdat_payload.extend_from_slice(&color.slice);
    mdat_payload.extend_from_slice(&(alpha.slice.len() as u32).to_be_bytes());
    mdat_payload.extend_from_slice(&alpha.slice);
    let mdat = iso_box(b"mdat", &mdat_payload);
    let mut file = Vec::with_capacity(ftyp.len() + meta.len() + mdat.len());
    file.extend(ftyp);
    file.extend(meta);
    file.extend(mdat);
    if &file[4..12] != b"ftypheic" {
        return Err("HEIC file did not start with the heic brand".into());
    }
    Ok(file)
}

fn hdlr_box() -> Vec<u8> {
    let mut payload = vec![0u8; 4];
    payload.extend_from_slice(b"pict");
    payload.extend_from_slice(&[0u8; 12]);
    payload.push(0);
    full_box(b"hdlr", 0, 0, &payload)
}

fn pitm_box() -> Vec<u8> {
    full_box(b"pitm", 0, 0, &1u16.to_be_bytes())
}

fn iinf_box() -> Vec<u8> {
    let primary = infe_box(1, false);
    let auxiliary = infe_box(2, true);
    let mut payload = Vec::new();
    payload.extend_from_slice(&2u16.to_be_bytes());
    payload.extend(primary);
    payload.extend(auxiliary);
    full_box(b"iinf", 0, 0, &payload)
}

fn infe_box(id: u16, hidden: bool) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&id.to_be_bytes());
    payload.extend_from_slice(&0u16.to_be_bytes());
    payload.extend_from_slice(b"hvc1");
    payload.push(0);
    full_box(b"infe", 2, u32::from(hidden), &payload)
}

fn iref_box() -> Vec<u8> {
    let mut auxl = Vec::new();
    auxl.extend_from_slice(&2u16.to_be_bytes());
    auxl.extend_from_slice(&1u16.to_be_bytes());
    auxl.extend_from_slice(&1u16.to_be_bytes());
    full_box(b"iref", 0, 0, &iso_box(b"auxl", &auxl))
}

fn ispe_box(width: u32, height: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&width.to_be_bytes());
    payload.extend_from_slice(&height.to_be_bytes());
    full_box(b"ispe", 0, 0, &payload)
}

fn pixi_box(bits: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(1 + bits.len());
    payload.push(bits.len() as u8);
    payload.extend_from_slice(bits);
    full_box(b"pixi", 0, 0, &payload)
}

fn aux_box() -> Vec<u8> {
    full_box(
        b"auxC",
        0,
        0,
        b"urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0",
    )
}

fn iprp_box(
    width: u32,
    height: u32,
    icc: &[u8],
    color: &ImageNals,
    alpha: &ImageNals,
) -> Result<Vec<u8>, String> {
    let ispe = ispe_box(width, height);
    let pixi_color = pixi_box(&[8, 8, 8]);
    let colr = iso_box(b"colr", &[b"prof".as_slice(), icc].concat());
    let hvcc_color = hvcc_box(
        &color.profile,
        color.chroma,
        &[&color.vps, &color.sps, &color.pps],
    )?;
    let pixi_alpha = pixi_box(&[8]);
    let hvcc_alpha = hvcc_box(
        &alpha.profile,
        alpha.chroma,
        &[&alpha.vps, &alpha.sps, &alpha.pps],
    )?;
    let aux = aux_box();
    let ipco = container(
        b"ipco",
        &[
            ispe, pixi_color, colr, hvcc_color, pixi_alpha, hvcc_alpha, aux,
        ],
    );
    let ipma = ipma_box(&[(1, &[1, 2, 3, 4]), (2, &[1, 5, 6, 7])]);
    Ok(container(b"iprp", &[ipco, ipma]))
}

fn iloc_box(items: &[(u16, u32, u32)]) -> Vec<u8> {
    // Version 1: 4-byte offsets and lengths, no base offset, no extent index,
    // construction_method 0 (the offset is a file offset).
    let mut payload = vec![0x44, 0x00];
    payload.extend_from_slice(&(items.len() as u16).to_be_bytes());
    for &(id, offset, length) in items {
        payload.extend_from_slice(&id.to_be_bytes());
        payload.extend_from_slice(&0u16.to_be_bytes());
        payload.extend_from_slice(&0u16.to_be_bytes());
        payload.extend_from_slice(&1u16.to_be_bytes());
        payload.extend_from_slice(&offset.to_be_bytes());
        payload.extend_from_slice(&length.to_be_bytes());
    }
    full_box(b"iloc", 1, 0, &payload)
}

fn ipma_box(entries: &[(u16, &[u16])]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for &(id, properties) in entries {
        payload.extend_from_slice(&id.to_be_bytes());
        payload.push(properties.len() as u8);
        for index in properties {
            payload.push(0x80 | (*index as u8));
        }
    }
    full_box(b"ipma", 0, 0, &payload)
}

fn hvcc_box(profile: &[u8; 12], chroma: u8, nals: &[&[u8]]) -> Result<Vec<u8>, String> {
    if nals.len() != 3 || chroma > 3 {
        return Err("HEIC decoder configuration is incomplete".into());
    }
    let mut payload = Vec::new();
    payload.push(1);
    payload.extend_from_slice(profile);
    payload.extend_from_slice(&0xF000u16.to_be_bytes());
    payload.push(0xFC);
    payload.push(0xFC | chroma);
    payload.push(0xF8);
    payload.push(0xF8);
    payload.extend_from_slice(&0u16.to_be_bytes());
    // constantFrameRate 0, one temporal layer, nested, 4-byte NAL lengths.
    payload.push(0x0f);
    payload.push(nals.len() as u8);
    for (index, nal) in nals.iter().enumerate() {
        if nal.len() > u16::MAX as usize {
            return Err("HEIC parameter set does not fit in hvcC".into());
        }
        let nal_type = match index {
            0 => 32,
            1 => 33,
            _ => 34,
        };
        payload.push(0x80 | nal_type);
        payload.extend_from_slice(&1u16.to_be_bytes());
        payload.extend_from_slice(&(nal.len() as u16).to_be_bytes());
        payload.extend_from_slice(nal);
    }
    Ok(iso_box(b"hvcC", &payload))
}

fn iso_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let size = 8 + payload.len();
    assert!(size <= u32::MAX as usize, "ISO box exceeds 4 GiB");
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(&(size as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

fn full_box(kind: &[u8; 4], version: u8, flags: u32, payload: &[u8]) -> Vec<u8> {
    assert!(flags <= 0x00ff_ffff);
    let mut body = Vec::with_capacity(4 + payload.len());
    body.push(version);
    body.push((flags >> 16) as u8);
    body.push((flags >> 8) as u8);
    body.push(flags as u8);
    body.extend_from_slice(payload);
    iso_box(kind, &body)
}

fn container(kind: &[u8; 4], children: &[Vec<u8>]) -> Vec<u8> {
    let mut payload = Vec::new();
    for child in children {
        payload.extend_from_slice(child);
    }
    iso_box(kind, &payload)
}

fn nal(kind: u8, rbsp: &[u8]) -> Vec<u8> {
    let header = (u16::from(kind) << 9) | 1;
    let mut out = Vec::with_capacity(2 + rbsp.len() + rbsp.len() / 32);
    out.extend_from_slice(&header.to_be_bytes());
    out.extend(ebsp(rbsp));
    out
}

fn ebsp(rbsp: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rbsp.len() + rbsp.len() / 64);
    let mut zeros = 0u8;
    for &byte in rbsp {
        if zeros == 2 && byte <= 3 {
            out.push(3);
            zeros = 0;
        }
        out.push(byte);
        zeros = if byte == 0 { zeros + 1 } else { 0 };
    }
    out
}

/// 96 bits: profile_space/tier/idc, 32 compatibility flags, 48 constraint
/// bits, then level 6.2. Monochrome sets the 4:2:2/4:2:0/mono constraint
/// flags so a 4:0:0 alpha picture stays inside Main 4:4:4.
fn profile_tier_level(monochrome: bool) -> [u8; 12] {
    let mut bits = BitWriter::with_capacity(12);
    bits.write(0, 2);
    bits.write(0, 1);
    bits.write(4, 5);
    for index in 0..32 {
        bits.write(u32::from(index == 4), 1);
    }
    bits.write(1, 1);
    bits.write(0, 1);
    bits.write(1, 1);
    bits.write(1, 1);
    bits.write(1, 1);
    bits.write(1, 1);
    bits.write(1, 1);
    if monochrome {
        bits.write(1, 1);
        bits.write(1, 1);
        bits.write(1, 1);
    } else {
        bits.write(0, 1);
        bits.write(0, 1);
        bits.write(0, 1);
    }
    bits.write(1, 1);
    bits.write(1, 1);
    bits.write(1, 1);
    bits.write(0, 16);
    bits.write(0, 16);
    bits.write(0, 2);
    bits.write(0, 1);
    bits.write(186, 8);
    let bytes = bits.into_bytes();
    let mut profile = [0u8; 12];
    profile.copy_from_slice(&bytes);
    profile
}

fn vps_rbsp(profile: &[u8; 12]) -> Result<Vec<u8>, String> {
    let mut bits = BitWriter::with_capacity(64);
    bits.write(0, 4);
    bits.write_flag(true);
    bits.write_flag(true);
    bits.write(0, 6);
    bits.write(0, 3);
    bits.write_flag(true);
    bits.write(0xffff, 16);
    bits.write_bytes(profile);
    bits.write_flag(true);
    bits.write_ue(0);
    bits.write_ue(0);
    bits.write_ue(0);
    bits.write(0, 6);
    bits.write_ue(0);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.byte_alignment();
    Ok(bits.into_bytes())
}

fn sps_rbsp(
    profile: &[u8; 12],
    chroma: u32,
    padded_w: u32,
    padded_h: u32,
    width: u32,
    height: u32,
    alpha: bool,
    primaries: u8,
) -> Result<Vec<u8>, String> {
    let mut bits = BitWriter::with_capacity(128);
    bits.write(0, 4);
    bits.write(0, 3);
    bits.write_flag(true);
    bits.write_bytes(profile);
    bits.write_ue(0);
    bits.write_ue(chroma);
    if chroma == 3 {
        bits.write_flag(false);
    }
    bits.write_ue(padded_w);
    bits.write_ue(padded_h);
    let crop_right = padded_w - width;
    let crop_bottom = padded_h - height;
    bits.write_flag(crop_right != 0 || crop_bottom != 0);
    if crop_right != 0 || crop_bottom != 0 {
        bits.write_ue(0);
        bits.write_ue(crop_right);
        bits.write_ue(0);
        bits.write_ue(crop_bottom);
    }
    bits.write_ue(0);
    bits.write_ue(0);
    bits.write_ue(0);
    bits.write_flag(true);
    bits.write_ue(0);
    bits.write_ue(0);
    bits.write_ue(0);
    bits.write_ue(2);
    bits.write_ue(0);
    bits.write_ue(0);
    bits.write_ue(3);
    bits.write_ue(0);
    bits.write_ue(0);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(true);
    bits.write(7, 4);
    bits.write(7, 4);
    bits.write_ue(2);
    bits.write_ue(0);
    bits.write_flag(true);
    bits.write_ue(0);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(true);
    write_vui(&mut bits, alpha, primaries);
    bits.write_flag(false);
    bits.byte_alignment();
    Ok(bits.into_bytes())
}

fn write_vui(bits: &mut BitWriter, alpha: bool, primaries: u8) {
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(true);
    bits.write(5, 3);
    bits.write_flag(true);
    bits.write_flag(true);
    if alpha {
        bits.write(2, 8);
        bits.write(2, 8);
        bits.write(2, 8);
    } else {
        bits.write(u32::from(primaries), 8);
        bits.write(13, 8);
        bits.write(0, 8);
    }
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(true);
    bits.write_flag(true);
    bits.write_flag(false);
    bits.write_flag(true);
    bits.write_ue(0);
    bits.write_ue(0);
    bits.write_ue(0);
    bits.write_ue(0);
    bits.write_ue(0);
}

fn pps_rbsp() -> Result<Vec<u8>, String> {
    let mut bits = BitWriter::with_capacity(32);
    bits.write_ue(0);
    bits.write_ue(0);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write(0, 3);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_ue(0);
    bits.write_ue(0);
    bits.write_se(0);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_se(0);
    bits.write_se(0);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_flag(true);
    bits.write_flag(false);
    bits.write_flag(true);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.write_ue(0);
    bits.write_flag(false);
    bits.write_flag(false);
    bits.byte_alignment();
    Ok(bits.into_bytes())
}

fn slice_rbsp(
    rgba: &[u8],
    width: u32,
    height: u32,
    padded_w: u32,
    padded_h: u32,
    alpha: bool,
) -> Result<Vec<u8>, String> {
    let mut cabac = Cabac::with_capacity(
        (padded_w as usize) * (padded_h as usize) * if alpha { 1 } else { 3 } + 256,
    );
    cabac.bits.write_flag(true);
    cabac.bits.write_flag(true);
    cabac.bits.write_ue(0);
    cabac.bits.write_ue(2);
    cabac.bits.write_se(0);
    cabac.bits.byte_alignment();
    cabac.start();
    let mut part = Context::part_mode();
    let cols = padded_w / CODING_BLOCK;
    let rows = padded_h / CODING_BLOCK;
    for row in 0..rows {
        for col in 0..cols {
            let last = row + 1 == rows && col + 1 == cols;
            cabac.encode_bin(1, &mut part);
            cabac.encode_trm(true);
            cabac.pcm_align();
            write_ctu(
                &mut cabac.bits,
                rgba,
                width,
                height,
                col * CODING_BLOCK,
                row * CODING_BLOCK,
                alpha,
            );
            cabac.start();
            cabac.encode_trm(last);
        }
    }
    cabac.finish();
    cabac.bits.byte_alignment();
    Ok(cabac.bits.into_bytes())
}

fn write_ctu(
    bits: &mut BitWriter,
    rgba: &[u8],
    width: u32,
    height: u32,
    origin_x: u32,
    origin_y: u32,
    alpha: bool,
) {
    let channels: &[usize] = if alpha { &[3] } else { &[1, 2, 0] };
    for &channel in channels {
        let mut row = [0u8; CODING_BLOCK as usize];
        for y in 0..CODING_BLOCK {
            let sample_y = origin_y + y;
            for x in 0..CODING_BLOCK {
                let sample_x = origin_x + x;
                row[x as usize] = if sample_x < width && sample_y < height {
                    rgba[((sample_y * width + sample_x) * 4) as usize + channel]
                } else {
                    0
                };
            }
            bits.write_bytes(&row);
        }
    }
}

struct Context {
    state: u8,
    mps: u8,
}

impl Context {
    /// I-slice `part_mode` ctxIdx 0, initValue 184, SliceQpY 26.
    /// Equations 9-4..9-6 yield pStateIdx 0 and valMps 1.
    fn part_mode() -> Self {
        Self { state: 0, mps: 1 }
    }
}

struct Cabac {
    low: u32,
    range: u32,
    bits_left: i32,
    buffered: u32,
    buffered_count: i32,
    bits: BitWriter,
}

impl Cabac {
    fn with_capacity(bytes: usize) -> Self {
        Self {
            low: 0,
            range: 510,
            bits_left: 23,
            buffered: 0xff,
            buffered_count: 0,
            bits: BitWriter::with_capacity(bytes),
        }
    }

    fn start(&mut self) {
        self.low = 0;
        self.range = 510;
        self.bits_left = 23;
        self.buffered = 0xff;
        self.buffered_count = 0;
    }

    fn encode_bin(&mut self, bin: u32, ctx: &mut Context) {
        let q = ((self.range >> 6) & 3) as usize;
        let lps = u32::from(LPS[ctx.state as usize][q]);
        self.range -= lps;
        if bin == u32::from(ctx.mps) {
            ctx.state = MPS_NEXT[ctx.state as usize];
            if self.range < 256 {
                self.low = self.low.wrapping_shl(1);
                self.range <<= 1;
                self.bits_left -= 1;
                self.test_and_write_out();
            }
        } else {
            let shift = i32::from(RENORM[lps as usize >> 3]);
            self.low = self.low.wrapping_add(self.range).wrapping_shl(shift as u32);
            self.range = lps << shift;
            if ctx.state == 0 {
                ctx.mps = 1 - ctx.mps;
            }
            ctx.state = LPS_NEXT[ctx.state as usize];
            self.bits_left -= shift;
            self.test_and_write_out();
        }
    }

    fn encode_trm(&mut self, bin: bool) {
        self.range -= 2;
        if bin {
            self.low = self.low.wrapping_add(self.range).wrapping_shl(7);
            self.range = 2 << 7;
            self.bits_left -= 7;
        } else if self.range >= 256 {
            return;
        } else {
            self.low = self.low.wrapping_shl(1);
            self.range <<= 1;
            self.bits_left -= 1;
        }
        self.test_and_write_out();
    }

    fn pcm_align(&mut self) {
        self.finish();
        self.bits.write(1, 1);
        self.bits.align_zero();
    }

    fn finish(&mut self) {
        let shift = 32 - self.bits_left;
        if self.low >> shift != 0 {
            self.bits.write(self.buffered + 1, 8);
            while self.buffered_count > 1 {
                self.bits.write(0x00, 8);
                self.buffered_count -= 1;
            }
            self.low = self.low.wrapping_sub(1u32.wrapping_shl(shift as u32));
        } else {
            if self.buffered_count > 0 {
                self.bits.write(self.buffered, 8);
            }
            while self.buffered_count > 1 {
                self.bits.write(0xff, 8);
                self.buffered_count -= 1;
            }
        }
        let n = (24 - self.bits_left) as u32;
        self.bits.write(self.low >> 8, n);
    }

    fn test_and_write_out(&mut self) {
        if self.bits_left < 12 {
            self.write_out();
        }
    }

    fn write_out(&mut self) {
        let lead = self.low >> (24 - self.bits_left);
        self.bits_left += 8;
        self.low &= u32::MAX >> self.bits_left;
        if lead == 0xff {
            self.buffered_count += 1;
        } else if self.buffered_count > 0 {
            let carry = lead >> 8;
            let byte = self.buffered + carry;
            self.buffered = lead & 0xff;
            self.bits.write(byte, 8);
            let fill = (0xff + carry) & 0xff;
            while self.buffered_count > 1 {
                self.bits.write(fill, 8);
                self.buffered_count -= 1;
            }
        } else {
            self.buffered_count = 1;
            self.buffered = lead;
        }
    }
}

struct BitWriter {
    bytes: Vec<u8>,
    held: u8,
    held_count: u32,
}

impl BitWriter {
    fn with_capacity(bytes: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(bytes),
            held: 0,
            held_count: 0,
        }
    }

    fn write(&mut self, bits: u32, n: u32) {
        assert!(n > 0 && n <= 32, "bit count {n}");
        if n < 32 {
            assert!(
                bits & (!0u32 << n) == 0,
                "value {bits:#x} does not fit in {n} bits"
            );
        }
        let num_total = n + self.held_count;
        let next_held_count = num_total % 8;
        let next_held = if next_held_count == 0 {
            0
        } else {
            ((bits << (8 - next_held_count)) & 0xff) as u8
        };
        if num_total < 8 {
            self.held |= next_held;
            self.held_count = next_held_count;
            return;
        }
        let topword = (n - next_held_count) & !7;
        let held_part = if topword >= 32 {
            0
        } else {
            u32::from(self.held) << topword
        };
        let bits_part = if next_held_count == 0 {
            bits
        } else {
            bits >> next_held_count
        };
        let write_bits = held_part | bits_part;
        let nbytes = num_total >> 3;
        if nbytes >= 4 {
            self.bytes.push((write_bits >> 24) as u8);
        }
        if nbytes >= 3 {
            self.bytes.push((write_bits >> 16) as u8);
        }
        if nbytes >= 2 {
            self.bytes.push((write_bits >> 8) as u8);
        }
        if nbytes >= 1 {
            self.bytes.push(write_bits as u8);
        }
        self.held = next_held;
        self.held_count = next_held_count;
    }

    fn write_flag(&mut self, value: bool) {
        self.write(u32::from(value), 1);
    }

    fn write_ue(&mut self, value: u32) {
        let code = u64::from(value) + 1;
        let zeros = 63 - code.leading_zeros();
        if zeros > 0 {
            self.write(0, zeros);
        }
        let width = zeros + 1;
        assert!(width <= 32, "exp-golomb {value} is wider than 32 bits");
        self.write(code as u32, width);
    }

    fn write_se(&mut self, value: i32) {
        let mapped = if value > 0 {
            (value as u32) * 2 - 1
        } else if value < 0 {
            value.unsigned_abs() * 2
        } else {
            0
        };
        self.write_ue(mapped);
    }

    fn write_bytes(&mut self, data: &[u8]) {
        assert_eq!(self.held_count, 0, "byte write requires alignment");
        self.bytes.extend_from_slice(data);
    }

    fn align_zero(&mut self) {
        if self.held_count == 0 {
            return;
        }
        self.bytes.push(self.held);
        self.held = 0;
        self.held_count = 0;
    }

    fn byte_alignment(&mut self) {
        self.write(1, 1);
        self.align_zero();
    }

    fn into_bytes(self) -> Vec<u8> {
        assert_eq!(self.held_count, 0, "bitstream is not byte aligned");
        self.bytes
    }
}

const LPS: [[u8; 4]; 64] = [
    [128, 176, 208, 240],
    [128, 167, 197, 227],
    [128, 158, 187, 216],
    [123, 150, 178, 205],
    [116, 142, 169, 195],
    [111, 135, 160, 185],
    [105, 128, 152, 175],
    [100, 122, 144, 166],
    [95, 116, 137, 158],
    [90, 110, 130, 150],
    [85, 104, 123, 142],
    [81, 99, 117, 135],
    [77, 94, 111, 128],
    [73, 89, 105, 122],
    [69, 85, 100, 116],
    [66, 80, 95, 110],
    [62, 76, 90, 104],
    [59, 72, 86, 99],
    [56, 69, 81, 94],
    [53, 65, 77, 89],
    [51, 62, 73, 85],
    [48, 59, 69, 80],
    [46, 56, 66, 76],
    [43, 53, 63, 72],
    [41, 50, 59, 69],
    [39, 48, 56, 65],
    [37, 45, 54, 62],
    [35, 43, 51, 59],
    [33, 41, 48, 56],
    [32, 39, 46, 53],
    [30, 37, 43, 50],
    [29, 35, 41, 48],
    [27, 33, 39, 45],
    [26, 31, 37, 43],
    [24, 30, 35, 41],
    [23, 28, 33, 39],
    [22, 27, 32, 37],
    [21, 26, 30, 35],
    [20, 24, 29, 33],
    [19, 23, 27, 31],
    [18, 22, 26, 30],
    [17, 21, 25, 28],
    [16, 20, 23, 27],
    [15, 19, 22, 25],
    [14, 18, 21, 24],
    [14, 17, 20, 23],
    [13, 16, 19, 22],
    [12, 15, 18, 21],
    [12, 14, 17, 20],
    [11, 14, 16, 19],
    [11, 13, 15, 18],
    [10, 12, 15, 17],
    [10, 12, 14, 16],
    [9, 11, 13, 15],
    [9, 11, 12, 14],
    [8, 10, 12, 14],
    [8, 9, 11, 13],
    [7, 9, 11, 12],
    [7, 9, 10, 12],
    [7, 8, 10, 11],
    [6, 8, 9, 11],
    [6, 7, 9, 10],
    [6, 7, 8, 9],
    [2, 2, 2, 2],
];

const RENORM: [u8; 32] = [
    6, 5, 4, 4, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
];

const MPS_NEXT: [u8; 64] = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
    51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 62, 63,
];

const LPS_NEXT: [u8; 64] = [
    0, 0, 1, 2, 2, 4, 4, 5, 6, 7, 8, 9, 9, 11, 11, 12, 13, 13, 15, 15, 16, 16, 18, 18, 19, 19, 21,
    21, 22, 22, 23, 24, 24, 25, 26, 26, 27, 27, 28, 29, 29, 30, 30, 30, 31, 32, 32, 33, 33, 33, 34,
    34, 35, 35, 35, 36, 36, 36, 37, 37, 37, 38, 38, 63,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_bytes_name_main_444_still_level_6_2() {
        let color = profile_tier_level(false);
        let alpha = profile_tier_level(true);
        assert_eq!(color[0], 0x04, "profile_idc 4");
        assert_eq!(color[1], 0x08, "compatible with profile 4 only");
        assert_eq!(color[11], 186);
        assert_eq!(alpha[0], 0x04);
        assert_ne!(color[5], alpha[5], "monochrome constraint bits differ");
        assert_eq!(color.len(), 12);
    }

    #[test]
    fn padded_thin_frame_is_rejected_without_allocating_the_pixels() {
        let profile = crate::export::srgb_icc_profile().unwrap();
        let error = encode(&[], 1, 16_777_216, &profile, 1).unwrap_err();
        assert!(error.contains("32×32"), "{error}");
    }

    #[test]
    fn heic_is_a_decodable_ftypheic_with_exact_straight_alpha() {
        let width = 120u32;
        let height = 90u32;
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        for (index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
            pixel[0] = (index % 251) as u8;
            pixel[1] = ((index / 3) % 251) as u8;
            pixel[2] = ((index / 7) % 251) as u8;
            pixel[3] = if index % 11 == 0 { 0 } else { 200 };
        }
        let png = crate::export::encode_rgba(width, height, &pixels).unwrap();
        let heic = crate::export_formats::transcode(&png, "heic", 1.).unwrap();
        let heif = crate::export_formats::transcode(&png, "heif", 1.).unwrap();
        assert_eq!(heic, heif, "heif is the same lossless HEIC encoder");
        assert_eq!(&heic[4..12], b"ftypheic");
        assert!(!heic.starts_with(b"\x89PNG"));
        assert_ne!(heic, png);
        let profile = crate::export::srgb_icc_profile().unwrap();
        assert!(
            heic.windows(profile.len())
                .any(|window| window == profile.as_slice()),
            "colour item carries the sRGB ICC profile"
        );
        assert!(heic.windows(4).any(|window| window == b"hvcC"));
        assert!(heic.windows(4).any(|window| window == b"auxl"));
        assert!(crate::export_formats::transcode(&heic, "heic", 1.).is_err());
        assert!(crate::export_formats::transcode(&png, "eps", 1.).is_err());
        super::assert_heic_rgba(&heic, width, height, &pixels);
        if let Ok(dir) = std::env::var("SKETCH_EXPORT_VERIFY_DIR") {
            let dir = std::path::PathBuf::from(dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("sample-120x90.heic"), &heic).unwrap();
            std::fs::write(
                dir.join("sample-120x90.tiff"),
                crate::export_formats::transcode(&png, "tiff", 1.).unwrap(),
            )
            .unwrap();
        }
    }

    #[test]
    fn heic_covers_an_exact_coding_block_and_a_padded_odd_frame() {
        for (width, height) in [(32u32, 32u32), (3, 5)] {
            let mut pixels = vec![0u8; (width * height * 4) as usize];
            for (index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
                pixel[0] = 255 - (index as u8);
                pixel[1] = (index * 3) as u8;
                pixel[2] = 40;
                pixel[3] = if index % 2 == 0 { 1 } else { 254 };
            }
            let png = crate::export::encode_rgba(width, height, &pixels).unwrap();
            let heic = crate::export_formats::transcode(&png, "heic", 1.).unwrap();
            super::assert_heic_rgba(&heic, width, height, &pixels);
        }
    }

    #[test]
    fn heic_keeps_display_p3_samples_quantizes_sixteen_bit_and_refuses_linear() {
        let source = [10u8, 20, 30, 128, 255, 0, 0, 255];
        let png =
            crate::export::encode_tagged_rgba(2, 1, &source, crate::color::ColorSpace::DisplayP3)
                .unwrap();
        let expected = super::png_rgba(&png);
        assert_ne!(expected, source);
        let heic = crate::export_formats::transcode(&png, "heic", 2.).unwrap();
        let profile = crate::export::display_p3_icc_profile().unwrap();
        assert!(
            heic.windows(profile.len())
                .any(|window| window == profile.as_slice())
        );
        assert!(
            !heic
                .windows(crate::export::srgb_icc_profile().unwrap().len())
                .any(|window| { window == crate::export::srgb_icc_profile().unwrap().as_slice() })
        );
        super::assert_heic_rgba(&heic, 2, 1, &expected);

        let wide = crate::export::encode_color_png(
            1,
            1,
            &[crate::blend::Pixel::rgba(0.5, 0.25, 0.125, 0.5)],
            crate::color::ColorSettings::default(),
            crate::color::ColorOutput::default(),
        )
        .unwrap();
        let raw = super::png_raw(&wide);
        let mut quantized = Vec::new();
        for pair in raw.chunks_exact(2) {
            let value = u16::from_be_bytes([pair[0], pair[1]]);
            quantized.push(((u32::from(value) * 255 + 32767) / 65535) as u8);
        }
        let heic = crate::export_formats::transcode(&wide, "heif", 1.).unwrap();
        super::assert_heic_rgba(&heic, 1, 1, &quantized);

        let linear = crate::export::encode_color_png(
            1,
            1,
            &[crate::blend::Pixel::rgba(0.5, 0.25, 0.125, 1.)],
            crate::color::ColorSettings::default(),
            crate::color::ColorOutput {
                space: crate::color::ColorSpace::LinearSrgb,
                tone_map: crate::color::ToneMap::Clip,
            },
        )
        .unwrap();
        let rejected = crate::export_formats::transcode(&linear, "heic", 1.).unwrap_err();
        assert!(
            rejected.contains("sRGB") || rejected.contains("Display P3"),
            "{rejected}"
        );
        assert!(!rejected.contains("ftyp"));
    }
}

#[cfg(test)]
fn png_rgba(png: &[u8]) -> Vec<u8> {
    let samples = png_raw(png);
    assert_eq!(samples.len() % 4, 0);
    samples
}

#[cfg(test)]
fn png_raw(png: &[u8]) -> Vec<u8> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(png));
    decoder.set_transformations(png::Transformations::IDENTITY);
    let mut reader = decoder.read_info().unwrap();
    let mut buffer = vec![0; reader.output_buffer_size().unwrap()];
    let frame = reader.next_frame(&mut buffer).unwrap();
    buffer.truncate(frame.buffer_size());
    buffer
}

/// Pixel oracle for tests. libde265 decodes the embedded HEVC items.
/// libheif decodes the container, including the auxiliary alpha image.
/// The shared ICC profile is hidden only for libheif's PNG writer: this
/// platform's libpng rejects that profile's PCS illuminant, which is a
/// writer check and does not change the HEIC samples.
#[cfg(test)]
pub(crate) fn assert_heic_rgba(heic: &[u8], width: u32, height: u32, rgba: &[u8]) {
    assert_eq!(&heic[4..12], b"ftypheic");
    assert_eq!(rgba.len(), (width as usize) * (height as usize) * 4);
    let (color, alpha) = annex_b_items(heic);
    if cfg!(target_os = "macos") {
        assert_imageio_rgba(heic, width, height, rgba);
        return;
    }
    let dir = std::env::temp_dir().join(format!(
        "fx-heic-{}-{:p}-{}x{}",
        std::process::id(),
        heic.as_ptr(),
        width,
        height
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let color_yuv = decode_libde265(&dir, "color", &color);
    let alpha_yuv = decode_libde265(&dir, "alpha", &alpha);
    let plane = (width as usize) * (height as usize);
    assert_eq!(color_yuv.len(), plane * 3, "libde265 colour plane size");
    assert_eq!(alpha_yuv.len(), plane, "libde265 alpha plane size");
    for index in 0..plane {
        let expected = &rgba[index * 4..index * 4 + 4];
        let g = color_yuv[index];
        let b = color_yuv[plane + index];
        let r = color_yuv[plane * 2 + index];
        assert_eq!(
            [r, g, b, alpha_yuv[index]],
            [expected[0], expected[1], expected[2], expected[3]],
            "libde265 pixel {index}"
        );
    }
    let mut container = heic.to_vec();
    hide_colour_box(&mut container);
    let png_path = dir.join("libheif.png");
    let input = dir.join("container.heic");
    std::fs::write(&input, &container).unwrap();
    let converted = std::process::Command::new("heif-convert")
        .args([input.to_str().unwrap(), png_path.to_str().unwrap()])
        .output()
        .expect("heif-convert");
    assert!(
        converted.status.success(),
        "heif-convert failed: {}\n{}",
        String::from_utf8_lossy(&converted.stderr),
        String::from_utf8_lossy(&converted.stdout)
    );
    let image = image::open(&png_path)
        .unwrap_or_else(|error| panic!("libheif PNG unreadable: {error}"))
        .to_rgba8();
    assert_eq!(image.dimensions(), (width, height));
    assert_eq!(image.as_raw(), rgba);
}

#[cfg(test)]
fn assert_imageio_rgba(heic: &[u8], width: u32, height: u32, expected: &[u8]) {
    let root = std::env::temp_dir().join(format!("futureox-heic-imageio-{}-{:?}-{width}x{height}",
        std::process::id(), std::thread::current().id()));
    std::fs::create_dir_all(&root).unwrap();
    let source = root.join("sample.heic");
    let target = root.join("sample.png");
    std::fs::write(&source, heic).unwrap();
    let output = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "png"]).arg(&source).arg("--out").arg(&target)
        .output().expect("ImageIO via sips");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let image = image::open(&target).unwrap().into_rgba8();
    assert_eq!(image.dimensions(), (width, height));
    for (index, (actual, expected)) in image.as_raw().chunks_exact(4).zip(expected.chunks_exact(4)).enumerate() {
        assert_eq!(actual[3], expected[3], "alpha at pixel {index}");
        if expected[3] != 0 {
            assert_eq!(&actual[..3], &expected[..3], "colour at pixel {index}");
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(test)]
fn decode_libde265(dir: &std::path::Path, name: &str, annex_b: &[u8]) -> Vec<u8> {
    let input = dir.join(format!("{name}.265"));
    let output = dir.join(format!("{name}.yuv"));
    std::fs::write(&input, annex_b).unwrap();
    let decoded = std::process::Command::new("libde265-dec265")
        .args([
            "-q",
            "-o",
            output.to_str().unwrap(),
            input.to_str().unwrap(),
        ])
        .output()
        .expect("libde265-dec265");
    assert!(
        decoded.status.success(),
        "libde265 failed on {name}: {}",
        String::from_utf8_lossy(&decoded.stderr)
    );
    std::fs::read(&output).unwrap()
}

#[cfg(test)]
fn annex_b_items(heic: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let top = iso_boxes(heic);
    let meta = payload_of(&top, b"meta");
    let meta_children = iso_boxes(&meta[4..]);
    let iprp = payload_of(&meta_children, b"iprp");
    let ipco = payload_of(&iso_boxes(iprp), b"ipco");
    let mut parameter_sets = Vec::new();
    for (kind, payload) in iso_boxes(ipco) {
        if kind == *b"hvcC" {
            parameter_sets.push(hvcc_nals(payload));
        }
    }
    assert_eq!(
        parameter_sets.len(),
        2,
        "colour and alpha decoder configurations"
    );
    let slices = length_prefixed_nals(payload_of(&top, b"mdat"));
    assert_eq!(slices.len(), 2);
    (
        annex_b(&parameter_sets[0], slices[0]),
        annex_b(&parameter_sets[1], slices[1]),
    )
}

#[cfg(test)]
fn annex_b(parameters: &[Vec<u8>], slice: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for nal in parameters
        .iter()
        .map(Vec::as_slice)
        .chain(std::iter::once(slice))
    {
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(nal);
    }
    out
}

#[cfg(test)]
fn hvcc_nals(payload: &[u8]) -> Vec<Vec<u8>> {
    assert!(payload.len() > 23 && payload[0] == 1, "hvcC configuration");
    assert_eq!(payload[21] & 0x03, 0x03, "4-byte NAL lengths");
    let arrays = payload[22] as usize;
    let mut at = 23;
    let mut nals = Vec::new();
    for _ in 0..arrays {
        at += 1;
        let count = u16::from_be_bytes(payload[at..at + 2].try_into().unwrap()) as usize;
        at += 2;
        for _ in 0..count {
            let len = u16::from_be_bytes(payload[at..at + 2].try_into().unwrap()) as usize;
            at += 2;
            nals.push(payload[at..at + len].to_vec());
            at += len;
        }
    }
    assert_eq!(at, payload.len(), "hvcC trailing bytes");
    nals
}

#[cfg(test)]
fn length_prefixed_nals(payload: &[u8]) -> Vec<&[u8]> {
    let mut at = 0;
    let mut nals = Vec::new();
    while at + 4 <= payload.len() {
        let len = u32::from_be_bytes(payload[at..at + 4].try_into().unwrap()) as usize;
        at += 4;
        assert!(at + len <= payload.len(), "truncated HEVC item");
        nals.push(&payload[at..at + len]);
        at += len;
    }
    assert_eq!(at, payload.len(), "mdat trailing bytes");
    nals
}

#[cfg(test)]
fn iso_boxes(data: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut at = 0;
    let mut boxes = Vec::new();
    while at + 8 <= data.len() {
        let size = u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize;
        assert!(size >= 8 && at + size <= data.len(), "truncated ISO box");
        let kind = data[at + 4..at + 8].try_into().unwrap();
        boxes.push((kind, &data[at + 8..at + size]));
        at += size;
    }
    assert_eq!(at, data.len(), "trailing bytes outside boxes");
    boxes
}

#[cfg(test)]
fn payload_of<'a>(boxes: &[([u8; 4], &'a [u8])], kind: &[u8; 4]) -> &'a [u8] {
    boxes
        .iter()
        .find(|(name, _)| name == kind)
        .unwrap_or_else(|| panic!("missing {} box", std::str::from_utf8(kind).unwrap()))
        .1
}

#[cfg(test)]
fn hide_colour_box(data: &mut [u8]) {
    fn visit(data: &mut [u8], start: usize, end: usize) {
        let mut at = start;
        while at + 8 <= end {
            let size = u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize;
            if size < 8 || at + size > end {
                break;
            }
            let kind = data[at + 4..at + 8].to_vec();
            if kind == b"colr" {
                data[at + 4..at + 8].copy_from_slice(b"free");
            } else if kind == b"meta" || kind == b"iprp" || kind == b"ipco" {
                let child = if kind == b"meta" { at + 12 } else { at + 8 };
                visit(data, child, at + size);
            }
            at += size;
        }
    }
    visit(data, 0, data.len());
}
