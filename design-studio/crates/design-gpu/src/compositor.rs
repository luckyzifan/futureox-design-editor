//! Ordered sample-plane compositor. Matches the browser coherent-sample graph.
//! Sample planes survive nested clips and opacity; filters explicitly resolve
//! them at effect boundaries rather than independently filtering geometry masks.
use crate::device::{Frame, Surface, parameters};
use futureox_design_kernel::{
    blend::Pixel,
    gpu::{GpuNode, GpuPaint, GpuPath, GpuScene},
    math::Rect,
    paint::Images,
    scene::Effect,
    texture_replay::{SourcePlan, TileOutcome, TilePlan as TextureTilePlan},
};
use std::collections::HashMap;

const BLENDS: [&str; 18] = [
    "normal",
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
    "color-dodge",
    "color-burn",
    "hard-light",
    "soft-light",
    "difference",
    "exclusion",
    "hue",
    "saturation",
    "color",
    "luminosity",
    "linear-burn",
    "linear-dodge",
];
fn blend(mode: &str) -> Result<f32, String> {
    BLENDS
        .iter()
        .position(|m| *m == mode)
        .map(|i| i as f32)
        .ok_or_else(|| format!("Unknown blend mode: {mode}"))
}
fn rgb(scene: &GpuScene, color: &str) -> Result<[f32; 3], String> {
    if let Some(p) = scene.colors.get(color) {
        return Ok([p[0], p[1], p[2]]);
    }
    let p = Pixel::hex(color, 1.)?;
    Ok([p.0[0], p.0[1], p.0[2]])
}
fn batchable(n: &GpuNode) -> bool {
    n.opacity == 1.
        && n.blend == "normal"
        && n.children.is_empty()
        && n.effects.is_empty()
        && n.strokes.is_empty()
        && n.fills.len() == 1
        && n.fills[0].visible
        && n.fills[0].kind == "solid"
        && n.fills[0].blend == "normal"
                && n.fills[0].stops.len() <= 32
        && n.fill.analytic.is_some()
}
pub(crate) fn render(
    frame: &mut Frame<'_>,
    scene: &GpuScene,
    decoder: &mut Images,
    mips: bool,
    atlas: bool,
) -> Result<(Surface, u32, u32), String> {
    if scene.nodes.values().any(|n| n.texture_replay.is_some())
        && (scene.float_compositing || !scene.coherent_samples)
    {
        return Err("Texture replay requires bounded SDR sample planes".into());
    }
    let mut c = Compositor {
        frame,
        scene,
        masks: HashMap::new(),
        images: HashMap::new(),
        image_dims: HashMap::new(),
        image_slots: HashMap::new(),
        mips,
        blur_kernels: HashMap::new(),
        motion_kernels: HashMap::new(),
        zoom_kernels: HashMap::new(),
        image_grids: HashMap::new(),
        gradient_grids: HashMap::new(),
        texture_math: None,
        texture_lookups: HashMap::new(),
    };
    decoder.set_color_settings(scene.color_management);
    // Collect the unique (asset, level) entries the scene samples, then
    // allocate residency once: float scenes may shelf-pack small levels into
    // zero-padded atlas pages (byte scenes keep standalone textures because
    // their inline-coordinate branches address textures directly).
    let mut wanted: Vec<(String, u32)> = Vec::new();
    for n in scene.nodes.values() {
        for p in n.fills.iter().chain(n.strokes.iter().map(|s| &s.paint)) {
            if p.kind != "image" {
                continue;
            }
            let uri = p.image.as_deref().ok_or("Missing image")?;
            let base = decoder.image(uri)?;
            let dims = [base.rect.w, base.rect.h];
            c.image_dims.insert(uri.to_owned(), dims);
            let level = c.paint_level(n, p, dims);
            let key = image_key(uri, level);
            if !wanted.iter().any(|(u, _l)| *u == key) {
                wanted.push((key, level));
            }
        }
    }
    for (key, level) in &wanted {
        let uri = key.split('#').next().unwrap_or(key);
        // Device-resident images skip both the decode and the CPU→GPU upload
        // on every subsequent compose (IOSurface-style asset residency).
        if let Some(resident) = c.frame.persistent_surface(key) {
            c.images.insert(key.clone(), resident);
            continue;
        }
        let source = decoder.image_at_selected_level(uri, *level)?;
        let small = source.rect.w <= ATLAS_MAX_IMAGE && source.rect.h <= ATLAS_MAX_IMAGE;
        if atlas && scene.float_compositing && small {
            continue;
        }
        if scene.float_compositing {
            let values: Vec<f32> = source.pixels.iter().flat_map(|p| p.0).collect();
            let out = c.frame.upload_persistent(
                key,
                source.rect,
                &crate::device::floats(&values),
                true,
            )?;
            c.images.insert(key.clone(), out);
        } else {
            let bytes: Vec<u8> = source
                .pixels
                .iter()
                .flat_map(|p| {
                    p.rgba8_quantized()
                        .0
                        .map(|c| (c * 255.).round_ties_even() as u8)
                })
                .collect();
            let out = c.frame.upload_persistent(key, source.rect, &bytes, false)?;
            c.images.insert(key.clone(), out);
        }
    }
    if atlas && scene.float_compositing {
        let packable: Vec<String> = wanted
            .iter()
            .filter(|(key, _)| {
                let uri = key.split('#').next().unwrap_or(key);
                let dims = decoder
                    .image(uri)
                    .map(|s| [s.rect.w, s.rect.h])
                    .unwrap_or([u32::MAX, u32::MAX]);
                let level = key
                    .rsplit('#')
                    .next()
                    .and_then(|l| l.parse::<u32>().ok())
                    .unwrap_or(0);
                let level_dims =
                    futureox_design_kernel::image_mipmap::level_dimensions(dims, level);
                level_dims[0] <= ATLAS_MAX_IMAGE && level_dims[1] <= ATLAS_MAX_IMAGE
            })
            .map(|(key, _)| key.clone())
            .collect();
        pack_atlas_pages(&mut c, decoder, &packable)?;
    }
    let color = rgb(scene, &scene.background)?;
    let mut planes = Vec::new();
    for _ in 0..if scene.coherent_samples { 4 } else { 1 } {
        let checker = rgb(scene, "#eeeeee")?;
        planes.push(c.frame.run(12., scene.extent, &[], |u| {
            if scene.checkerboard && !scene.transparent {
                u[52..56].copy_from_slice(&[checker[0], checker[1], checker[2], scene.checkerboard_size as f32]);
            }
            u[48..52].copy_from_slice(&[
                color[0],
                color[1],
                color[2],
                if scene.transparent {
                    0.
                } else {
                    scene.colors.get(&scene.background).map_or(1., |c| c[3])
                },
            ]);
            u[44..48].copy_from_slice(&[
                scene.view.x as f32,
                scene.view.y as f32,
                scene.view.zoom as f32,
                f32::from(scene.grid && !scene.transparent),
            ]);
        })?);
    }
    if scene.coherent_samples {
        planes = c.draw_list(&scene.roots, planes, None, 0)?;
    } else {
        planes[0] = c.draw_scalar(&scene.roots, planes[0], None, 0)?;
    }
    let (mut output, width, height) = if let Some(p) = &scene.resolve {
        let r = Rect::new(0, 0, p.width, p.height);
        (
            c.frame.run(
                if scene.coherent_samples { 24. } else { 21. },
                r,
                &planes,
                |u| {
                    u[36..39].copy_from_slice(&[
                        p.offset_x as f32,
                        p.offset_y as f32,
                        p.scale as f32,
                    ]);
                },
            )?,
            p.width,
            p.height,
        )
    } else {
        (
            c.frame.run(
                if scene.coherent_samples {
                    if scene.float_compositing { 23. } else { 36. }
                } else {
                    0.
                },
                scene.extent,
                &planes,
                |_| {},
            )?,
            scene.width,
            scene.height,
        )
    };
    c.frame.release(&planes);
    if scene.presentation.is_some() {
        let crop = Rect::new(0, 0, width, height);
        if output.rect != crop {
            let clipped = c.copy(output, crop)?;
            c.frame.release(&[output]);
            output = clipped;
        }
    }
    let (width, height) = if let Some(p) = &scene.presentation {
        (p.width, p.height)
    } else {
        (width, height)
    };
    // Command version 8 carries the cropped scene's absolute output rect;
    // presenting at the origin would sample the top-left of the camera frame
    // instead of the requested region. Version 7 scenes have no output rect
    // and keep the origin-sized presentation surface.
    let presented = scene.output.unwrap_or(Rect::new(0, 0, width, height));
    let source = output;
    output = c.frame.run(
        if scene.presentation.is_some() {
            if scene.float_compositing && scene.color_management.is_none() {
                33.
            } else {
                18.
            }
        } else {
            0.
        },
        presented,
        &[source],
        |u| {
            if let Some(p) = &scene.presentation {
                u[36..39].copy_from_slice(&[p.offset_x as f32, p.offset_y as f32, p.scale as f32]);
            }
        },
    )?;
    c.frame.release(&[source]);
    Ok((output, width, height))
}
#[derive(Hash, PartialEq, Eq)]
struct ImageGridKey {
    node: String,
    fit: String,
    transform: Option<[u64; 6]>,
    width: u32,
    height: u32,
    sample: usize,
    level: u32,
}
#[derive(Hash, PartialEq, Eq)]
struct GradientGridKey {
    node: String,
    kind: String,
    angle: u64,
    transform: Option<[u64; 6]>,
    offsets: Vec<u64>,
    sample: usize,
}
struct Compositor<'a, 'b, 'c> {
    frame: &'a mut Frame<'b>,
    scene: &'c GpuScene,
    masks: HashMap<String, Surface>,
    images: HashMap<String, Surface>,
    image_dims: HashMap<String, [u32; 2]>,
    image_slots: HashMap<String, [i32; 2]>,
    mips: bool,
    blur_kernels: HashMap<u64, Surface>,
    motion_kernels: HashMap<[u64;6],Surface>,
    zoom_kernels: HashMap<[u64;15],Surface>,
    image_grids: HashMap<ImageGridKey, (usize, Surface)>,
    gradient_grids: HashMap<GradientGridKey, Surface>,
    texture_math: Option<Surface>,
    texture_lookups: HashMap<String, Surface>,
}
/// Atlas pages carry a zero border per slot: an out-of-bounds neighbour fetch
/// reads zero either way, so packed output is byte-identical to standalone
/// textures. Float pages stay at 1024² (16 MiB of RGBA32F) to fit the frame
/// surface budget alongside the scene.
const ATLAS_SIDE: u32 = 1024;
const ATLAS_MAX_IMAGE: u32 = 512;
const ATLAS_PAD: u32 = 1;
/// Shelf-pack the given float entries into stitched pages. Pages upload once
/// and every slot records its page origin for placed grid compilation.
fn pack_atlas_pages(
    c: &mut Compositor<'_, '_, '_>,
    decoder: &mut Images,
    keys: &[String],
) -> Result<(), String> {
    let sources: Vec<(
        String,
        std::sync::Arc<futureox_design_kernel::blend::Surface>,
    )> = keys
        .iter()
        .map(|key| {
            let uri = key.split('#').next().unwrap_or(key);
            let level = key
                .rsplit('#')
                .next()
                .and_then(|l| l.parse::<u32>().ok())
                .unwrap_or(0);
            Ok((key.clone(), decoder.image_at_selected_level(uri, level)?))
        })
        .collect::<Result<_, String>>()?;
    struct Page {
        buffer: Vec<f32>,
        x: u32,
        y: u32,
        row_height: u32,
        slots: HashMap<String, [i32; 2]>,
    }
    let side = ATLAS_SIDE;
    let fits = |page: &Page, slot_w: u32, slot_h: u32| {
        (page.x + slot_w <= side && page.y + page.row_height.max(slot_h) <= side)
            || (page.y + page.row_height + slot_h <= side)
    };
    let mut pages: Vec<Page> = Vec::new();
    for (key, source) in &sources {
        let slot_w = source.rect.w + ATLAS_PAD * 2;
        let slot_h = source.rect.h + ATLAS_PAD * 2;
        let index = pages.iter().rposition(|p| fits(p, slot_w, slot_h));
        let page = match index {
            Some(i) => &mut pages[i],
            None => {
                pages.push(Page {
                    buffer: vec![0.; (side * side * 4) as usize],
                    x: 0,
                    y: 0,
                    row_height: 0,
                    slots: HashMap::new(),
                });
                pages.last_mut().expect("just pushed")
            }
        };
        if page.x + slot_w > side {
            page.y += page.row_height;
            page.x = 0;
            page.row_height = 0;
        }
        let origin = [(page.x + ATLAS_PAD) as i32, (page.y + ATLAS_PAD) as i32];
        for row in 0..source.rect.h {
            let dst = ((page.y + row + ATLAS_PAD) * side + page.x + ATLAS_PAD) as usize * 4;
            for column in 0..source.rect.w {
                let pixel = source.pixels[(row * source.rect.w + column) as usize].0;
                page.buffer[dst + (column as usize) * 4..dst + (column as usize) * 4 + 4]
                    .copy_from_slice(&pixel);
            }
        }
        page.x += slot_w;
        page.row_height = page.row_height.max(slot_h);
        page.slots.insert(key.clone(), origin);
    }
    for page in pages {
        let page_rect = Rect::new(0, 0, side, side);
        let surface = c.frame.upload_linear(page_rect, &page.buffer)?;
        for (key, origin) in page.slots {
            c.images.insert(key.clone(), surface);
            c.image_slots.insert(key, origin);
        }
    }
    Ok(())
}
/// Level-qualified texture key; level 0 keeps the plain URI so existing
/// lookups stay stable when mips are disabled.
fn image_key(uri: &str, level: u32) -> String {
    if level == 0 {
        uri.to_owned()
    } else {
        format!("{uri}#{level}")
    }
}
impl Compositor<'_, '_, '_> {
    fn paint_level(&self, n: &GpuNode, p: &GpuPaint, dims: [u32; 2]) -> u32 {
        if !self.mips {
            return if p.sketch_bitmap_sampling {
                futureox_design_kernel::paint::sketch_bitmap_mip_level(n.rect, n.matrix, n.size, dims, &p.paint)
                    .unwrap_or(0)
            } else {
                0
            };
        }
        let level = futureox_design_kernel::paint::image_mip_level(
            n.rect, n.matrix, n.size, dims, &p.paint,
        )
        .unwrap_or(0);
        level.min(futureox_design_kernel::image_mipmap::mip_levels(dims) - 1)
    }
    fn draw_scalar(
        &mut self,
        ids: &[String],
        mut target: Surface,
        clip: Option<Surface>,
        depth: usize,
    ) -> Result<Surface, String> {
        if depth > 64 {
            return Err("Native GPU scene nesting exceeds 64".into());
        }
        let scene = self.scene;
        for id in ids {
            let Some(n) = scene.nodes.get(id) else {
                continue;
            };
            if n.opacity <= 0. {
                continue;
            }
            if !scene.float_compositing
                && n.children.is_empty()
                && n.effects.is_empty()
                && n.blend == "normal"
                && n.opacity == 1.
                && n.strokes.is_empty()
                && n.fills.len() == 1
                && n.fills[0].blend == "normal"
                && n.fills[0].stops.len() <= 32
            {
                let p = &n.fills[0];
                let mask = self.mask(&n.fill, 4)?;
                let image = if p.kind == "image" {
                    *self
                        .images
                        .get(p.image.as_deref().unwrap_or(""))
                        .ok_or("Missing image")?
                } else {
                    mask
                };
                let mut inputs = vec![mask, image];
                inputs.extend(clip);
                let mut u = parameters(target.rect, &inputs);
                self.configure_paint(&mut u, n, p, 4)?;
                u[16..20].copy_from_slice(&[16., 0., n.opacity as f32, f32::from(clip.is_some())]);
                self.frame.draw(target, u, &inputs, true, None)?;
                continue;
            }
            let source = self.scalar_node(n, target, depth)?;
            let next = if n.passthrough {
                self.interpolate(source, target, n.opacity, clip)?
            } else {
                self.merge(source, target, &n.blend, n.opacity, clip)?
            };
            if next.id != target.id {
                self.frame.release(&[target]);
            }
            self.frame.release(&[source]);
            target = next;
        }
        Ok(target)
    }
    fn scalar_node(
        &mut self,
        n: &GpuNode,
        backdrop: Surface,
        depth: usize,
    ) -> Result<Surface, String> {
        if depth > 64 {
            return Err("Native GPU scene nesting exceeds 64".into());
        }
        let scene = self.scene;
        let mut layer = if n.passthrough {
            self.copy(backdrop, n.rect)?
        } else {
            self.frame.empty(n.rect)?
        };
        let fill = self.mask(&n.fill, 4)?;
        if let Some(fx) = futureox_design_kernel::scene::selected_backdrop(&n.effects) {
            let copy = self.copy(backdrop, n.rect)?;
            let raw = self.blur(copy, fx.backdrop_radius() * n.matrix.max_scale(), false)?;
            let mixed = self.gradient_blur(copy, raw, n, fx)?;
            if mixed.id != raw.id && raw.id != copy.id {
                self.frame.release(&[raw]);
            }
            let blurred = self.color_controls(mixed, fx.color_controls.as_ref())?;
            if mixed.id != blurred.id && mixed.id != copy.id {
                self.frame.release(&[mixed]);
            }
            let next = if fx.kind == "glass" {
                self.glass(blurred, fill, n, fx, false, None)?
            } else {
                self.compose(blurred, layer, "normal", 1., Some(fill))?
            };
            self.frame.release(&[copy, blurred, layer]);
            layer = next;
        }
        for p in &n.fills {
            if !p.visible {
                continue;
            }
            let painted = self.paint(n, p, fill, 4)?;
            layer = self.merge(painted, layer, &p.blend, 1., None)?;
            self.frame.release(&[painted]);
        }
        let clip = n.clip.then_some(fill);
        let mask_id = n.mask_id.as_ref();
        let mut mask_surface = None;
        if let Some(id) = mask_id {
            let empty = self.frame.empty(n.rect)?;
            let masked = if let Some(mask_node) = scene.nodes.get(id) {
                let raw = self.scalar_node(mask_node, empty, depth + 1)?;
                let masked = self.compose(raw, empty, "normal", mask_node.opacity, None)?;
                self.frame.release(&[raw, empty]);
                masked
            } else {
                empty
            };
            let masked = if scene
                .nodes
                .get(id)
                .is_some_and(|n| n.mask_type.as_deref() == Some("luminance"))
            {
                let next = self.frame.run(30., masked.rect, &[masked], |_| {})?;
                self.frame.release(&[masked]);
                next
            } else {
                masked
            };
            mask_surface = Some(masked);
        }
        let children: Vec<_> = n
            .children
            .iter()
            .filter(|id| Some(*id) != mask_id)
            .cloned()
            .collect();
        if mask_surface.is_some() {
            let copy = if n.passthrough {
                self.copy(layer, layer.rect)?
            } else {
                self.frame.empty(layer.rect)?
            };
            let content = self.draw_scalar(&children, copy, clip, depth + 1)?;
            let combined = if n.passthrough {
                self.interpolate(content, layer, 1., mask_surface)?
            } else {
                self.compose(content, layer, "normal", 1., mask_surface)?
            };
            self.frame.release(&[content]);
            if combined.id != layer.id {
                self.frame.release(&[layer]);
            }
            layer = combined;
        } else {
            layer = self.draw_scalar(&children, layer, clip, depth + 1)?;
        }
        if let Some(clip) = clip
            && clip.id != fill.id
            && mask_surface.is_none_or(|m| m.id != clip.id)
        {
            self.frame.release(&[clip]);
        }
        if let Some(mask) = mask_surface {
            self.frame.release(&[mask]);
        }
        for s in &n.strokes {
            let raw = self.mask(&s.path, 4)?;
            let mask = if s.align != "center" {
                self.combine(raw, fill, n.rect, s.align == "outside")?
            } else {
                raw
            };
            let painted = self.paint(n, &s.paint, mask, 4)?;
            layer = self.merge(painted, layer, &s.paint.blend, 1., None)?;
            self.frame.release(&[painted]);
            if mask.id != raw.id {
                self.frame.release(&[mask]);
            }
        }
        let sc = n.matrix.max_scale();
        for fx in &n.effects {
            if !fx.visible || (fx.kind == "texture" && fx.texture_amount() == 0.) {
                continue;
            }
            if fx.kind == "color-controls" {
                let next = self.color_controls(layer, fx.color_controls.as_ref())?;
                if next.id != layer.id { self.frame.release(&[layer]); }
                layer = next;
            } else if matches!(fx.kind.as_str(),"gaussian-blur"|"motion-blur"|"zoom-blur") {
                let next=self.spatial_blur(layer,n,fx)?;
                if next.id!=layer.id {self.frame.release(&[layer]);} layer=next;
            } else if fx.kind == "blur" {
                let full = self.blur(layer, fx.blur_radius() * sc, false)?;
                let next = self.gradient_blur(layer, full, n, fx)?;
                if next.id != full.id && full.id != layer.id {
                    self.frame.release(&[full]);
                }
                if next.id != layer.id {
                    self.frame.release(&[layer]);
                }
                layer = next;
            } else if fx.kind == "shadow" || fx.kind == "inner-shadow" {
                let inner = fx.kind == "inner-shadow";
                let alpha = if (fx.spread * sc).abs() >= 0.5 {
                    self.morphology(
                        layer,
                        (fx.spread * sc).abs().round(),
                        if inner {
                            fx.spread < 0.
                        } else {
                            fx.spread > 0.
                        },
                    )?
                } else {
                    layer
                };
                let blurred = self.blur(alpha, fx.radius * sc, false)?;
                let color = rgb(self.scene, &fx.color)?;
                let m = n.matrix.0;
                let shadow = self.frame.run(6., n.rect, &[layer, blurred], |u| {
                    u[28..32].copy_from_slice(&[0., color[0], color[1], color[2]]);
                    u[32] =
                        fx.opacity as f32 * self.scene.colors.get(&fx.color).map_or(1., |c| c[3]);
                    u[36..40].copy_from_slice(&[
                        1.,
                        (m[0] * fx.x + m[2] * fx.y) as f32,
                        (m[1] * fx.x + m[3] * fx.y) as f32,
                        f32::from(inner),
                    ]);
                })?;
                let next = if inner {
                    self.compose(shadow, layer, "normal", 1., None)?
                } else {
                    self.compose(layer, shadow, "normal", 1., None)?
                };
                self.frame.release(&[layer, alpha, blurred, shadow]);
                layer = next;
            } else if fx.kind == "noise" || fx.kind == "texture" {
                let mut inputs = vec![layer];
                if let Some(field) = self.texture_parameters(n, fx)? {
                    inputs.push(field);
                }
                let next = self.frame.run(
                    if fx.kind == "noise" { 7. } else { 8. },
                    n.rect,
                    &inputs,
                    |u| {
                        for i in 0..4 {
                            u[20 + i] = n.inverse.0[i] as f32;
                            u[180 + i] = n.matrix.0[i] as f32;
                        }
                        u[24..28].copy_from_slice(&[
                            n.inverse.0[4] as f32,
                            n.inverse.0[5] as f32,
                            n.size[0] as f32,
                            n.size[1] as f32,
                        ]);
                        u[42] = f32::from(fx.texture.is_some());
                        u[43] = f32::from(fx.texture.as_ref().is_some_and(|t| t.clip_to_shape));
                        u[40..42].copy_from_slice(&[
                            if fx.kind == "noise" {
                                fx.amount as f32
                            } else {
                                (fx.amount * fx.opacity * 2.) as f32
                            },
                            fx.opacity as f32,
                        ]);
                    },
                )?;
                self.frame.release(&[layer]);
                layer = next;
            }
        }
        Ok(layer)
    }
    fn gradient_blur(
        &mut self,
        sharp: Surface,
        blurred: Surface,
        n: &GpuNode,
        fx: &Effect,
    ) -> Result<Surface, String> {
        self.gradient_blur_at(sharp, blurred, n, fx, [0., 0.])
    }
    fn gradient_blur_at(
        &mut self,
        sharp: Surface,
        blurred: Surface,
        n: &GpuNode,
        fx: &Effect,
        origin: [f64; 2],
    ) -> Result<Surface, String> {
        let Some(params) = fx.gradient_blur else {
            return Ok(blurred);
        };
        let a = self.frame.read_surface(sharp)?;
        let b = self.frame.read_surface(blurred)?;
        let mut target = futureox_design_kernel::blend::Surface::new(sharp.rect)?;
        let mut full = futureox_design_kernel::blend::Surface::new(blurred.rect)?;
        for (p, v) in target.pixels.iter_mut().zip(a.chunks_exact(4)) {
            p.0.copy_from_slice(v);
        }
        for (p, v) in full.pixels.iter_mut().zip(b.chunks_exact(4)) {
            p.0.copy_from_slice(v);
        }
        // Cropped backdrop textures store texel 0 at the fractional box origin,
        // while the integer rect may truncate that origin. The CPU composite
        // adds the same offset before projecting into node space.
        futureox_design_kernel::effects::gradient_blur_composite_at(
            &mut target,
            &full,
            &n.matrix.inverse_composed(sharp.rect)?,
            &params,
            futureox_design_kernel::math::Point::new(origin[0], origin[1]),
        );
        if !self.scene.float_compositing {
            target.quantize_rgba8();
        }
        self.frame.upload_parameters(
            sharp.rect,
            &target
                .pixels
                .into_iter()
                .flat_map(|p| p.0)
                .collect::<Vec<_>>(),
        )
    }
    fn glass(
        &mut self,
        background: Surface,
        geometry: Surface,
        n: &GpuNode,
        fx: &Effect,
        unmasked: bool,
        sample: Option<usize>,
    ) -> Result<Surface, String> {
        let resolved_glass = fx.evaluated_glass();
        if let Some((shape, glass)) = n.glass_shape.zip(resolved_glass.as_ref()) {
            let values = futureox_design_kernel::optics::field_with_raster(
                n.rect,
                shape,
                n.matrix,
                glass,
                sample,
                self.scene.software_raster,
            )?;
            let field = self.frame.upload_parameters(n.rect, &values)?;
            if let Some((replay, sample)) = n.capture_replay.as_ref().zip(sample) {
                let output = self.frame.empty(n.rect)?;
                for (origin, region) in replay.tiles(n.rect) {
                    let plan = replay.tile(origin, sample)?;
                    let source = self.capture_background(&plan)?;
                    let mut u = parameters(n.rect, &[source, field, geometry]);
                    u[16] = 34.;
                    u[39] = f32::from(unmasked);
                    u[40] = glass.chromatic_aberration();
                    u[46] = 3.;
                    u[47] = 8.;
                    u[48..52].copy_from_slice(&[
                        1.,
                        origin[0] as f32,
                        origin[1] as f32,
                        plan.density,
                    ]);
                    self.frame.draw_region(
                        output,
                        u,
                        &[source, field, geometry],
                        false,
                        None,
                        Some(region),
                    )?;
                    self.frame.release(&[source]);
                }
                self.frame.release(&[field]);
                return Ok(output);
            }
            let offset = futureox_design_kernel::optics::sample_offset(sample)?;
            let next = self
                .frame
                .run(34., n.rect, &[background, field, geometry], |u| {
                    u[39] = f32::from(unmasked);
                    u[40] = glass.chromatic_aberration();
                    u[44..46].copy_from_slice(&offset);
                    u[46] = 3.;
                    u[47] = 8.;
                })?;
            self.frame.release(&[field]);
            return Ok(next);
        }
        let mut field = self.frame.run(9., n.rect, &[geometry], |_| {})?;
        let mut step = n.rect.w.max(n.rect.h).next_power_of_two() / 2;
        while step >= 1 {
            let next = self
                .frame
                .run(10., n.rect, &[field], |u| u[36] = step as f32)?;
            self.frame.release(&[field]);
            field = next;
            step /= 2;
        }
        let scale = n.matrix.max_scale();
        let next = self
            .frame
            .run(11., n.rect, &[background, field, geometry], |u| {
                u[36..40].copy_from_slice(&[
                    (fx.radius * scale * 2.).max(4.) as f32,
                    (fx.amount * scale) as f32,
                    fx.opacity as f32,
                    f32::from(unmasked),
                ]);
                if fx.glass.is_some() {
                    let values =
                        futureox_design_kernel::material::GlassMaterial::new(fx, scale).uniforms();
                    u[36..39].copy_from_slice(&values[..3]);
                    u[40..45].copy_from_slice(&values[4..9]);
                }
            })?;
        self.frame.release(&[field]);
        Ok(next)
    }
    fn capture_background(
        &mut self,
        plan: &futureox_design_kernel::glass_capture::TilePlan,
    ) -> Result<Surface, String> {
        let rect = Rect::new(0, 0, plan.side, plan.side);
        let filter = plan.filter_plan()?;
        let source = self.frame.empty(rect)?;
        for primitive in &plan.primitives {
            let mut u = parameters(rect, &[]);
            u[16] = 12.;
            u[48..52].copy_from_slice(&primitive.color);
            self.frame
                .draw_region(source, u, &[], false, None, Some(primitive.rect))?;
        }
        let mut filtered = self.frame.empty(rect)?;
        if !filter.down_rect.empty() {
            let mut u = parameters(rect, &[source]);
            u[16] = 40.;
            u[36..38].copy_from_slice(&filter.origin);
            u[38..40].copy_from_slice(&filter.gradient);
            u[40..42].copy_from_slice(&filter.source_origin);
            self.frame
                .draw_region(filtered, u, &[source], false, None, Some(filter.down_rect))?;
        }
        self.frame.release(&[source]);
        for axis in 0..2 {
            let next = self.frame.empty(rect)?;
            if !filter.blur_rect.empty() {
                let mut u = parameters(rect, &[filtered]);
                u[16] = 41.;
                u[36..39].copy_from_slice(&[plan.kernel_count, axis as f32, 64.]);
                self.frame.draw_region(
                    next,
                    u,
                    &[filtered],
                    false,
                    None,
                    Some(filter.blur_rect),
                )?;
            }
            self.frame.release(&[filtered]);
            filtered = next;
        }
        Ok(filtered)
    }
    fn texture_clip_atlas(&mut self) -> Result<Surface, String> {
        if let Some(texture) = self.texture_math {
            return Ok(texture);
        }
        use futureox_design_kernel::texture_noise::clip_weight;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(1024 * 1024 * 4)
            .map_err(|_| "Could not allocate texture clip math atlas")?;
        bytes.resize(1024 * 1024 * 4, 0);
        bytes[..clip_weight::BASELINE_BYTES].copy_from_slice(clip_weight::baseline_root_bytes());
        bytes[clip_weight::BASELINE_BYTES..clip_weight::TOTAL_BYTES]
            .copy_from_slice(clip_weight::residual_bytes());
        let texture = self.frame.upload(Rect::new(0, 0, 1024, 1024), &bytes)?;
        self.texture_math = Some(texture);
        Ok(texture)
    }
    fn texture_source(
        &mut self,
        plan: &SourcePlan,
        template: &futureox_design_kernel::blend::Surface,
    ) -> Result<Surface, String> {
        let rect = Rect::new(0, 0, plan.side, plan.side);
        let source = self.frame.empty(rect)?;
        if plan.paint.kind == "solid" {
            let color = Pixel::hex(&plan.paint.color, 1.)?.0;
            let mut u = parameters(rect, &[]);
            u[16] = 12.;
            u[48..52].copy_from_slice(&color);
            self.frame
                .draw_region(source, u, &[], false, None, Some(plan.coverage))?;
            return Ok(source);
        }
        if plan.paint.kind != "linear" {
            return Err("Unsupported texture replay source paint".into());
        }
        let key = serde_json::to_string(&plan.paint).map_err(|e| e.to_string())?;
        let lookup = if let Some(lookup) = self.texture_lookups.get(&key) {
            *lookup
        } else {
            let gradient = futureox_design_kernel::figma_gradient::from_paint(&plan.paint)?;
            let lookup = self
                .frame
                .upload(Rect::new(0, 0, 1024, 2), gradient.lookup_bytes())?;
            self.texture_lookups.insert(key, lookup);
            lookup
        };
        let field = {
            let grid = plan.sampling_grid(template)?;
            self.frame
                .upload_replay_parameters(grid.rect, &grid.values)?
        };
        let mut u = parameters(rect, &[lookup, field]);
        u[16] = 45.;
        u[32] = plan.paint.opacity as f32;
        self.frame.draw_region(
            source,
            u,
            &[lookup, field],
            false,
            None,
            Some(plan.coverage),
        )?;
        Ok(source)
    }
    fn texture_tile(
        &mut self,
        plan: &TextureTilePlan,
        target: Surface,
        clip: Option<Surface>,
        template: &futureox_design_kernel::blend::Surface,
    ) -> Result<(), String> {
        let expanded = self.texture_source(&plan.expanded, template)?;
        let original = plan
            .original
            .as_ref()
            .map(|source| self.texture_source(source, template))
            .transpose()?;
        let field = {
            let grid = plan.effect_sampling_grid(template)?;
            self.frame
                .upload_replay_parameters(grid.rect, &grid.values)?
        };
        let math = self.texture_clip_atlas()?;
        let side = plan.capture.capture_pixels;
        let effect = self.frame.empty(Rect::new(0, 0, side, side))?;
        let inputs = [expanded, original.unwrap_or(expanded), field, math];
        let mut u = parameters(effect.rect, &inputs);
        u[16] = 43.;
        u[36..40].copy_from_slice(&[
            plan.capture.scale,
            f32::from(plan.capture.clipped),
            f32::from(original.is_some()),
            side as f32,
        ]);
        u[40..46].copy_from_slice(&plan.capture.node_to_tile);
        self.frame
            .draw_region(effect, u, &inputs, false, None, Some(field.rect))?;
        self.frame.release(&[expanded]);
        if let Some(original) = original {
            self.frame.release(&[original]);
        }
        let coordinates = {
            let grid = plan.copyback_sampling_grid(template)?;
            self.frame
                .upload_replay_parameters(grid.rect, &grid.values)?
        };
        let mut inputs = vec![effect, coordinates];
        inputs.extend(clip);
        let mut u = parameters(target.rect, &inputs);
        u[16] = 44.;
        u[19] = f32::from(clip.is_some());
        let region = clip.map_or(plan.copyback_region, |clip| {
            plan.copyback_region.intersect(clip.rect)
        });
        // No leaf mask or intermediate byte layer: the source owns its shape
        // coverage, and the parent performs the only copyback UNORM8 store.
        if !region.empty() {
            self.frame
                .draw_region(target, u, &inputs, true, None, Some(region))?;
        }
        self.frame.release(&[effect]);
        Ok(())
    }
    fn replay_texture(
        &mut self,
        node: &GpuNode,
        targets: &mut [Surface],
        clip: Option<&[Surface]>,
    ) -> Result<bool, String> {
        let Some(replay) = &node.texture_replay else {
            return Ok(false);
        };
        if self.scene.float_compositing || targets.len() != 4 {
            return Err("Texture replay requires four SDR sample planes".into());
        }
        let mut captured = false;
        let mut passthrough = false;
        let mut unsupported = false;
        // Inspect outcomes before painting. Retain only origins, not a clone
        // of every authored paint and plan for a potentially large viewport.
        let mut origins = Vec::with_capacity(4);
        for (sample, target) in targets.iter().enumerate() {
            let tiles = replay.tiles(target.rect)?;
            for (origin, _) in &tiles {
                match replay.tile(*origin, sample, target.rect)? {
                    TileOutcome::Capture(_) => captured = true,
                    TileOutcome::Passthrough => passthrough = true,
                    TileOutcome::Empty => {}
                    TileOutcome::Unsupported => unsupported = true,
                }
            }
            origins.push(tiles);
        }
        if unsupported {
            return Ok(false);
        }
        if captured && passthrough {
            return Err("Mixed texture capture and passthrough tiles".into());
        }
        if passthrough {
            for sample in 0..4 {
                let mask = self.mask(&node.fill, sample)?;
                let combined = clip
                    .map(|clip| self.combine(mask, clip[sample], node.rect, false))
                    .transpose()?;
                for paint in &node.fills {
                    if paint.visible {
                        targets[sample] = self.paint_over(
                            node,
                            paint,
                            combined.unwrap_or(mask),
                            targets[sample],
                            sample,
                        )?;
                    }
                }
                if let Some(combined) = combined {
                    self.frame.release(&[combined]);
                }
            }
            return Ok(true);
        }
        let template = futureox_design_kernel::texture_replay::parameter_template()?;
        for (sample, tiles) in origins.into_iter().enumerate() {
            for (origin, _) in tiles {
                match replay.tile(origin, sample, targets[sample].rect)? {
                    TileOutcome::Capture(plan) => self.texture_tile(
                        &plan,
                        targets[sample],
                        clip.map(|clip| clip[sample]),
                        &template,
                    )?,
                    TileOutcome::Empty => {}
                    _ => return Err("Texture replay plan changed before drawing".into()),
                }
            }
        }
        Ok(true)
    }
    fn copy(&mut self, s: Surface, r: Rect) -> Result<Surface, String> {
        self.frame.run(0., r, &[s], |_| {})
    }
    fn mask(&mut self, p: &GpuPath, sample: usize) -> Result<Surface, String> {
        if let Some(area) = &p.area {
            let key = format!("area:{sample}:{}:{}:{:?}", area.first, area.count, p.rect);
            if let Some(s) = self.masks.get(&key) {
                return Ok(*s);
            }
            let out = if p.count == 0 {
                self.frame.empty(p.rect)?
            } else {
                self.frame.run(31., p.rect, &[], |u| {
                    u[36] = area.first as f32;
                    u[38] = if sample < 4 { sample as f32 + 1. } else { 0. };
                })?
            };
            self.masks.insert(key, out);
            return Ok(out);
        }
        let a = p
            .analytic
            .as_ref()
            .ok_or("Native coverage requires analytic path commands")?;
        let key = format!(
            "{}:{}:{}:{}:{}:{}:{}:{}",
            sample, a.first, a.count, p.rule, p.rect.x, p.rect.y, p.rect.w, p.rect.h
        );
        if let Some(s) = self.masks.get(&key) {
            return Ok(*s);
        }
        let s = if p.count == 0 {
            self.frame.empty(p.rect)?
        } else {
            self.frame.run(20., p.rect, &[], |u| {
                u[36..40].copy_from_slice(&[
                    a.first as f32,
                    a.count as f32,
                    f32::from(p.rule == "evenodd"),
                    if sample < 4 { sample as f32 + 1. } else { 0. },
                ]);
                if let Some(b) = a.bands {
                    u[40..42].copy_from_slice(&[b as f32, p.rect.h.div_ceil(16) as f32]);
                }
            })?
        };
        self.masks.insert(key, s);
        Ok(s)
    }
    fn combine(
        &mut self,
        a: Surface,
        b: Surface,
        r: Rect,
        outside: bool,
    ) -> Result<Surface, String> {
        self.frame
            .run(1., r, &[a, b], |u| u[36] = f32::from(outside))
    }
    fn compose(
        &mut self,
        src: Surface,
        dst: Surface,
        mode: &str,
        opacity: f64,
        mask: Option<Surface>,
    ) -> Result<Surface, String> {
        let b = blend(mode)?;
        let mut inputs = vec![src, dst];
        inputs.extend(mask);
        self.frame.run(3., dst.rect, &inputs, |u| {
            u[17] = b;
            u[18] = opacity as f32;
            u[19] = f32::from(mask.is_some());
        })
    }
    fn merge(
        &mut self,
        src: Surface,
        dst: Surface,
        mode: &str,
        opacity: f64,
        mask: Option<Surface>,
    ) -> Result<Surface, String> {
        if self.scene.integrated_blur
            && mode == "normal"
            && (!self.scene.float_compositing || opacity < 1.)
        {
            return self.replace_region(29., src, dst, opacity, mask);
        }
        if mode != "normal" || self.scene.float_compositing {
            let out = self.compose(src, dst, mode, opacity, mask)?;
            self.frame.release(&[dst]);
            return Ok(out);
        }
        let mut inputs = vec![src, src];
        inputs.extend(mask);
        let mut u = parameters(dst.rect, &inputs);
        u[16..20].copy_from_slice(&[15., 0., opacity as f32, f32::from(mask.is_some())]);
        self.frame.draw(dst, u, &inputs, true, None)?;
        Ok(dst)
    }
    fn paint_over(
        &mut self,
        n: &GpuNode,
        paint: &GpuPaint,
        mask: Surface,
        dst: Surface,
        sample: usize,
    ) -> Result<Surface, String> {
        if !self.scene.float_compositing
            && paint.blend == "normal"
            && let Some(color) = paint.constant_color()
        {
            let rgb = rgb(self.scene, color)?;
            let alpha = self.scene.colors.get(color).map_or(1., |c| c[3]);
            let source = Pixel::rgba(rgb[0], rgb[1], rgb[2], alpha).opacity(paint.opacity as f32);
            let out = self.frame.run(35., dst.rect, &[dst, mask], |u| {
                u[28..32].copy_from_slice(&source.0)
            })?;
            self.frame.release(&[dst]);
            return Ok(out);
        }
        if paint.figma_gradient && sample < 4 && !self.scene.float_compositing {
            let gradient = futureox_design_kernel::figma_gradient::from_paint(paint)?;
            let lookup = self
                .frame
                .upload(Rect::new(0, 0, 1024, 2), gradient.lookup_bytes())?;
            let values = futureox_design_kernel::figma_gradient::field_with_raster(
                n.rect,
                n.matrix,
                n.size,
                paint,
                sample,
                self.scene.software_raster,
            )?;
            let field = self.frame.upload_parameters(n.rect, &values)?;
            let out = self
                .frame
                .run(42., dst.rect, &[dst, mask, lookup, field], |u| {
                    u[32] = paint.opacity as f32;
                    u[52..56].copy_from_slice(&[
                        n.rect.x as f32,
                        n.rect.y as f32,
                        n.rect.w as f32,
                        n.rect.h as f32,
                    ]);
                })?;
            self.frame.release(&[dst, lookup, field]);
            return Ok(out);
        }
        let source = self.paint(n, paint, mask, sample)?;
        let out = self.merge(source, dst, &paint.blend, 1., None)?;
        self.frame.release(&[source]);
        Ok(out)
    }
    fn interpolate(
        &mut self,
        src: Surface,
        dst: Surface,
        opacity: f64,
        mask: Option<Surface>,
    ) -> Result<Surface, String> {
        self.replace_region(28., src, dst, opacity, mask)
    }
    // Snapshot only the affected backdrop region. This avoids a full-viewport
    // read/replace for every tiny translucent or pass-through sibling.
    fn replace_region(
        &mut self,
        mode: f32,
        src: Surface,
        dst: Surface,
        opacity: f64,
        mask: Option<Surface>,
    ) -> Result<Surface, String> {
        let mut region = src.rect.intersect(dst.rect);
        if let Some(mask) = mask {
            region = region.intersect(mask.rect);
        }
        if region.empty() || opacity <= 0. {
            return Ok(dst);
        }
        let snapshot = self.copy(dst, region)?;
        let mut inputs = vec![src, snapshot];
        inputs.extend(mask);
        let mut u = parameters(dst.rect, &inputs);
        u[16..20].copy_from_slice(&[
            mode,
            if mode == 28. { 1. } else { 0. },
            opacity as f32,
            f32::from(mask.is_some()),
        ]);
        self.frame
            .draw_region(dst, u, &inputs, false, None, Some(region))?;
        self.frame.release(&[snapshot]);
        Ok(dst)
    }
    fn configure_paint(
        &self,
        u: &mut [f32; 256],
        n: &GpuNode,
        p: &GpuPaint,
        sample: usize,
    ) -> Result<(), String> {
        u[20..24].copy_from_slice(
            &n.inverse.0[..4]
                .iter()
                .map(|v| *v as f32)
                .collect::<Vec<_>>(),
        );
        u[24..28].copy_from_slice(&[
            n.inverse.0[4] as f32,
            n.inverse.0[5] as f32,
            n.size[0] as f32,
            n.size[1] as f32,
        ]);
        u[180..184].copy_from_slice(
            &n.matrix.0[..4]
                .iter()
                .map(|v| *v as f32)
                .collect::<Vec<_>>(),
        );
        u[184..186].copy_from_slice(
            &[
                [-0.125, -0.375],
                [0.375, -0.125],
                [-0.375, 0.125],
                [0.125, 0.375],
                [0., 0.],
            ][sample],
        );
        let kind = ["solid", "linear", "radial", "image", "angular", "diamond"]
            .iter()
            .position(|k| *k == p.kind)
            .ok_or("Unknown paint kind")?;
        if let Some(t) = p.transform {
            for (i, v) in t.inverse()?.0.iter().enumerate() {
                u[244 + i] = *v as f32;
            }
            u[250] = 1.;
        }
        let color = rgb(self.scene, &p.color)?;
        u[187] = f32::from(sample < 4 && !self.scene.float_compositing);
        u[241] = self.scene.colors.get(&p.color).map_or(1., |c| c[3]);
        u[28..32].copy_from_slice(&[kind as f32, color[0], color[1], color[2]]);
        if kind == 0 && sample < 4 && !self.scene.float_compositing {
            u[186] = 1.;
            u[192..196].copy_from_slice(
                &futureox_design_kernel::paint::solid_rgba8(&p.color, p.opacity as f32)?.0,
            );
        }
        if kind == 3 && (p.adjust.is_some() || p.tile.as_ref().is_some_and(|tile| tile.is_active())) {
            u[186] = 1.;
        }
        if p.stops.len() > futureox_design_kernel::scene::MAX_GRADIENT_STOPS {
            return Err("Gradient stop budget exceeded".into());
        }
        let fit = ["cover", "contain", "stretch"]
            .iter()
            .position(|f| *f == p.fit)
            .ok_or("Invalid image fit")?;
        u[32..36].copy_from_slice(&[
            p.opacity as f32,
            p.angle.to_radians() as f32,
            fit as f32,
            p.stops.len() as f32,
        ]);
        let (sin, cos) = p.angle.to_radians().sin_cos();
        u[196..200].copy_from_slice(&[cos as f32, sin as f32, (cos.abs() + sin.abs()) as f32, 0.]);
        if let Some(plane) = p.gradient_plane {
            u[200..204].copy_from_slice(&[plane[0] as f32, plane[1] as f32, plane[2] as f32, 1.]);
            u[204..208].copy_from_slice(&[n.rect.x as f32, n.rect.y as f32, 0., 0.]);
        }
        let mut stops: Vec<_> = p.stops.iter().collect();
        stops.sort_by(|a, b| a.offset.total_cmp(&b.offset));
        for (i, s) in stops.iter().enumerate().take(if stops.len() <= 32 { 32 } else { 0 }) {
            let color = rgb(self.scene, &s.color)?;
            u[208 + i] = self.scene.colors.get(&s.color).map_or(1., |c| c[3]);
            u[52 + i * 4..56 + i * 4].copy_from_slice(&[
                s.offset as f32,
                color[0],
                color[1],
                color[2],
            ]);
        }
        if let Some(fixed) = &p.fixed_gradient {
            for (i, word) in fixed.words.iter().enumerate() {
                for j in 0..4 {
                    u[196 + i * 4 + j] = f32::from(word[j]);
                }
            }
            u[252] = fixed.bits as f32;
            u[253] = 0.;
            u[254] = 0.;
        }
        Ok(())
    }
    fn paint(
        &mut self,
        n: &GpuNode,
        p: &GpuPaint,
        mask: Surface,
        sample: usize,
    ) -> Result<Surface, String> {
        let mut inputs = vec![mask];
        let mut atlased_image = false;
        if p.kind == "image" {
            let uri = p.image.as_deref().unwrap_or("");
            let dims = self.image_dims.get(uri).copied().ok_or("Missing image")?;
            let level = self.paint_level(n, p, dims);
            let key = image_key(uri, level);
            let image = *self.images.get(&key).ok_or("Missing image texture")?;
            let origin = self.image_slots.get(&key).copied().unwrap_or([0, 0]);
            atlased_image = origin != [0, 0];
            inputs.push(image);
            if self.scene.float_compositing || sample < 4 {
                let key = ImageGridKey {
                    node: n.id.clone(),
                    fit: p.fit.clone(),
                    transform: p.transform.map(|m| m.0.map(f64::to_bits)),
                    width: image.rect.w,
                    height: image.rect.h,
                    sample: if self.scene.float_compositing {
                        sample
                    } else {
                        4
                    },
                    level,
                };
                let known = self.image_grids.get(&key).copied();
                let grid = if let Some((old_sample, grid)) = known.filter(|(old, _)| *old == sample)
                {
                    debug_assert_eq!(old_sample, sample);
                    grid
                } else {
                    let compile_grid = if self.scene.float_compositing {
                        futureox_design_kernel::paint::image_sampling_grid_placed
                    } else {
                        futureox_design_kernel::paint::image_byte_sampling_field_placed
                    };
                    let values = compile_grid(
                        n.rect,
                        n.matrix,
                        n.size,
                        dims,
                        &p.paint,
                        (sample < 4).then_some(sample),
                        level,
                        origin,
                    )?;
                    let grid = if let Some((_, grid)) = known {
                        // Only the next sample's addresses change. All previous
                        // reads are encoded before this ordered queue update.
                        self.frame.rewrite_parameters(grid, &values)?;
                        grid
                    } else {
                        let field_rect =
                            if !self.scene.float_compositing && values.get(3) == Some(&1.) {
                                Rect::new(0, 0, n.rect.w.max(n.rect.h), 2)
                            } else {
                                n.rect
                            };
                        self.frame.upload_parameters(field_rect, &values)?
                    };
                    self.image_grids.insert(key, (sample, grid));
                    grid
                };
                inputs.extend([mask, grid]);
            }
        }
        if self.scene.float_compositing
            && matches!(p.kind.as_str(), "linear" | "radial" | "angular" | "diamond")
        {
            let key = GradientGridKey {
                node: n.id.clone(),
                kind: p.kind.clone(),
                angle: p.angle.to_bits(),
                transform: p.transform.map(|m| m.0.map(f64::to_bits)),
                offsets: p.stops.iter().map(|s| s.offset.to_bits()).collect(),
                sample,
            };
            let grid = if let Some(grid) = self.gradient_grids.get(&key) {
                *grid
            } else {
                let values = futureox_design_kernel::paint::gradient_sampling_grid(
                    n.rect,
                    n.matrix,
                    n.size,
                    &p.paint,
                    (sample < 4).then_some(sample),
                )?;
                let grid = self.frame.upload_linear(n.rect, &values)?;
                self.gradient_grids.insert(key, grid);
                grid
            };
            inputs.extend([mask, mask, grid]);
        }
        if p.stops.len() > 32 && matches!(p.kind.as_str(), "linear" | "radial" | "angular" | "diamond") {
            let mut stops: Vec<_> = p.stops.iter().collect();
            stops.sort_by(|a,b| a.offset.total_cmp(&b.offset));
            if stops.len() > futureox_design_kernel::scene::MAX_GRADIENT_STOPS { return Err("Gradient stop budget exceeded".into()); }
            let mut values = vec![0f32; stops.len()*8];
            for (i,s) in stops.iter().enumerate() {
                let color = rgb(self.scene, &s.color)?;
                values[i*4..i*4+4].copy_from_slice(&[s.offset as f32,color[0],color[1],color[2]]);
                values[stops.len()*4+i*4] = self.scene.colors.get(&s.color).map_or(1., |c| c[3]);
            }
            let table = self.frame.upload_parameters(Rect::new(0,0,stops.len() as u32,2), &values)?;
            if inputs.len() == 1 { inputs.push(table); } else { inputs[1] = table; }
        }
        let out = self.frame.acquire(n.rect)?;
        let mut u = parameters(n.rect, &inputs);
        u[16] = 2.;
        self.configure_paint(&mut u, n, p, sample)?;
        if atlased_image {
            u[186] = 1.;
        }
        self.frame.draw(out, u, &inputs, false, None)?;
        Ok(out)
    }
    fn batch(
        &mut self,
        nodes: &[&GpuNode],
        targets: &[Surface],
        clip: Option<&[Surface]>,
    ) -> Result<(), String> {
        let mut data = Vec::with_capacity(nodes.len() * 20);
        for n in nodes {
            let p = &n.fill;
            let a = p.analytic.as_ref().unwrap();
            let r = p.rect;
            let b = r.intersect(targets[0].rect);
            if b.empty() || a.count == 0 {
                continue;
            }
            let color = Pixel::hex(&n.fills[0].color, n.fills[0].opacity as f32)?
                .rgba8_quantized()
                .0;
            data.extend([
                r.x as f32,
                r.y as f32,
                r.w as f32,
                r.h as f32,
                a.first as f32,
                a.count as f32,
                a.bands.map_or(-1., |b| b as f32),
                f32::from(p.rule == "evenodd"),
                0.,
                0.,
                0.,
                0.,
                color[0],
                color[1],
                color[2],
                color[3],
                b.x as f32,
                b.y as f32,
                b.w as f32,
                b.h as f32,
            ]);
        }
        if data.is_empty() {
            return Ok(());
        }
        let range = self.frame.add_instances(&data)?;
        for i in 0..4 {
            let mut u = parameters(targets[i].rect, &[]);
            u[36] = range.0 as f32;
            u[37] = i as f32;
            let inputs = if let Some(clip) = clip {
                let r = clip[i].rect;
                u[12..16].copy_from_slice(&[r.x as f32, r.y as f32, r.w as f32, r.h as f32]);
                u[19] = 1.;
                vec![clip[i]; 3]
            } else {
                Vec::new()
            };
            self.frame.draw(targets[i], u, &inputs, true, Some(range))?;
        }
        Ok(())
    }
    fn draw_list(
        &mut self, ids: &[String], targets: Vec<Surface>, clip: Option<&[Surface]>, depth: usize,
    ) -> Result<Vec<Surface>, String> {
        self.draw_list_inner(ids,targets,clip,depth,false)
    }
    fn draw_list_inner(
        &mut self,
        ids: &[String],
        mut targets: Vec<Surface>,
        clip: Option<&[Surface]>,
        depth: usize,
        omit_optics: bool,
    ) -> Result<Vec<Surface>, String> {
        if depth > 64 {
            return Err("Native GPU scene nesting exceeds 64".into());
        }
        let scene = self.scene;
        // Pure pass-through scopes have no rendering boundary. Flatten only
        // those scopes so adjacent leaves can share a batch without reordering.
        let mut expanded = Vec::new();
        let mut pending: Vec<_> = ids.iter().rev().map(|id| (id, depth)).collect();
        let mut visited = 0;
        while let Some((id, level)) = pending.pop() {
            visited += 1;
            if level > 64 || visited > 20000 {
                return Err("Native GPU scene nesting exceeds its work budget".into());
            }
            let flatten = scene.nodes.get(id).is_some_and(|n| {
                n.passthrough
                    && n.opacity == 1.
                    && !n.clip
                    && n.fills.is_empty()
                    && n.strokes.is_empty()
                    && n.effects.is_empty()
                    && n.mask_id.is_none()
            });
            if flatten {
                pending.extend(
                    scene.nodes[id]
                        .children
                        .iter()
                        .rev()
                        .map(|id| (id, level + 1)),
                );
            } else {
                expanded.push(id.clone());
            }
        }
        let ids = &expanded;
        let mut at = 0;
        let mut optical_prefix: Option<(&str, Vec<Surface>)> = None;
        let mut paint_before: Option<&String>=None;
        while at < ids.len() {
            if optical_prefix.as_ref().is_some_and(|(next,_)| *next!=ids[at]) {
                self.frame.release(&optical_prefix.take().unwrap().1);
                paint_before=None;
            }
            if let Some(prev)=paint_before.take() && let Some((_,base))=&mut optical_prefix {
                *base=self.draw_list_inner(std::slice::from_ref(prev),std::mem::take(base),clip,depth,true)?;
            }
            let Some(n) = scene.nodes.get(&ids[at]) else {
                at += 1;
                continue;
            };
            at += 1;
            if n.opacity <= 0. {
                continue;
            }
            let has_prior=optical_prefix.is_some();
            if !omit_optics && let Some(next)=n.optical_prefix_next.as_deref().filter(|next|ids.get(at).is_some_and(|id|id==next)) {
                if let Some(prefix)=&mut optical_prefix { prefix.0=next; }
                else if futureox_design_kernel::scene::selected_backdrop(&n.effects).is_some() {
                    let planes=targets.iter().map(|s|self.frame.snapshot(*s)).collect::<Result<Vec<_>,_>>()?;
                    optical_prefix=Some((next,planes));
                }
                if optical_prefix.is_some() && (!n.fills.is_empty() || !n.strokes.is_empty()) {paint_before=Some(&ids[at-1]);}
            }
            if self.replay_texture(n, &mut targets, clip)? {
                continue;
            }
            if !scene.float_compositing && batchable(n) {
                let mut end = at;
                while end < ids.len() && scene.nodes.get(&ids[end]).is_some_and(batchable) {
                    end += 1;
                }
                if end - at + 1 >= 8 {
                    let mut nodes = vec![n];
                    nodes.extend(ids[at..end].iter().map(|id| &scene.nodes[id]));
                    self.batch(&nodes, &targets, clip)?;
                    at = end;
                    continue;
                }
            }
            if !scene.float_compositing
                && n.opacity == 1.
                && n.blend == "normal"
                && n.fills
                    .first()
                    .is_some_and(|p| p.opacity == 1. && p.kind != "image" && !p.figma_gradient)
                && n.children.is_empty()
                && n.effects.is_empty()
                && n.strokes.is_empty()
                && n.fills.len() == 1
                && n.fills[0].blend == "normal"
                && n.fills[0].stops.len() <= 32
            {
                // Coherent paint is already quantized before source-over. A
                // single translucent paint needs no isolated temporary layer.
                for i in 0..4 {
                    let mask = self.mask(&n.fill, i)?;
                    let image = if n.fills[0].kind == "image" {
                        *self
                            .images
                            .get(n.fills[0].image.as_deref().unwrap_or(""))
                            .ok_or("Missing image")?
                    } else {
                        mask
                    };
                    let mut inputs = vec![mask, image];
                    if let Some(c) = clip {
                        inputs.push(c[i]);
                    }
                    let mut u = parameters(targets[i].rect, &inputs);
                    self.configure_paint(&mut u, n, &n.fills[0], i)?;
                    u[16..20].copy_from_slice(&[16., 0., 1., f32::from(clip.is_some())]);
                    self.frame.draw(targets[i], u, &inputs, true, None)?;
                }
                continue;
            }
            let needs_mask = !n.fills.is_empty()
                || n.clip
                || n.strokes.iter().any(|s| s.align != "center")
                || n.effects
                    .iter()
                    .any(|e| e.kind == "glass" || e.kind == "background-blur");
            let masks = (0..if needs_mask { 4 } else { 0 })
                .map(|i| self.mask(&n.fill, i))
                .collect::<Result<Vec<_>, _>>()?;
            let mask_id = n.mask_id.as_ref();
            if n.passthrough
                && n.opacity == 1.
                && mask_id.is_none()
                && n.fills.is_empty()
                && n.strokes.is_empty()
                && n.effects.is_empty()
            {
                let combined = if n.clip && clip.is_some() {
                    Some(
                        (0..4)
                            .map(|i| self.combine(masks[i], clip.unwrap()[i], n.rect, false))
                            .collect::<Result<Vec<_>, _>>()?,
                    )
                } else {
                    None
                };
                targets = self.draw_list(
                    &n.children,
                    targets,
                    combined
                        .as_deref()
                        .or(if n.clip { Some(&masks[..]) } else { clip }),
                    depth + 1,
                )?;
                if let Some(combined) = combined {
                    self.frame.release(&combined);
                }
                continue;
            }
            let in_place = clip.is_none()
                && mask_id.is_none()
                && n.opacity == 1.
                && n.blend == "normal"
                && !n.passthrough
                && n.effects.is_empty()
                && n.strokes.is_empty()
                && n.clip
                && n.fills.first().is_some_and(|p| {
                    p.visible
                        && p.opacity == 1.
                        && p.blend == "normal"
                        && p.kind != "image"
                        && scene.colors.get(&p.color).is_none_or(|c| c[3] == 1.)
                        && p.stops
                            .iter()
                            .all(|s| scene.colors.get(&s.color).is_none_or(|c| c[3] == 1.))
                });
            if in_place {
                for i in 0..4 {
                    for p in &n.fills {
                        targets[i] = self.paint_over(n, p, masks[i], targets[i], i)?;
                    }
                }
                targets = self.draw_list(&n.children, targets, Some(&masks), depth + 1)?;
                continue;
            }
            let mut layers = targets
                .iter()
                .map(|s| {
                    if n.passthrough {
                        self.copy(*s, n.rect)
                    } else {
                        self.frame.empty(n.rect)
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut coverage: Option<Vec<Surface>> = None;
            if !omit_optics && let Some(fx) = futureox_design_kernel::scene::selected_backdrop(&n.effects) {
                let cropped = fx.kind == "background-blur";
                let b = n.backdrop_box;
                let capture = if cropped {
                    Rect::new(b[0] as i32, b[1] as i32, b[2] as u32, b[3] as u32)
                } else {
                    n.rect
                };
                // Fractional capture origins are shader coordinates, not texture
                // dimensions. Preserve their phase exactly, as the browser does.
                let mut background = self.frame.acquire(capture)?;
                let inputs = if has_prior { &optical_prefix.as_ref().unwrap().1 } else { &targets };
                let mut u = parameters(capture, inputs);
                u[16] = 26.;
                if cropped {
                    u[0] = b[0] as f32;
                    u[1] = b[1] as f32;
                }
                if n.capture_replay.is_none() {
                    self.frame.draw(background, u, inputs, false, None)?;
                }
                // The integer Rect cannot carry a fractional origin; compensate
                // all subsequent pass parameters using the dedicated phase path.
                if n.capture_replay.is_none() {
                    background = self.backdrop_blur(background, n, fx, cropped, b)?;
                    let adjusted = self.color_controls(background, fx.color_controls.as_ref())?;
                    if adjusted.id != background.id { self.frame.release(&[background]); }
                    background = adjusted;
                }
                for i in 0..4 {
                    let optical = if n.glass_shape.is_some() && fx.evaluated_glass().is_some() {
                        Some(self.glass(background, masks[i], n, fx, true, Some(i))?)
                    } else {
                        None
                    };
                    let filled = self.compose(
                        optical.unwrap_or(background),
                        layers[i],
                        "normal",
                        1.,
                        Some(masks[i]),
                    )?;
                    if let Some(optical) = optical {
                        self.frame.release(&[optical]);
                    }
                    self.frame.release(&[layers[i]]);
                    layers[i] = filled;
                }
                self.frame.release(&[background]);
                coverage = Some(
                    masks
                        .iter()
                        .map(|m| self.copy(*m, n.rect))
                        .collect::<Result<Vec<_>, _>>()?,
                );
            }
            for i in 0..4 {
                for paint in &n.fills {
                    if !paint.visible {
                        continue;
                    }
                    layers[i] = self.paint_over(n, paint, masks[i], layers[i], i)?;
                }
            }
            if let Some(mask_id) = mask_id {
                let empties = (0..4)
                    .map(|_| self.frame.empty(n.rect))
                    .collect::<Result<Vec<_>, _>>()?;
                let mut mask_targets =
                    self.draw_list(std::slice::from_ref(mask_id), empties, None, depth + 1)?;
                if self
                    .scene
                    .nodes
                    .get(mask_id)
                    .is_some_and(|n| n.mask_type.as_deref() == Some("luminance"))
                {
                    for target in &mut mask_targets {
                        let next = self.frame.run(30., target.rect, &[*target], |_| {})?;
                        self.frame.release(&[*target]);
                        *target = next;
                    }
                }
                let content = layers
                    .iter()
                    .map(|s| {
                        if n.passthrough {
                            self.copy(*s, n.rect)
                        } else {
                            self.frame.empty(n.rect)
                        }
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let children: Vec<_> = n
                    .children
                    .iter()
                    .filter(|id| *id != mask_id)
                    .cloned()
                    .collect();
                let content =
                    self.draw_list(&children, content, n.clip.then_some(&masks[..]), depth + 1)?;
                for i in 0..4 {
                    let combined = if n.passthrough {
                        self.interpolate(content[i], layers[i], 1., Some(mask_targets[i]))?
                    } else {
                        self.compose(content[i], layers[i], "normal", 1., Some(mask_targets[i]))?
                    };
                    if combined.id != layers[i].id {
                        self.frame.release(&[layers[i]]);
                    }
                    layers[i] = combined;
                }
                self.frame.release(&content);
                self.frame.release(&mask_targets);
            } else {
                layers =
                    self.draw_list(&n.children, layers, n.clip.then_some(&masks[..]), depth + 1)?;
            }
            for i in 0..4 {
                for stroke in &n.strokes {
                    let raw = self.mask(&stroke.path, i)?;
                    let mask = if stroke.align != "center" {
                        self.combine(raw, masks[i], n.rect, stroke.align == "outside")?
                    } else {
                        raw
                    };
                    layers[i] = self.paint_over(n, &stroke.paint, mask, layers[i], i)?;
                    if mask.id != raw.id {
                        self.frame.release(&[mask]);
                    }
                }
            }
            layers = self.effects(n, layers, &mut coverage)?;
            for i in 0..4 {
                let old = targets[i];
                let mask = clip.map(|c| c[i]);
                targets[i] = if n.passthrough {
                    self.interpolate(layers[i], old, n.opacity, mask)?
                } else if let Some(coverage) = &coverage {
                    let knockout = coverage[i];
                    let b = blend(&n.blend)?;
                    self.frame.run(
                        25.,
                        old.rect,
                        &[layers[i], old, mask.unwrap_or(knockout), knockout],
                        |u| {
                            u[16..20].copy_from_slice(&[
                                25.,
                                b,
                                n.opacity as f32,
                                f32::from(mask.is_some()),
                            ]);
                            u[188..192].copy_from_slice(&[
                                knockout.rect.x as f32,
                                knockout.rect.y as f32,
                                knockout.rect.w as f32,
                                knockout.rect.h as f32,
                            ]);
                        },
                    )?
                } else if n.blend == "normal" && n.opacity < 1. {
                    self.replace_region(29., layers[i], old, n.opacity, mask)?
                } else {
                    self.merge(layers[i], old, &n.blend, n.opacity, mask)?
                };
                if targets[i].id != old.id {
                    self.frame.release(&[old]);
                }
            }
            self.frame.release(&layers);
            if let Some(coverage) = coverage {
                self.frame.release(&coverage);
            }
        }
        if let Some((_,planes))=optical_prefix { self.frame.release(&planes); }
        Ok(targets)
    }
    fn spatial_blur(&mut self,input:Surface,n:&GpuNode,fx:&Effect)->Result<Surface,String>{
        if let Some(z)=fx.zoom_blur {
            if z.is_identity() {return Ok(input)}
            let r=input.rect;
            let key=[n.matrix.0[0],n.matrix.0[1],n.matrix.0[2],n.matrix.0[3],n.matrix.0[4],n.matrix.0[5],n.size[0],n.size[1],f64::from(r.x),f64::from(r.y),f64::from(r.w),f64::from(r.h),z.amount,z.center[0],z.center[1]].map(f64::to_bits);
            if !self.zoom_kernels.contains_key(&key) {
                let data=futureox_design_kernel::zoom_blur::coordinates(z,n.matrix,n.size,r)?;
                let surface=self.frame.upload_parameters(Rect::new(0,0,256,(data.len()/1024) as u32),&data)?;
                self.zoom_kernels.insert(key,surface);
            }
            return self.frame.run(62.,input.rect,&[input,self.zoom_kernels[&key]], |_|{})
        }
        if fx.radius==0. {return Ok(input)}
        if fx.kind=="gaussian-blur" {return self.blur_mode(input,2.*fx.radius*n.matrix.max_scale(),false,true)}
        let key=[fx.radius.to_bits(),fx.motion_angle.to_bits(),n.matrix.0[0].to_bits(),n.matrix.0[1].to_bits(),n.matrix.0[2].to_bits(),n.matrix.0[3].to_bits()];
        if !self.motion_kernels.contains_key(&key) {
            let data=futureox_design_kernel::spatial_blur::MotionKernel::new(fx.radius,fx.motion_angle,n.matrix)?.encoded();
            let surface=self.frame.upload_parameters(Rect::new(0,0,256,(data.len()/1024) as u32),&data)?;
            self.motion_kernels.insert(key,surface);
        }
        self.frame.run(61.,input.rect,&[input,self.motion_kernels[&key]], |_|{})
    }
    fn blur(&mut self, input: Surface, radius: f64, clamp_edges: bool) -> Result<Surface, String> {
        self.blur_mode(input,radius,clamp_edges,false)
    }
    fn blur_mode(&mut self, input: Surface, radius: f64, clamp_edges: bool, gaussian: bool) -> Result<Surface, String> {
        if radius <= 0. {
            return Ok(input);
        }
        if radius > 512. && !gaussian {
            return Err("Native blur radius exceeds 512 pixels".into());
        }
        if gaussian || !self.scene.integrated_blur {
            let mut current = input;
            for r in futureox_design_kernel::effects::gaussian_box_radii(radius / 2.)? {
                if r == 0 {
                    continue;
                }
                let key = (-f64::from(r) - 1.).to_bits();
                if !self.blur_kernels.contains_key(&key) {
                    let bytes =
                        futureox_design_kernel::rational_filter::RationalKernel::uniform_box(r)?
                            .encoded();
                    let surface = self
                        .frame
                        .upload(Rect::new(0, 0, (bytes.len() / 4) as u32, 1), &bytes)?;
                    self.blur_kernels.insert(key, surface);
                }
                let kernel = self.blur_kernels[&key];
                for axis in [0., 1.] {
                    let next = if gaussian && self.frame.byte_targets() {
                        self.frame.slide_uniform_box(current, input.rect, r as f32, axis, false)?
                    } else {
                        self.frame.run(22., input.rect, &[current, kernel], |u| {
                            u[36..40].copy_from_slice(&[r as f32, axis, 0., if gaussian { 2. } else { 1. }]);
                        })?
                    };
                    if current.id != input.id {
                        self.frame.release(&[current]);
                    }
                    current = next;
                }
            }
            return Ok(current);
        }
        let managed = self.scene.float_compositing;
        let radius = if managed {
            radius
        } else {
            f64::from(radius as f32)
        };
        let kernel = if managed || radius.fract() != 0. {
            let key = radius.to_bits();
            if !self.blur_kernels.contains_key(&key) {
                let bytes = if managed {
                    futureox_design_kernel::rational_filter::RationalKernel::tent(radius)?.encoded()
                } else {
                    futureox_design_kernel::effects::quantized_tent_kernel(radius)?
                        .into_iter()
                        .flat_map(u32::to_le_bytes)
                        .collect()
                };
                let surface = self
                    .frame
                    .upload(Rect::new(0, 0, (bytes.len() / 4) as u32, 1), &bytes)?;
                self.blur_kernels.insert(key, surface);
            }
            Some(self.blur_kernels[&key])
        } else {
            None
        };
        let mut inputs = vec![input];
        inputs.extend(kernel);
        let h = self.frame.run(22., input.rect, &inputs, |u| {
            u[36..40].copy_from_slice(&[
                radius as f32,
                0.,
                f32::from(clamp_edges),
                f32::from(kernel.is_some()),
            ])
        })?;
        inputs[0] = h;
        let v = self.frame.run(22., input.rect, &inputs, |u| {
            u[36..40].copy_from_slice(&[
                radius as f32,
                1.,
                f32::from(clamp_edges),
                f32::from(kernel.is_some()),
            ])
        })?;
        self.frame.release(&[h]);
        Ok(v)
    }
    fn backdrop_blur(
        &mut self,
        input: Surface,
        n: &GpuNode,
        fx: &Effect,
        cropped: bool,
        b: [f64; 4],
    ) -> Result<Surface, String> {
        let sharp = input;
        let blurred = self.blur(sharp, fx.backdrop_radius() * n.matrix.max_scale(), cropped)?;
        let origin = if cropped {
            [b[0] - f64::from(sharp.rect.x), b[1] - f64::from(sharp.rect.y)]
        } else {
            [0., 0.]
        };
        let mut background = if fx.gradient_blur.is_some() {
            self.gradient_blur_at(sharp, blurred, n, fx, origin)?
        } else {
            blurred
        };
        if background.id != blurred.id && blurred.id != sharp.id {
            self.frame.release(&[blurred]);
        }
        if background.id != sharp.id {
            self.frame.release(&[sharp]);
        }
        if cropped {
            let expanded = self.frame.acquire(n.rect)?;
            let mut u = parameters(n.rect, &[background]);
            u[16] = 27.;
            u[4] = b[0] as f32;
            u[5] = b[1] as f32;
            self.frame.draw(expanded, u, &[background], false, None)?;
            self.frame.release(&[background]);
            background = expanded;
        } else if fx.kind == "glass" && (n.glass_shape.is_none() || fx.evaluated_glass().is_none()) {
            let masks = (0..4)
                .map(|i| self.mask(&n.fill, i))
                .collect::<Result<Vec<_>, _>>()?;
            let geometry = self.frame.run(23., n.rect, &masks, |_| {})?;
            let mut field = self.frame.run(9., n.rect, &[geometry], |_| {})?;
            let mut step = n.rect.w.max(n.rect.h).next_power_of_two() / 2;
            while step >= 1 {
                let next = self
                    .frame
                    .run(10., n.rect, &[field], |u| u[36] = step as f32)?;
                self.frame.release(&[field]);
                field = next;
                step /= 2;
            }
            let scale = n.matrix.max_scale();
            let next = self
                .frame
                .run(11., n.rect, &[background, field, geometry], |u| {
                    u[36..40].copy_from_slice(&[
                        (fx.radius * scale * 2.).max(4.) as f32,
                        (fx.amount * scale) as f32,
                        fx.opacity as f32,
                        1.,
                    ]);
                    if fx.glass.is_some() {
                        let values =
                            futureox_design_kernel::material::GlassMaterial::new(fx, scale)
                                .uniforms();
                        u[36..39].copy_from_slice(&values[..3]);
                        u[40..45].copy_from_slice(&values[4..9]);
                    }
                })?;
            self.frame.release(&[background, field, geometry]);
            background = next;
        }
        Ok(background)
    }
    fn texture_parameters(
        &mut self,
        n: &GpuNode,
        fx: &futureox_design_kernel::scene::Effect,
    ) -> Result<Option<Surface>, String> {
        if fx.kind != "texture" {
            return Ok(None);
        }
        if let Some(t) = &fx.texture {
            let values = futureox_design_kernel::material::texture_field_at(
                n.rect,
                fx.texture_amount(),
                t,
                n.matrix,
                n.size.map(|v| v / 2.),
            )?;
            return self.frame.upload_parameters(n.rect, &values).map(Some);
        }
        if !self.scene.float_compositing {
            return Ok(None);
        }
        let values = futureox_design_kernel::effects::texture_sampling_grid(
            n.rect,
            fx.texture_amount(),
            n.matrix,
        )?;
        self.frame.upload_linear(n.rect, &values).map(Some)
    }
    fn morphology(&mut self, input: Surface, r: f64, dilate: bool) -> Result<Surface, String> {
        if r > 256. {
            return Err("Native spread exceeds 256 pixels".into());
        }
        let h = self.frame.run(5., input.rect, &[input], |u| {
            u[36..39].copy_from_slice(&[r as f32, 0., f32::from(dilate)])
        })?;
        let v = self.frame.run(5., input.rect, &[h], |u| {
            u[36..39].copy_from_slice(&[r as f32, 1., f32::from(dilate)])
        })?;
        self.frame.release(&[h]);
        Ok(v)
    }
    fn color_controls(&mut self, input: Surface, controls: Option<&futureox_design_kernel::color_controls::ColorControls>) -> Result<Surface, String> {
        let Some(controls) = controls.filter(|c| !c.is_identity()) else { return Ok(input); };
        let matrix = controls.uniforms(self.scene.color_management.is_some());
        self.frame.run(60., input.rect, &[input], |u| u[36..76].copy_from_slice(&matrix))
    }
    fn effects(
        &mut self,
        n: &GpuNode,
        mut planes: Vec<Surface>,
        coverage: &mut Option<Vec<Surface>>,
    ) -> Result<Vec<Surface>, String> {
        let sc = n.matrix.max_scale();
        for fx in &n.effects {
            if !fx.visible
                || fx.kind == "background-blur"
                || fx.kind == "glass"
                || (fx.kind == "blur" && fx.radius == 0.)
                || (fx.kind == "texture" && fx.texture_amount() == 0.)
            {
                continue;
            }
            if fx.kind == "color-controls" {
                let mut outputs = Vec::new();
                let mut shared = HashMap::new();
                for plane in &planes {
                    let next = if let Some(next) = shared.get(&plane.id) { *next } else {
                        let next = self.color_controls(*plane, fx.color_controls.as_ref())?;
                        shared.insert(plane.id, next); next
                    };
                    outputs.push(next);
                }
                let consumed: Vec<_> = planes.iter().zip(&outputs).filter(|(a,b)|a.id!=b.id).map(|(a,_)|*a).collect();
                self.frame.release(&consumed);
                planes = outputs; continue;
            }
            let resolved = self.frame.run(23., n.rect, &planes, |_| {})?;
            if matches!(fx.kind.as_str(),"gaussian-blur"|"motion-blur"|"zoom-blur") {
                let filtered=self.spatial_blur(resolved,n,fx)?;
                self.frame.release(&planes);if filtered.id!=resolved.id {self.frame.release(&[resolved]);}
                planes=vec![filtered;4];
                if let Some(old)=coverage {
                    let mask=self.frame.run(23.,n.rect,old, |_|{})?;
                    let filtered=self.spatial_blur(mask,n,fx)?;
                    self.frame.release(old);if filtered.id!=mask.id {self.frame.release(&[mask]);}*old=vec![filtered;4];
                }
            } else if fx.kind == "blur" {
                let full = self.blur(resolved, fx.blur_radius() * sc, false)?;
                let blurred = self.gradient_blur(resolved, full, n, fx)?;
                if blurred.id != full.id && full.id != resolved.id {
                    self.frame.release(&[full]);
                }
                self.frame.release(&planes);
                if blurred.id != resolved.id {
                    self.frame.release(&[resolved]);
                }
                planes = vec![blurred; 4];
                if let Some(old) = coverage {
                    let mask = self.frame.run(23., n.rect, old, |_| {})?;
                    let full_mask = self.blur(mask, fx.blur_radius() * sc, false)?;
                    let filtered = self.gradient_blur(mask, full_mask, n, fx)?;
                    if filtered.id != full_mask.id && full_mask.id != mask.id {
                        self.frame.release(&[full_mask]);
                    }
                    self.frame.release(old);
                    if filtered.id != mask.id {
                        self.frame.release(&[mask]);
                    }
                    *old = vec![filtered; 4];
                }
            } else if fx.kind == "shadow" || fx.kind == "inner-shadow" {
                let inner = fx.kind == "inner-shadow";
                let m = n.matrix.0;
                let dx = m[0] * fx.x + m[2] * fx.y;
                let dy = m[1] * fx.x + m[3] * fx.y;
                let pointwise =
                    fx.radius == 0. && fx.spread == 0. && dx.fract() == 0. && dy.fract() == 0.;
                let alpha = if (fx.spread * sc).abs() >= 0.5 {
                    self.morphology(
                        resolved,
                        (fx.spread * sc).abs().round(),
                        if inner {
                            fx.spread < 0.
                        } else {
                            fx.spread > 0.
                        },
                    )?
                } else {
                    resolved
                };
                let blurred = self.blur(alpha, fx.radius * sc, false)?;
                let color = rgb(self.scene, &fx.color)?;
                let mut outputs = Vec::new();
                let mut shared = HashMap::new();
                for plane in &planes {
                    let next = if let Some(next) = shared.get(&plane.id) {
                        *next
                    } else {
                        let shadow = self.frame.run(
                            6.,
                            n.rect,
                            &[*plane, if pointwise { *plane } else { blurred }],
                            |u| {
                                u[28..32].copy_from_slice(&[0., color[0], color[1], color[2]]);
                                u[32] = fx.opacity as f32
                                    * self.scene.colors.get(&fx.color).map_or(1., |c| c[3]);
                                u[36..40].copy_from_slice(&[
                                    1.,
                                    dx as f32,
                                    dy as f32,
                                    f32::from(inner),
                                ]);
                            },
                        )?;
                        let next = if inner {
                            self.compose(shadow, *plane, "normal", 1., None)?
                        } else {
                            self.compose(*plane, shadow, "normal", 1., None)?
                        };
                        self.frame.release(&[shadow]);
                        shared.insert(plane.id, next);
                        next
                    };
                    outputs.push(next);
                }
                self.frame.release(&planes);
                self.frame.release(&[resolved, alpha, blurred]);
                planes = outputs;
            } else if matches!(fx.kind.as_str(), "noise" | "texture") {
                let mut outputs = Vec::new();
                let mut shared = HashMap::new();
                let addresses = self.texture_parameters(n, fx)?;
                for plane in &planes {
                    let next = if let Some(next) = shared.get(&plane.id) {
                        *next
                    } else {
                        let mut inputs = vec![*plane];
                        inputs.extend(addresses);
                        let next = self.frame.run(
                            if fx.kind == "noise" { 7. } else { 8. },
                            n.rect,
                            &inputs,
                            |u| {
                                for i in 0..4 {
                                    u[20 + i] = n.inverse.0[i] as f32;
                                    u[180 + i] = n.matrix.0[i] as f32;
                                }
                                u[24..28].copy_from_slice(&[
                                    n.inverse.0[4] as f32,
                                    n.inverse.0[5] as f32,
                                    n.size[0] as f32,
                                    n.size[1] as f32,
                                ]);
                                u[42] = f32::from(fx.texture.is_some());
                                u[43] =
                                    f32::from(fx.texture.as_ref().is_some_and(|t| t.clip_to_shape));
                                u[40..42].copy_from_slice(&[
                                    if fx.kind == "noise" {
                                        fx.amount as f32
                                    } else {
                                        (fx.amount * fx.opacity * 2.) as f32
                                    },
                                    fx.opacity as f32,
                                ]);
                            },
                        )?;
                        shared.insert(plane.id, next);
                        next
                    };
                    outputs.push(next);
                }
                self.frame.release(&planes);
                self.frame.release(&[resolved]);
                planes = outputs;
            } else {
                return Err(format!("Unsupported coherent sample effect: {}", fx.kind));
            }
        }
        Ok(planes)
    }
}
