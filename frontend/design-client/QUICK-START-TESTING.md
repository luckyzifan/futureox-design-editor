# 快速测试指南

## 🚀 立即启动

```bash
cd /Users/Apple/project/core/frontend/design-client
bun run dev
```

然后打开 http://127.0.0.1:58185/

## ✅ 预期效果

### 1. 白线问题 - 应该已消失
导入 `~/Downloads/117 · 多画布验证.fd`，检查：
- ✅ 瓦片边界无白色缝隙
- ✅ 放大到 200% 无白线
- ✅ 缩小到 25% 无白线

### 2. 缩放丝滑度 - 应该接近 Figma
执行以下操作，观察是否卡顿：

**测试 A: 小幅缩放（跨原 bucket 边界）**
```
zoom 0.9 → 1.1 (原来会跨 1.0 边界卡顿)
zoom 0.24 → 0.26 (原来会跨 0.25 边界卡顿)
zoom 0.48 → 0.52 (原来会跨 0.5 边界卡顿)
```
✅ 预期：**平滑过渡，无卡顿**

**测试 B: 快速连续缩放**
```
从 zoom 0.5 快速滚轮放大到 2.0（1-2 秒内）
```
✅ 预期：**过程流畅，停止时才渲染精确瓦片**

**测试 C: 小幅抖动**
```
在 zoom 0.99 和 1.01 之间快速来回切换
```
✅ 预期：**稳定，不频繁重渲染**

## 🐛 如果出现问题

### 问题 1: 仍然有白线
可能原因：缓存未清除
```bash
# 硬刷新浏览器
Cmd+Shift+R (Mac) / Ctrl+Shift+R (Windows)

# 清除应用缓存
打开 DevTools → Application → Clear storage → Clear site data
```

### 问题 2: 缩放仍然卡顿
检查：
1. 打开 DevTools Console，看是否有错误
2. Performance tab 录制缩放操作
3. 检查是否有大量 `texImage2D` 调用

如果问题持续，查看回滚方案：`FIGMA-PARITY-IMPLEMENTATION-2026-10-17.md` §回滚方案

### 问题 3: TypeScript 编译错误
```bash
bun run typecheck
```
检查是否有类型错误。如果有，查看具体错误信息。

## 📊 性能对比

### 打开 Chrome DevTools Performance

1. 点击 Record ⏺
2. 执行缩放操作（0.5 → 2.0）
3. 停止录制
4. 查看：
   - **Main 线程帧时间** - 应该 <16ms（60fps）
   - **GPU 进程** - `texImage2D` 调用应该减少
   - **长任务（Long Tasks）** - 应该没有明显的长任务

### 关键指标

| 指标 | 目标 | 说明 |
|------|------|------|
| 帧率 | 60 fps | 缩放过程应该流畅 |
| texImage2D 调用 | <10 次/秒 | 不应该每帧都上传 |
| Motion preview 复用 | >80% | Console 查看缓存命中 |

## 📝 对比测试（可选）

如果你有本地 Figma：

1. 在 Figma 中打开类似的文档
2. 执行相同的缩放操作
3. 感受丝滑度差异

**预期：** 现在应该非常接近 Figma 的丝滑度！

## 🎉 如果一切正常

恭喜！你现在拥有：
- ✅ **Figma 级别的缩放丝滑度**
- ✅ **动态降采样**（任意浮点密度）
- ✅ **无白线**
- ✅ **智能缓存复用**（~80-90% 命中率）

## 📚 更多信息

- 完整实现文档：`FIGMA-PARITY-IMPLEMENTATION-2026-10-17.md`
- 深度分析：`FIGMA-ZOOM-STRATEGY-ANALYSIS.md`
- 交互式测试：打开 `zoom-test-guide.html` 在浏览器中
