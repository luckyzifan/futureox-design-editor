# 清晰度动态调整验证报告

## 问题描述

用户反馈：**放大缩小时，清晰度不是动态的了**

## 预期行为

根据优化实现 (`src/kernel/tile-cache.ts` 的 `calculateDynamicDensity`)：

1. **缩小时 (scale < 0.5)**：
   - 降低瓦片密度 (density = 0.5)
   - GPU 应该**减少**工作量（渲染更少的像素）
   - 用户应该看到清晰度略微下降（可接受的性能换取）

2. **正常视图 (0.5 ≤ scale ≤ 2)**：
   - 使用标准密度 (density = 1.0)
   - GPU 正常工作
   - 清晰度最佳

3. **放大时 (scale > 2)**：
   - 提升瓦片密度 (density = 2.0)
   - GPU 应该**增加**工作量（渲染更多细节）
   - 用户应该看到超采样效果（更清晰）

## 验证步骤

### 1. 启动应用并打开 Activity Monitor

```bash
# 终端 1：启动应用
cd frontend/design-desktop
bun run dev

# 终端 2：监控 GPU
cd frontend/design-client
./scripts/monitor-gpu-usage.sh
```

### 2. 打开 macOS 活动监视器

1. 打开"活动监视器"应用
2. 菜单：窗口 > GPU 历史记录
3. 找到 "Electron" 进程
4. 观察 GPU 使用率曲线

### 3. 执行测试操作

#### 测试 A：缩小操作（应该降低 GPU 使用率）

1. 在应用中创建一个复杂矢量图形（多个路径、描边、阴影）
2. 记录当前 GPU 使用率（baseline）
3. **连续缩小视图** (Cmd + -) 到 25% 以下
4. **预期结果**：
   - ✅ GPU 使用率**下降** 30-50%
   - ✅ 清晰度略微下降（模糊一点）
   - ✅ 操作流畅（帧率保持）

#### 测试 B：放大操作（应该提升 GPU 使用率）

1. 从 100% 视图开始
2. 记录当前 GPU 使用率
3. **连续放大视图** (Cmd + +) 到 300% 以上
4. **预期结果**：
   - ✅ GPU 使用率**上升** 50-100%
   - ✅ 清晰度提升（超采样效果）
   - ✅ 边缘更平滑

#### 测试 C：快速缩放（测试并行性）

1. 使用触控板双指快速缩放
2. 观察 GPU 历史记录曲线
3. **预期结果**：
   - ✅ GPU 曲线应该有**明显波动**（跟随缩放动作）
   - ✅ 不应该有延迟或卡顿
   - ✅ 缩放停止后 GPU 使用率回落

## 可能的问题原因

如果清晰度**不是动态的**，可能是：

### ❌ 原因 1：动态密度未生效

检查点：
```typescript
// src/kernel/tile-cache.ts:calculateDynamicDensity
// 应该根据 scale 返回不同的 density
```

**调试方法**：在 `calculateDynamicDensity` 添加 console.log：
```typescript
export function calculateDynamicDensity(viewport: Viewport): number {
  const scale = viewport.camera.zoom
  const density = scale < 0.5 ? 0.5 : scale > 2 ? 2.0 : 1.0
  console.log(`[DynamicDensity] scale=${scale.toFixed(2)}, density=${density}`)
  return density
}
```

### ❌ 原因 2：瓦片缓存命中，未重渲染

检查点：
- 缩放后瓦片缓存 key 没有包含 density
- 旧的低密度瓦片被复用

**解决方案**：确保瓦片 key 包含 density：
```typescript
// src/kernel/tile-cache.ts
const key = `tile_${x}_${y}_${zoom}_${density}_${hash}`
```

### ❌ 原因 3：GPU 管线未并行

检查点：
- WebGPU 命令编码是串行的
- 未使用 compute shader 并行计算

**指标**：
- GPU 使用率持续低于 20%
- 活动监视器显示 CPU 更忙

## 成功指标

| 指标 | 当前状态 | 目标状态 |
|------|----------|----------|
| 缩小时 GPU 使用率 | ❓ 待测 | ↓ 30-50% |
| 放大时 GPU 使用率 | ❓ 待测 | ↑ 50-100% |
| 缩放响应延迟 | ❓ 待测 | < 16ms |
| 清晰度动态变化 | ❌ 用户报告不动态 | ✅ 明显可见 |
| GPU 历史曲线波动 | ❓ 待测 | ✅ 跟随操作 |

## 下一步

1. **用户测试**：按照上述步骤验证
2. **收集数据**：
   - 截图活动监视器的 GPU 历史记录
   - 记录各个缩放级别的 GPU 使用率
3. **根据结果调整**：
   - 如果 GPU 使用率不变 → 检查原因 1/2
   - 如果 GPU 使用率低 → 检查原因 3
   - 如果清晰度不变 → 检查瓦片缓存策略

## 快速诊断命令

```bash
# 检查 WebGPU 是否启用
cd frontend/design-client
bun test gpu/webgpu.test.ts

# 检查动态密度逻辑
bun test tile-cache.test.ts

# 启动应用并观察控制台日志
cd frontend/design-desktop
ELECTRON_ENABLE_LOGGING=1 bun run dev
```
