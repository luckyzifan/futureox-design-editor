//! Execute the shared production integer filter against independent rational integration.
use futureox_design_kernel::rational_filter::RationalKernel;
use std::{sync::mpsc, time::Duration};
use wgpu::util::DeviceExt;

#[tokio::test]
#[cfg_attr(not(feature = "hardware-tests"), ignore = "requires a real GPU")]
async fn shader_rational_filter_matches_exact_oracle() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testing/fixtures/design/filter-vectors.json"
    ))
    .unwrap();
    let rows = corpus["cases"].as_array().unwrap();
    let mut words = vec![0_u32; rows.len() * 4];
    for (index, row) in rows.iter().enumerate() {
        let radius =
            f64::from_bits(u64::from_str_radix(row["radiusBits"].as_str().unwrap(), 16).unwrap());
        let kernel = if row["kind"] == "box" {
            RationalKernel::uniform_box(radius as u32)
        } else {
            RationalKernel::tent(radius)
        }
        .unwrap();
        words[index * 4] = words.len() as u32;
        words.extend(
            kernel
                .encoded()
                .chunks_exact(4)
                .map(|p| u32::from_le_bytes(p.try_into().unwrap())),
        );
        words[index * 4 + 1] = words.len() as u32;
        words[index * 4 + 2] = kernel.reach() as u32;
        words.extend(
            row["values"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap() as u32),
        );
    }
    let input: Vec<u8> = words.into_iter().flat_map(u32::to_le_bytes).collect();
    let sampling = include_str!("../../design-kernel/shaders/sampling.wgsl");
    let rational = include_str!("../../design-kernel/shaders/rational-filter.wgsl");
    let shader = format!(
        "{}\n{}\n{}",
        sampling.split("fn bsParts").next().unwrap(),
        r#"
@group(0) @binding(0) var<storage,read> inputs:array<u32>;
@group(0) @binding(1) var<storage,read_write> outputs:array<u32>;
var<private> caseIndex:u32;
fn rfLoad(index:u32)->u32{return inputs[inputs[caseIndex*4u]+index];}
fn rfSource(p:vec2<f32>)->vec4<f32>{let index=u32(i32(p.x)+i32(inputs[caseIndex*4u+2u]));return vec4<f32>(bitcast<f32>(inputs[inputs[caseIndex*4u+1u]+index]));}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=arrayLength(&outputs)){return;}caseIndex=id.x;
 outputs[id.x]=bitcast<u32>(rfChannel(vec2<f32>(0),vec2<f32>(1,0),0u));
}
"#,
        &rational[rational.find("fn rfChannel").unwrap()..]
    );
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = instance.request_adapter(&Default::default()).await.unwrap();
    eprintln!("Sampling adapter: {:?}", adapter.get_info());
    let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Production rational filter oracle"),
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
        "{} filter vectors; {} bit differences; first {:?}",
        rows.len(),
        failures.len(),
        &failures[..failures.len().min(8)]
    );
    assert!(
        failures.is_empty(),
        "production rational filter differs from exact oracle"
    );
}
