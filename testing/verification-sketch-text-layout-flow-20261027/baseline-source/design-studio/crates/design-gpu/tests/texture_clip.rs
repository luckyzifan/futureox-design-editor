//! Actual GPU execution of the production scalar helper. Inputs are canonical
//! alpha scalars and one immutable numeric atlas, never CPU-computed weights.
use futureox_design_kernel::{figma_sampling::normalize_q4, texture_noise::clip_weight};
use std::{sync::mpsc, time::Duration};
use wgpu::util::DeviceExt;

fn shader() -> String {
    let source = include_str!("../../design-kernel/shaders/vector.wgsl");
    let initial = &source[..source.find("fn paintUV").unwrap()];
    let fixed = initial.find("fn fixedLinear").unwrap();
    let scaled = initial.find("fn scaledPositive64").unwrap();
    format!(
        // The extracted material block also carries softwareRasterByte, which
        // reads the compositor uniform accessor. No tested helper reaches it;
        // the stub exists only so the module compiles standalone.
        "const BYTE_SURFACE:bool=false;\nfn u(i:u32)->vec4<f32>{{return vec4<f32>(0);}}\n{}{}\n{}\n{}\n{}",
        &initial[..fixed],
        &initial[scaled..],
        &source[source.find("fn figmaMsb32").unwrap()..source.find("fn materialSample").unwrap()],
        &source[source.find("fn textureClipReadWord").unwrap()
            ..source.find("fn figmaByteValue").unwrap()],
        r#"
@group(0) @binding(0) var math:texture_2d<f32>;
@group(0) @binding(1) var<storage,read> alphas:array<f32>;
@group(0) @binding(2) var<storage,read> cases:array<vec2<u32>>;
@group(0) @binding(3) var<uniform> config:vec4<u32>;
@group(0) @binding(4) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3<u32>){
 if(gid.x>=config.z){return;}let index=config.y+gid.x;var value:f32;
 if(config.x==0u){value=textureClipWeight(math,alphas[index%4081u],alphas[index/4081u]);}
 else if(config.x==1u){let pair=cases[index];value=textureClipWeight(math,bitcast<f32>(pair.x),bitcast<f32>(pair.y));}
 else{let pair=cases[index];value=textureClipWeightQ4(math,pair.x,pair.y);}
 output[gid.x]=bitcast<u32>(value);
}"#
    )
}

#[tokio::test]
#[cfg_attr(not(feature = "hardware-tests"), ignore = "requires a real GPU")]
async fn exact_texture_clip_atlas_matches_every_pair_and_rejects_invalid_inputs() {
    const N: u32 = clip_weight::ALPHA_COUNT;
    const CHUNK: u32 = N * 256;
    let mut atlas = vec![0_u8; 1024 * 1024 * 4];
    atlas[..clip_weight::BASELINE_BYTES].copy_from_slice(clip_weight::baseline_root_bytes());
    atlas[clip_weight::BASELINE_BYTES..clip_weight::TOTAL_BYTES]
        .copy_from_slice(clip_weight::residual_bytes());
    assert!(atlas[clip_weight::TOTAL_BYTES..].iter().all(|b| *b == 0));
    let alphas: Vec<u8> = (0..N).flat_map(|q| normalize_q4(q).to_le_bytes()).collect();
    let mut domain = Vec::new();
    for q in 1..N {
        let bits = normalize_q4(q).to_bits();
        for adjacent in [bits - 1, bits + 1] {
            domain.extend([[0, adjacent], [adjacent, 0]]);
        }
    }
    for bits in [
        0x80000000, 0x7f800000, 0xff800000, 0x7fc12345, 0xffc12345, 1,
    ] {
        domain.extend([[0, bits], [bits, 0]]);
    }
    let index_cases = [
        [0, N],
        [N, 0],
        [u32::MAX, 0],
        [0, u32::MAX],
        [0, 0],
        [N - 1, N - 1],
    ];
    let capacity = domain.len().max(index_cases.len()) * 8;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = instance.request_adapter(&Default::default()).await.unwrap();
    eprintln!("Texture clip adapter: {:?}", adapter.get_info());
    let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Immutable numeric clip atlas"),
        size: wgpu::Extent3d {
            width: 1024,
            height: 1024,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &atlas,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(4096),
            rows_per_image: Some(1024),
        },
        wgpu::Extent3d {
            width: 1024,
            height: 1024,
            depth_or_array_layers: 1,
        },
    );
    let alphas = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Synthetic Q4 alpha inputs"),
        contents: &alphas,
        usage: wgpu::BufferUsages::STORAGE,
    });
    let cases = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: capacity as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let config = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 16,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let output = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: u64::from(CHUNK) * 4,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: output.size(),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Production clip helper"),
        source: wgpu::ShaderSource::Wgsl(shader().into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: None,
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let view = texture.create_view(&Default::default());
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: alphas.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: cases.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: config.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: output.as_entire_binding(),
            },
        ],
    });
    for mode in 0..3_u32 {
        let pairs: &[[u32; 2]] = if mode == 2 { &index_cases } else { &domain };
        if mode != 0 {
            queue.write_buffer(
                &cases,
                0,
                &pairs
                    .iter()
                    .flatten()
                    .flat_map(|v| v.to_le_bytes())
                    .collect::<Vec<_>>(),
            );
        }
        let total = if mode == 0 { N * N } else { pairs.len() as u32 };
        let mut different = 0;
        let mut examples = Vec::new();
        for start in (0..total).step_by(CHUNK as usize) {
            let count = CHUNK.min(total - start);
            queue.write_buffer(
                &config,
                0,
                &[mode, start, count, 0]
                    .into_iter()
                    .flat_map(u32::to_le_bytes)
                    .collect::<Vec<_>>(),
            );
            let mut encoder = device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(&pipeline);
                pass.set_bind_group(0, &bind, &[]);
                pass.dispatch_workgroups(count.div_ceil(64), 1, 1);
            }
            encoder.copy_buffer_to_buffer(&output, 0, &readback, 0, u64::from(count) * 4);
            queue.submit([encoder.finish()]);
            let (tx, rx) = mpsc::sync_channel(1);
            readback.map_async(wgpu::MapMode::Read, .., move |r| tx.send(r).unwrap());
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(Duration::from_secs(30)),
                })
                .unwrap();
            rx.recv_timeout(Duration::from_secs(1)).unwrap().unwrap();
            let mapped = readback.get_mapped_range(..).unwrap();
            for (i, bytes) in mapped.chunks_exact(4).take(count as usize).enumerate() {
                let index = start + i as u32;
                let expected = if mode == 0 {
                    clip_weight::evaluate_indices(index % N, index / N)
                } else if mode == 1 {
                    let [a, b] = pairs[index as usize];
                    clip_weight::evaluate(f32::from_bits(a), f32::from_bits(b))
                } else {
                    let [a, b] = pairs[index as usize];
                    clip_weight::evaluate_indices(a, b)
                }
                .map(f32::to_bits)
                .unwrap_or(0x7fc00000);
                let actual = u32::from_le_bytes(bytes.try_into().unwrap());
                if actual != expected {
                    different += 1;
                    if examples.len() < 8 {
                        examples.push((index, actual, expected));
                    }
                }
            }
            drop(mapped);
            readback.unmap();
        }
        eprintln!("Clip mode={mode}: {total} values, {different} bit differences, {examples:?}");
        assert_eq!(different, 0);
    }
}
