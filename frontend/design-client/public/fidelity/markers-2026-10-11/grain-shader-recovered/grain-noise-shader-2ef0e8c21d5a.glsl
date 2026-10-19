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
@group(0) @binding(2) var<uniform> uParams: vec4<f32>;

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
  let t = uParams.x * 0.001;
  var uv = in.uv;

  // Slow, wandering "intensity" so the glitches breathe instead of running
  // at a constant rate.
  let intensity = 0.5 + 0.5 * sin(t * 0.37);

  // Horizontal tape slices: divide the image into chunky bands that slip
  // sideways independently. The band seed advances with time so the set of
  // misaligned bands cycles.
  let bandId = floor(uv.y * 28.0 + floor(t * 6.0));
  let bandRand = hash11(bandId);
  let bandActive = step(0.82 - intensity * 0.2, bandRand);
  let bandShift = (hash11(bandId * 1.73) - 0.5) * 0.12 * bandActive;
  uv.x = uv.x + bandShift;

  // Per-scanline jitter layered on top of the bands.
  let lineJitter = (hash11(floor(uv.y * 600.0) + floor(t * 60.0)) - 0.5) * 0.004;
  uv.x = uv.x + lineJitter;

  // Block corruption: small rectangular regions of the frame get offset and
  // color-inverted, like missing macroblocks.
  let blockCoord = floor(vec2<f32>(uv.x * 32.0, uv.y * 20.0) + vec2<f32>(floor(t * 9.0)));
  let blockRand = hash12(blockCoord);
  let blockBroken = step(0.94 - intensity * 0.05, blockRand);
  let blockOffset = vec2<f32>(
    (hash12(blockCoord + 7.0) - 0.5) * 0.15,
    (hash12(blockCoord + 13.0) - 0.5) * 0.04,
  ) * blockBroken;
  uv = uv + blockOffset;

  // Chromatic aberration: split the RGB taps apart. The separation wobbles so
  // it reads as signal drift, and ramps up with bandShift so torn regions
  // look more broken.
  let aberration = 0.004 + 0.008 * abs(sin(t * 2.0)) + abs(bandShift) * 0.25;
  let r = textureSample(inputTex, inputSampler, uv + vec2<f32>(aberration, 0.0)).r;
  let g = textureSample(inputTex, inputSampler, uv).g;
  let b = textureSample(inputTex, inputSampler, uv - vec2<f32>(aberration, 0.0)).b;
  let a = textureSample(inputTex, inputSampler, uv).a;
  var color = vec3<f32>(r, g, b);

  // Invert the broken blocks so they flash cyan/magenta against the original.
  color = mix(color, vec3<f32>(1.0) - color, blockBroken * 0.75);

  // Dropout bars: rare, wide horizontal strips go almost black, like a dead
  // VSync frame.
  let dropoutRand = hash11(floor(uv.y * 6.0) + floor(t * 2.0));
  let dropout = step(0.97, dropoutRand);
  color = mix(color, vec3<f32>(0.04, 0.04, 0.06), dropout * 0.85);

  // Fine digital noise so flat regions stay alive.
  let grain = (hash12(floor(in.position.xy) + floor(t * 120.0)) - 0.5) * 0.18;
  color = color + vec3<f32>(grain);

  // Scanlines that crawl downward with time.
  let scanline = 1.0 - 0.18 * (0.5 + 0.5 * sin(in.position.y * 3.14159 + t * 8.0));
  color = color * scanline;

  // Occasional global flicker 