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

struct Params {
  // Cursor position normalized to [0,1] UV (top-left origin, y down). Computed
  // in render() as mousePosition / output size and compared against the vertex
  // uv attribute, so it never depends on the builtin fragment position's
  // render target origin (which a viewport/pooling offset could shift).
  mouseUv: vec2<f32>,
  // width / height: keeps the halo a true circle on non-square frames.
  aspect: f32,
  // frame.time in milliseconds.
  time: f32,
  // Halo radius in UV units (fraction of frame height).
  haloSize: f32,
  // Additive strength of the soft inner glow.
  glowStrength: f32,
  // Depth of the scanline darkening.
  scanlineStrength: f32,
  _pad: f32,
};

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> uParams: Params;

const PI: f32 = 3.14159265;

fn hash12(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

// Barrel distortion that fakes the outward bulge of a CRT picture tube.
fn curveUv(uv: vec2<f32>) -> vec2<f32> {
  var c = uv * 2.0 - 1.0;
  let off = abs(c.yx) / vec2<f32>(3.5, 4.5);
  c = c + c * off * off;
  return c * 0.5 + 0.5;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let t = uParams.time * 0.001;

  // Bulge the sampled image so it reads as a curved tube.
  let cuv = curveUv(in.uv);
  // Anything the curve pushes past [0,1] is the black bezel outside the glass.
  let inside = step(0.0, cuv.x) * step(cuv.x, 1.0) *
               step(0.0, cuv.y) * step(cuv.y, 1.0);

  // Chromatic aberration: spread the RGB taps apart toward the edges.
  let edge = cuv - vec2<f32>(0.5);
  let ab = 0.003 + 0.010 * dot(edge, edge);
  let r = textureSample(inputTex, inputSampler, cuv + vec2<f32>(ab, 0.0)).r;
  let g = textureSample(inputTex, inputSampler, cuv).g;
  let b = textureSample(inputTex, inputSampler, cuv - vec2<f32>(ab, 0.0)).b;
  var color = vec3<f32>(r, g, b);

  // Aperture-grille phosphor mask: vertical R/G/B triads down the screen.
  let phase = i32(floor(in.position.x)) % 3;
  var mask = vec3<f32>(0.35, 0.35, 0.35);
  if (phase == 0) { mask = vec3<f32>(1.0, 0.4, 0.4); }
  else if (phase == 1) { mask = vec3<f32>(0.4, 1.0, 0.4); }
  else { mask = vec3<f32>(0.4, 0.4, 1.0); }
  color = color * mask;

  // Scanlines that crawl slowly downward.
  let scan = 0.5 + 0.5 * sin(in.position.y * PI - t * 6.0);
  color = color * (1.0 - uParams.scanlineStrength * scan);

  // Rolling brightness bar, like a vertical hold that never quite locks.
  let rollPos = fract(t * 0.12);
  let rollDist = abs(fract(in.uv.y - rollPos + 0.5) - 0.5);
  color = color * (0.82 + 0.18 * smoothstep(0.0, 0.18, rollDist));

  // Static snow so flat regions stay alive.
  let n = hash12(floor(in.position.xy) + floor(vec2<f32>(t * 57.0, t * 91.0)));
  color = color + (n - 0.5) * 0.06;

  // CRT vignette.
  let vd = distance(in.uv, vec2<f32>(0.5));
  color = color * (1.0 - smoothstep(0.45, 0.95, vd) * 0.6);

  // --- Mouse halo -------------------------------------------------------
  // Work in the same UV space as the cursor (in.uv). Scale x by aspect so the
  // halo stays circular rather than stretching on non-square frames.
  var delta = in.uv - uParams.mouseUv;
  delta.x = delta.x * uParams.aspect;
  let dist = length(delta);
  let baseR = uParams.haloSize;
  let pulse = 0.88 + 0.12 * sin(t * 3.0);
  let ringR = baseR * pulse;
  let ringW = max(baseR * 0.16, 0.001);
  let ringX = (dist - ringR) / ringW;
  let ring = exp(-ringX * ringX);
  let glowR = max(baseR * 0.6, 0.001);
  let glow = exp(-(dist * dist) / (2.0 * glowR * glowR));
  // Slowly cycle the halo through cyan / green / magenta phosphor tints.
  let haloTint = 0.5 + 0.5 * sin(t * 0.7 + vec3<f32>(0.0, 2.094, 4.188));
  color = color + (ring * 1.3 + glow * uParams.glowStrength) * haloTint;

  // Mask off the curved-tube bezel last so the halo respects the glass too.
  color = color * inside;

  return vec4<f32>(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
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

  // mouse.xy, resolution.xy, time, + padding to a 32-byte uniform.
  frame.state.paramsBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

export function render(device, frame) {
  if (!frame.input) return;

  var mouse = frame.mousePosition || { x: 0, y: 0 };
  var w = frame.output.width;
  var h = frame.output.height;
  // mousePosition is in effect-local pixels; normalize to the same [0,1] UV
  // space as the vertex uv attribute the shader interpolates.
  var mouseUvX = w > 0 ? mouse.x / w : 0;
  var mouseUvY = h > 0 ? mouse.y / h : 0;
  var aspect = h > 0 ? w / h : 1;

  var p = frame.params || {};
  var haloSize = p.haloSize !== undefined ? p.haloSize : 0.22;
  var glowStrength = p.glowStrength !== undefined ? p.glowStrength : 0.45;
  var scanlineStrength = p.scanlineStrength !== undefined ? p.scanlineStrength : 0.28;
  device.queue.writeBuffer(
    frame.state.paramsBuffer,
    0,
    new Float32Array([
      mouseUvX, mouseUvY,
      aspect, frame.time,
      haloSize, glowStrength, scanlineStrength, 0,
    ]),
  );

  var bindGroup = device.createBindGroup({
    layout: frame.state.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: frame.input.createView() },
      { binding: 1, resource: frame.state.sampler },
      { binding: 2, resource: { buffer: frame.state.paramsBuffer } },
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

defineProperties(Effect, {
  haloSize: {
    type: "number",
    label: "Halo Size",
    defaultValue: 0.22,
    control: "slider",
    min: 0.05,
    max: 0.5,
    step: 0.01,
  },
  glowStrength: {
    type: "number",
    label: "Glow Strength",
    defaultValue: 0.45,
    control: "slider",
    min: 0.0,
    max: 1.0,
    step: 0.01,
  },
  scanlineStrength: {
    type: "number",
    label: "Scanlines",
    defaultValue: 0.28,
    control: "slider",
    min: 0.0,
    max: 1.0,
    step: 0.01,
  },
});
