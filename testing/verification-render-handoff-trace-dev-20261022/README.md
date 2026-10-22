# 8070ebe 交接修复与 handoff trace 开发包合并记录（2026-10-22）

将 `core-8070ebe-handoff-trace-dev-20261022.zip` 合入主线。适用基线 `8070ebeed52f75cadc66b036543e9fcc8fad104f` 与合并时 HEAD 完全一致，执行包内哈希守卫的 `apply_increment.py apply`（13 个路径全部命中）。归档见 [bundle/](bundle/)。

**这是开发测试包，不是验收包**：按用户指示跳过最终回归，三修复+trace 最终组合未跑过功能回归、typecheck、guard 或补丁正反应用测试；仅做包装完整性检查。追加 trace 前的三修复版本另有 542 项去重测试与 strict scoped TypeScript 记录（evidence/base-before-trace/），不能当作本组合的验证。

## 合并内容

1. 一次性普通图片区域字段安全退休（不再被当可复用字段保留，走既有退休队列与完成边界）。
2. 非 tiled 平移 commit handoff 交接改善。
3. Rotation owner/cohort v3：旋转所有权与同批次画面交接，保留 fatal handler 接线与过时通知保护。
4. 有界 owner/sourceOrder/cohort 交接 trace（开发候选，非全系统因果 trace）。

## 本地补修与验证

最终组合缺 typecheck，合入后完整 `tsc --noEmit` 暴露两处新测试文件类型错误，已按仓库惯例最小修复（与 146825d 的 findLast 修复同性质）：

- `handoff-trace.test.ts`：no-op `schedule/cancel` 回调经 `as unknown as typeof setTimeout/clearTimeout` 对齐 `.d.mts` 的 Node 类型声明；
- `rotation-handoff.integration.test.tsx`：jsdom 导入加 `@ts-expect-error jsdom runtime dependency`（与 ColorPickerPopover/AutomationPanel 既有做法一致）。

修复后本地验证：完整 `tsc --noEmit` 通过；`handoff-trace.test.ts` 5/5、`rotation-handoff.integration.test.tsx` 13/13 通过。**未运行**包内 542 项回归、生产构建、硬件 GPU、Electron GUI 或 117 回放。包内 req173 复现记录（旧路径 3 条后失败 → 新候选 24 条）是受控 CPU/recording-driver 结果且追加 trace 后未复跑。

## 边界

不降画质、不改采样策略；rotation v1/v2、FrameCoordinator、paired-tap 等实验不包含。工作集峰值/预算错误、物理同帧、GPU 画质、FPS、完整操作回放均不在本包范围；fatal 恢复仍限于活跃手势。
