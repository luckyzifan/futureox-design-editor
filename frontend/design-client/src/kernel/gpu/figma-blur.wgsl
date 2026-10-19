// Figma 成对采样帐篷模糊。
// 算法事实(源码):uniform 携 CPU 计算的 count 与 blurDelta;≤64 有界循环早退;
// 帐篷权重解析(weight_k=count-k),无核纹理;相邻 tap 位置按权重插值,一次线性
// fetch = 两次 tap 的加权平均(带宽减半)。
// 绑定沿用驱动 Params 约定:values[9] = (radius, direction, clampEdges, hasKernel),
// 矩形/尺寸取 values[0..1];count 由 CPU 按 count=radius·√6 夹 64 预计算写入 values[10]。
struct Params { values: array<vec4<f32>, 64> }  // uniform 地址空间禁止未定尺寸数组(参照 displayFilter 同款定尺寸)
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var texSampler: sampler;
@group(0) @binding(2) var texture0: texture_2d<f32>;

@vertex
fn quad(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

const MAX_TAPS: i32 = 64;  // 其 const int a=64

@fragment
fn fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let dstRect = params.values[0];  // 目标矩形(x, y, w, h,像素)
  let srcRect = params.values[1]; // 源矩形(x, y, w, h)——尺寸与原点同 displayFilter 约定
  let radius = params.values[9].x;
  let horizontal = params.values[9].y < 0.5;
  let count = params.values[10].x; // CPU 预计算:min(64, radius·√6)
  // 其 blurDelta 契约:总跨度 = radius 纹素,count 个 tap 均布 → 步进 = radius/count 纹素
  // (count=radius·√6 时为亚纹素步进 1/√6,成对插值因此成立;count 夹 64 后步进同步放大)
  let spacing = radius / max(count, 1.0);
  let delta = select(vec2<f32>(0.0, spacing / srcRect.w), vec2<f32>(spacing / srcRect.z, 0.0), horizontal);
  // @builtin(position) 在片元阶段已是纹素中心(含 +0.5),不再额外加
  let uv = (position.xy + dstRect.xy - srcRect.xy) / srcRect.zw;
  // 渐变模糊变体:采样位置逐 tap 钳制到 blurClamp 矩形,
  // 防止渐变方向上的采样跨界取色;values[11].x 为启用旗,values[12] 为钳制矩形。
  let clampEnabled = params.values[11].x > 0.5;
  let blurClamp = params.values[12];
  var accumulator = textureSample(texture0, texSampler,
    select(uv, clamp(uv, blurClamp.xy, blurClamp.zw), clampEnabled)) * count;
  var weightSum = count;
  var e: i32 = 1;
  loop {
    if (e >= MAX_TAPS) { break; }
    if (f32(e) >= count) { break; }                 // 其早退
    let f = f32(e);
    let g = min(f + 1.0, count);
    let l = count - f;                             // 帐篷权重(k)
    let m = count - g;                             // 帐篷权重(k+1)
    let n = l + m;
    // 成对采样(其 (h*l+j*m)/n 插值):一次线性 fetch 抵两次 tap
    let minus = (uv - delta * f) * (l / n) + (uv - delta * g) * (m / n);
    let plus = (uv + delta * f) * (l / n) + (uv + delta * g) * (m / n);
    let minusClamped = select(minus, clamp(minus, blurClamp.xy, blurClamp.zw), clampEnabled);
    let plusClamped = select(plus, clamp(plus, blurClamp.xy, blurClamp.zw), clampEnabled);
    accumulator += n * (textureSample(texture0, texSampler, minusClamped)
      + textureSample(texture0, texSampler, plusClamped));
    weightSum += 2.0 * n;
    e += 2;
  }
  return accumulator / weightSum;
}
