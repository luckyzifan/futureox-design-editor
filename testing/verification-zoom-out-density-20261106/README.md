# 滚轮缩小卡住：分析与主动缩出密度播种（2026-11-06）

## 症状与既有实测

用户报告：高倍放大后缩小，屏幕卡住。仓库已有量化证据（非新回归）：

- `verification-overview-zoom-20261104/measurements.json`：`reverse-zoom-out.readyObservedAfterInputMs = 9392`（反向缩小松手后 9.4 秒才就绪）；zoom-to-neighbours 10.7 s、zoom-back 7.1 s。
- `verification-zoom-navigation-20261103`：拓扑冷视口过渡→清晰约 **35 秒**（记录明示未关闭）。
- 11-02 轮已修「快速缩小后画板空白」（density-0 覆盖误判），但「缩小后长时间不清晰」一直开放。

## 机制（四层，按权重）

1. **瓦片需求平方爆炸**：瓦片寻址 `bounds×zoom/512`（`tile_stack.rs`），3200%→6% 为 53 倍线性比 → 2809 倍瓦片需求，全部重新光栅。
2. **高倍效果代价**：模糊/阴影按设备像素计价，撞 2048 光晕/256MiB 合成账本后 128px 分块降级，缩小手势中逐帧重算。
3. **缩入/缩出不对称（本轮修复点）**：`NativeSourceSurface` 的滚轮快道（`wheel`）只对 `zoomingIn` 开放；缩出方向没有任何快道，且 `SourceQualityLadder` 是**反应式**——先按全密度尝试、被 `sourceRasterLimit` 拒绝后才降档（最多 7 步试错），每步都是一次完整的失败光栅往返。
4. **总览图片串行解码**：缩小露出大量素材时逐画板解码排在瓦片光栅之后。

另注：滚轮缩放不开编辑事务（`interactionActive=false`），因此既有的指针手势自适应密度（`VITE_DESIGN_INTERACTION_ADAPTIVE_DENSITY`，zoom32 实测 758–951ms→10–216ms）即便开 flag 也从未覆盖滚轮通道。

## 修复（方案 A：滚轮缩出主动密度播种）

- `interaction-adaptive-density.ts`：`interactionAdaptiveScale` 增加 `zoomOut` 旁路参数；新增 `outwardInteractionScale`——同一 Figma-viewer 阶梯除数（2^⌈log₄(需求/8M)⌉），对缩出方向**无需全局 flag** 即生效。指针手势通道语义完全不变。
- `source-quality-ladder.ts`：新增 `seed(scale, original)`——把梯子直接种在阶梯密度上（escalation 以 original 为上界），跳过「失败全量光栅才发现可用密度」的试错。
- `NativeSourceSurface.tsx`：pose 重置后，`continuousZoom && !zoomingIn`（连续缩出）且 `(zoom×DPR)²×视口 > 8M` 时播种；姿态变化逐 tick 重新播种；松手后由既有 `presented()` 几何升级回到全密度。

## 验证

- 单测：`interaction-adaptive-density.test.ts` 新增缩出旁路用例（flag 关时指针通道不变、缩出通道降档且 ≤8M 预算、预算内不降）；`source-quality-ladder.test.ts` 新增 3 例（seed 落底并以 original 为界升级、seed 后再被拒继续减半不回全量、seed≥original 忽略）。
- 回归：`interaction-adaptive-density` + `source-quality-ladder` + `NativeSourceSurface`（管线+本体）4 文件 **36/36 通过**；`tsc --noEmit` 干净。

## 边界与后续

- 本轮只动滚轮缩出通道的**调度密度**，不动落定精确瓦片、导出、低倍缩减层与任何预算常量；松手后的清晰化路径不变。
- 真机收益复测待做：建议按 11-03 的固定回放（117/FIG/拓扑三件套 + reverse-zoom-out 段）对比 `readyObservedAfterInputMs`。
- 方案 B（缩出预取低密度层）、C（总览金字塔兜底）与 dense_coverage 缩出回退验证仍列后续。
