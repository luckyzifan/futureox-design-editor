// Integer uniform-box blur. One lane owns one scanline and advances a byte sum,
// matching the mode-22 byte box: round(sample*255), then (sum + denom/2) / denom.
struct Params { values: array<vec4<f32>, 64> }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source_tex: texture_2d<f32>;
@group(0) @binding(2) var output_tex: texture_storage_2d<rgba8unorm, write>;

fn u(i: u32) -> vec4<f32> { return params.values[i]; }

fn blur_byte(world: vec2<f32>) -> vec4<u32> {
  var q = world;
  if (u(9u).z > 0.5) {
    q = clamp(q, u(1u).xy + vec2<f32>(0.5), u(1u).xy + u(1u).zw - vec2<f32>(0.5));
  }
  let texel = vec2<i32>(floor(q - u(1u).xy));
  if (any(texel < vec2<i32>(0)) || any(texel >= vec2<i32>(vec2<f32>(u(1u).zw)))) {
    return vec4<u32>(0u);
  }
  return vec4<u32>(round(textureLoad(source_tex, texel, 0) * 255.0));
}

@compute @workgroup_size(64)
fn slideBox(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  let horizontal = u(9u).y < 0.5;
  let origin = u(0u).xy;
  let width = u32(u(0u).z);
  let height = u32(u(0u).w);
  let radius = i32(u(9u).x);
  if (radius <= 0) { return; }
  let denom = u32(radius * 2 + 1);
  let lines = select(width, height, horizontal);
  let length = i32(select(height, width, horizontal));
  let line = group.x * 64u + lane;
  if (line >= lines || length <= 0) { return; }
  let axis = select(vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), horizontal);
  let fixed = select(vec2<f32>(f32(line) + 0.5, 0.5), vec2<f32>(0.5, f32(line) + 0.5), horizontal);
  var sum = vec4<u32>(0u);
  for (var i = -radius; i <= radius; i = i + 1) {
    sum = sum + blur_byte(origin + fixed + axis * f32(i));
  }
  for (var at = 0; at < length; at = at + 1) {
    let q = (sum + vec4<u32>(denom / 2u)) / vec4<u32>(denom);
    let tex = select(vec2<i32>(i32(line), at), vec2<i32>(at, i32(line)), horizontal);
    textureStore(output_tex, tex, vec4<f32>(vec4<f32>(q) / 255.0));
    if (at + 1 < length) {
      let step = vec2<f32>(f32(at + 1), 0.0);
      let moved = select(vec2<f32>(0.0, step.x), step, horizontal);
      sum = sum + blur_byte(origin + fixed + moved + axis * f32(radius)) - blur_byte(origin + fixed + moved - axis * f32(radius + 1));
    }
  }
}
