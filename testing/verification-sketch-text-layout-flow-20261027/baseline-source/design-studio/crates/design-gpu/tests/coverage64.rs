//! Production software binary64 coverage operations, tested on native hardware.
use std::{sync::mpsc, time::Duration};
use wgpu::util::DeviceExt;
#[tokio::test]
#[cfg_attr(not(feature = "hardware-tests"), ignore = "requires a real GPU")]
async fn coverage64_matches_independent_rational_oracle() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/coverage-vectors.json"
    ))
    .unwrap();
    let rows = corpus["cases"].as_array().unwrap();
    let input: Vec<u8> = rows
        .iter()
        .flat_map(|r| {
            r["words"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|v| (v.as_u64().unwrap() as u32).to_le_bytes())
        })
        .collect();
    let source = include_str!("../../design-kernel/shaders/vector.wgsl");
    let first = source.find("fn fixedLinear").unwrap();
    let start = source.find("fn scaledPositive64").unwrap();
    let end = source.find("fn paintUV").unwrap();
    let shader = format!(
        "{}\n{}\n{}\n{}",
        &source[..first],
        &source[start..end],
        include_str!("../../design-kernel/shaders/coverage64.wgsl"),
        r#"
@group(0) @binding(0) var<storage,read> inputs:array<u32>;
@group(0) @binding(1) var<storage,read_write> outputs:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=arrayLength(&outputs)){return;}let base=id.x*16u;
 let x=cvWidth(inputs[base+9u],vec2<u32>(inputs[base+1u],inputs[base+2u]),vec2<u32>(inputs[base+3u],inputs[base+4u]));
 var value=cvScaled(x.xy,x.z+3u);
 if(inputs[base]!=0u){let y=cvWidth(inputs[base+10u],vec2<u32>(inputs[base+5u],inputs[base+6u]),vec2<u32>(inputs[base+7u],inputs[base+8u]));value=cvProduct(x,y);}
 outputs[id.x]=bitcast<u32>(value);
}
"#
    );
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = instance.request_adapter(&Default::default()).await.unwrap();
    eprintln!("Sampling adapter: {:?}", adapter.get_info());
    let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Production coverage64 oracle"),
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
    let size = rows.len() as u64 * 4;
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
        let expected = rows[i]["expected"].as_u64().unwrap() as u32;
        if actual != expected {
            failures.push(serde_json::json!({"index":i,"input":rows[i],"actual":actual}));
        }
    }
    eprintln!(
        "{} coverage vectors; {} bit differences; first {:?}",
        rows.len(),
        failures.len(),
        &failures[..failures.len().min(8)]
    );
    assert!(
        failures.is_empty(),
        "production coverage64 differs from exact oracle"
    );
}
