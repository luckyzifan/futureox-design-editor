# 旋转/仿射手势 commit-handoff 修复记录（2026-10-22）

针对用户报告的"页面旋转拖动时割裂闪烁,然后突然渲染错位置":本增量落地诊断结论中的修复 1+2（最小改动组合),消除手势结束提交时的"跳回旋转前姿态"空窗,并停止仿射手势逐样本拆除交互所有者。诊断全文见会话记录;根因与本次修复的对应关系如下。

## 根因回顾（代码证据）

- `interactionPatchedOffsets`/`interactionOffsets`（interaction-layers.ts）对矩阵前 4 项变化的编辑返回 null,旋转因此无法走任何平移复用/热姿态路径;`end()` 的 worker-pose 收尾（interaction-renderer.ts:248 前置 `offsets`）与 commit-handoff（:258 前置 `offsets`、`!r.workerPoses`）都被跳过。
- Canvas.tsx move() 对非 move 手势每个指针样本调用 `gpuMove.end()`:逐样本 `stopResidentInteraction` + `inlineDisabled=true`,并写 `endedDocument` 去重标记,使手势末次(来自 editor 订阅)的 `end()` 被吞,交接永不触发。
- 内核侧 `can_retain_translation`（design-studio/crates/design-kernel/src/renderer.rs:371-398）同样硬性拒绝线性部分变化——姿态快车道是 Rust 层纯平移设计,治本需要独立内核增量。

## 修复内容（4 个文件,+69/-6）

1. **interaction-layers.ts**:新增 `interactionTransformsOnly(plan, current)`——校验当前文档与 plan 快照的差异仅限选中节点的 transform 字段（任意六元组变化,非 transform 字段/非选中节点/页面结构变化均拒绝）。它与 `interactionOffsets` 的区别:把"平移可复用"与"结构上可保留显示"两个语义分开。
2. **interaction-renderer.ts `end()`**:计算 `affine = !offsets && document !== r.plan.document && interactionTransformsOnly(...)`;commit-handoff 分支门槛由 `!r.workerPoses && offsets` 放宽为 `(offsets && !r.workerPoses || affine)`。取消路径(文档回到 plan 快照,`document === r.plan.document`)不取该栅栏,维持原回退行为。`lastEnd` 诊断新增 `'affine'` 值。worker-pose 收尾分支保持 offsets-only(内核交互车道纯平移,仿射送入只会 rebase)。
3. **Canvas.tsx move()**:`gpuMove.end()` 仅在 `d.kind === 'move'`（平移快路径回落时需要交还所有权)调用;rotate/resize/scale 的所有者只在 commit/cancel 后经 editor 订阅结束一次——会话/页面/相机变化仍由 `prepare()` 既有路径处理。
4. **rotation-handoff.integration.test.tsx**:新增 2 个用例——仿射 commit 交接在精确瓦片就绪前保留已完成姿态(无空帧、不 stop 会话、就绪后释放),以及含非 transform 内容变化的结束不取保留栅栏。

## 效果与边界

- 修复后,旋转手势结束时:最后一次完成的捕获在精确通道渲染最终文档期间持续显示(样本地板/`sameHandoff` 既有机制保证就绪后一次性切换),不再出现跳回旋转前姿态再跳到最终姿态的空窗;拖动中不再逐样本 stop/重建 worker 姿态会话。
- **不解决**:拖动中的捕获节奏跳变本身(每样本仍是全量捕获;姿态快路径需内核 `apply_interaction_transforms` 支持仿射 + WASM 重建 + 独立验收,未包含);resize 补丁含非 transform 字段(宽度/高度),多数情况不满足 transforms-only,维持原路径;硬件 GPU/Electron 实机、FPS、物理同帧未验收。
- `VITE_DESIGN_INTERACTION_ADAPTIVE_DENSITY` 保持默认关闭(整编辑器验收未完成,见 verification-interaction-adaptive-density-20261022)。

## 本地验证

- `tsc --noEmit` 通过(树中含并行 WIP 的全部改动)。
- vitest:rotation-handoff.integration 15/15(含新增 2)、interaction-release-handoff 21/21、handoff-trace 5/5、interaction-renderer 63/63、canvas-block-interaction + electron-resize-rotate-boundaries 98/98、interaction-editor-recovery 32/32、canvas-async-preview-recovery + canvas-action-mounted 10/10。
- kernel 全目录 2574 通过、12 失败(gpu/mask-lifetime、paint-merge-admission、painter-stage、whole-image-filter、resident-budget-failure)。**该 12 项为预先存在**:将本增量 4 文件 stash 后复跑,同样 12 项失败(工作区含另一批并行 WIP:gpu/renderer.ts、App.tsx、scheduleIdleWarm flag 语义翻转、实例分离提示等,非本增量内容,归属待其作者处理)。
- 未运行:生产构建、硬件 GPU、Electron GUI、117 回放。
