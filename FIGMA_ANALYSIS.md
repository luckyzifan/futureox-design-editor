# Figma 高倍率渲染逆向分析

## 问题现象
- **3200% 放大后出现锯齿** - 原始图片被降采样，导致质量损失
- **平移卡顿** - 大图片在高倍率下内存占用过大

## Figma 的核心策略

### 1. **Mipmap Fallback 机制** ⭐
Figma 使用多级 mipmap 链，当原始图片超出 GPU 预算时自动降级：

```typescript
// imageForAdmitted: 智能重试机制
private imageForAdmitted(uri, level, ...) {
  const maxLevel = mipLevelsFor(dims) - 1
  for (;;) {
    try {
      return { image: this.imageFor(uri, level, ...), level }
    } catch (error) {
      if (level >= maxLevel || !isAdmissionFailure(error))
        throw error
      level++  // 自动尝试下一个 mip level
    }
  }
}
```

**关键点**：
- Level 0 = 原始尺寸
- Level 1 = 1/2 尺寸 (1/4 像素)
- Level 2 = 1/4 尺寸 (1/16 像素)
- ...

### 2. **动态像素限制**

```typescript
// 当前实现
const pixelLimit = zoom >= 10  // 1000%+
  ? 67_108_864  // 64M pixels (8192×8192)
  : zoom >= 3   // 300%+
  ? 33_554_432  // 32M pixels (~5657×5657)
  : 16_777_216  // 16M pixels (4096×4096)
```

**问题**：这个策略可能过于激进！

### 3. **Figma 的真实策略（推测）**

#### A. 视口驱动的 Level 选择
```typescript
// Figma 可能根据视口大小选择 level，而不是 zoom
function imageLevel(node, paint) {
  const baseDims = this.baseDims(paint.image)
  const screenDims = this.nodeToScreenSize(node, baseDims)
  
  // 如果屏幕显示尺寸 < 原始尺寸，使用更高 level
  // 3200% 时，即使原图很大，屏幕显示可能只需要 2K-4K
  let level = 0
  let dims = baseDims
  
  while (dims[0] > screenDims[0] * 2 && dims[1] > screenDims[1] * 2) {
    dims = [dims[0] / 2, dims[1] / 2]
    level++
  }
  
  return level
}
```

#### B. 分层预算
```typescript
// Figma 可能有分层的内存预算
const budgets = {
  // 当前视口：最高优先级
  viewport: 512 * 1024 * 1024,  // 512MB
  
  // 交互缓存：周围 1 屏幕范围
  interaction: 256 * 1024 * 1024,  // 256MB
  
  // 背景缓存：远处内容
  background: 256 * 1024 * 1024   // 256MB
}
```

#### C. 渐进式加载
```typescript
// 先加载低 level，再逐步升级
1. Level 2 (1/4) - 立即显示，避免空白
2. Level 1 (1/2) - 0.1s 后加载
3. Level 0 (原始) - 0.5s 后加载（如果 zoom 足够高）
```

## 当前代码的问题

### 1. **Level 选择逻辑不合理**

查看 `imageLevel` 函数：
```typescript
private imageLevel(n: SceneNode, p: ImagePaint): number {
  // 当前逻辑可能直接返回 0，导致总是尝试加载原始图片
  // 应该根据实际渲染尺寸计算 level
}
```

### 2. **像素限制太大**
64M 像素 (8192×8192) 对于 3200% 可能仍然过大：
- 8K × 4 bytes = 256MB (单张图片！)
- 如果场景中有 10 张这样的图片 = 2.56GB

### 3. **缺少视口裁剪优化**
Figma 可能只渲染视口内的图片部分：
```glsl
// GPU shader: 只采样视口内的纹理区域
vec2 visibleRegion = intersect(imageRect, viewportRect)
```

## 建议的修复方案

### 方案 A: 修复 imageLevel 函数（推荐）
```typescript
private imageLevel(n: SceneNode, p: ImagePaint): number {
  const baseDims = this.baseDims(p.image || '')
  const screenSize = this.nodeScreenSize(n)
  
  // 计算需要的实际像素数
  let level = 0
  let w = baseDims[0]
  let h = baseDims[1]
  
  // 如果屏幕显示 < 原始尺寸的一半，升级 level
  while (level < 6 && 
         w > screenSize[0] * 2 && 
         h > screenSize[1] * 2) {
    w = Math.ceil(w / 2)
    h = Math.ceil(h / 2)
    level++
  }
  
  return level
}
```

### 方案 B: 降低像素限制（保守）
```typescript
const pixelLimit = 16_777_216  // 始终 4K limit
// 依赖 mipmap fallback 自动降级
```

### 方案 C: 完全移除像素限制（Figma 做法？）
```typescript
// 不检查像素数，完全依赖：
// 1. imageLevel 选择正确的 level
// 2. GPU 内存预算自动淘汰
// 3. 视口裁剪减少渲染
```

## 调试步骤

1. **添加日志查看 level 选择**：
   ```typescript
   console.log(`[Image] ${uri} - Zoom: ${zoom}%, Level: ${level}, Size: ${w}×${h}`)
   ```

2. **检查 imageLevel 返回值**：
   - 如果总是返回 0 → 问题在这里
   - 应该在高 zoom 时返回 0，低 zoom 时返回更高 level

3. **测试 mipmap fallback**：
   - 故意设置低像素限制 (8M)
   - 观察是否自动降级到 level 1+

## Rust 层的角色

```rust
// design-kernel/src/image_mipmap.rs
// Rust 负责生成 mipmap 链：
// - Level 0: 原始图片
// - Level 1: 1/2 box filter
// - Level 2: 1/4 box filter
// ...

// JavaScript 层只需要选择正确的 level！
```

## 结论

**真正的问题不是像素限制太低，而是 `imageLevel` 选择逻辑有问题！**

Figma 的策略：
1. 根据屏幕显示尺寸智能选择 mip level
2. 3200% 时如果只显示图片一小部分，仍可能用 level 1-2
3. 只有当图片在屏幕上实际显示 > 4K 时才用 level 0

需要检查的关键函数：
- `imageLevel(n, p)` - 是否根据屏幕尺寸选择？
- `nodeScreenSize(n)` - 计算节点在屏幕上的实际像素尺寸
- 视口裁剪 - GPU 是否只渲染可见部分？
