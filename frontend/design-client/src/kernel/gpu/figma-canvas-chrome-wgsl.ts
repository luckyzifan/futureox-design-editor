/** Figma 画布镶边 WGSL(棋盘两档/点背景/网格十字线)。 */
export const figmaCanvasChromeWgsl = `// Figma 画布镶边着色器。
// 源码事实:checkerboardStyle 四档(0=无,1=亮棋盘,2=暗棋盘,3=点背景);
// 棋盘两色是 1.0/0.95(亮)与 0.12/0.17(暗),按 fract(c*scale)-0.5 的叉积符号切换;
// 点背景的网格大小随 zoomScale 指数降档(32×16→16×16→…→1×16,基 16px);
// 网格线是亚像素十字线(a() 函数:粗细 <1px 的两条细线,亮度反演保护暗背景)。
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

// 其 z(float zoomScale):点背景网格大小的指数降档
fn dotGridSize(zoomScale: f32) -> f32 {
  let u = 16.0;
  if (zoomScale < 0.03125) { return 32.0 * u; }
  else if (zoomScale < 0.0625) { return 16.0 * u; }
  else if (zoomScale < 0.125) { return 8.0 * u; }
  else if (zoomScale < 0.25) { return 4.0 * u; }
  else if (zoomScale < 0.5) { return 2.0 * u; }
  else { return u; }
}

// 其 a(vec3 b, vec2 c, float d):网格十字线。d = 线粗(像素)
fn gridLines(b: vec3<f32>, c: vec2<f32>, d: f32) -> vec3<f32> {
  let e = fract(c);
  let f = max(f32(e.x < d), f32(e.y < d));
  var g: vec3<f32>;
  let h = vec3<f32>(0.299, 0.587, 0.114);           // 其亮度权重
  let i = dot(b * b, h);                             // 平方亮度(避免 sqrt)
  let j = sqrt(i);
  if (j > 0.5) {
    let k = (j - 0.05) / j;
    g = b * k;                                       // 亮背景:整体暗 5%
  } else {
    let k = j * 0.8 + 0.15;
    let l = dot(b, h);
    let m = 1.0 - 2.0 * l + i;
    let n = i - l;
    // 其根式选亮分支
    g = mix(b, vec3<f32>(1.0), (n + sqrt(n * n - m * (i - k * k))) / m);
  }
  return mix(b, g, f);
}

fn o1(p: f32) -> f32 { return floor(p + 0.5); }
fn o2(q: vec2<f32>) -> vec2<f32> { return floor(q + vec2<f32>(0.5)); }

@fragment
fn fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let dstRect = params.values[0];   // (x,y,w,h)
  let checkerboardStyle = i32(params.values[9].x);  // 0 无|1 亮|2 暗|3 点背景
  let unpremultiplyAlpha = params.values[9].y > 0.5;
  let alphaMultiplier = params.values[9].z;
  let zoomScale = params.values[9].w;
  let gridData = params.values[10].xy;               // (线粗 px, 棋盘 scale)
  let pageColor = params.values[11];                 // 底色(含 alpha)
  let dotBase = params.values[12].x;
  let dotZoomedOut = params.values[12].y;
  let dotColorDiff = params.values[12].z;
  // 世界坐标(其 _position4.xy 语义):设备像素 / zoomScale
  let world = position.xy / max(zoomScale, 1e-9);

  let uv = (position.xy + vec2<f32>(0.5)) / dstRect.zw;
  var am = textureSample(texture0, texSampler, uv) * alphaMultiplier;

  if (checkerboardStyle == 0) {
    if (unpremultiplyAlpha) {
      return vec4<f32>(am.rgb / max(am.a, 0.00001), am.a);
    }
    return am;
  }
  var ad: f32;
  let ac = gridData.y;
  if (checkerboardStyle == 1) {                      // 亮棋盘 1.0/0.95
    let ae = fract(world * ac) - vec2<f32>(0.5);
    ad = select(0.95, 1.0, ae.x * ae.y < 0.0);
  } else if (checkerboardStyle == 2) {               // 暗棋盘 0.12/0.17
    let ae = fract(world * ac) - vec2<f32>(0.5);
    ad = select(0.17, 0.12, ae.x * ae.y < 0.0);
  } else {                                           // 点背景
    let d = dotGridSize(zoomScale);
    let af = smoothstep(0.5, 1.0, zoomScale);
    let ag = dotZoomedOut + dotColorDiff * af;
    let ah = o2(world / d) * d;
    let ai = length(world - ah);
    let aj = ai * zoomScale;
    let ak = max(0.5, 1.0 * zoomScale);
    let al = 1.0 - smoothstep(0.0, 1.0, (aj - ak + 0.5));
    ad = mix(dotBase, ag, al);
  }
  // 内容叠底:ad*(1-contentAlpha) + contentRGB
  let b = ad * (1.0 - am.a) + am.rgb;
  let withGrid = gridLines(b, world, gridData.x);
  return vec4<f32>(withGrid, 1.0);
}
`
