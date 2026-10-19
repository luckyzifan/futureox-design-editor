# 性能优化与新功能实施计划 (2026-10-18)

## 📋 任务清单

### 第一部分：性能优化（预计 2-3 小时）

#### 优化 1：合并场景遍历（2-3x 提升）

**当前问题**：
- `renderer.rs:699-732` 场景图被遍历 3 次：
  1. `scene_halo()` - 计算效果光晕
  2. `prepare_node_geometry()` - 准备几何数据
  3. `painter.node()` - 实际渲染

**优化方案**：
```rust
// 新增统一的场景准备函数
struct ScenePrepareResult {
    prepared: HashMap<String, Prepared>,
    max_halo: i32,
    stats: PrepareStats,
}

fn prepare_scene_unified(
    roots: &[String],
    camera: Transform,
    context: (&Document, &Fonts, Rect, bool),
    paths: &mut HashMap<String, Arc<(Path, Path)>>,
) -> Result<ScenePrepareResult, String> {
    // 一次遍历同时完成：
    // 1. 计算 halo
    // 2. 准备几何
    // 3. 收集统计
}
```

**预期提升**：10-20ms → 5-10ms（2x）

---

#### 优化 2：Checkerboard 行优化（2-4x 提升）

**当前问题**：
- `renderer.rs:757-766` 每像素执行 `div_euclid`
- `renderer.rs:767-791` 每像素执行 `rem_euclid` 和 `hypot`

**优化方案**：
```rust
// 行级计算，内层只做加减
for y in extent.y..extent.bottom() {
    let y_mod = (y - options.view.y as i32).rem_euclid(cell);
    for x in extent.x..extent.right() {
        let x_mod = (x - options.view.x as i32).rem_euclid(cell);
        // 使用预计算的 y_mod，只需一次加法
    }
}
```

**预期提升**：1-3ms → 0.3-1ms（3x）

---

### 第二部分：新功能 - 鼠标悬浮显示边距（预计 2-3 小时）

#### Figma 功能分析

根据 `figma-wasm-analysis/evidence/js-mining-2026-10-16/engine-wasm-export-funcidx-map.tsv`：

**核心 API**：
```
HandoffBindingsCpp_getMeasurementsForNode    (funcidx: 45517)
HandoffBindingsCpp_getMeasurementsForPage    (funcidx: 45515)
HandoffBindingsCpp_selectMeasurement         (funcidx: 45500)
NodeTsApi_addMeasurement                     (funcidx: 44760)
EditorState_Internal___getProperty_selectedMeasurementId (funcidx: 51601)
```

#### 功能需求

1. **悬浮检测**
   - 鼠标移动时检测悬停的节点
   - 计算该节点与周围节点的距离
   - 显示内边距、外边距、对齐参考线

2. **视觉呈现**
   - 红色矩形框：选中节点
   - 蓝色虚线：距离测量线
   - 数字标签：距离值（px）
   - 紫色参考线：对齐参考

3. **交互逻辑**
   - 按住 Alt/Option 键激活测量模式
   - 自动检测最近的 4 个邻居（上下左右）
   - 显示与父容器的边距

#### 实现架构

```typescript
// frontend/design-client/src/MeasurementOverlay.tsx
interface MeasurementData {
  targetNode: string;
  measurements: Array<{
    type: 'horizontal' | 'vertical';
    distance: number;
    from: { x: number; y: number };
    to: { x: number; y: number };
    relatedNode?: string;
  }>;
  bounds: { x: number; y: number; width: number; height: number };
}

export function MeasurementOverlay({
  enabled,
  hoverNode,
  document,
  camera,
}: {
  enabled: boolean;
  hoverNode: string | null;
  document: DesignDocument;
  camera: View;
}) {
  // 渲染测量线和标签
}
```

```rust
// design-kernel/src/measurement.rs
pub struct Measurement {
    pub node_id: String,
    pub direction: MeasurementDirection,
    pub distance: f64,
    pub start: Point,
    pub end: Point,
    pub related_node: Option<String>,
}

pub enum MeasurementDirection {
    Horizontal,
    Vertical,
}

pub fn calculate_measurements(
    doc: &Document,
    target_id: &str,
    viewport: Rect,
) -> Vec<Measurement> {
    // 1. 获取目标节点边界
    // 2. 查找同级兄弟节点
    // 3. 计算距离
    // 4. 查找父容器边距
}
```

#### 实现步骤

1. **Rust 内核**（1 小时）
   - `measurement.rs` - 计算逻辑
   - 导出 WASM API
   - 单元测试

2. **TypeScript 前端**（1-1.5 小时）
   - `MeasurementOverlay.tsx` - 渲染组件
   - Canvas SVG 层叠
   - Alt 键检测
   - 与现有选择系统集成

3. **集成测试**（0.5 小时）
   - 多节点场景测试
   - 性能验证
   - 视觉对齐检查

---

## 🎯 实施优先级

### 今日完成（4-6 小时）
1. ✅ 合并场景遍历优化（1 小时）
2. ✅ Checkerboard 优化（30 分钟）
3. ✅ 测试验证（30 分钟）
4. ⏸️ 测量功能 - Rust 内核（1 小时）
5. ⏸️ 测量功能 - 前端 UI（1-1.5 小时）
6. ⏸️ 集成测试（30 分钟）

### 明日目标
- 扩展瓦片缓存
- 像素填充 SIMD

---

## 📊 预期性能提升

| 优化项 | 当前耗时 | 优化后 | 提升 | 状态 |
|--------|----------|--------|------|------|
| HashMap 替换 | 已完成 | 已完成 | 2-3x | ✅ |
| 合并场景遍历 | 10-20ms | 5-10ms | 2x | ⏸️ |
| Checkerboard 优化 | 1-3ms | 0.3-1ms | 3x | ⏸️ |
| **累计提升** | - | - | **12-27x** | 40% |

---

## 📝 技术细节

### 场景遍历合并关键点

**挑战**：
- `scene_halo` 需要先完成才能计算 guard
- `prepare_node_geometry` 需要 guard 参数
- 两者都是递归遍历

**解决方案**：
- 第一次遍历：计算 halo + 准备几何（合并）
- 递归时携带 parent_halo
- 返回 (prepared, max_halo) 元组

### Checkerboard 优化关键点

**原理**：
```
当前：每像素 (x, y) 计算 x.div_euclid(cell) ^ y.div_euclid(cell)
优化：y 固定时，div_euclid(y, cell) 恒定
      内层只需计算 x.div_euclid(cell)
进一步：预计算行起始，内层用加法
```

### 测量功能关键点

**距离计算算法**：
```rust
// 水平距离
if target.right() <= neighbor.left() {
    // 目标在左
    distance = neighbor.left() - target.right()
} else if target.left() >= neighbor.right() {
    // 目标在右
    distance = target.left() - neighbor.right()
}

// 垂直距离同理
```

**性能考虑**：
- 只计算 viewport 内的节点
- 限制邻居搜索范围（最近 8 个）
- 缓存计算结果

---

**文档创建时间**：2026-10-18  
**预计完成时间**：今日 18:00  
**负责人**：Claude Opus 5.5
