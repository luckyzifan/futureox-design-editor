# Figma 缩放策略深度分析与差距

## 问题根源

你当前系统**不丝滑**的根本原因：**使用固定 LOD bucket 而非 Figma 的动态降采样**

### 当前实现（Sketch 风格）

```typescript
// tile-cache.ts:64-73
export function lodBucketScale(scale: number): number {
  if (scale > 2) return scale
  if (scale > 1) return 1
  if (scale > 0.5) return 0.5
  if (scale > 0.25) return 0.25
  // ... 固定档位
}
```

**问题：**
1. 固定档位：`0.05 / 0.1 / 0.25 / 0.5 / 1 / 2 / 4 / 8...`
2. **跨档位必须清空所有瓦片**：zoom 0.24 → 0.26 = 跨越 0.25 边界 = **全部失效重渲染**
3. 即使在档位内缩放（如 0.10 → 0.24），LOD 预览也必须**等到 1.05x 阈值**才切换精确瓦片

### Figma 实现（动态降采样）

```javascript
// 来自 GLUE-JS-MINING.md §2.4
devicePixelsPerCanvasPixel = zoom * devicePixelRatio  // 可以是任意浮点值！

// 2 帧去抖
debouncer = new FrameDebouncer(2, (a,b) => a==b, () => setNeedsBlit(true))

// 动态降采样（只在瓦片预算不足时触发）
function getPrioritizedListOfTilesToPopulate() {
  let density = devicePixelsPerCanvasPixel * maxTransformScale
  let tilesPerGrid = (maxTextureSize / tileSize)²
  let requiredTiles = calculateRequiredTiles(viewport, density)
  
  // 预算不足才降采样
  if (requiredTiles > tilesPerGrid) {
    let ratio = requiredTiles / tilesPerGrid
    density /= 2^ceil(log4(ratio))  // 4 倍降采样
    if (still_too_many) density /= 2  // 再降 2 倍
  }
  
  // 清空瓦片的条件：density 改变（而非 zoom 改变）
  if (grid.density !== density) {
    grid.tiles.clear()  // 只有这时才失效
  }
}
```

**关键差异：**
1. ✅ **连续密度**：`devicePixelsPerCanvasPixel` 可以是 0.73、1.42 等**任意浮点值**
2. ✅ **2 帧去抖**：连续 2 帧稳定才提交新密度（防止抖动）
3. ✅ **按需降采样**：只在瓦片预算不足时才降低密度，不是预先分档
4. ✅ **小幅缩放不清空**：zoom 0.9 → 1.1 时 density 从 0.9 → 1.1，**瓦片不失效**（CSS 缩放复用）

---

## 具体场景对比

### 场景 1: 小幅缩放 (zoom 0.9 → 1.1)

**你的实现：**
```
zoom 0.9  → lodBucket 0.5 → 渲染 0.5 瓦片，放大 1.8x 显示（模糊）
                              等待 lodActive (0.9/0.5=1.8 > 1.05) → 触发精确瓦片
zoom 0.95 → lodBucket 0.5 → 复用 0.5 瓦片，放大 1.9x（更模糊）
zoom 1.0  → lodBucket 1.0 → **跨档位！全部失效！重新渲染所有瓦片！**
zoom 1.05 → lodBucket 1.0 → 复用 1.0 瓦片
zoom 1.1  → lodBucket 1.0 → 复用 1.0 瓦片
```
**结果**: 跨越 1.0 边界时**卡顿**（全部重渲染）

**Figma 实现：**
```
zoom 0.9  → density 0.9  → 渲染 0.9 密度瓦片
                             （2 帧后）density 稳定，继续复用
zoom 0.95 → density 0.95 → 仍在去抖（< 2 帧），复用 0.9 瓦片，CSS 放大 1.056x
                             （2 帧后）density 稳定 0.95，渲染新瓦片
zoom 1.0  → density 1.0  → 去抖中，复用 0.95 瓦片，CSS 放大 1.053x
                             （2 帧后）渲染 1.0 瓦片
zoom 1.05 → density 1.05 → 去抖中，复用 1.0 瓦片，CSS 放大 1.05x
zoom 1.1  → density 1.1  → （2 帧后）渲染 1.1 瓦片
```
**结果**: **平滑**，每次只是 CSS 缩放，2 帧后渐进式替换瓦片

### 场景 2: 快速连续缩放 (zoom 0.5 → 2.0，1 秒内)

**你的实现：**
```
跨越 0.5 / 1.0 两个边界 → 2 次全部失效 → 大量重渲染 → **明显卡顿**
```

**Figma 实现：**
```
连续缩放 → density 一直在变化 → 去抖器一直**不稳定** → 复用旧瓦片 + CSS 缩放
停止缩放 → 2 帧后稳定 → 一次性渲染新密度瓦片 → **流畅**
```

---

## 白线问题分析

白线可能来自几个原因：

### 1. 瓦片 Gutter 渲染问题

```typescript
// tile-cache.ts:116-118
tiles.push({
  x: x * TILE_SIDE - 1,     // 左边 1px gutter
  y: y * TILE_SIDE - 1,     // 上边 1px gutter
  width: TILE_SIDE + 2,     // 512 + 左右各 1px
  height: TILE_SIDE + 2,    // 512 + 上下各 1px
})
```

**Gutter 的作用**: 防止瓦片边缘在 CSS 缩放时出现缝隙

**可能的问题**:
- Rust 渲染器没有正确渲染 gutter 区域（只渲染了 512x512，不是 514x514）
- 描边/边界效果没有延伸到 gutter
- 合成器裁剪掉了 gutter

### 2. 描边渲染边界问题

如果文档有很多矩形带白色描边，可能是：
- 描边在瓦片边界被截断
- 抗锯齿在瓦片边界失效
- Alpha 预乘问题

### 3. 背景/网格渲染

检查是否：
- 像素网格（pixel grid）被错误启用
- 画布背景渲染出现裂缝
- Checkerboard 模式的边界问题

---

## 修复方案

### 方案 A: 完整实施 Figma 动态降采样（推荐，根本解决）

**需要修改的文件：**

1. **`src/kernel/use-raster-density.ts`** - 改为 2 帧去抖，无固定档位
2. **`src/kernel/ProgressiveSurface.tsx`** - 移除 `lodBucketScale`，使用连续 density
3. **`src/kernel/tile-cache.ts`** - 新增 `calculateDynamicDensity()` 函数
4. **`src/kernel/render-worker.ts`** - 支持任意浮点 density

**核心逻辑：**

```typescript
// 新增：动态降采样计算
export function calculateDynamicDensity(
  requestedDensity: number,
  viewport: { width: number; height: number },
  maxTiles = 256,
  tileSize = 512,
): number {
  // 计算需要的瓦片数
  const columns = Math.ceil(viewport.width * requestedDensity / tileSize)
  const rows = Math.ceil(viewport.height * requestedDensity / tileSize)
  const required = columns * rows
  
  if (required <= maxTiles) return requestedDensity
  
  // 4 倍降采样
  const ratio = required / maxTiles
  const factor4x = 2 ** Math.ceil(Math.log2(ratio) / 2)  // ceil(log4(ratio))
  let density = requestedDensity / factor4x
  
  // 仍然不够，再降 2 倍
  const recheck = Math.ceil(viewport.width * density / tileSize) * 
                  Math.ceil(viewport.height * density / tileSize)
  if (recheck > maxTiles) density /= 2
  
  return density
}

// 修改：ProgressiveSurface.tsx
const requestedDensity = view.zoom * dpr
const budgetedDensity = calculateDynamicDensity(requestedDensity, { width, height })
const stableDensity = useRasterDensity(budgetedDensity, identity)  // 2 帧去抖

// 关键：移除所有 lodBucketScale 调用
// 瓦片失效条件改为：stableDensity 改变（而非 zoom 跨档位）
```

### 方案 B: 保留 LOD bucket，优化切换策略（部分改进）

如果短期无法完全重构，可以：

1. **减少 bucket 数量**，扩大每个档位的覆盖范围
   ```typescript
   // 只保留 4 个档位：0.25 / 0.5 / 1.0 / 2.0
   // 减少跨边界次数
   ```

2. **实施"双缓冲"瓦片**
   ```typescript
   // 跨档位时保留旧瓦片，新瓦片渐进替换
   // 而非立即清空
   ```

3. **延长去抖时间**
   ```typescript
   // 从 2 帧提升到 5 帧
   // 减少频繁切换
   ```

### 方案 C: 白线问题修复（独立进行）

1. **验证 Gutter 渲染**
   ```rust
   // design-kernel/src/tiled_renderer.rs
   // 确保渲染 514x514，不是 512x512
   ```

2. **检查合成器裁剪**
   ```typescript
   // tile-compositor.ts
   // 确保 uvBox 正确包含 gutter
   ```

3. **检查描边扩展**
   ```rust
   // 确保描边效果延伸到 gutter 区域
   ```

---

## 实施优先级

### 立即可做（30 分钟）
1. ✅ 检查 gutter 渲染 - 打开你的文档，在开发者工具查看瓦片实际尺寸
2. ✅ 增加去抖时间到 5 帧 - 临时缓解卡顿

### 短期（2-4 小时）
3. 实施方案 A 的核心部分 - 动态降采样，保留 2 帧去抖

### 中期（1-2 天）
4. 完整重构为连续密度系统
5. 移除所有固定 LOD bucket 依赖

---

## 测试验证

### 丝滑度测试
```
1. zoom 0.9 → 1.1 (跨 1.0 边界)
   - 修复前：明显卡顿
   - 修复后：平滑过渡

2. 快速连续缩放 0.5 → 2.0
   - 修复前：多次卡顿
   - 修复后：只在停止时一次重渲染

3. 小幅抖动 (zoom 0.99 ↔ 1.01 快速来回)
   - 修复前：频繁重渲染
   - 修复后：去抖器过滤，复用旧瓦片
```

### 白线测试
```
1. 导入 117 文件，查看是否有白线
2. 放大到 200%，观察瓦片边界
3. 缩小到 50%，观察是否有缝隙
```

---

## 推荐行动

1. **先修白线** - 这是视觉 bug，优先级最高
2. **再做方案 B** - 短期改善丝滑度（减少 bucket）
3. **最后方案 A** - 完整实施动态降采样

要我现在开始实施吗？从哪个方案开始？
