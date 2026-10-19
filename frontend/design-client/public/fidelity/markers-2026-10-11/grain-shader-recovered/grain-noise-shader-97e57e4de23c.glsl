// v2 custom effect. `setup(device, frame)` is called once and owns the
// pipeline / sampler / vertex buffer; `render(device, frame)` samples
// `frame.input` and writes to `frame.output` every frame.
//
// This template produces a static retro VCR look - magnetic-tape tracking
// wobble, chromatic aberration, a green/red color cast, film grain,
// scanlines, and a CRT-style vignette. Edit fs_main to change the look.

import { defineProperties } from "figma:react";

export default function Effect() {}

const WGSL = `
struct VsIn {
  @location(0) pos: vec2<f32>,
  @location(1) uv: vec2<f32>,
};
struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
  var out: VsOut;
  out.position = vec4<f32>(in.pos, 0.0, 1.0);
  out.uv = in.uv;
  return out;
}

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;

fn hash11(p: f32) -> f32 {
  let x = fract(p * 0.1031);
  let q = x * (x + 33.33);
  return fract(q * q);
}

fn hash12(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  var uv = in.uv;

  // Tape tracking: every scanline wobbles a little, and a small fraction of
  // wider bands slip sideways like the head lost the track.
  let lineJitter = (hash11(floor(uv.y * 400.0)) - 0.5) * 0.003;
  let bandRand = hash11(floor(uv.y * 30.0));
  let bandShift = select(0.0, (bandRand - 0.5) * 0.08, bandRand > 0.9);
  uv.x = uv.x + lineJitter + bandShift;

  // Chromatic aberration that ramps up toward the horizontal edges, like a
  // cheap lens with purple fringing.
  let edgeFalloff = abs(in.uv.x - 0.5) * 2.0;
  let aberration = 0.012 + 0.02 * edgeFalloff;
  let r = textureSample(inputTex, inputSampler, uv + vec2<f32>(aberration, 0.0)).r;
  let g = textureSample(inputTex, inputSampler, uv).g;
  let b = textureSample(inputTex, inputSampler, uv - vec2<f32>(aberration, 0.0)).b;
  let a = textureSample(inputTex, inputSampler, uv).a;

  var color = vec3<f32>(r, g, b);

  // Magnetic-tape color cast: drop a little red, nudge green up.
  color = color * vec3<f32>(0.94, 1.02, 1.0);

  // Snow: fine per-pixel grain so flat regions don't look inert.
  let grain = (hash12(floor(in.position.xy)) - 0.5) * 0.12;
  color = color + vec3<f32>(grain);

  // Scanlines: every other pixel row is slightly darker.
  let scanline = 1.0 - 0.10 * (0.5 + 0.5 * sin(in.position.y * 3.14159));
  color = color * scanline;

  // Vignette: CRT-style corner dimming around the radial center of the uv
  // square (reads as an oval on non-square effects, which is on-theme).
  let d = distance(in.uv, vec2<f32>(0.5, 0.5));
  let vignette = 1.0 - smoothstep(0.4, 0.85, d) * 0.45;
  color = color * vignette;

  return vec4<f32>(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), a);
}
`;

export function setup(device, frame) {
  var module = device.createShaderModule({ code: WGSL });

  frame.state.pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vs_main",
      buffers: [{
        arrayStride: 16,
        attributes: [
          { shaderLocation: 0, format: "float32x2", offset: 0 },
          { shaderLocation: 1, format: "float32x2", offset: 8 },
        ],
      }],
    },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [{ format: "rgba8unorm" }],
    },
    primitive: { topology: "triangle-list" },
  });

  frame.state.quad = device.createBuffer({
    size: 6 * 4 * 4,
    usage: GPUBufferUsage.VERTEX,
    mappedAtCreation: true,
  });
  new Float32Array(frame.state.quad.getMappedRange()).set([
    -1, -1,   0, 1,
     1, -1,   1, 1,
    -1,  1,   0, 0,
    -1,  1,   0, 0,
     1, -1,   1, 1,
     1,  1,   1, 0,
  ]);
  frame.state.quad.unmap();

  frame.state.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
}

export function render(device, frame) {
  if (!frame.input) return;

  var bindGroup = device.createBindGroup({
    layout: frame.state.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: frame.input.createView() },
      { binding: 1, resource: frame.state.sampler },
    ],
  });

  var encoder = device.createCommandEncoder();
  var pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: frame.output.createView(),
      loadOp: "clear",
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
      storeOp: "store",
    }],
  });
  pass.setPipeline(frame.state.pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.setVertexBuffer(0, frame.state.quad);
  pass.draw(6);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

defineProperties(Effect, {});
