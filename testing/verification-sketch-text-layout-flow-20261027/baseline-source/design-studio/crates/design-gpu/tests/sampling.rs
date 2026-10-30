//! Exercise production shader helpers, with independent exact-rational fixtures.
use std::{sync::mpsc, time::Duration};
use wgpu::util::DeviceExt;

#[tokio::test]
#[cfg_attr(not(feature = "hardware-tests"), ignore = "requires a real GPU")]
async fn shader_sampling_matches_exact_rational_oracle() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/sampling-vectors.json"
    ))
    .unwrap();
    let mut rows = corpus["vectors"].as_array().unwrap().clone();
    let bounded: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/bounded-sampling-vectors.json"
    ))
    .unwrap();
    rows.extend(bounded["vectors"].as_array().unwrap().iter().cloned());
    let input: Vec<u8> = rows
        .iter()
        .flat_map(|r| {
            (0..8).flat_map(move |i| {
                (if i < 6 {
                    r[i].as_u64().unwrap() as u32
                } else {
                    0
                })
                .to_le_bytes()
            })
        })
        .collect();
    let shader = format!(
        "{}\n{}",
        include_str!("../../design-kernel/shaders/sampling.wgsl"),
        r#"
@group(0) @binding(0) var<storage,read> inputs:array<vec4<u32>>;
@group(0) @binding(1) var<storage,read_write> outputs:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=arrayLength(&outputs)/7u){return;}let a=inputs[id.x*2u];let b=inputs[id.x*2u+1u];
 let p=bitcast<vec4<f32>>(a);let k=bitcast<vec2<f32>>(b.xy);let zero=bitcast<f32>(0x80000000u);
 outputs[id.x*7u]=bitcast<u32>(bsBilinear(p,k.x,k.y,19u,9u));
 for(var channel=0u;channel<3u;channel++){
  let pair=bsBilinearChannelAlpha(vec4<f32>(p.x,0.25,zero,p.w),vec4<f32>(p.y,0.25,zero,p.z),vec4<f32>(p.z,0.25,zero,p.y),vec4<f32>(p.w,0.25,zero,p.x),k,channel,19u,9u);
  outputs[id.x*7u+1u+channel*2u]=bitcast<u32>(pair.x);
  outputs[id.x*7u+2u+channel*2u]=bitcast<u32>(pair.y);
 }
}"#
    );
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = instance.request_adapter(&Default::default()).await.unwrap();
    eprintln!("Sampling adapter: {:?}", adapter.get_info());
    let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Production sampling oracle"),
        source: wgpu::ShaderSource::Wgsl(shader.into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: None,
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let input = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None,
        contents: &input,
        usage: wgpu::BufferUsages::STORAGE,
    });
    let size = rows.len() as u64 * 7 * 4;
    let output = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: input.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: output.as_entire_binding(),
            },
        ],
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.dispatch_workgroups((rows.len() as u32).div_ceil(64), 1, 1);
    }
    encoder.copy_buffer_to_buffer(&output, 0, &readback, 0, size);
    queue.submit([encoder.finish()]);
    let (tx, rx) = mpsc::sync_channel(1);
    readback.map_async(wgpu::MapMode::Read, .., move |v| {
        tx.send(v).unwrap();
    });
    device
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(30)),
        })
        .unwrap();
    rx.recv_timeout(Duration::from_secs(1)).unwrap().unwrap();
    let mapped = readback.get_mapped_range(..).unwrap();
    let mut failures = Vec::new();
    for (i, bytes) in mapped.chunks_exact(4).enumerate() {
        let actual = u32::from_le_bytes(bytes.try_into().unwrap());
        let row = &rows[i / 7];
        let slot = i % 7;
        let values: [f32; 4] =
            std::array::from_fn(|c| f32::from_bits(row[c].as_u64().unwrap() as u32));
        let u = f32::from_bits(row[4].as_u64().unwrap() as u32);
        let v = f32::from_bits(row[5].as_u64().unwrap() as u32);
        let expected = match slot {
            0 | 1 => row[6].as_u64().unwrap() as u32,
            3 => futureox_design_kernel::sampling::bilinear([0.25; 4], u, v).to_bits(),
            5 => futureox_design_kernel::sampling::bilinear([-0.0; 4], u, v).to_bits(),
            _ => futureox_design_kernel::sampling::bilinear(
                [values[3], values[2], values[1], values[0]],
                u,
                v,
            )
            .to_bits(),
        };
        if actual != expected {
            failures.push(serde_json::json!({"index":i/7,"slot":slot,"input":row,"expected":expected,"actual":actual}));
        }
    }
    eprintln!(
        "{} sampling values (scalar and channel/alpha); {} bit differences; first {:?}",
        rows.len() * 7,
        failures.len(),
        &failures[..failures.len().min(8)]
    );
    assert!(
        failures.is_empty(),
        "production shader sampling differs from exact oracle"
    );
}
