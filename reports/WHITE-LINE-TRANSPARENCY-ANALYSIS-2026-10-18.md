# 白线/透明问题深度分析（2026-10-18）

## 问题描述

用户报告：**缩放放大缩小时出现白色透明线，初始化时也出现**

## 🔍 根本原因分析

基于代码审查和 Figma 对比分析，我发现了**3 个独立的根本原因**：

---

## 原因 1：Gutter 不匹配（已识别但未完全修复）

### 现状

**TypeScript 期待**：
```typescript
// tile-cache.ts:149-157
tiles.push({
  x: x * TILE_SIDE - 1,     // 左边 1px gutter
  y: y * TILE_SIDE - 1,     // 上边 1px gutter
  width: TILE_SIDE + 2,     // 512 + 2 = 514
  height: TILE_SIDE + 2,    // 512 + 2 = 514
  gutter: 1,                // 显式标记
})
```

**Rust 实际渲染**：
- **问题**：Rust `renderer.rs` 只渲染 512×512，**不渲染 gutter**
- **结果**：gutter 区域（边缘 1px）为空/白色

### 解决方案

#### 方案 A：Rust 侧支持 Gutter（推荐，长期）

修改 `design-kernel/src/renderer.rs` 以渲染 514×514：

```rust
// renderer.rs
pub fn render_tile(&mut self, options: &RenderOptions) -> Result<Vec<u8>, String> {
    // 当前：
    let width = options.width;   // 512
    let height = options.height; // 512
    
    // 修改为：
    let gutter = options.gutter.unwrap_or(1);
    let width = options.width + gutter * 2;   // 512 + 2 = 514
    let height = options.height + gutter * 2; // 512 + 2 = 514
    
    // 渲染时扩展视口以包含 gutter
    let expanded_viewport = Rect {
        x: options.viewport.x - gutter as f64,
        y: options.viewport.y - gutter as f64,
        w: width as f64,
        h: height as f64,
    };
    
    // ... 渲染逻辑
}
```

#### 方案 B：前端禁用 Gutter（临时，快速）

修改 `tile-cache.ts` 以移除 gutter：

```typescript
// tile-cache.ts:149-157
tiles.push({
  x: x * TILE_SIDE,      // 无 gutter
  y: y * TILE_SIDE,      // 无 gutter
  width: TILE_SIDE,      // 512
  height: TILE_SIDE,     // 512
  gutter: 0,             // 禁用
})
```

**权衡**：
- ✅ 快速修复（5 分钟）
- ❌ 可能在高 DPR/缩放时出现细微缝隙
- ❌ 不符合 Figma 实践（Figma 可能也用 gutter）

---

## 原因 2：LOD 瓦片切换不流畅（固定 bucket 问题）

### 现状

**问题**：虽然你已经实现了 `calculateDynamicDensity`，但 LOD 切换逻辑可能仍有问题。

**ProgressiveSurface.tsx:508** 使用固定阈值：
```typescript
const lodActive = detailLevel / lodScale >= 1.02  // 2% 阈值
```

### 表现

1. **缩放时**：zoom 0.9 → 1.1
   - LOD 瓦片（低分辨率）先渲染
   - 等待 2% 阈值触发
   - 精确瓦片才开始渲染
   - **期间看到模糊的 LOD 瓦片边缘 = 白线**

2. **初始化时**：
   - LOD 瓦片先显示（快速预览）
   - 精确瓦片慢慢加载
   - **过渡期间白线明显**

### 解决方案

#### A. 更激进的 LOD 切换

```typescript
// ProgressiveSurface.tsx:508
// 旧代码
const lodActive = detailLevel / lodScale >= 1.02  // 2% 阈值

// 新代码：立即切换
const lodActive = stableDensity !== lodScale  // 密度一变就切换
```

#### B. LOD 瓦片与精确瓦片平滑过渡

```typescript
// 添加混合渲染：LOD 瓦片 + 精确瓦片同时显示
// 精确瓦片覆盖在 LOD 之上，逐步替换
const showBothLayers = lodActive && preciseTilesPartiallyReady
```

---

## 原因 3：瓦片合成器边界处理问题

### 现状

**tile-compositor.ts:127-150** 的边界计算可能有误：

```typescript
// tile-compositor.ts
const left = p.left + sx * (gutter || 0)
const pw = p.width - sx * (gutter || 0) * 2
gl.uniform4f(this.uvBox, (gutter || 0) / tile.width, ...)
```

### 问题

1. **UV 坐标计算错误**：
   - 如果 gutter=1，UV 应该从 1/514 开始
   - 但 Rust 只渲染了 512×512，所以 UV 应该是 0-1
   - **不匹配导致采样到纹理边缘外 = 白线**

2. **相邻瓦片对齐问题**：
   - 瓦片 A 的右边缘
   - 瓦片 B 的左边缘
   - 如果对齐有 1px 偏差 = **白色缝隙**

### 解决方案

#### A. 检查 UV 坐标（假设 Rust 渲染 512×512）

```typescript
// tile-compositor.ts
const actualTileSize = 512  // Rust 实际渲染尺寸
const uvGutter = 0  // Rust 不渲染 gutter，所以 UV 无需偏移

gl.uniform4f(
  this.uvBox,
  uvGutter / actualTileSize,  // 左
  uvGutter / actualTileSize,  // 上
  (actualTileSize - uvGutter) / actualTileSize,  // 右
  (actualTileSize - uvGutter) / actualTileSize,  // 下
)
```

#### B. 验证相邻瓦片对齐

```typescript
// 确保相邻瓦片无缝对接
// 瓦片 A (x=0): 覆盖 [0, 512)
// 瓦片 B (x=512): 覆盖 [512, 1024)
// 不应有 gap 或 overlap
```

---

## 原因 4：Alpha 预乘/透明度问题

### 现状

**可能的问题**：
- 瓦片背景不是完全不透明
- Alpha 预乘处理不一致
- 混合模式错误

### 检查点

```typescript
// 1. 检查瓦片是否有 Alpha 通道
const hasAlpha = renderOptions.transparent === true

// 2. 检查混合模式
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)  // 标准混合
// vs
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)  // Alpha 预乘

// 3. 检查背景色
// 如果背景不是 opaque white/checkerboard，白线会更明显
```

---

## 原因 5：设备像素比（DPR）不匹配

### 现状

**ProgressiveSurface.tsx:469-471**：
```typescript
const dpr = useDevicePixelRatio()
const detailLevel = view.zoom * dpr
const stableDensity = useRasterDensity(detailLevel, identity)
```

### 问题

1. **高 DPR 设备**（Retina，dpr=2）：
   - 请求密度 = zoom × 2
   - 如果瓦片按 dpr=1 渲染
   - 放大 2x 显示 = **模糊 + 边缘白线**

2. **DPR 不稳定**：
   - 浏览器缩放改变 DPR
   - DPR 改变 → 密度改变 → 所有瓦片失效
   - 重渲染期间 = **白线闪烁**

### 解决方案

#### A. 验证 DPR 传递

```typescript
// 确保 DPR 正确传递给 Rust
const renderOptions = {
  ...options,
  width: TILE_SIDE,
  height: TILE_SIDE,
  dpr: dpr,  // ⚠️ 确保这个值传递了
  density: stableDensity,
}
```

#### B. DPR 去抖

```typescript
// 避免 DPR 频繁变化导致瓦片失效
const stableDpr = useRasterDensity(dpr, identity, { frames: 4 })  // 4 帧去抖
```

---

## 🔧 完整修复方案（分优先级）

### 🚨 P0：立即修复（< 30 分钟）

#### 1. 禁用 Gutter（临时）

```typescript
// tile-cache.ts:149-157
tiles.push({
  x: x * TILE_SIDE,
  y: y * TILE_SIDE,
  width: TILE_SIDE,      // 512，不是 514
  height: TILE_SIDE,     // 512，不是 514
  gutter: 0,             // 显式禁用
})
```

#### 2. 修复 tile-compositor UV 坐标

```typescript
// tile-compositor.ts
const gutter = tile.gutter || 0
const actualSize = TILE_SIDE  // Rust 实际渲染 512

// UV 坐标：假设 Rust 不渲染 gutter
gl.uniform4f(
  this.uvBox,
  0,  // 左（无 gutter）
  0,  // 上（无 gutter）
  1,  // 右
  1,  // 下
)
```

#### 3. 更激进的 LOD 切换

```typescript
// ProgressiveSurface.tsx:508
const lodActive = stableDensity !== lodScale  // 立即切换
```

### ⚠️ P1：短期优化（1-2 小时）

#### 4. Rust 侧支持 Gutter

修改 `design-kernel/src/renderer.rs`：
```rust
pub struct RenderOptions {
    // ... 现有字段
    pub gutter: Option<u32>,  // 新增
}

pub fn render_tile(&mut self, options: &RenderOptions) -> Result<Vec<u8>, String> {
    let gutter = options.gutter.unwrap_or(0);
    let render_width = options.width + gutter * 2;
    let render_height = options.height + gutter * 2;
    
    // 扩展视口
    let viewport = Rect {
        x: options.viewport.x - gutter as f64,
        y: options.viewport.y - gutter as f64,
        w: render_width as f64,
        h: render_height as f64,
    };
    
    // ... 渲染 514×514
}
```

#### 5. 添加瓦片边界可视化（调试）

```typescript
// 添加到 TileCompositeSurface.tsx
if (import.meta.env.DEV) {
  // 渲染瓦片边界线（红色）
  ctx.strokeStyle = 'red'
  ctx.lineWidth = 1
  tiles.forEach(tile => {
    ctx.strokeRect(tile.x / zoom, tile.y / zoom, tile.width / zoom, tile.height / zoom)
  })
}
```

### 📊 P2：长期优化（1 天）

#### 6. 实现平滑 LOD 过渡

```typescript
// LOD 瓦片 + 精确瓦片混合显示
const renderLayers = [
  { tiles: lodTiles, opacity: preciseTilesReady ? 0 : 1 },
  { tiles: preciseTiles, opacity: loadProgress },
]
```

#### 7. 改进 DPR 处理

```typescript
// DPR 变化时不立即失效所有瓦片
// 而是复用并 CSS 缩放，2 帧后再重新渲染
const dprDebounced = useFrameDebounce(dpr, 2)
```

---

## 🧪 验证步骤

### 1. 检查 Gutter 状态

```typescript
// 在 console 中运行
const tiles = document.querySelectorAll('canvas')
tiles.forEach((canvas, i) => {
  console.log(`Tile ${i}: ${canvas.width}x${canvas.height}`)
  // 应该全部是 512x512（如果禁用 gutter）
  // 或 514x514（如果启用 gutter 且 Rust 支持）
})
```

### 2. 检查瓦片对齐

```typescript
// 添加到 ProgressiveSurface
useEffect(() => {
  const checkAlignment = () => {
    const tiles = Array.from(tileRef.current.values())
    tiles.forEach((tile, i) => {
      const next = tiles[i + 1]
      if (next && tile.x + tile.width !== next.x) {
        console.warn(`Gap between tile ${i} and ${i+1}:`, {
          tileEnd: tile.x + tile.width,
          nextStart: next.x,
          gap: next.x - (tile.x + tile.width),
        })
      }
    })
  }
  checkAlignment()
}, [tileRef.current])
```

### 3. 检查 LOD 切换

```typescript
// 在 ProgressiveSurface 添加日志
console.log('[LOD]', {
  detailLevel,
  lodScale,
  lodActive,
  stableDensity,
  ratio: detailLevel / lodScale,
})

// 观察 lodActive 的切换时机
// 如果 ratio 长时间在 [1.0, 1.02) 之间 = LOD 延迟切换 = 白线
```

---

## 📊 Figma 对比

### Figma 的实现（GLUE-JS-MINING.md §2.2）

```javascript
// Figma viewer
static DEFAULT_TILE_SIZE = 512  // 基础瓦片
SSAA_SIZE() = baseTileSize * supersampleCount  // 512*2=1024 桌面

// ⚠️ 关键：Figma 可能不用 gutter！
// 代码中没有明确的 "gutter" 或 "+2" 常量
// 可能靠精确对齐 + SSAA 避免缝隙
```

**结论**：Figma 可能**不使用 gutter**，而是：
1. 使用 SSAA（2x/4x 超采样）消除边缘问题
2. 精确的浮点对齐（无舍入误差）
3. 立即的 LOD 切换（无过渡期）

---

## 🎯 推荐修复顺序

1. **立即**（5 分钟）：禁用 gutter，修改 tile-cache.ts
2. **验证**（10 分钟）：运行验证步骤 1-3，确认白线减少
3. **如果仍有白线**（20 分钟）：修复 UV 坐标 + 更激进 LOD 切换
4. **长期**（1-2 小时）：Rust 侧支持 gutter（如果需要）

---

## 📝 总结

白线/透明问题的**3 个根本原因**：

1. **Gutter 不匹配**（TypeScript 期待 514，Rust 渲染 512）- **P0 修复**
2. **LOD 切换延迟**（1.02 阈值导致过渡期模糊）- **P0 修复**
3. **UV 坐标错误**（合成器假设 gutter，但 Rust 没渲染）- **P1 修复**

**预期修复时间**：
- P0 修复：30 分钟
- 完全解决：2-3 小时

**下一步**：立即实施 P0 修复！
