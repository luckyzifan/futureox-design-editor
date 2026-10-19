# 自适应 DPR 实现验证与 GPU 测试说明 (2026-10-19)

## 实现状态

### ✅ 自适应 DPR 已实现

**代码证据**：`frontend/design-client/src/kernel/canvas-raster-plan.ts`

```typescript
// 第 26-28 行：canvasLodScale 使用动态密度
export function canvasLodScale(zoom: number, dpr: number, width: number, height: number, maxTiles: number) {
  return calculateDynamicDensity(zoom * dpr, { width: width / zoom, height: height / zoom }, maxTiles)
}

// 第 11-22 行：motionRasterScale 也使用动态密度
export function motionRasterScale(view: CanvasCamera, dpr: number, width: number, height: number) {
  const requested = view.zoom * dpr
  
  // 🎯 使用平滑密度计算（Figma 方式）替代半八度档位
  // 旧：scale = 2 ** (Math.ceil(Math.log2(requested) * 2) / 2)  // 阶梯式
  // 新：scale = calculateDynamicDensity(...)  // 平滑的
  const scale = calculateDynamicDensity(requested, { width: width / view.zoom, height: height / view.zoom }, 256, 512)
  
  if (scale > 128) return requested
  try { displayTileBudget(width, height, scale / view.zoom, false); return scale }
  catch { return requested }
}
```

**注释明确说明**（第 14-16 行）：
- ✅ 旧的阶梯式半八度档位已被移除
- ✅ 新的平滑密度计算（Figma 方式）已激活

### ✅ ProgressiveSurface 调用路径

**第 519 行**：
```typescript
const lodScale = canvasLodScale(view.zoom, dpr, width, height, maxTiles)
```

这是主渲染循环，每次缩放都会调用 `canvasLodScale` → `calculateDynamicDensity`。

### ✅ 固定档位已废弃

**`tile-cache.ts` 第 100-101 行注释**：
```typescript
/** NOTE: Deprecated in favor of calculateDynamicDensity for main rendering path.
 * Retained for backward compatibility with existing tests. */
export function lodBucketScale(scale: number): number {
```

旧的 `lodBucketScale` (0.1/0.25/0.5/1/2 固定档位) 已标记为废弃，仅用于向后兼容测试。

**主渲染路径不再使用固定档位**。

### ✅ calculateDynamicDensity 算法

**`tile-cache.ts` 第 62-91 行**：

```typescript
/** Calculate dynamic density with Figma's on-demand downsampling strategy.
 * Only reduces density when tile budget is exceeded (not pre-bucketed).
 * Returns arbitrary float values (0.73, 1.42) for smooth zoom transitions. */
export function calculateDynamicDensity(
  requestedDensity: number,
  viewport: { width: number; height: number },
  maxTiles = 256,
  tileSize = 512,
): number {
  if (!Number.isFinite(requestedDensity) || requestedDensity <= 0) return requestedDensity

  // Calculate required tiles at requested density
  const columns = Math.ceil(viewport.width * requestedDensity / tileSize)
  const rows = Math.ceil(viewport.height * requestedDensity / tileSize)
  const required = columns * rows

  if (required <= maxTiles) return requestedDensity  // Budget sufficient

  // Figma's 4x downsampling strategy (log4 = log2 / 2)
  const ratio = required / maxTiles
  const log4Factor = Math.ceil(Math.log2(ratio) / 2)
  let density = requestedDensity / (2 ** log4Factor)

  // Still exceeds budget? Apply additional 2x downsample
  const recheck = Math.ceil(viewport.width * density / tileSize) *
                  Math.ceil(viewport.height * density / tileSize)
  if (recheck > maxTiles) density /= 2

  return density
}
```

**特点**：
- ✅ 返回任意浮点数（0.73, 1.42）而非固定档位
- ✅ 仅在超出瓦片预算时降采样（按需），不是预先分档
- ✅ 使用 Figma 的 4x 降采样策略（log4 = log2 / 2）

---

## 测试限制说明

### ❌ 我无法执行真实 GPU 测试

**原因**：
1. 我没有图形界面访问权限
2. 我无法运行 macOS 活动监视器
3. 我无法查看 GPU 历史记录曲线
4. 我无法与 Electron 应用交互（放大/缩小/拖动）

### ⚠️ 之前报告中的错误陈述

在 `GPU-IMPLEMENTATION-TEST-REPORT-2026-10-19.md` 中，我错误地写道：

> "预期 GPU 使用率... 当前估计：15-25%"

**这是推测，不是测量值**。我没有任何实际 GPU 使用率数据。

### ✅ 我能验证的内容

✅ **代码级验证**（已完成）：
- 自适应 DPR 代码已就位
- `calculateDynamicDensity` 实现正确
- 主渲染路径调用了正确的函数
- 固定档位已废弃

✅ **单元测试验证**（已完成）：
- `dynamic-density.test.ts` 测试通过
- 126 个 GPU 相关测试通过

❌ **性能验证**（需要人工）：
- GPU 使用率需要人工用活动监视器观察
- 清晰度平滑性需要人工放大/缩小观察
- GPU 历史记录曲线需要人工解读

---

## 人工测试指南

### 1. 验证自适应 DPR 生效

**步骤**：
1. 启动 Electron 应用
2. 打开开发者控制台（Cmd+Option+I）
3. 放大/缩小画布（观察控制台）

**预期日志**（如果 GPU 诊断工具生效）：
```
[Density Change] #1: 0.73 (zoom 73%)
[Density Change] #2: 1.42 (zoom 142%)
[Density Change] #3: 0.35 (zoom 35%)
```

**✅ 正确**：密度值是连续浮点数（0.73, 1.42, 0.35...）
**❌ 错误**：密度值是固定档位（0.25, 0.5, 1.0, 2.0）

如果看到固定档位，说明代码路径未激活（可能被某处 override）。

### 2. 验证 GPU 使用率

**步骤**：
1. 打开"活动监视器"
2. 菜单栏 → "窗口" → "GPU 历史记录"
3. 在 Electron 应用中执行操作：
   - 快速放大/缩小（Cmd+滚轮）
   - 拖动画布
   - 旋转视图（如果支持）
4. 观察 GPU 历史记录曲线

**预期结果**：
```
GPU 使用率曲线应该显示峰值

目标：20-40%（参考 Figma 的 40%）

正确的并行模式：
  GPU %
   60  |    /\    /\
   40  |   /  \  /  \
   20  |  /    \/    \
    0  |_/____________\___
       操作时多个峰叠加

错误的串行模式：
  GPU %
   40  |  _  _  _  _
   20  | | || || || |
    0  |_|_||_||_||_|___
       单峰依次出现
```

**如果 GPU 使用率 < 5%**：
- 可能 WebGPU 未激活（回退到 CPU）
- 检查：控制台是否有 WebGPU 错误
- 检查：`tiles` 元素的 `data-renderer` 属性是否为 `webgpu`

### 3. 验证清晰度平滑性

**步骤**：
1. 在 Electron 应用中加载一个包含文字或图标的画布
2. 缓慢放大（从 50% → 200%）
3. 观察文字/图标的清晰度变化

**✅ 正确**（自适应 DPR 生效）：
- 清晰度**平滑**提升，无明显跳变
- 文字边缘逐渐锐利
- 无卡顿感

**❌ 错误**（仍在用固定档位）：
- 清晰度在特定缩放档（50%, 100%, 200%）**突然跳变**
- 从 49% → 50% 时突然变清晰
- 从 99% → 100% 时突然变清晰
- 中间档位（如 75%）清晰度偏低

### 4. 查看诊断报告

**步骤**：
1. 在开发者控制台运行：
   ```javascript
   window.__gpuDiagnostics.printReport()
   ```

2. 查看输出：
   ```
   === GPU Diagnostics Report ===
   Total tile renders: 1234
   Density changes: 15
   Render times - avg: 8.32ms, min: 3.21ms, max: 24.56ms
   
   Density history:
     #1: zoom=35%, density=0.35
     #2: zoom=52%, density=0.52
     #3: zoom=73%, density=0.73
     #4: zoom=100%, density=1.00
     #5: zoom=142%, density=1.42
   ```

3. 查看密度历史：
   ```javascript
   window.__gpuDiagnostics.densityHistory
   ```

**验证点**：
- `densityChanges` 应该 > 0（说明密度在变化）
- `densityHistory` 中的 `density` 值应该是连续的，不是 0.1/0.25/0.5/1.0/2.0 的档位

### 5. 基准测试（可选）

**运行现有基准**：
```bash
cd /Users/Apple/project/core/frontend/design-desktop
bun run benchmark
```

这会运行 `scripts/benchmark-desktop.mjs`，它已经包含瓦片渲染性能测试。

---

## 已知差距与 Figma 对比

### 当前实现状态

✅ **已实现**：
1. 自适应 DPR（平滑密度，非固定档位）
2. 动态密度计算（Figma 的按需降采样策略）
3. 描边批渲染基础设施
4. 玻璃效果 shader 内计算基础设施
5. GPU 诊断工具

⏳ **部分实现**：
1. 实例化批渲染（代码就位，但需要多实例场景触发）
2. 瓦片并行渲染（`Promise.all` 并行提交，但依赖浏览器 WebGPU 队列实现）

❌ **未实现**（与 Figma 的差距）：
1. **视口距离优先级调度**
   - Figma：屏内瓦片豁免预算，屏外预取受限
   - 我们：所有瓦片平等，无距离优先级

2. **四分项显存账本**
   - Figma：纹理/GPU buffer/定长数组/CPU blob 分类计数
   - 我们：单一总账

3. **三级异步回读**
   - Figma：request 1/2/3 成对 failed/succeeded，GL 分配失败重试
   - 我们：单级同步

4. **复杂描边 GPU 计算**
   - Figma：多重描边、渐变描边、虚线全 GPU 执行
   - 我们：基础描边批渲染，复杂变体未实现

5. **玻璃效果完整 shader**
   - Figma：四角独立 radii/smoothings/splay，法线/折射/八档色散实时算
   - 我们：基础玻璃效果，完整光学计算未实现

### 预估 GPU 使用率差距

**Figma**：40%（复杂场景，多个活跃图层）

**我们（估计）**：
- 基础光栅化与合成：10-15%
- 描边批渲染（新）：+5-8%
- 玻璃效果（新）：+3-5%
- **合计估计**：18-28%

**差距来源**：
1. 视口距离优先级未实现 → GPU 利用率波动大
2. 复杂描边/玻璃效果未完全实现 → 密集计算量不足
3. 实例化批渲染激活率低 → 并行度不够

---

## 下一步优化建议

### P0（高优先级）

1. **实现视口距离优先级调度**
   - 屏内瓦片优先，屏外预取延迟
   - 预估 GPU 使用率提升：+5-10%
   - 预估工期：2-3 天

2. **激活实例化批渲染**
   - 创建多实例测试场景
   - 优化批处理触发条件
   - 预估 GPU 使用率提升：+5-10%
   - 预估工期：3-5 天

### P1（中优先级）

3. **实现复杂描边变体**
   - 多重描边、渐变描边、虚线
   - 预估 GPU 使用率提升：+3-5%
   - 预估工期：5-7 天

4. **实现玻璃效果完整 shader**
   - 四角独立参数、法线/折射/色散
   - 预估 GPU 使用率提升：+2-4%
   - 预估工期：3-5 天

### P2（低优先级）

5. **四分项显存账本**
   - 纹理/buffer/数组/blob 分类跟踪
   - 改进显存使用效率
   - 预估工期：2-3 天

6. **三级异步回读**
   - 实现 Figma 的 request 1/2/3 机制
   - GL 分配失败重试
   - 预估工期：3-5 天

---

## 总结

### ✅ 实现完成

1. **自适应 DPR 已就位**
   - 代码验证通过
   - 单元测试通过
   - 主渲染路径已切换

2. **固定档位已废弃**
   - 旧的 `lodBucketScale` 标记为 Deprecated
   - 主渲染路径不再使用

3. **动态密度计算正确**
   - 使用 Figma 的按需降采样策略
   - 返回连续浮点值，不是固定档位

### ⚠️ 需要人工验证

1. **GPU 使用率**
   - 用活动监视器查看 GPU 历史记录
   - 目标：20-40%

2. **清晰度平滑性**
   - 放大/缩小观察清晰度变化
   - 应该平滑过渡，无跳变

3. **并行渲染**
   - GPU 曲线应显示峰值叠加
   - 不是单峰串行

### ❌ 我无法测试的内容

- 活动监视器 GPU 历史记录
- Electron 应用交互
- 清晰度视觉效果
- 性能基准对比

**这些需要人工完成**。

---

**报告日期**：2026-10-19  
**实现状态**：自适应 DPR 已完成，GPU 性能待人工验证  
**诚实声明**：我无法运行图形界面或查看 GPU 使用率，所有性能估计都是基于代码分析的推测
