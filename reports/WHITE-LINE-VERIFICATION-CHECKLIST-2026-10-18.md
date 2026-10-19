# 白线修复验证清单（2026-10-18）

## 🚀 开发服务器已启动

**地址**：http://127.0.0.1:5173

---

## ✅ 验证步骤

### 1. 基础检查（5 分钟）

#### A. 瓦片尺寸验证
打开浏览器开发者工具（F12），在 Console 中运行：

```javascript
// 检查瓦片实际尺寸
const canvases = document.querySelectorAll('canvas')
canvases.forEach((canvas, i) => {
  console.log(`Canvas ${i}: ${canvas.width}x${canvas.height}`, canvas.className || canvas.id)
})

// 预期结果：应该看到多个 512x512 的 canvas
// 不应该有 514x514
```

#### B. 合成器统计
```javascript
// 检查合成器状态
const compositor = document.querySelector('canvas[data-compositor-tiles]')
if (compositor) {
  console.log({
    tiles: compositor.dataset.compositorTiles,
    frames: compositor.dataset.compositorFrames,
    uploads: compositor.dataset.compositorUploads,
    bytes: compositor.dataset.compositorBytes,
    coverage: compositor.dataset.coverage,
  })
}
```

### 2. 白线测试（10 分钟）

#### A. 初始化白线
- [ ] 打开文档（或创建新文档，添加几个矩形）
- [ ] 观察初始加载时是否有白线
- [ ] **预期**：白线应该明显减少（修复前明显 → 修复后轻微或无）

#### B. 缩放测试
- [ ] 缩小：滚轮向下（zoom 0.5）
- [ ] 观察：白线是否出现
- [ ] 放大：滚轮向上（zoom 2.0）
- [ ] 观察：白线是否出现
- [ ] **预期**：白线减少 80%+

#### C. 快速连续缩放
- [ ] 快速连续滚轮缩放（0.5 → 2.0 → 0.5）
- [ ] 观察：过渡期间是否有白线闪烁
- [ ] **预期**：白线闪烁明显减少

#### D. 平移测试
- [ ] 按住空格 + 拖动平移画布
- [ ] 观察：平移时瓦片边界是否有白线
- [ ] **预期**：平移时无白线（瓦片复用）

### 3. 边缘情况测试（5 分钟）

#### E. 高 DPR（Retina）
如果你在 Retina 显示器上：
- [ ] 缩放到 1:1（zoom 1.0）
- [ ] 观察：是否有白线
- [ ] **预期**：Retina 下白线也应减少

#### F. 浏览器缩放
- [ ] 按 Cmd/Ctrl + "+" 放大浏览器
- [ ] 观察：是否有白线
- [ ] 按 Cmd/Ctrl + "-" 缩小浏览器
- [ ] 观察：是否有白线
- [ ] **预期**：浏览器缩放不影响白线修复

### 4. 性能测试（5 分钟）

#### G. 缩放流畅度
- [ ] 快速缩放（滚轮快速滚动）
- [ ] 观察：是否流畅（60fps）
- [ ] **预期**：应该流畅，无明显卡顿

#### H. 控制台性能日志
```javascript
// 在 Console 中运行，监控性能
performance.mark('zoom-start')
// 然后手动缩放
performance.mark('zoom-end')
performance.measure('zoom', 'zoom-start', 'zoom-end')
console.table(performance.getEntriesByType('measure'))

// 预期：每次缩放 < 100ms
```

---

## 📊 结果记录

### 白线情况（修复前 vs 修复后）

| 场景 | 修复前 | 修复后 | 改善 |
|------|-------|--------|------|
| 初始化加载 | ⬜⬜⬜⬜⬜ 5/5 严重 | ⬜☐☐☐☐ ?/5 | ? |
| 缩放 0.5 → 2.0 | ⬜⬜⬜⬜☐ 4/5 明显 | ☐☐☐☐☐ ?/5 | ? |
| 快速连续缩放 | ⬜⬜⬜⬜⬜ 5/5 严重 | ⬜☐☐☐☐ ?/5 | ? |
| 平移 | ⬜⬜☐☐☐ 2/5 轻微 | ☐☐☐☐☐ ?/5 | ? |
| Retina 显示 | ⬜⬜⬜⬜☐ 4/5 明显 | ⬜☐☐☐☐ ?/5 | ? |

**评分标准**：
- 5/5 = 非常明显白线，覆盖 > 50% 边界
- 4/5 = 明显白线，覆盖 20-50% 边界
- 3/5 = 中等白线，覆盖 10-20% 边界
- 2/5 = 轻微白线，覆盖 5-10% 边界
- 1/5 = 极轻微，覆盖 < 5% 边界
- 0/5 = 完全无白线

### 性能情况

| 指标 | 测量值 |
|------|--------|
| 初始加载时间 | ? ms |
| 缩放响应时间 | ? ms |
| 平移流畅度 | ? fps |
| 瓦片上传次数 | ? |
| 内存占用 | ? MB |

---

## 🔧 如果白线仍然存在

### 调试步骤

1. **检查 gutter 是否真的禁用了**
```javascript
// 在 Console 运行
const tiles = window.__DEBUG_TILES__ || []
console.log('Tile gutter:', tiles[0]?.gutter)
// 应该输出 0
```

2. **检查 UV 坐标**
在 `tile-compositor.ts:129` 添加日志：
```typescript
console.log('[UV]', raster.uv, 'Size:', tile.width, 'x', tile.height)
// 应该是 [0, 0, 1, 1]
```

3. **截图对比**
- 修复前：（如果有旧截图）
- 修复后：（拍摄新截图）

---

## ✅ 预期结果

如果修复成功，你应该看到：
- ✅ 瓦片尺寸全部是 512×512
- ✅ 初始化白线减少 60%+
- ✅ 缩放白线减少 80%+
- ✅ 快速缩放白线闪烁减少 80%+
- ✅ 平移流畅，无白线
- ✅ 性能无明显下降

---

## 🚨 如果白线没有改善

可能的原因：
1. **缓存问题**：硬刷新（Cmd/Ctrl + Shift + R）
2. **其他原因**：可能是 LOD 切换或 UV 坐标问题
3. **需要进一步调试**：使用上述调试步骤

---

**测试时间**：预计 20-25 分钟  
**完成后**：报告结果，我会根据情况继续优化
