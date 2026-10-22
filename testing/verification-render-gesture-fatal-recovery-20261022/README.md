# 146825d 异步预览 fatal 恢复合并记录（2026-10-22）

将 `core-146825d-active-gesture-fatal-recovery-20261022.zip` 增量合入主线。适用基线 `146825dad9e292b1b06046d17a269397d75ab323` 与合并时 HEAD 完全一致，执行包内哈希守卫的 `apply_increment.py apply`（7 个路径——生产 4、测试 2、测试配置 1——全部命中，无手工改动；脚本 SHA-256 与前四包一致 `7779f3b2…`）。归档见 [bundle/](bundle/)，完整性清单 [SHA256SUMS](bundle/SHA256SUMS)。

## 修复内容

仅在移动手势仍活跃时：原生预览在指针停止后异步 fatal 失败，不再等下一次 pointermove 才处理——在文档、页面、会话、选择和输入序号仍匹配时，一次性把最新绝对 patch 转交原有 Editor 事务。同步抛错也等 apply 返回、最新待处理 patch 发布后再通知。交接先结束失败的 native 姿态作用域再走既有编辑路径，防重入造成重复移动或多余历史项；结束/取消/提交/切换文档/新手势/选择变化后的过时通知被隔离。诊断保留未确认（未 ACK）姿态汇总，不把未确认伪装为已呈现。

**边界**：已结束手势不适用自动接管（结束后到达的失败被拒绝）；不解决迟到失败的主要耗时；不保证后续手势 native 快路径自动恢复（错误锁存可能仍走 fallback）；旋转闪烁、大表面驻留峰值、预算错误、蓝框与画面物理同帧、硬件画质/帧率均不在本修复范围。

## 验证边界

包内记录：484 项去重测试（284 renderer、101 pose/Editor、17 mounted Canvas、82 Node）、strict scoped TypeScript（含传递依赖）、7 补丁前置哈希取自精确 Git 基线、1,973 文件基线指纹审计（保留 findLast 兼容修改）、正反向应用与 12 项保护检查。

本地按用户指示只做 **Vitest 冒烟：interaction-editor-recovery 32/32 通过**，未复跑 484 项全量。测试用真实 React/Editor 与源码匹配 dev opt1 WASM；渲染设备与呈现为 mock/fixture。未验收硬件 GPU 像素、Electron/macOS GUI、FPS、物理同帧或完整操作回放。
