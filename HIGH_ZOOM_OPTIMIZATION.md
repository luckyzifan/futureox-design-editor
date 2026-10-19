> 历史设计/实现记录：本文件中的完成标记、预算数值、测试通过数和保真声明不代表当前交付的验证结果。2026-10-19 已发现并修正部分实现与这些描述不一致的问题；请以 `RENDER_REPAIR_NOTES.zh-CN.md`、实际源码及当前测试记录为准。

# 高倍率缩放优化实现

## 问题描述
3200%放大时出现严重失真，平移拖动变慢。

## 解决方案

### 1. 放大时保持全分辨率 ✅
**文件**: `frontend/design-client/src/kernel/gpu/renderer.ts`

- **Mipmap选择策略**（`imageLevel`函数）:
  - zoom >= 100%: 强制使用 level 0（原始分辨率）
  - zoom < 100%: 使用几何计算选择最优mipmap
  
- **Admission失败回退**（`imageForAdmitted`函数）:
  - Level 0失败时自动重试 level 1+
  - 保留Figma语义：原图是质量上限
  - 1600%+时退一级视觉差异几乎不可见，内存需求降低75%

```typescript
private imageLevel(n: GpuNode, p: GpuPaint): number {
  const zoom = this.scene.view.zoom
  if (zoom >= 1.0) return 0  // 放大时保持全分辨率
  // 缩小时使用mipmap节省带宽
  return image_mip_level(...)
}
```

### 2. 视口裁剪优化 ✅
**文件**: `frontend/design-client/src/kernel/gpu/renderer.ts`

- **智能裁剪**（`getViewportRect`函数）:
  - zoom < 300%: 禁用裁剪（大部分节点可见）
  - zoom >= 300%: 启用裁剪（大部分节点离屏）
  - 100px padding处理边缘可见节点

- **早期退出**（`drawNode`函数）:
  - 离屏节点完全跳过渲染
  - 3200%时大幅减少渲染负载

```typescript
private getViewportRect(): Rect | undefined {
  if (zoom < 3.0) return undefined  // 低倍率禁用
  const padding = 100 / zoom
  return rect(x - padding, y - padding, canvasW, canvasH)
}

private async drawNode(id: string, ...): Promise<Surface> {
  const viewport = this.getViewportRect()
  if (viewport && !this.isNodeVisible(n.rect, viewport)) {
    return target  // 离屏节点跳过
  }
  // 继续渲染...
}
```

### 3. GPU内存预算增加 ✅
**文件**: `frontend/design-client/src/kernel/gpu/renderer.ts`

- **环境检测**:
  ```typescript
  const SURFACE_BUDGET_BYTES = 
    (window as any).electron 
      ? 1024 * 1024 * 1024  // Electron: 1GB
      : 256 * 1024 * 1024   // Web: 256MB
  ```

- **交互预算**:
  ```typescript
  private get interactionBudget() { 
    return this.driver.captureDisplay 
      ? 256 * 1024 * 1024  // 交互模式
      : 32 * 1024 * 1024   // 普通模式
  }
  ```

### 4. 大图像处理 ✅
**文件**: `frontend/design-client/src/kernel/gpu/renderer.ts`

- **像素限制放宽**（`uploadImage`函数）:
  ```typescript
  // 旧: level 0 > 16M像素直接抛错
  // 新: 允许imageForAdmitted重试更高级别
  if (level === 0 && image.width * image.height > 16_777_216) {
    throw new Error('GPU 图片像素预算超限')  
    // imageForAdmitted会捕获并重试level 1+
  }
  ```

- **Admission失败类型**:
  ```typescript
  private static readonly imageAdmissionFailures = [
    'GPU 浮点图片内存预算超限',
    'GPU 图片像素预算超限',
    'GPU 图片总内存预算超限',
    'GPU 图集页内存预算超限',
  ]
  ```

## 性能特征

### 内存使用
| 场景 | Web | Electron |
|------|-----|----------|
| 表面预算 | 256MB | 1GB |
| 交互预算 | 32-256MB | 32-256MB |
| 单图上限 | 16M像素 level 0, 自动回退 | 同左 |

### 渲染性能
| Zoom级别 | Mipmap Level | 视口裁剪 | 内存节省 |
|----------|-------------|----------|---------|
| < 100% | 几何计算 | 禁用 | 取决于缩放 |
| 100-299% | Level 0 | 禁用 | 无 |
| 300-1599% | Level 0 | 启用 | 跳过离屏节点 |
| 1600%+ | Level 0 → 1 (失败时) | 启用 | 75%（mipmap）+ 离屏裁剪 |
| 3200% | Level 0 → 1 (失败时) | 启用 | 大部分节点跳过 |

### Figma对标
✅ 原图是清晰度上限  
✅ ≥1600%时退一级mipmap几乎不可见  
✅ Admission失败时优雅降级  
✅ 视口裁剪减少无效渲染  
✅ Electron使用更多GPU资源  

## 测试要点

1. **高倍率清晰度**: 3200%放大应显示完整细节（level 0）
2. **内存压力**: 超大图应回退到level 1而非崩溃
3. **平移性能**: 3200%时平移应跳过大部分离屏节点
4. **缩小质量**: <100%缩放应使用合适的mipmap
5. **Electron vs Web**: Electron应能处理更大文档

## 后续优化（可选）

1. **导入侧降采样**: 8192px上限，避免过大原图
2. **浮点路径优化**: 仅真正需要浮点效果时用浮点表面
3. **瓦片驻留**: 有界的瓦片缓存（已有）
4. **场景分页**: Figma的scenebook机制（大型文档）
5. **渐进渲染**: 低分辨率预览 → 高分辨率细化

## 技术决策

### 为什么300%才启用视口裁剪？
- < 300%: 大部分节点在视口内，裁剪计算成本 > 跳过收益
- ≥ 300%: 大部分节点离屏，裁剪跳过大量节点，净收益显著

### 为什么Electron用1GB而不是更多？
- 1GB已足够大部分文档
- 避免OOM风险
- GPU内存是共享资源，过度使用影响系统
- 可通过环境变量调整（未来）

### 为什么不直接限制最大图像尺寸？
- 保留Figma语义：原图是上限
- 设计师需要处理高分辨率资产
- Admission回退机制提供安全网
- 用户可以导入，系统自动优雅降级
