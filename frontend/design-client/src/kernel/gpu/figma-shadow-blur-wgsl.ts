/** Figma 阴影模糊 WGSL(标量成对帐篷 + RGBA 打包阶梯)。 */
export const figmaShadowBlurWgsl = `// Figma 阴影模糊 pass。
// 算法事实:阴影是单标量(alpha)的成对帐篷模糊;RGBA8 精度下标量经
// 1/255 → 1/65025 → 1/16581375 三级阶梯打包进 vec4,unpack 是点积还原:
//   vec2 pack(b): c=floor(b*255)/255; d=(b-c)*255 → (c,d)
//   vec4 pack4(b): 两级嵌套 pack(残差放大 65025)
//   float unpack(v) = dot(v, vec4(1, 1/255, 1/65025, 1/16581375))
// 循环与主模糊完全同构(≤64 有界、count-k 帐篷、成对插值),
// 差异仅在标量域 + 归一化除 max(t, 1e-20)。
struct Params { values: array<vec4<f32>, 64> }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var texSampler: sampler;
@group(0) @binding(2) var texture0: texture_2d<f32>;

@vertex
fn quad(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

// 其 vec2 a(float b):一级打包(高字节为分数,低字节为残差)
fn pack2(b: f32) -> vec2<f32> {
  let c = floor(b * 255.0) * (1.0 / 255.0);
  let d = (b - c) * 255.0;
  return vec2<f32>(c, d);
}
// 其 vec4 e(float b):两级嵌套,残差放大 65025 再打包
fn pack4(b: f32) -> vec4<f32> {
  let f = pack2(b);
  let g = f.x + f.y * (1.0 / 255.0);
  let h = (b - g) * 65025.0;
  let i = pack2(h);
  return vec4<f32>(f, i);
}
// 其 float k(vec4 l):点积还原(1/16581375 = 1/(255^3))
fn unpack4(l: vec4<f32>) -> f32 {
  return dot(l, vec4<f32>(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}

const MAX_TAPS: i32 = 64;

fn sampleScalar(coord: vec2<f32>, inputIsPacked: bool) -> f32 {
  let p = textureSample(texture0, texSampler, coord);
  return select(clamp(p.a, 0.0, 1.0), unpack4(p), inputIsPacked);
}

@fragment
fn fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let dstRect = params.values[0];
  let srcRect = params.values[1];
  let radius = params.values[9].x;
  let horizontal = params.values[9].y < 0.5;
  let inputIsPacked = params.values[9].z > 0.5;  // 其 uniform int inputIsPacked
  let count = params.values[10].x;
  let spacing = radius / max(count, 1.0);
  let delta = select(vec2<f32>(0.0, spacing / srcRect.w), vec2<f32>(spacing / srcRect.z, 0.0), horizontal);
  let uv = (position.xy + dstRect.xy - srcRect.xy) / srcRect.zw;
  // 其 n(vec2):标量样本(打包域 unpack / 非打包取 alpha 钳制)——无捕获闭包提升为函数,打包旗经全局传递
  var s = sampleScalar(uv, inputIsPacked) * count;
  var t = count;
  var e: i32 = 1;
  loop {
    if (e >= MAX_TAPS) { break; }
    if (f32(e) > count) { break; }
    let v = f32(e);
    let w = min(v + 1.0, count);
    let ab = count - v;
    let ac = count - w;
    let ad = ab + ac;
    let ae = (uv - delta * v) * (ab / ad) + (uv - delta * w) * (ac / ad);
    let af = (uv + delta * v) * (ab / ad) + (uv + delta * w) * (ac / ad);
    s += ad * (sampleScalar(ae, inputIsPacked) + sampleScalar(af, inputIsPacked));
    t += 2.0 * ad;
    e += 2;
  }
  // 其归一化:max(t, 1e-20) 防零;输出经 pack4 回打包域
  return pack4(s / max(t, 1e-20));
}
`
