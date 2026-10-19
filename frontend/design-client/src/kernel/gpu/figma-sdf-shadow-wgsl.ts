/** Figma SDF 阴影 WGSL(shader_129 逐行移植:帐篷核积分 + SDF 圆角盒 + AAA)。 */
export const figmaSdfShadowWgsl = `// Figma SDF 阴影蒙版,逐行移植自 shader_129(figma-wasm-analysis/shaders/)。
// 源码事实:圆角矩形阴影 = 解析积分(shadow_coverage y 函数:4 步数值积分
// 帐篷核平滑边缘)+ SDF 圆角盒蒙版(bw/bt 函数:标准 SDF + 内圆角钳制)
// + AAA 抗锯齿(bq:fwidth smoothstep)或硬边(1-step)。
// 抖动着色器 d()(fract(sin(dot(...))*43758.5453))未移植——仅用于其
// RGBA8 抖动,浮点管线不需要。
struct Params { values: array<vec4<f32>, 64> }
@group(0) @binding(0) var<uniform> params: Params;

@vertex
fn quad(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

// 其 g(float h):帐篷核 CDF(三次曲线分段)
fn smoothCdf(h: f32) -> f32 {
  if (h < -1.0) { return 0.0; }
  else if (h < 0.0) { return 0.5 * (h + 1.0) * (h + 1.0); }
  else if (h < 1.0) { return 0.5 - 0.5 * h * (h - 2.0); }
  else { return 1.0; }
}
// 其 i(float h):帐篷核 PDF(1-|h|)
fn tentPdf(h: f32) -> f32 { return max(0.0, 1.0 - abs(h)); }

// 其 l():一维圆弧 SDF 覆盖
fn arcCoverage(m: f32, n: f32, o: f32, p: f32, q: f32) -> f32 {
  let r = min(q - o - abs(n), 0.0);
  let s = p - o + sqrt(max(0.0, o * o - r * r));
  let t = vec2<f32>(m + s, m - s);
  return smoothCdf(t.x) - smoothCdf(t.y);
}
// 其 u()/x():水平/竖直方向包装
fn horizCoverage(h: f32, v: f32, o: f32, w: vec2<f32>) -> f32 {
  return arcCoverage(v, h, o, w.y, w.x);
}
fn vertCoverage(h: f32, v: f32, o: f32, w: vec2<f32>) -> f32 {
  return arcCoverage(h, v, o, w.x, w.y);
}

// 其 y(vec2 z, vec2 aa, float ab):阴影覆盖(4 步数值积分)
// z = 归一化阴影坐标,aa = 归一化半尺寸,ab = 归一化圆角
fn shadowCoverage(z: vec2<f32>, aa: vec2<f32>, ab: f32) -> f32 {
  const STEPS: i32 = 4;
  var sum: f32 = 0.0;
  var weightSum: f32 = 0.0;
  if (abs(z.x) > abs(z.y)) {
    let lo = clamp(-1.0, z.y - aa.y, z.y + aa.y);
    let hi = clamp(1.0, z.y - aa.y, z.y + aa.y);
    if (lo == hi) { return 0.0; }
    let step = (hi - lo) / f32(STEPS);
    var v = lo + step * 0.5;
    for (var k: i32 = 0; k < STEPS; k++) {
      let pdf = tentPdf(v);
      sum += vertCoverage(z.x, z.y - v, ab, aa) * pdf;
      weightSum += pdf;
      v += step;
    }
    return sum * ((smoothCdf(hi) - smoothCdf(lo)) / weightSum);
  } else {
    let lo = clamp(-1.0, z.x - aa.x, z.x + aa.x);
    let hi = clamp(1.0, z.x - aa.x, z.x + aa.x);
    if (lo == hi) { return 0.0; }
    let step = (hi - lo) / f32(STEPS);
    var h = lo + step * 0.5;
    for (var k: i32 = 0; k < STEPS; k++) {
      let pdf = tentPdf(h);
      sum += horizCoverage(z.x - h, z.y, ab, aa) * pdf;
      weightSum += pdf;
      h += step;
    }
    return sum * ((smoothCdf(hi) - smoothCdf(lo)) / weightSum);
  }
}

// 其 bt(vec2 bu, vec2 w):标准 SDF 盒
fn sdfBox(bu: vec2<f32>, w: vec2<f32>) -> f32 {
  let bv = abs(bu) - w;
  return length(max(bv, vec2<f32>(0.0))) + min(max(bv.x, bv.y), 0.0);
}
// 其 bw(vec2 bu, vec2 w, float o):圆角 SDF 盒(内圆角钳制)
fn sdfRoundedBox(bu: vec2<f32>, w: vec2<f32>, o: f32) -> f32 {
  let bx = min(o, min(w.x, w.y));
  return sdfBox(bu, w - vec2<f32>(bx)) - bx;
}
// 其 bq(float br):AAA 抗锯齿(fwidth smoothstep)
fn aaa(br: f32) -> f32 {
  let bs = max(fwidth(br), 0.00001);
  let distance = br / bs;
  return 1.0 - smoothstep(-0.5, 0.5, distance);
}

@fragment
fn fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let dstRect = params.values[0];          // (x,y,w,h)
  let maskCornerRadius = params.values[9].x;
  let shadowCornerRadius = params.values[9].y;
  let maskHalfSize = params.values[10].xy;
  let shadowHalfSize = params.values[10].zw;
  let invBlurRadius = params.values[11].x;
  let color = params.values[12];           // 阴影色(含 alpha)
  let useAAAMask = params.values[11].y > 0.5;
  // 中心化坐标(其 _centeredMaskRectCoords / _centeredNormShadowBlurCoords)
  let uv = (position.xy + vec2<f32>(0.5) - dstRect.xy) / dstRect.zw;  // [0,1]
  let maskCoords = (uv - vec2<f32>(0.5)) * maskHalfSize * 2.0;        // 像素
  let shadowBlurCoords = (uv - vec2<f32>(0.5)) * shadowHalfSize * 2.0 * invBlurRadius; // 归一化

  // 阴影覆盖(1 - 内覆盖率 → 外扩)
  let shadow = 1.0 - shadowCoverage(shadowBlurCoords, shadowHalfSize * invBlurRadius,
                                     shadowCornerRadius * invBlurRadius);
  // 蒙版 SDF
  let maskSdf = sdfRoundedBox(maskCoords, maskHalfSize, maskCornerRadius);
  let mask = select(1.0 - step(0.0, maskSdf), aaa(maskSdf), useAAAMask);
  return color * (shadow * mask);
}
`
