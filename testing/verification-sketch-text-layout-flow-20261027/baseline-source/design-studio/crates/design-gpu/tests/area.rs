//! GPU evaluates interval geometry/coverage, compared to the CPU rasterizer.
use futureox_design_kernel::{
    area_program::AreaProgram,
    math::{Point, Rect, Transform},
    path::{Contour, Path},
    raster,
};
use std::{sync::mpsc, time::Duration};
use wgpu::util::DeviceExt;
#[tokio::test]
#[cfg_attr(not(feature = "hardware-tests"), ignore = "requires a real GPU")]
async fn area_program_matches_cpu_for_curves_holes_and_thin_negative_coordinates() {
    let mut shapes = vec![
        vec![Contour {
            closed: true,
            points: vec![
                Point::new(0., -2e-20),
                Point::new(1., -2e-20),
                Point::new(1., -1e-20),
                Point::new(0., -1e-20),
            ],
        }],
        vec![Contour {
            closed: true,
            points: vec![
                Point::new(-1.75, -2.375),
                Point::new(21.3, 17.2),
                Point::new(-2.1, 20.9),
            ],
        }],
    ];
    for transform in [
        Transform::default(),
        Transform([-1., 0.25, 0.3, 0.9, 23.125, -2.375]),
    ] {
        shapes.push(
            Path::rectangle(21.3, 17.7, [6., 4., 5., 2.], 0.6)
                .flatten(transform, 1. / 64.)
                .unwrap(),
        );
        shapes.push(
            Path::ellipse(23.5, 19.25)
                .flatten(transform, 1. / 64.)
                .unwrap(),
        );
    }
    let mut compound = Path::rectangle(23., 21., [0.; 4], 0.)
        .flatten(Transform::default(), 1. / 64.)
        .unwrap();
    let mut hole = Path::rectangle(12., 9., [0.; 4], 0.)
        .flatten(Transform([1., 0., 0., 1., 3.125, 4.375]), 1. / 64.)
        .unwrap();
    hole[0].points.reverse();
    compound.extend(hole);
    shapes.push(compound);
    // Many disjoint spans on the same row exercise the indexed entry, including
    // multiple intervals sharing an integer bound and fractional negative x.
    for count in [1, 16, 128, 512] {
        let mut bars = Vec::new();
        for i in 0..count {
            let x = -2.125 + i as f64 * 28. / count as f64;
            bars.extend(Path::rectangle(14. / count as f64, 13.875, [0.; 4], 0.)
                .flatten(Transform([1., 0., 0., 1., x, -0.375]), 1. / 64.).unwrap());
        }
        shapes.push(bars);
    }
    shapes.push(vec![
        Contour {
            closed: true,
            points: vec![
                Point::new(0., 0.),
                Point::new(12., 0.),
                Point::new(12., 10.),
                Point::new(0., 10.)
            ]
        };
        256
    ]);
    shapes.push(
        Path::rectangle(31.7, 25.3, [0.; 4], 0.)
            .flatten(
                Transform([0.93, 0.21, -0.17, 1.07, 9.125, 3.375]),
                1. / 8192.,
            )
            .unwrap(),
    );
    let mut programs = Vec::new();
    let mut positions = Vec::new();
    let mut expected = Vec::new();
    for shape in &shapes {
        for even_odd in [false, true] {
            for rect in [Rect::new(-4, -4, 32, 32), Rect::new(4, 3, 7, 9)] {
                for mode in 0..6 {
                    let sample = if mode >= 2 { Some(mode - 2) } else { None };
                    let mask = if mode == 0 {
                        raster::rasterize(shape, rect, even_odd)
                    } else {
                        raster::rasterize_sample_linear(shape, rect, even_odd, sample)
                    };
                    let program = if mode == 0 {
                        AreaProgram::compile(shape, rect, even_odd)
                    } else {
                        AreaProgram::compile_samples(shape, rect, even_odd)
                    }
                    .unwrap();
                    assert_eq!(mask.rect, program.rect);
                    let id = programs.len();
                    for y in 0..mask.rect.h {
                        for x in 0..mask.rect.w {
                            positions.push([id as u32, x, y, sample.map_or(0, |s| s as u32 + 1)]);
                            expected.push(
                                mask.at(mask.rect.x + x as i32, mask.rect.y + y as i32)
                                    .to_bits(),
                            );
                        }
                    }
                    programs.push(program);
                }
            }
        }
    }
    let mut words = vec![0_u32; positions.len() * 4];
    let mut offsets = Vec::new();
    for program in programs {
        offsets.push(words.len() as u32);
        words.extend(program.data.into_iter().map(f32::to_bits));
    }
    for (i, p) in positions.iter().enumerate() {
        words[i * 4..i * 4 + 4].copy_from_slice(&[offsets[p[0] as usize], p[1], p[2], p[3]]);
    }
    let input: Vec<u8> = words.into_iter().flat_map(u32::to_le_bytes).collect();
    let source = include_str!("../../design-kernel/shaders/vector.wgsl");
    let first = source.find("fn fixedLinear").unwrap();
    let start = source.find("fn scaledPositive64").unwrap();
    let end = source.find("fn paintUV").unwrap();
    let shader = format!(
        "{}\n{}\n{}\n{}\n{}",
        &source[..first],
        &source[start..end],
        include_str!("../../design-kernel/shaders/coverage64.wgsl"),
        include_str!("../../design-kernel/shaders/area.wgsl"),
        r#"
@group(0) @binding(0) var<storage,read> inputs:array<u32>;
@group(0) @binding(1) var<storage,read_write> outputs:array<u32>;
var<private> base:u32;
var<private> sample:u32;
fn cvSampleIndex()->i32{return i32(sample);}
fn cvFetch(index:u32)->vec4<f32>{let at=base+index*4u;return bitcast<vec4<f32>>(vec4<u32>(inputs[at],inputs[at+1u],inputs[at+2u],inputs[at+3u]));}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>){
 if(id.x>=arrayLength(&outputs)){return;}let at=id.x*4u;base=inputs[at];sample=inputs[at+3u];
 outputs[id.x]=bitcast<u32>(areaCoverage(vec2<i32>(i32(inputs[at+1u]),i32(inputs[at+2u]))));
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
        label: Some("Production analytic coverage program"),
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
    let size = expected.len() as u64 * 4;
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
        pass.dispatch_workgroups((expected.len() as u32).div_ceil(64), 1, 1);
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
        let expected = expected[i];
        if actual != expected {
            failures.push(serde_json::json!({"index":i,"pixel":positions[i],"actual":actual}));
        }
    }
    eprintln!(
        "{} area pixels; {} bit differences; first {:?}",
        expected.len(),
        failures.len(),
        &failures[..failures.len().min(8)]
    );
    assert!(
        failures.is_empty(),
        "analytic area program differs from exact oracle"
    );
}
