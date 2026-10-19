//! Exercise production shader helpers, with independent exact-rational fixtures.
use std::{sync::mpsc, time::Duration};
use wgpu::util::DeviceExt;

#[tokio::test]
#[cfg_attr(not(feature = "hardware-tests"), ignore = "requires a real GPU")]
async fn shader_arithmetic_matches_exact_rational_oracle() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/arithmetic-vectors.json"
    ))
    .unwrap();
    let rows = corpus["vectors"].as_array().unwrap();
    let input: Vec<u8> = rows
        .iter()
        .flat_map(|r| (0..4).flat_map(move |i| (r[i].as_u64().unwrap() as u32).to_le_bytes()))
        .collect();
    let source = include_str!("../../design-kernel/shaders/vector.wgsl");
    let helpers = source.split("fn paintUV").next().unwrap();
    let start = helpers.find("fn fixedLinear").unwrap();
    let end = helpers.find("fn scaledPositive64").unwrap();
    let shader = format!(
        "{}{}\n{}\n{}\n{}",
        &helpers[..start],
        &helpers[end..],
        &source[source.find("fn tentWeight").unwrap()..source.find("fn blurAt").unwrap()],
        &source[source.find("fn matPower5").unwrap()..source.find("fn materialSample").unwrap()],
        r#"
@group(0) @binding(0) var<storage,read> inputs:array<vec4<u32>>;
@group(0) @binding(1) var<storage,read_write> outputs:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=arrayLength(&inputs)){return;}let v=inputs[id.x];var result=0.;
 if(v.x==0u){result=divideRN(bitcast<f32>(v.y),bitcast<f32>(v.z));}
 else if(v.x==1u){result=colourMix(f32(v.y),f32(v.z),bitcast<f32>(v.w));}
 else if(v.x==2u){result=scaledPositive64(v.yz,v.w);}
 else if(v.x==3u){result=addRN(bitcast<f32>(v.y),bitcast<f32>(v.z));}
 else if(v.x==4u){result=mulRN(bitcast<f32>(v.y),bitcast<f32>(v.z));}
 else if(v.x==5u){result=sqrtRN(bitcast<f32>(v.y));}
 else if(v.x==7u){result=materialRoot5(bitcast<f32>(v.y));}
 else if(v.x==8u){result=positiveFmaRN(bitcast<f32>(v.y),bitcast<f32>(v.z),bitcast<f32>(v.w));}
 else if(v.x==9u){result=constantColorBlendRN(bitcast<f32>(v.y),bitcast<f32>(v.z),bitcast<f32>(v.w));}
 else if(v.x==10u){result=fmaRN(bitcast<f32>(v.y),bitcast<f32>(v.z),bitcast<f32>(v.w));}
 else{result=tentWeight(bitcast<f32>(v.y),f32(v.z));}outputs[id.x]=bitcast<u32>(result);
}"#
    );
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = instance.request_adapter(&Default::default()).await.unwrap();
    eprintln!("Arithmetic adapter: {:?}", adapter.get_info());
    let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Production arithmetic oracle"),
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
        let expected = rows[i][4].as_u64().unwrap() as u32;
        if actual != expected {
            failures.push(serde_json::json!({"index":i,"input":rows[i],"actual":actual}));
        }
    }
    eprintln!(
        "{} arithmetic vectors; {} bit differences; first {:?}",
        rows.len(),
        failures.len(),
        &failures[..failures.len().min(8)]
    );
    assert!(
        failures.is_empty(),
        "production shader arithmetic differs from exact oracle"
    );
}
