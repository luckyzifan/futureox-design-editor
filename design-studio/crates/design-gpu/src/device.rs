use futureox_design_kernel::{
    gpu::{BYTE_VECTOR_SHADER, GpuScene, VECTOR_SHADER},
    math::Rect,
    memory::{GpuMemoryCategory, GpuMemoryLedger},
};
use serde::Serialize;
use std::collections::HashMap;
use std::{
    num::NonZeroU64,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use wgpu::util::DeviceExt;

const UNIFORM_BYTES: u64 = 4 * 1024 * 1024;
const MAX_COMMANDS: usize = 262_144;
const MAX_SURFACES: u64 = 256 * 1024 * 1024;
const MAX_INSTANCES: usize = 20_000 * 20;
// Bound native command-buffer work independently of uniform memory. Mobile
// and Metal watchdogs must not receive a frame's thousands of layer passes as
// one uninterrupted submission. Ordered queue submissions preserve sampling.
const COMMANDS_PER_SUBMISSION: usize = 128;

#[derive(Serialize, Debug)]
pub struct AdapterDescription {
    pub name: String,
    pub backend: String,
    pub device_type: String,
}
#[derive(Serialize, Debug)]
pub struct RenderedFrame {
    pub width: u32,
    pub height: u32,
    #[serde(skip)]
    pub rgba: Vec<u8>,
    /// Premultiplied extended linear sRGB, present for managed scenes.
    #[serde(skip)]
    pub linear: Option<Vec<f32>>,
    pub draw_calls: usize,
    pub submissions: usize,
    pub peak_texture_bytes: u64,
    pub render_ms: f64,
    pub encode_ms: f64,
    pub readback_ms: f64,
}
pub struct NativeGpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    layout: wgpu::BindGroupLayout,
    solid_layout: wgpu::BindGroupLayout,
    float_paint: wgpu::RenderPipeline,
    byte_motion: wgpu::RenderPipeline,
    byte_zoom: wgpu::RenderPipeline,
    area: wgpu::RenderPipeline,
    byte_area: wgpu::RenderPipeline,
    paint: wgpu::RenderPipeline,
    over: wgpu::RenderPipeline,
    solid: wgpu::RenderPipeline,
    solid_over: wgpu::RenderPipeline,
    slide_layout: wgpu::BindGroupLayout,
    slide_box: wgpu::ComputePipeline,
    errors: Arc<Mutex<Vec<String>>>,
    description: AdapterDescription,
    /// Persistent CPU-side asset decoder so repeated compositions reuse
    /// decoded assets (and materialized mip levels) instead of re-decoding
    /// every frame. Color-settings changes clear it inside `Images`. Behind a
    /// `RefCell` because the frame keeps a shared borrow of the device.
    images: std::cell::RefCell<futureox_design_kernel::paint::Images>,
    image_mips: bool,
    image_atlas: bool,
    /// Device-resident decoded images, the safe-wgpu equivalent of Sketch's
    /// IOSurface-backed asset residency: an unchanged image keeps its GPU
    /// texture across compositions instead of paying a CPU→GPU upload every
    /// frame. Bounded by PERSISTENT_IMAGE_BYTES with LRU eviction; entries
    /// the current compose samples are pinned.
    image_textures: std::cell::RefCell<HashMap<String, ResidentImage>>,
    image_texture_bytes: std::cell::Cell<u64>,
    image_generation: std::cell::Cell<u64>,
    image_domain: Option<ImageDomain>,
    /// Four-bucket GPU memory ledger (Figma `CorePerfInfo` counters): fed
    /// at this device's resource construction/destruction points; hosts
    /// share the handle with the kernel `Engine` export. Clones share one
    /// state.
    ledger: GpuMemoryLedger,
}

/// One device-resident decoded image: GPU handles, extent, float flag and the
/// last compose generation that sampled it (LRU pinning).
struct ResidentImage {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
    floating: bool,
    last_used: u64,
}

/// Image texels are a function of both the working color settings and the
/// storage domain. A URI alone cannot identify those derived pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
struct ImageDomain {
    color: Option<futureox_design_kernel::color::ColorSettings>,
    floating: bool,
}

/// Cap for device-resident decoded images; they share the frame surface
/// budget conceptually and evict least-recently-used beyond it.
const PERSISTENT_IMAGE_BYTES: u64 = 96 * 1024 * 1024;
impl NativeGpu {
    pub async fn new(backends: wgpu::Backends) -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: None,
                ..Default::default()
            })
            .await
            .map_err(|e| format!("No native GPU adapter: {e}"))?;
        let info = adapter.get_info();
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("Core self-developed vector engine"),
                ..Default::default()
            })
            .await
            .map_err(|e| format!("Native GPU device: {e}"))?;
        let errors = Arc::new(Mutex::new(Vec::new()));
        let sink = errors.clone();
        device.on_uncaptured_error(Arc::new(move |e| {
            if let Ok(mut errors) = sink.lock()
                && errors.len() < 32
            {
                errors.push(e.to_string());
            }
        }));
        let sink = errors.clone();
        device.set_device_lost_callback(move |reason, message| {
            if let Ok(mut errors) = sink.lock()
                && errors.len() < 32
            {
                errors.push(format!("GPU device lost ({reason:?}): {message}"));
            }
        });
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared self-developed vector WGSL"),
            source: wgpu::ShaderSource::Wgsl(VECTOR_SHADER.into()),
        });
        let byte_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Byte-surface vector program"),
            source: wgpu::ShaderSource::Wgsl(BYTE_VECTOR_SHADER.into()),
        });
        let area_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Analytic interval coverage"),
            source: wgpu::ShaderSource::Wgsl(futureox_design_kernel::gpu::area_shader().into()),
        });
        let buffer_entry = |binding, ty, size, visibility| wgpu::BindGroupLayoutEntry {
            binding,
            visibility,
            ty: wgpu::BindingType::Buffer {
                ty,
                has_dynamic_offset: false,
                min_binding_size: NonZeroU64::new(size),
            },
            count: None,
        };
        let mut entries = vec![
            buffer_entry(
                0,
                wgpu::BufferBindingType::Uniform,
                1024,
                wgpu::ShaderStages::VERTEX_FRAGMENT,
            ),
            buffer_entry(
                4,
                wgpu::BufferBindingType::Storage { read_only: true },
                16,
                wgpu::ShaderStages::FRAGMENT,
            ),
        ];
        for binding in [1, 2, 3, 5] {
            entries.push(wgpu::BindGroupLayoutEntry {
                binding,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            });
        }
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Vector inputs"),
            entries: &entries,
        });
        let solid_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Ordered solid instances"),
            entries: &[buffer_entry(
                0,
                wgpu::BufferBindingType::Storage { read_only: true },
                80,
                wgpu::ShaderStages::VERTEX_FRAGMENT,
            )],
        });
        let pipeline = |solid: bool, over: bool, format: wgpu::TextureFormat, area: bool, exact_mode: Option<f64>| {
            let module = if area {
                &area_module
            } else if format == wgpu::TextureFormat::Rgba32Float || exact_mode.is_some() {
                &module
            } else {
                &byte_module
            };
            let constants=exact_mode.map(|mode|[("COMPOSITOR_MODE",mode)]);
            let layouts = if solid {
                vec![Some(&layout), Some(&solid_layout)]
            } else {
                vec![Some(&layout)]
            };
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None,
                bind_group_layouts: &layouts,
                ..Default::default()
            });
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(if solid {
                    "Vector solid batch"
                } else {
                    "Vector compositor"
                }),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module,
                    entry_point: Some(if area {
                        "areaQuad"
                    } else if solid {
                        "solidQuad"
                    } else {
                        "quad"
                    }),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module,
                    entry_point: Some(if area {
                        "areaFragment"
                    } else if solid {
                        "solidFragment"
                    } else {
                        "fragment"
                    }),
                    compilation_options: wgpu::PipelineCompilationOptions {
                        constants: constants.as_ref().map_or(&[],|c|c.as_slice()),
                        ..Default::default()
                    },
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: over.then_some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let paint = pipeline(false, false, wgpu::TextureFormat::Rgba8Unorm, false, None);
        let over = pipeline(false, true, wgpu::TextureFormat::Rgba8Unorm, false, None);
        let solid = pipeline(true, false, wgpu::TextureFormat::Rgba8Unorm, false, None);
        let solid_over = pipeline(true, true, wgpu::TextureFormat::Rgba8Unorm, false, None);
        let float_paint = pipeline(false, false, wgpu::TextureFormat::Rgba32Float, false, None);
        let area = pipeline(false, false, wgpu::TextureFormat::Rgba32Float, true, None);
        // Motion alone needs the full single-round sampler on byte targets.
        let byte_motion = pipeline(false, false, wgpu::TextureFormat::Rgba8Unorm, false, Some(61.));
        let byte_zoom = pipeline(false, false, wgpu::TextureFormat::Rgba8Unorm, false, Some(62.));
        let byte_area = pipeline(false, false, wgpu::TextureFormat::Rgba8Unorm, true, None);
        let slide_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Integer sliding box blur"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../../design-kernel/shaders/slide-blur.wgsl").into()),
        });
        let slide_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Sliding box"),
            entries: &[
                buffer_entry(0, wgpu::BufferBindingType::Uniform, 1024, wgpu::ShaderStages::COMPUTE),
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
            ],
        });
        let slide_box = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Sliding box"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Sliding box"),
                bind_group_layouts: &[Some(&slide_layout)],
                immediate_size: 0,
            })),
            module: &slide_module,
            entry_point: Some("slideBox"),
            compilation_options: Default::default(),
            cache: None,
        });
        if let Some(error) = scope.pop().await {
            return Err(format!("Native vector pipeline: {error}"));
        }
        Ok(Self {
            device,
            queue,
            layout,
            solid_layout,
            paint,
            over,
            float_paint,
            byte_motion,
            byte_zoom,
            area,
            byte_area,
            solid,
            solid_over,
            slide_layout,
            slide_box,
            errors,
            description: AdapterDescription {
                name: info.name,
                backend: format!("{:?}", info.backend),
                device_type: format!("{:?}", info.device_type),
            },
            images: std::cell::RefCell::new(futureox_design_kernel::paint::Images::default()),
            image_mips: false,
            image_atlas: false,
            image_textures: std::cell::RefCell::new(HashMap::new()),
            image_texture_bytes: std::cell::Cell::new(0),
            image_generation: std::cell::Cell::new(0),
            image_domain: None,
            ledger: GpuMemoryLedger::default(),
        })
    }
    /// Install a shared ledger (typically `Engine::gpu_memory_ledger()`).
    /// Transfer any existing resident image allocation to the new owner.
    /// The mutable borrow prevents a live Frame from straddling this swap.
    pub fn set_memory_ledger(&mut self, ledger: GpuMemoryLedger) {
        let bytes = self.image_texture_bytes.get();
        if bytes > 0 {
            self.ledger.free(GpuMemoryCategory::Texture, bytes);
            ledger.alloc(GpuMemoryCategory::Texture, bytes);
        }
        self.ledger = ledger;
    }
    /// Drop derived image residency when replacing a document. CPU decoded
    /// images and GPU images share this lifetime boundary; evicting only GPU
    /// textures otherwise leaves obsolete CPU images consuming decode budget.
    pub fn clear_image_cache(&mut self) {
        let bytes = self.image_texture_bytes.replace(0);
        self.image_textures.get_mut().clear();
        self.images.get_mut().clear();
        self.image_generation.set(0);
        self.image_domain = None;
        if bytes > 0 {
            self.ledger.free(GpuMemoryCategory::Texture, bytes);
        }
    }
    /// The device's GPU memory ledger (four buckets, peaks, `needs_free`).
    pub fn memory_ledger(&self) -> &GpuMemoryLedger {
        &self.ledger
    }
    /// Toggle mip-level selection for image fills. Both the CPU reference and
    /// this compositor derive the level from the same pure geometry, so parity
    /// holds with the switch in either state.
    pub fn set_image_mips(&mut self, mips: bool) {
        self.image_mips = mips;
        self.images.get_mut().set_mip_enabled(mips);
    }
    pub fn image_mips(&self) -> bool {
        self.image_mips
    }
    /// Toggle atlas packing of small float-composited image levels. Packing
    /// is byte-exact by construction (zero-padded slots, placed grids).
    pub fn set_image_atlas(&mut self, atlas: bool) {
        self.image_atlas = atlas;
    }
    pub fn image_atlas(&self) -> bool {
        self.image_atlas
    }
    pub fn description(&self) -> &AdapterDescription {
        &self.description
    }
    /// Surface for the tile cache to observe asynchronous device errors after
    /// sub-frame compositions without re-entering the device borrow.
    pub(crate) fn check_public_errors(&self) -> Result<(), String> {
        self.check_errors()
    }
    fn check_errors(&self) -> Result<(), String> {
        let mut errors = self.errors.lock().map_err(|_| "GPU error state poisoned")?;
        if errors.is_empty() {
            Ok(())
        } else {
            Err(std::mem::take(&mut *errors).join("\n"))
        }
    }
    /// Synchronous, bounded native render. Invoke from a bounded blocking worker
    /// in an async host; the CLI and integration tests use one worker at a time.
    /// No CPU rasterization or silent fallback occurs in this function.
    pub fn render(&mut self, scene: &GpuScene) -> Result<RenderedFrame, String> {
        self.check_errors()?;
        let started = Instant::now();
        if scene.version != 7 {
            return Err("Unsupported GPU command version".into());
        }
        let (frame, output, width, height) = self.compose(scene)?;
        let encode_ms = started.elapsed().as_secs_f64() * 1000.;
        let wait_started = Instant::now();
        let readback = frame.readback(
            output,
            width,
            height,
            scene.presentation.as_ref().is_some_and(|preview|
                scene.color_management.is_none() && (scene.float_compositing || preview.scale < 1.)),
        );
        self.check_errors()?;
        let mut result = readback?;
        result.render_ms = started.elapsed().as_secs_f64() * 1000.;
        result.encode_ms = encode_ms;
        result.readback_ms = wait_started.elapsed().as_secs_f64() * 1000.;
        Ok(result)
    }

    /// Compose a scene into a live surface without reading it back. Used by the
    /// tile cache, which copies sub-rects out of the composited extent before
    /// presenting. Accepts the cropped command version 8 in addition to 7;
    /// the uncropped public [`Self::render`] keeps rejecting version 8.
    pub(crate) fn compose<'a>(
        &'a mut self,
        scene: &GpuScene,
    ) -> Result<(Frame<'a>, Surface, u32, u32), String> {
        self.check_errors()?;
        if scene.version != 7 && scene.version != 8 {
            return Err("Unsupported GPU command version".into());
        }
        if scene.nodes.len() > 20_000 || scene.curves.len() > 2_000_000 {
            return Err("GPU scene work budget exceeded".into());
        }
        let domain = ImageDomain {
            color: scene.color_management,
            floating: scene.float_compositing,
        };
        if self.image_domain != Some(domain) {
            self.clear_image_cache();
            self.image_domain = Some(domain);
        }
        let mips = self.image_mips;
        let atlas = self.image_atlas;
        let mut decoder = self.images.borrow_mut();
        decoder.set_color_settings(scene.color_management);
        let mut frame = Frame::new(
            self,
            &scene.curves,
            scene.color_management,
            scene.float_compositing,
            scene.software_raster,
        );
        let (output, width, height) =
            crate::compositor::render(&mut frame, scene, &mut decoder, mips, atlas)?;
        Ok((frame, output, width, height))
    }
}

impl Drop for NativeGpu {
    fn drop(&mut self) {
        // Destructor-side ledger hook for device-resident images: they are
        // freed only here or by the Frame::new eviction path, so device drop
        // must clear their texture bytes or the ledger leaks live state.
        let bytes: u64 = self
            .image_textures
            .borrow()
            .values()
            .map(|e| e.width as u64 * e.height as u64 * if e.floating { 16 } else { 4 })
            .sum();
        if bytes > 0 {
            self.ledger.free(GpuMemoryCategory::Texture, bytes);
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Surface {
    pub id: usize,
    pub rect: Rect,
}
/// Per-frame counters, exposed so the tile cache can aggregate them across
/// its per-tile compositions.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct FrameStats {
    pub draw_calls: usize,
    pub submissions: usize,
    pub peak_texture_bytes: u64,
}
struct Texture {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
    busy: bool,
    floating: bool,
}
pub(crate) struct Frame<'a> {
    gpu: &'a NativeGpu,
    color: Option<futureox_design_kernel::color::ColorSettings>,
    floating: bool,
    software_raster: bool,
    encoder: Option<wgpu::CommandEncoder>,
    textures: Vec<Texture>,
    uniform: wgpu::Buffer,
    uniforms: Vec<u8>,
    curves: wgpu::Buffer,
    instances: wgpu::Buffer,
    instance_data: Vec<f32>,
    instance_uploaded: usize,
    commands: usize,
    draw_calls: usize,
    submissions: usize,
    bytes: u64,
    blank: Surface,
    replay_parameters: Option<usize>,
    persistent_ids: HashMap<String, usize>,
    /// Shared GPU memory ledger (Figma CorePerfInfo four counters).
    ledger: GpuMemoryLedger,
    /// Texture bytes this frame allocated through `acquire_impl` (blank
    /// sentinel included). Persistent images are excluded: their bytes are
    /// counted at upload and freed at eviction/device drop.
    ledger_frame_textures: u64,
    /// Storage-array bytes created with this frame (analytic segments).
    ledger_curves_bytes: u64,
}
/// Destructor-side ledger hook for the padded readback buffer: a GPU buffer
/// whose mapped range becomes a CPU copy (Figma category 4 blob). Drop-based
/// so early error returns cannot leak live bytes; owns a ledger clone so it
/// never borrows the frame.
struct LedgerBlob(GpuMemoryLedger, u64);
impl Drop for LedgerBlob {
    fn drop(&mut self) {
        self.0.free(GpuMemoryCategory::Blob, self.1);
    }
}
pub(crate) fn floats(data: &[f32]) -> Vec<u8> {
    data.iter().flat_map(|v| v.to_le_bytes()).collect()
}
pub(crate) fn parameters(output: Rect, inputs: &[Surface]) -> [f32; 256] {
    let mut u = [0.; 256];
    for i in 0..4 {
        let r = if i == 0 {
            output
        } else {
            inputs.get(i - 1).map_or(output, |s| s.rect)
        };
        u[i * 4..i * 4 + 4].copy_from_slice(&[r.x as f32, r.y as f32, r.w as f32, r.h as f32]);
    }
    u
}
impl<'a> Frame<'a> {
    fn new(
        gpu: &'a NativeGpu,
        curves: &[f32],
        color: Option<futureox_design_kernel::color::ColorSettings>,
        floating: bool,
        software_raster: bool,
    ) -> Self {
        let curve_bytes = if curves.is_empty() {
            vec![0; 16]
        } else {
            floats(curves)
        };
        let curves = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Monotone analytic segments"),
                contents: &curve_bytes,
                usage: wgpu::BufferUsages::STORAGE,
            });
        let uniform = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Bounded uniform arena"),
            size: UNIFORM_BYTES,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let instances = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Bounded ordered instances"),
            size: (MAX_INSTANCES * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        // Constructor-side ledger hooks (Figma: every backend resource
        // constructor +bytes on exactly one counter):
        // - uniform arena -> Buffer bucket (lazy GPU buffer objects);
        // - analytic segments -> FixedArray bucket (f32 element array);
        // - ordered instances -> FixedArray bucket (f32 element array).
        let ledger = gpu.ledger.clone();
        ledger.alloc(GpuMemoryCategory::Buffer, UNIFORM_BYTES);
        ledger.alloc(GpuMemoryCategory::FixedArray, (MAX_INSTANCES * 4) as u64);
        ledger.alloc(GpuMemoryCategory::FixedArray, curve_bytes.len() as u64);
        let ledger_curves_bytes = curve_bytes.len() as u64;
        let mut frame = Self {
            gpu,
            color,
            floating,
            software_raster: software_raster && !floating,
            encoder: Some(gpu.device.create_command_encoder(&Default::default())),
            textures: Vec::new(),
            uniform,
            uniforms: Vec::with_capacity(UNIFORM_BYTES as usize),
            curves,
            instances,
            instance_data: Vec::new(),
            instance_uploaded: 0,
            commands: 0,
            draw_calls: 0,
            submissions: 0,
            bytes: 0,
            blank: Surface {
                id: 0,
                rect: Rect::new(0, 0, 1, 1),
            },
            replay_parameters: None,
            persistent_ids: HashMap::new(),
            ledger,
            ledger_frame_textures: 0,
            ledger_curves_bytes,
        };
        // wgpu initializes every newly allocated texture to transparent zero.
        frame.blank = frame
            .acquire(Rect::new(0, 0, 1, 1))
            .expect("one-pixel texture fits device limits");
        // Device-resident images join this frame's texture registry so bind
        // groups address them like any other input; their bytes count against
        // the frame budget through the seeded total. Eviction happens here,
        // between composes, so no in-frame handle can dangle.
        {
            // Memory-pressure decision hook (Figma `needs_free`/FREE_CACHED_DATA,
            // wasm #39291): when the four-bucket live allocation total is over the
            // ledger limit, the existing persistent-image LRU reclaim path
            // also runs — no second eviction system. A free event is counted
            // only when cached data was actually dropped.
            let pressure = frame.ledger.needs_free();
            let mut freed_under_pressure = false;
            let mut persistent = gpu.image_textures.borrow_mut();
            let generation = gpu.image_generation.get();
            while (gpu.image_texture_bytes.get() > PERSISTENT_IMAGE_BYTES
                || gpu.ledger.needs_free())
                && persistent.values().any(|e| e.last_used < generation)
            {
                let victim = persistent
                    .iter()
                    .filter(|(_, e)| e.last_used < generation)
                    .min_by_key(|(_, e)| e.last_used)
                    .map(|(k, _)| k.clone());
                let Some(victim) = victim else { break };
                if let Some(entry) = persistent.remove(&victim) {
                    let (texture, w, h, floating) =
                        (entry.texture, entry.width, entry.height, entry.floating);
                    let bytes = w as u64 * h as u64 * if floating { 16 } else { 4 };
                    gpu.image_texture_bytes
                        .set(gpu.image_texture_bytes.get() - bytes);
                    gpu.ledger.free(GpuMemoryCategory::Texture, bytes);
                    freed_under_pressure |= pressure;
                    drop(texture);
                }
            }
            if freed_under_pressure {
                gpu.ledger.note_free_event();
            }
            for (key, entry) in persistent.iter() {
                frame
                    .persistent_ids
                    .insert(key.clone(), frame.textures.len());
                frame.textures.push(Texture {
                    texture: entry.texture.clone(),
                    view: entry.view.clone(),
                    width: entry.width,
                    height: entry.height,
                    busy: true,
                    floating: entry.floating,
                });
            }
            frame.bytes += gpu.image_texture_bytes.get();
        }
        frame
    }
    /// Borrow a device-resident image by cache key for this compose.
    pub(crate) fn persistent_surface(&mut self, key: &str) -> Option<Surface> {
        let generation = {
            let next = self.gpu.image_generation.get() + 1;
            self.gpu.image_generation.set(next);
            next
        };
        if let Some(entry) = self.gpu.image_textures.borrow_mut().get_mut(key) {
            entry.last_used = generation;
        }
        let id = *self.persistent_ids.get(key)?;
        let texture = self.textures.get(id)?;
        Some(Surface {
            id,
            rect: Rect::new(0, 0, texture.width, texture.height),
        })
    }
    /// Upload an image as a device-resident texture keyed for reuse across
    /// compositions. `floats` selects RGBA32F over premultiplied RGBA8.
    pub(crate) fn upload_persistent(
        &mut self,
        key: &str,
        rect: Rect,
        data: &[u8],
        floating: bool,
    ) -> Result<Surface, String> {
        let max = self.gpu.device.limits().max_texture_dimension_2d;
        if rect.empty() || rect.w > max || rect.h > max {
            return Err("GPU surface dimensions exceed device limits".into());
        }
        let bytes = rect.w as u64 * rect.h as u64 * if floating { 16 } else { 4 };
        let texture = self.gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Resident image"),
            size: wgpu::Extent3d {
                width: rect.w,
                height: rect.h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: if floating {
                wgpu::TextureFormat::Rgba32Float
            } else {
                wgpu::TextureFormat::Rgba8Unorm
            },
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        self.gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(rect.w * if floating { 16 } else { 4 }),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: rect.w,
                height: rect.h,
                depth_or_array_layers: 1,
            },
        );
        let view = texture.create_view(&Default::default());
        let generation = self.gpu.image_generation.get();
        self.gpu.image_textures.borrow_mut().insert(
            key.to_owned(),
            ResidentImage {
                texture: texture.clone(),
                view: view.clone(),
                width: rect.w,
                height: rect.h,
                floating,
                last_used: generation,
            },
        );
        self.gpu
            .image_texture_bytes
            .set(self.gpu.image_texture_bytes.get() + bytes);
        // Constructor-side ledger hook: device-resident images are textures
        // (format x width x height), freed by the Frame::new eviction path
        // or NativeGpu drop.
        self.ledger.alloc(GpuMemoryCategory::Texture, bytes);
        let id = self.textures.len();
        self.persistent_ids.insert(key.to_owned(), id);
        self.textures.push(Texture {
            texture,
            view,
            width: rect.w,
            height: rect.h,
            busy: true,
            floating,
        });
        self.bytes += bytes;
        Ok(Surface { id, rect })
    }
    pub fn acquire(&mut self, rect: Rect) -> Result<Surface, String> {
        self.acquire_impl(rect, true, self.floating)
    }
    pub fn snapshot(&mut self, source: Surface) -> Result<Surface, String> {
        self.commands += 1;
        if self.commands > MAX_COMMANDS { return Err("Native GPU command budget exceeded".into()); }
        let target = self.acquire_impl(source.rect, true, self.textures[source.id].floating)?;
        let image = |id: usize| wgpu::TexelCopyTextureInfo { texture: &self.textures[id].texture, mip_level: 0,
            origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All };
        self.encoder.as_mut().unwrap().copy_texture_to_texture(image(source.id),image(target.id),
            wgpu::Extent3d{width:source.rect.w,height:source.rect.h,depth_or_array_layers:1});
        Ok(target)
    }
    fn acquire_impl(&mut self, rect: Rect, reuse: bool, floating: bool) -> Result<Surface, String> {
        let max = self.gpu.device.limits().max_texture_dimension_2d;
        if rect.empty() || rect.w > max || rect.h > max {
            return Err("GPU surface dimensions exceed device limits".into());
        }
        if let Some((id, t)) = self.textures.iter_mut().enumerate().find(|(_, t)| {
            reuse && !t.busy && t.floating == floating && t.width == rect.w && t.height == rect.h
        }) {
            t.busy = true;
            return Ok(Surface { id, rect });
        }
        let required = rect.w as u64 * rect.h as u64 * if floating { 16 } else { 4 };
        if self.bytes + required > MAX_SURFACES {
            // Over-budget admission refusal stays observable in the ledger
            // (Figma's #45702/#45914 "would delta exceed the limit" query
            // counterpart); admission itself remains this existing cap.
            self.ledger.note_rejection(required);
            return Err("GPU surface budget exceeds 256 MiB".into());
        }
        let texture = self.gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Vector layer"),
            size: wgpu::Extent3d {
                width: rect.w,
                height: rect.h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: if floating {
                wgpu::TextureFormat::Rgba32Float
            } else {
                wgpu::TextureFormat::Rgba8Unorm
            },
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST
                | if floating { wgpu::TextureUsages::empty() } else { wgpu::TextureUsages::STORAGE_BINDING },
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        let id = self.textures.len();
        self.textures.push(Texture {
            texture,
            view,
            width: rect.w,
            height: rect.h,
            busy: true,
            floating,
        });
        self.bytes += required;
        // Constructor-side ledger hook: layer/blank textures (Figma texture
        // bytes, size = format x width x height). Freed by Frame::drop.
        self.ledger.alloc(GpuMemoryCategory::Texture, required);
        self.ledger_frame_textures += required;
        Ok(Surface { id, rect })
    }
    pub fn release(&mut self, surfaces: &[Surface]) {
        for s in surfaces {
            if s.id != self.blank.id && Some(s.id) != self.replay_parameters {
                self.textures[s.id].busy = false;
            }
        }
    }
    pub fn empty(&mut self, rect: Rect) -> Result<Surface, String> {
        let out = self.acquire(rect)?;
        self.encoder
            .as_mut()
            .unwrap()
            .begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Clear layer"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.textures[out.id].view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
        Ok(out)
    }
    pub fn upload(&mut self, rect: Rect, bytes: &[u8]) -> Result<Surface, String> {
        if bytes.len() != rect.w as usize * rect.h as usize * 4 {
            return Err("Invalid image byte length".into());
        }
        if self.floating {
            let values: Vec<f32> = bytes.iter().map(|v| f32::from(*v) / 255.).collect();
            return self.upload_linear(rect, &values);
        }
        // Queue writes happen before the whole encoded command buffer. A
        // recycled target may still be written by an earlier encoded pass,
        // which would erase this upload before its first sampling command.
        let out = self.acquire_impl(rect, false, self.floating)?;
        self.gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.textures[out.id].texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            bytes,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(rect.w * 4),
                rows_per_image: Some(rect.h),
            },
            wgpu::Extent3d {
                width: rect.w,
                height: rect.h,
                depth_or_array_layers: 1,
            },
        );
        Ok(out)
    }
    pub fn upload_linear(&mut self, rect: Rect, values: &[f32]) -> Result<Surface, String> {
        if !self.floating
            || values.len() != rect.pixels() * 4
            || values.iter().any(|v| !v.is_finite() || v.abs() > 65504.)
        {
            return Err("Invalid float image upload".into());
        }
        self.upload_parameters(rect, values)
    }
    /// Colour-independent float metadata also accompanies byte colour surfaces.
    pub fn upload_parameters(&mut self, rect: Rect, values: &[f32]) -> Result<Surface, String> {
        if values.len() != rect.pixels() * 4 || values.iter().any(|v| !v.is_finite()) {
            return Err("Invalid material parameter upload".into());
        }
        let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        let out = self.acquire_impl(rect, false, true)?;
        self.gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.textures[out.id].texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &bytes,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(rect.w * 16),
                rows_per_image: Some(rect.h),
            },
            wgpu::Extent3d {
                width: rect.w,
                height: rect.h,
                depth_or_array_layers: 1,
            },
        );
        Ok(out)
    }
    /// Rewrite an already-accounted metadata allocation only after all earlier
    /// reads have been submitted. The caller must encode every use before this
    /// call; queue ordering then protects those reads without a CPU/GPU wait.
    pub fn rewrite_parameters(&mut self, target: Surface, values: &[f32]) -> Result<(), String> {
        let rect = target.rect;
        let valid = self.textures.get(target.id).is_some_and(|texture| {
            texture.busy && texture.floating && texture.width >= rect.w && texture.height >= rect.h
        });
        if !valid || values.len() != rect.pixels() * 4 || values.iter().any(|v| !v.is_finite()) {
            return Err("Invalid reusable image coordinate field".into());
        }
        self.submit();
        self.gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.textures[target.id].texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &floats(values),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(rect.w * 16),
                rows_per_image: Some(rect.h),
            },
            wgpu::Extent3d {
                width: rect.w,
                height: rect.h,
                depth_or_array_layers: 1,
            },
        );
        Ok(())
    }
    /// One bounded, colour-free scratch field. The caller must finish encoding
    /// every use of the returned field before requesting the next one. Submit
    /// those reads before the next queue write; no texture is destroyed or
    /// removed from the frame's memory accounting while it remains in flight.
    pub fn upload_replay_parameters(
        &mut self,
        rect: Rect,
        values: &[f32],
    ) -> Result<Surface, String> {
        if rect.empty()
            || rect.w > 1024
            || rect.h > 1024
            || values.len() != rect.pixels() * 4
            || values.iter().any(|v| !v.is_finite())
        {
            return Err("Invalid texture replay parameter field".into());
        }
        let id = if let Some(id) = self.replay_parameters {
            self.submit();
            id
        } else {
            let storage = self.acquire_impl(Rect::new(0, 0, 1024, 1024), false, true)?;
            self.replay_parameters = Some(storage.id);
            storage.id
        };
        self.gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.textures[id].texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &floats(values),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(rect.w * 16),
                rows_per_image: Some(rect.h),
            },
            wgpu::Extent3d {
                width: rect.w,
                height: rect.h,
                depth_or_array_layers: 1,
            },
        );
        Ok(Surface { id, rect })
    }
    fn submit(&mut self) {
        if !self.uniforms.is_empty() {
            self.gpu
                .queue
                .write_buffer(&self.uniform, 0, &self.uniforms);
        }
        if self.instance_data.len() > self.instance_uploaded {
            self.gpu.queue.write_buffer(
                &self.instances,
                (self.instance_uploaded * 4) as u64,
                &floats(&self.instance_data[self.instance_uploaded..]),
            );
            self.instance_uploaded = self.instance_data.len();
        }
        self.gpu
            .queue
            .submit([self.encoder.take().unwrap().finish()]);
        self.submissions += 1;
        self.encoder = Some(self.gpu.device.create_command_encoder(&Default::default()));
        self.uniforms.clear();
    }
    pub fn add_instances(&mut self, data: &[f32]) -> Result<(u32, u32), String> {
        if !data.len().is_multiple_of(20) || self.instance_data.len() + data.len() > MAX_INSTANCES {
            return Err("GPU solid instance budget exceeded".into());
        }
        let base = (self.instance_data.len() / 4) as u32;
        self.instance_data.extend_from_slice(data);
        Ok((base, (data.len() / 20) as u32))
    }
    pub fn draw(
        &mut self,
        output: Surface,
        u: [f32; 256],
        inputs: &[Surface],
        over: bool,
        instances: Option<(u32, u32)>,
    ) -> Result<(), String> {
        self.draw_region(output, u, inputs, over, instances, None)
    }
    pub fn draw_region(
        &mut self,
        output: Surface,
        mut u: [f32; 256],
        inputs: &[Surface],
        over: bool,
        instances: Option<(u32, u32)>,
        explicit_region: Option<Rect>,
    ) -> Result<(), String> {
        u[240] = f32::from(self.floating);
        u[253] = f32::from(self.software_raster);
        u[254] = 9.;
        u[255] = 19.; // Exact sampler limb count; runtime bound avoids shader loop explosion.
        if self.floating && instances.is_some() {
            return Err("Managed solid batches must use the float paint path".into());
        }
        if self.floating && over {
            return Err("Managed RGBA32F compositing requires an explicit shader blend".into());
        }
        if inputs.iter().any(|s| s.id == output.id) {
            return Err("GPU texture feedback loop".into());
        }
        // Source-over touches only the destination footprint. Without this scissor,
        // hundreds of small siblings shade the entire multi-megapixel parent
        // four times each, exceeding native driver watchdog budgets.
        let region = if over && instances.is_none() {
            // A resampling pass supplies its transformed destination footprint;
            // the source attachment can have an unrelated origin and size.
            let mut r = explicit_region
                .unwrap_or_else(|| inputs.first().map_or(output.rect, |s| s.rect))
                .intersect(output.rect);
            if u[19] > 0.5
                && let Some(mask) = inputs.get(2)
            {
                r = r.intersect(mask.rect);
            }
            if r.empty() {
                return Ok(());
            }
            Some(r)
        } else {
            explicit_region
        };
        self.commands += 1;
        if self.commands > MAX_COMMANDS {
            return Err("GPU command work budget exceeded".into());
        }
        if self.uniforms.len() + 1024 > UNIFORM_BYTES as usize
            || self.uniforms.len() / 1024 >= COMMANDS_PER_SUBMISSION
        {
            self.submit();
        }
        let offset = self.uniforms.len() as u64;
        self.uniforms.extend(floats(&u));
        let mut entries = vec![
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &self.uniform,
                    offset,
                    size: NonZeroU64::new(1024),
                }),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: self.curves.as_entire_binding(),
            },
        ];
        for (i, binding) in [1, 2, 3, 5].into_iter().enumerate() {
            let s = inputs.get(i).copied().unwrap_or(self.blank);
            entries.push(wgpu::BindGroupEntry {
                binding,
                resource: wgpu::BindingResource::TextureView(&self.textures[s.id].view),
            });
        }
        let bind = self
            .gpu
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.gpu.layout,
                entries: &entries,
            });
        let solid_bind = instances.map(|_| {
            self.gpu
                .device
                .create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &self.gpu.solid_layout,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: self.instances.as_entire_binding(),
                    }],
                })
        });
        let mut pass =
            self.encoder
                .as_mut()
                .unwrap()
                .begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Self-developed vector pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &self.textures[output.id].view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
        if let Some(r) = region {
            pass.set_scissor_rect(
                (r.x - output.rect.x) as u32,
                (r.y - output.rect.y) as u32,
                r.w,
                r.h,
            );
        }
        pass.set_pipeline(if u[16] == 31. {
            if self.floating {
                &self.gpu.area
            } else {
                &self.gpu.byte_area
            }
        } else if self.floating {
            &self.gpu.float_paint
        } else if u[16] == 61. {
            &self.gpu.byte_motion
        } else if u[16] == 62. {
            &self.gpu.byte_zoom
        } else if instances.is_some() && over {
            &self.gpu.solid_over
        } else if instances.is_some() {
            &self.gpu.solid
        } else if over {
            &self.gpu.over
        } else {
            &self.gpu.paint
        });
        pass.set_bind_group(0, &bind, &[]);
        if let (Some(bind), Some((_, count))) = (&solid_bind, instances) {
            pass.set_bind_group(1, bind, &[]);
            pass.draw(0..6, 0..count);
        } else {
            pass.draw(0..3, 0..1);
        }
        self.draw_calls += 1;
        Ok(())
    }
    pub fn run(
        &mut self,
        mode: f32,
        rect: Rect,
        inputs: &[Surface],
        configure: impl FnOnce(&mut [f32; 256]),
    ) -> Result<Surface, String> {
        let out = self.acquire(rect)?;
        let mut u = parameters(rect, inputs);
        u[16] = mode;
        configure(&mut u);
        self.draw(out, u, inputs, false, None)?;
        Ok(out)
    }
    pub(crate) fn byte_targets(&self) -> bool { !self.floating }
    /// Byte uniform box with a per-scanline sliding sum. Same rounding as shader mode 22
    /// when the fourth blur uniform is above 1.5. Float and tent paths stay on that fragment loop.
    pub fn slide_uniform_box(&mut self, input: Surface, output_rect: Rect, radius: f32, axis: f32, clamp_edges: bool) -> Result<Surface, String> {
        if self.floating || self.textures[input.id].floating || radius < 1. {
            return Err("Sliding box is the byte uniform path".into());
        }
        let out = self.acquire(output_rect)?;
        self.commands += 1;
        if self.commands > MAX_COMMANDS {
            self.release(&[out]);
            return Err("GPU command work budget exceeded".into());
        }
        if self.uniforms.len() + 1024 > UNIFORM_BYTES as usize {
            self.submit();
        }
        let mut u = parameters(output_rect, &[input]);
        u[16] = 22.;
        u[36] = radius;
        u[37] = axis;
        u[38] = f32::from(clamp_edges);
        u[39] = 2.;
        let offset = self.uniforms.len() as u64;
        self.uniforms.extend(floats(&u));
        let bind = self.gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Sliding box"),
            layout: &self.gpu.slide_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.uniform,
                        offset,
                        size: NonZeroU64::new(1024),
                    }),
                },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&self.textures[input.id].view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&self.textures[out.id].view) },
            ],
        });
        let lines = if axis < 0.5 { output_rect.h } else { output_rect.w };
        let mut pass = self.encoder.as_mut().unwrap().begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("Sliding box"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&self.gpu.slide_box);
        pass.set_bind_group(0, &bind, &[]);
        pass.dispatch_workgroups(lines.div_ceil(64), 1, 1);
        drop(pass);
        self.draw_calls += 1;
        Ok(out)
    }
    fn read_surface_bytes(
        &mut self,
        output: Surface,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, String> {
        self.read_surface_rect(
            output,
            Rect::new(output.rect.x, output.rect.y, width, height),
        )
    }
    /// Exact typed readback for the f64 material bridge. Keep the cropped
    /// reader used by the tile compositor as the single copy/mapping path.
    pub fn read_surface(&mut self, output: Surface) -> Result<Vec<f32>, String> {
        let floating = self.textures[output.id].floating;
        let bytes = self.read_surface_rect(output, output.rect)?;
        Ok(if floating {
            bytes
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().expect("four-byte channel")))
                .collect()
        } else {
            bytes.into_iter().map(|b| f32::from(b) / 255.).collect()
        })
    }
    /// Read an absolute device-pixel rectangle out of a composited surface.
    /// The rectangle is clipped to the surface; reading is bounded by the
    /// texture's real allocation, never by assumptions about its origin.
    pub fn read_surface_rect(&mut self, output: Surface, region: Rect) -> Result<Vec<u8>, String> {
        let region = region.intersect(output.rect);
        if region.empty() {
            return Ok(Vec::new());
        }
        let width = region.w;
        let height = region.h;
        let origin_x = (region.x - output.rect.x) as u32;
        let origin_y = (region.y - output.rect.y) as u32;
        let bpp = if self.textures[output.id].floating {
            16
        } else {
            4
        };
        let stride = (width * bpp).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let readback_bytes = stride as u64 * height as u64;
        // Constructor-side ledger hook: padded readback buffer — a GPU buffer
        // whose mapped range becomes a CPU copy (Figma category 4, data blob
        // with explicit CPU side). The guard frees on every exit path.
        self.ledger.alloc(GpuMemoryCategory::Blob, readback_bytes);
        let _blob = LedgerBlob(self.ledger.clone(), readback_bytes);
        let buffer = self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Padded RGBA readback"),
            size: readback_bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        self.encoder.as_mut().unwrap().copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.textures[output.id].texture,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: origin_x,
                    y: origin_y,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.submit();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        buffer.map_async(wgpu::MapMode::Read, .., move |r| {
            let _ = tx.send(r);
        });
        self.gpu
            .device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(Duration::from_secs(10)),
            })
            .map_err(|e| format!("GPU completion: {e}"))?;
        rx.recv_timeout(Duration::from_secs(1))
            .map_err(|e| format!("GPU mapping callback: {e}"))?
            .map_err(|e| format!("GPU readback: {e}"))?;
        let mapped = buffer
            .get_mapped_range(..)
            .map_err(|e| format!("GPU mapped range: {e}"))?;
        let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
        for row in mapped.chunks_exact(stride as usize) {
            rgba.extend_from_slice(&row[..width as usize * bpp as usize]);
        }
        drop(mapped);
        buffer.unmap();
        Ok(rgba)
    }
    /// Counters for callers composing sub-frames (the tile cache).
    pub(crate) fn stats(&self) -> FrameStats {
        FrameStats {
            draw_calls: self.draw_calls,
            submissions: self.submissions,
            peak_texture_bytes: self.bytes,
        }
    }
    fn readback(
        mut self,
        output: Surface,
        width: u32,
        height: u32,
        straight_bytes: bool,
    ) -> Result<RenderedFrame, String> {
        let rgba = self.read_surface_bytes(output, width, height)?;
        let (rgba, linear) = present_bytes(
            rgba,
            self.floating,
            self.color,
            self.software_raster,
            straight_bytes,
        )?;
        Ok(RenderedFrame {
            linear,
            width,
            height,
            rgba,
            draw_calls: self.draw_calls,
            submissions: self.submissions,
            peak_texture_bytes: self.bytes,
            render_ms: 0.,
            encode_ms: 0.,
            readback_ms: 0.,
        })
    }
}

impl Drop for Frame<'_> {
    fn drop(&mut self) {
        // Destructor-side ledger hooks: every frame-scoped resource is
        // destroyed with the frame (wgpu handles drop with it), so the four
        // buckets give their bytes back here. Persistent images are not
        // frame-scoped: Frame::new's eviction path and NativeGpu::drop free
        // those. Blob readbacks free through LedgerBlob at their own scope.
        self.ledger
            .free(GpuMemoryCategory::Buffer, UNIFORM_BYTES);
        self.ledger.free(
            GpuMemoryCategory::FixedArray,
            (MAX_INSTANCES as u64) * 4 + self.ledger_curves_bytes,
        );
        self.ledger
            .free(GpuMemoryCategory::Texture, self.ledger_frame_textures);
    }
}

/// Shared GPU-readback presentation conversion. The whole-frame path and the
/// tile-cache path must run the exact same per-pixel arithmetic so partial
/// re-renders land on identical bytes.
pub(crate) fn present_bytes(
    rgba: Vec<u8>,
    floating: bool,
    color: Option<futureox_design_kernel::color::ColorSettings>,
    software_raster: bool,
    straight_bytes: bool,
) -> Result<(Vec<u8>, Option<Vec<f32>>), String> {
    if !floating {
        let mut rgba = rgba;
        for p in rgba.chunks_exact_mut(4) {
            if straight_bytes {
                // Minified pixel preview has a Q12 premultiplied-byte resolve
                // followed by the CPU preview's half-up integer conversion.
                // Ordinary Metal byte display uses a different reciprocal/tie
                // contract, e.g. [36,72,108,136] must become [68,135,203,136].
                let alpha = u32::from(p[3]);
                for c in 0..3 {
                    p[c] = if alpha == 0 { 0 } else {
                        ((u32::from(p[c]) * 510 + alpha) / (alpha * 2)).min(255) as u8
                    };
                }
                continue;
            }
            if software_raster {
                p.copy_from_slice(&futureox_design_kernel::software_raster::straight_rgba8([
                    p[0], p[1], p[2], p[3],
                ]));
                continue;
            }
            p.copy_from_slice(
                &futureox_design_kernel::figma_sampling::unpremultiply_rgba8([
                    p[0], p[1], p[2], p[3],
                ]),
            );
        }
        return Ok((rgba, None));
    }
    let values: Vec<f32> = rgba
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().expect("four-byte float")))
        .collect();
    if values.iter().any(|v| !v.is_finite()) {
        return Err("Non-finite GPU float output".into());
    }
    if let Some(settings) = color {
        let bytes = values
            .chunks_exact(4)
            .flat_map(|p| {
                settings
                    .output(
                        futureox_design_kernel::blend::Pixel([p[0], p[1], p[2], p[3]]),
                        Default::default(),
                    )
                    .map(|v| (v.clamp(0., 1.) * 255.).round_ties_even() as u8)
            })
            .collect();
        return Ok((bytes, Some(values)));
    }
    let rgba = if straight_bytes {
        values
            .iter()
            .map(|v| (v.clamp(0., 1.) * 255.).round() as u8)
            .collect()
    } else {
        values
            .chunks_exact(4)
            .flat_map(|p| {
                futureox_design_kernel::blend::Pixel([p[0], p[1], p[2], p[3]]).straight_rgba8()
            })
            .collect()
    };
    Ok((rgba, None))
}
