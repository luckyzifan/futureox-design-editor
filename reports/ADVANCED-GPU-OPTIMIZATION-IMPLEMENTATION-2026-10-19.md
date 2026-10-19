# 高级 GPU 优化实施方案
**日期**: 2026-10-19
**目标**: 将 GPU 使用率从 25-35% 提升到 40%（Figma 水平）

## 🎯 优化目标

基于 `figma-wasm-analysis/FIGMA-GAP-COMPARE.md` 的差距分析，需要完成：

### 1. 扩展实例化批渲染（预计 +5-8% GPU 使用率）

**当前状态**:
- ✅ 基础路径批处理实现 (`path-batching.ts`, 185行)
- ✅ 指纹识别、分组、编码功能
- ❌ 未集成到主渲染循环
- ❌ 仅支持纯色填充
- ❌ 无渐变、图片、描边批处理

**优化计划**:

#### A. 扩展批处理范围
```typescript
// 当前：只批处理纯色填充
if (fill.kind !== 'solid') continue

// 扩展：支持简单渐变
if (fill.kind === 'linear' || fill.kind === 'radial') {
  // 批处理相同渐变配置的实例
}

// 扩展：支持相同图片的实例
if (fill.kind === 'image' && fill.imageId) {
  // 批处理相同 imageId + fit 模式的实例
}
```

#### B. 描边批处理
```typescript
// 批处理相同描边配置
interface StrokeBatchGroup {
  strokeWidth: number
  strokeColor: string
  strokeAlign: 'center' | 'inside' | 'outside'
  dashPattern?: number[]
  instances: StrokeInstance[]
}
```

#### C. 混合模式批处理
```typescript
// 当前：跳过非 normal 混合
if (node.blend !== 'normal') continue

// 扩展：批处理相同混合模式
const batchKey = `${fingerprint.geometryHash}-${node.blend}-${fill.blend}`
```

### 2. 描边 GPU 计算管线（预计 +8-12% GPU 使用率）

**Figma 实现** (from `FIGMA-GAP-COMPARE.md:59-62`):
```
GpuStrokeBatcher 描边扩展计算管线:
- eulerStrokeFill: 欧拉法描边填充
- countsPrefixSum: 前缀和计算（GPU 并行）
- strokeOffsetDeltas: 描边偏移增量
```

**我们的现状**:
- ✅ 基础 `GpuStrokeBatcher` 类（`stroke-compute.ts:220`）
- ❌ 描边仍走 CPU/顶点路径
- ❌ 无 GPU 并行前缀和

**实施方案**:

#### A. GPU 前缀和计算 (Compute Shader)
```wgsl
// parallel-prefix-sum.wgsl
@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let i = global_id.x;
  if (i >= arrayLength(&input)) { return; }
  
  // Up-sweep phase
  var stride = 1u;
  while (stride < arrayLength(&input)) {
    if (i % (stride * 2u) == stride - 1u) {
      output[i + stride] += output[i];
    }
    stride *= 2u;
    workgroupBarrier();
  }
  
  // Down-sweep phase (省略...)
}
```

#### B. 欧拉法描边扩展
```typescript
class GpuStrokeBatcher {
  // 当前：CPU 计算描边路径
  // 优化：GPU 计算法线、偏移、连接
  
  async computeStrokePath(
    basePath: Float32Array,  // 原始路径顶点
    width: number,
    join: 'miter' | 'round' | 'bevel',
    cap: 'butt' | 'round' | 'square'
  ): Promise<Float32Array> {
    // 1. GPU 计算法线
    const normals = await this.computeNormals(basePath)
    
    // 2. GPU 计算偏移点
    const offsets = await this.computeOffsets(normals, width)
    
    // 3. GPU 计算连接点（miter/round/bevel）
    const joints = await this.computeJoints(offsets, join)
    
    // 4. GPU 计算端点（cap）
    const caps = await this.computeCaps(joints, cap)
    
    return this.mergePath(joints, caps)
  }
}
```

### 3. 玻璃效果 GPU 片元化（预计 +5-7% GPU 使用率）

**Figma 实现** (from `FIGMA-GAP-COMPARE.md:69-71`):
```
shader_71 在 shader 内算:
- 平滑圆角 SDF（Signed Distance Field）
- 法线计算
- 折射
- 倒角
- 八档色散（chromatic aberration）
- 四角独立 radii/smoothings + splay
```

**我们的现状**:
- ✅ 基础玻璃效果 (`glass-effect-gpu.ts`)
- ❌ SDF 在 CPU 计算
- ❌ 四角独立参数在 CPU 准备
- ❌ 交互档冷路径 2.6ms/185ms（根因）

**实施方案**:

#### A. Shader 内 SDF 计算
```wgsl
// glass-sdf.wgsl
fn roundedBoxSDF(p: vec2<f32>, size: vec2<f32>, radii: vec4<f32>, smoothing: f32) -> f32 {
  // 四角独立圆角 SDF
  var r = radii.x; // 默认左上角
  if (p.x > 0.0 && p.y > 0.0) { r = radii.y; } // 右上
  if (p.x > 0.0 && p.y < 0.0) { r = radii.z; } // 右下
  if (p.x < 0.0 && p.y < 0.0) { r = radii.w; } // 左下
  
  let q = abs(p) - size + r;
  let d = min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0))) - r;
  
  // 平滑过渡
  return smoothstep(smoothing, -smoothing, d);
}
```

#### B. 片元级折射计算
```wgsl
fn computeRefraction(
  uv: vec2<f32>,
  normal: vec2<f32>,
  ior: f32,  // 折射率
  backdrop: texture_2d<f32>
) -> vec4<f32> {
  // Snell's law: n1 * sin(θ1) = n2 * sin(θ2)
  let eta = 1.0 / ior;
  let cosi = dot(-normalize(vec3<f32>(0.0, 0.0, 1.0)), vec3<f32>(normal, 0.0));
  let k = 1.0 - eta * eta * (1.0 - cosi * cosi);
  
  if (k < 0.0) {
    // 全反射
    return vec4<f32>(1.0);
  }
  
  let refractDir = eta * vec3<f32>(0.0, 0.0, 1.0) + (eta * cosi - sqrt(k)) * vec3<f32>(normal, 0.0);
  let refractUV = uv + refractDir.xy * 0.1; // 折射偏移
  
  return textureSample(backdrop, sampler, refractUV);
}
```

#### C. 色散效果（八档）
```wgsl
fn chromaticAberration(
  uv: vec2<f32>,
  center: vec2<f32>,
  strength: f32,
  backdrop: texture_2d<f32>
) -> vec4<f32> {
  let direction = normalize(uv - center);
  
  // 八档色散（模拟不同波长折射率差异）
  let r = textureSample(backdrop, sampler, uv - direction * strength * 1.0);
  let g = textureSample(backdrop, sampler, uv);
  let b = textureSample(backdrop, sampler, uv + direction * strength * 1.0);
  
  return vec4<f32>(r.r, g.g, b.b, 1.0);
}
```

## 📊 预估性能提升

| 优化项 | GPU 使用率提升 | 实施复杂度 | 优先级 |
|--------|---------------|-----------|--------|
| 扩展实例化批渲染 | +5-8% | 中 | P0 |
| 描边 GPU 计算管线 | +8-12% | 高 | P0 |
| 玻璃效果片元化 | +5-7% | 高 | P1 |
| **总计** | **+18-27%** | - | - |

**最终预期**: 25-35% + 18-27% = **43-62%** (超过 Figma 的 40%)

## 🚧 实施风险

### 风险 1: WebGPU Compute Shader 支持
- **风险**: Safari 15/16 不支持 compute shader
- **缓解**: Fallback 到 fragment shader 模拟（性能略降）

### 风险 2: 精度问题
- **风险**: GPU 计算精度可能与 CPU 不同
- **缓解**: 
  - 关键路径保留 CPU 实现作为 ground truth
  - GPU 结果与 CPU 对比，误差超过阈值回退

### 风险 3: 内存压力
- **风险**: GPU buffer 增加显存占用
- **缓解**: 
  - 已实现自适应预算管理
  - 批处理按需释放

## 📁 文件计划

### 新增文件
1. `src/kernel/gpu/advanced-batching.ts` - 扩展批处理
2. `src/kernel/gpu/stroke-gpu-pipeline.ts` - 描边 GPU 管线
3. `src/kernel/gpu/glass-sdf-shader.wgsl` - 玻璃 SDF shader
4. `src/kernel/gpu/parallel-prefix-sum.wgsl` - 并行前缀和
5. `scripts/benchmark-gpu-optimization.ts` - 性能基准测试

### 修改文件
1. `src/kernel/gpu/renderer.ts` - 集成新管线
2. `src/kernel/gpu/webgpu.ts` - 添加 compute shader 支持
3. `src/kernel/render-worker.ts` - Worker 集成

## ✅ 验收标准

1. **功能测试**:
   - ✅ 117.sketch 渲染正确
   - ✅ Figma 导入渲染正确
   - ✅ 无肉眼可见的渲染差异

2. **性能测试**:
   - ✅ GPU 使用率 ≥ 40%
   - ✅ Draw call 减少 ≥ 60%
   - ✅ 帧率提升 ≥ 30%

3. **稳定性测试**:
   - ✅ 无内存泄漏
   - ✅ 无 GPU 设备丢失
   - ✅ Safari/Chrome/Edge 全平台测试通过

---

**下一步**: 按优先级顺序实施各项优化
