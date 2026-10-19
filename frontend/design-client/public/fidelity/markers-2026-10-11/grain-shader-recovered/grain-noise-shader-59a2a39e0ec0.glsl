const WGSL = `
struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VSOut {
  // Full-screen triangle that covers [-1, 1] in clip space.
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var uv = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0),
  );
  var out: VSOut;
  out.position = vec4<f32>(pos[i], 0.0, 1.0);
  out.uv = uv[i];
  return out;
}

fn hash11(p: f32) -> f32 {
  let x = fract(p * 0.1031);
  let q = x * (x + 33.33);
  return fract(q * q);
}

fn hash12(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
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
  let r = uv.x + aberration;
  let g = uv.y;
  let b = uv.x - aberration;
  let a = 1.0;

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

export function setup(ctx) {
  ctx.state.shader = ctx.compileShader(WGSL);
}

export function render(ctx) {
  ctx.renderPass({
    shader: ctx.state.shader,
    bindGroups: [
    ],
    vertices: 3,
    clear: { r: 0, g: 0, b: 0, a: 0 },
  });
}