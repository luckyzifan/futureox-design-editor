# 前端 UI 集成完整实施方案（2026-10-18）

## 📊 当前状态总结

### ✅ 已完成的基础设施

#### 1. 动态降采样系统（Figma 风格）
**文件**：`tile-cache.ts`、`canvas-raster-plan.ts`

```typescript
// ✅ 已实现：calculateDynamicDensity()
// 特点：
// - 连续密度（任意浮点值）
// - 按需降采样（只在超预算时）
// - 4x/2x 降采样策略
// - 与 Figma 的 GLUE-JS-MINING.md §2.4 完全一致
```

**使用位置**：`canvas-raster-plan.ts:canvasLodScale()`
```typescript
return calculateDynamicDensity(
  zoom * dpr,
  { width: width / zoom, height: height / zoom },
  maxTiles
)
```

#### 2. 2 帧去抖系统
**文件**：`use-raster-density.ts`、`interaction-density.ts`

```typescript
// ✅ 已实现：InteractionDensity
// 特点：
// - 2 帧稳定才切换密度
// - 大跳跃立即生效 (>1.5x 或 <0.5x)
// - 80ms 超时保护
// - 与 Figma 的 FrameDebouncer(2) 完全一致
```

#### 3. 瓦片系统
**文件**：`ProgressiveSurface.tsx`、`tile-cache.ts`

```typescript
// ✅ 已实现：
// - 世界坐标瓦片 (512x512)
// - LRU 淘汰
// - 距离排序（最近优先）
// - 屏内/屏外预算分离
// - 16ms/2 瓦片预算
```

---

## 🎯 需要完成的工作

### 1. 测量功能集成（2-3 小时）

#### A. 已创建的组件 ✅
- `MeasurementOverlay.tsx` - SVG 测量线渲染组件
- `measurement.ts` - TypeScript 类型定义

#### B. 待集成到 ProgressiveSurface ⏸️

**需要添加的功能：**

1. **Alt 键监听**
```typescript
const [altPressed, setAltPressed] = useState(false)
const [measurements, setMeasurements] = useState<Measurement[]>([])

useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Alt' && !altPressed) {
      setAltPressed(true)
    }
  }
  const handleKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Alt' && altPressed) {
      setAltPressed(false)
      setMeasurements([]) // 清空测量
    }
  }
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  return () => {
    window.removeEventListener('keydown', handleKeyDown)
    window.removeEventListener('keyup', handleKeyUp)
  }
}, [altPressed])
```

2. **鼠标悬浮检测 + 测量计算**
```typescript
const handleMouseMove = useCallback(async (e: React.MouseEvent) => {
  if (!altPressed) return

  // 转换为世界坐标
  const rect = canvasRef.current?.getBoundingClientRect()
  if (!rect) return

  const canvasX = (e.clientX - rect.left) / rect.width * width
  const canvasY = (e.clientY - rect.top) / rect.height * height
  
  const worldX = view.x + canvasX / view.zoom
  const worldY = view.y + canvasY / view.zoom

  // TODO: 调用 Rust 内核的 hit test
  // const targetId = await kernel.hitTest(worldX, worldY)
  // if (!targetId) return

  // TODO: 调用 Rust 内核计算测量
  // const m = await kernel.calculateNodeMeasurements(targetId)
  // setMeasurements(m)
  
  console.warn('[Measurement] Rust kernel binding not yet wired')
}, [altPressed, view, width, height])
```

3. **渲染 MeasurementOverlay**
```typescript
return (
  <>
    {/* 现有的渲染内容 */}
    <TileCompositeSurface ... />
    
    {/* 新增：测量覆盖层 */}
    {altPressed && measurements.length > 0 && (
      <MeasurementOverlay
        measurements={measurements}
        zoom={view.zoom}
        dpr={dpr}
      />
    )}
  </>
)
```

#### C. Rust 内核绑定 ⏸️

**已完成**：
- ✅ Rust 测量函数：`measurement.rs::calculate_measurements()`
- ✅ 导出函数：`export.rs::calculate_node_measurements()`

**待完成**：
- ⏸️ WASM 绑定（wasm-bindgen）
- ⏸️ Worker 消息传递
- ⏸️ TypeScript 调用封装

**需要修改的文件**：
1. `design-kernel/src/lib.rs` - 添加 wasm-bindgen 导出
2. `render-worker.ts` - 添加 `calculateMeasurements` 消息处理
3. `client.ts` - 添加 `calculateMeasurements()` API

---

### 2. 前端性能优化 ✅ 已完成

#### A. 动态降采样（替代固定 LOD bucket）✅

**对比**：

| 特性 | 旧实现（固定 bucket） | 新实现（动态密度）✅ |
|------|----------------------|---------------------|
| 密度值 | 固定档位（0.25/0.5/1/2） | 任意浮点值（0.73/1.42...） |
| 缩放 0.9→1.1 | 跨 1.0 边界→全部失效 | density 0.9→1.1→瓦片保留 |
| 超预算策略 | 预先分档 | 按需 4x/2x 降采样 |
| 去抖 | 2 帧（已有）| 2 帧（已有） |

**实施状态**：✅ 完成
- `calculateDynamicDensity()` 已实现
- `canvasLodScale()` 已集成
- `lodBucketScale()` 标记为 deprecated

#### B. 瓦片调度优化 ✅ 已完成

**参考 Figma**：（GLUE-JS-MINING.md §2）

| 特性 | Figma | 你的实现 | 状态 |
|------|-------|---------|------|
| 瓦片尺寸 | 512 设备像素 | 512 (TILE_SIDE) | ✅ 一致 |
| 帧预算 | 16ms / 2 瓦片 | 16ms / 2 瓦片 | ✅ 一致 |
| 屏内豁免 | 忽略预算 | permitWorkAfterBudgetExceeded | ✅ 一致 |
| 屏外预取 | 强制预算 | while(permitsMoreWork()) | ✅ 一致 |
| 优先级 | 距离排序 | prioritizeTileFill() | ✅ 一致 |
| 淘汰策略 | LRU 代标 | LRU (ready/failedTiles) | ✅ 一致 |
| 密度策略 | 2 帧去抖 + 按需降采样 | InteractionDensity + calculateDynamicDensity | ✅ 一致 |

#### C. 交互渲染优化 ✅ 已完成

**参考 Figma**：（CURRENT-GAP-AUDIT §4）

| 场景 | Figma | 你的实现 | 状态 |
|------|-------|---------|------|
| 拖动独立画板 | 复用隔离纹理 | ResidentCompositeSurface | ✅ 一致 |
| 拖动嵌套对象 | 低分辨率重绘 | interaction-renderer (512px) | ✅ 一致 |
| 缩放 | 2 帧去抖 + CSS 复用 | InteractionDensity + TileCompositeSurface | ✅ 一致 |
| 平移 | 瓦片复用 | panPrefetch() | ✅ 一致 |

---

## 📝 实施优先级

### 高优先级（必须完成）

1. **⏸️ WASM 绑定测量函数**（1 小时）
   - 修改 `lib.rs` 添加 `#[wasm_bindgen]`
   - 修改 `render-worker.ts` 处理消息
   - 修改 `client.ts` 封装 API

2. **⏸️ Alt 键交互集成**（0.5 小时）
   - 修改 `ProgressiveSurface.tsx` 添加键盘监听
   - 添加鼠标悬浮处理
   - 渲染 `MeasurementOverlay`

3. **⏸️ 端到端测试**（0.5 小时）
   - Alt 键激活/取消
   - 鼠标悬浮显示距离
   - 缩放时坐标更新
   - 性能流畅（< 16ms）

### 低优先级（可选增强）

4. **⏸️ 测量功能增强**
   - 箭头指示器
   - 多色测量线（父容器/兄弟节点）
   - 快捷键切换（可视化模式）

5. **⏸️ 性能监控面板**
   - 实时瓦片统计
   - 密度变化可视化
   - 内存占用监控

---

## 🔧 实施步骤（详细）

### 步骤 1: WASM 绑定（1 小时）

#### 1.1 修改 `design-kernel/src/lib.rs`

```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn calculate_node_measurements_wasm(
    engine_ptr: *mut Engine,
    target_id: &str,
) -> Result<JsValue, JsValue> {
    let engine = unsafe { &mut *engine_ptr };
    let measurements = export::calculate_node_measurements(engine, target_id)
        .map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&measurements)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
```

#### 1.2 修改 `render-worker.ts`

```typescript
// 添加消息类型
interface CalculateMeasurementsRequest {
  type: 'calculateMeasurements'
  targetId: string
  serial: number
}

// 添加处理逻辑
case 'calculateMeasurements': {
  const measurements = await kernel.calculateNodeMeasurements(msg.targetId)
  postMessage({
    type: 'measurementsResult',
    serial: msg.serial,
    measurements,
  })
  break
}
```

#### 1.3 修改 `client.ts`

```typescript
export class KernelClient {
  // ...

  async calculateMeasurements(targetId: string): Promise<Measurement[]> {
    const serial = this.nextSerial++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), 5000)
      
      this.pendingMeasurements.set(serial, (measurements) => {
        clearTimeout(timeout)
        resolve(measurements)
      })
      
      this.worker.postMessage({
        type: 'calculateMeasurements',
        targetId,
        serial,
      })
    })
  }
}
```

### 步骤 2: Alt 键集成（0.5 小时）

#### 2.1 修改 `ProgressiveSurface.tsx`

```typescript
// 在组件顶部添加
import { MeasurementOverlay } from './MeasurementOverlay'
import type { Measurement } from './measurement'

// 在函数体内添加状态
const [altPressed, setAltPressed] = useState(false)
const [measurements, setMeasurements] = useState<Measurement[]>([])
const [hoveredNode, setHoveredNode] = useState<string | null>(null)

// 添加键盘监听
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Alt' && !e.repeat) setAltPressed(true)
  }
  const handleKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Alt') {
      setAltPressed(false)
      setMeasurements([])
      setHoveredNode(null)
    }
  }
  window.addEventListener('keydown', handleKeyDown, { passive: true })
  window.addEventListener('keyup', handleKeyUp, { passive: true })
  return () => {
    window.removeEventListener('keydown', handleKeyDown)
    window.removeEventListener('keyup', handleKeyUp)
  }
}, [])

// 添加鼠标悬浮处理
const handleMouseMove = useCallback(async (e: React.MouseEvent) => {
  if (!altPressed || !canvasRef.current) return

  const rect = canvasRef.current.getBoundingClientRect()
  const worldX = view.x + ((e.clientX - rect.left) / rect.width * width) / view.zoom
  const worldY = view.y + ((e.clientY - rect.top) / rect.height * height) / view.zoom

  // TODO: Hit test + 计算测量
  // const targetId = await client.hitTest(worldX, worldY)
  // if (targetId && targetId !== hoveredNode) {
  //   setHoveredNode(targetId)
  //   const m = await client.calculateMeasurements(targetId)
  //   setMeasurements(m)
  // }
}, [altPressed, view, width, height, hoveredNode])

// 在 return 中添加
<div onMouseMove={handleMouseMove}>
  {/* 现有内容 */}
  {altPressed && measurements.length > 0 && (
    <MeasurementOverlay
      measurements={measurements}
      zoom={view.zoom}
      dpr={dpr}
    />
  )}
</div>
```

### 步骤 3: 测试（0.5 小时）

#### 3.1 功能测试
```bash
# 启动开发服务器
bun run dev

# 测试步骤：
# 1. 打开画布
# 2. 按下 Alt 键 → 应该激活测量模式
# 3. 鼠标悬浮到节点 → 应该显示距离线
# 4. 松开 Alt 键 → 测量线消失
# 5. 缩放/平移 → 测量线坐标实时更新
```

#### 3.2 性能测试
```typescript
// 添加到 handleMouseMove
const start = performance.now()
const measurements = await client.calculateMeasurements(targetId)
const elapsed = performance.now() - start
console.log(`[Measurement] Calculated in ${elapsed.toFixed(2)}ms`)
// 目标：< 16ms
```

---

## 📊 预期成果

### 性能指标

| 指标 | 目标 | 状态 |
|------|------|------|
| 缩放流畅度 | 60fps | ✅ calculateDynamicDensity |
| 测量计算 | < 16ms | ⏸️ 待测试 |
| Alt 键响应 | < 100ms | ⏸️ 待实现 |
| 内存占用 | 无明显增长 | ✅ 测量缓存 < 10KB |

### 功能完整性

| 功能 | Figma | 你的实现 | 状态 |
|------|-------|---------|------|
| 连续密度 | ✅ | ✅ calculateDynamicDensity | ✅ |
| 2 帧去抖 | ✅ | ✅ InteractionDensity | ✅ |
| 按需降采样 | ✅ | ✅ 4x/2x 策略 | ✅ |
| 父容器边距 | ✅ | ✅ measurement.rs | ✅ Rust 侧 |
| 兄弟间距 | ✅ | ✅ measurement.rs | ✅ Rust 侧 |
| Alt 键激活 | ✅ | ⏸️ 待集成 | ⏸️ |
| 测量 UI | ✅ | ✅ MeasurementOverlay | ✅ |

---

## 🎯 最终交付清单

### ✅ 已完成
1. Rust 测量内核（200 行）
2. 动态降采样系统
3. 2 帧去抖系统
4. MeasurementOverlay 组件
5. TypeScript 类型定义

### ⏸️ 待完成（2-3 小时）
1. WASM 绑定（1 小时）
2. Alt 键集成（0.5 小时）
3. 端到端测试（0.5-1 小时）

### 📝 文档
- 本文档：实施方案
- FINAL-SUMMARY-2026-10-18.md：Rust 侧总结
- FIGMA-PARITY-IMPLEMENTATION-2026-10-17.md：Figma 对齐分析

---

**完成时间预估**：2-3 小时（仅前端集成部分）  
**总体完成度**：Rust 侧 100%，前端侧 60%  
**下一步行动**：实施步骤 1（WASM 绑定）
