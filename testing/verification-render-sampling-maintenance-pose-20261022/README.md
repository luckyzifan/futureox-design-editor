# 117 采样分区 / 维护回收 / Pose 回执修复合并记录（2026-10-22）

将 `core-117-sampling-maintenance-pose-fixes-1cdebec-20261022.zip` 增量合入主线。适用基线 `1cdebec0a3bcde6633c71661511e532ab0b54aea` 与合并时 HEAD 完全一致，执行包内哈希守卫的 `apply_increment.py apply`（19 个路径——生产 9、测试 10——全部命中，无手工改动；脚本 SHA-256 与前两包一致 `7779f3b2…`）。归档见 [bundle/](bundle/)，完整性清单 [SHA256SUMS](bundle/SHA256SUMS)。

## 修复内容（实际源码修复，非仅日志）

1. **图片采样坐标分区**：符合条件的大型不可分离图片坐标场改用有界分区，避免单个坐标场超过既有 64 MiB 限制；不改原坐标算法、旋转与采样相位，不改 Rust 限制。分区路径限于 managed WebGPU、imageAtlas 关闭且坐标网格兼容的场景，其余分支保留原行为。
2. **维护回收**：区分可复用池与待退休临时资源，在既有完成边界后优先退休触发维护的坐标资源；小型临时资源可在严格预算/水位/次数条件下有限延后。资源退休前持续计费，不抬高预算。生产批次常量 48 MiB / 64 个资源。
3. **Pose 回执与预览失败恢复**：记录提交/回执序号并约束回执归属，同 epoch 下文档身份变化拒绝过期回执覆盖当前状态；覆盖预览失败后的状态恢复。普通 Editor fallback 的 DOM/画面同步问题仍独立未解决，未混入。

## 验证边界

包内记录（[VERIFICATION.md](bundle/evidence/VERIFICATION.md)）：326 项不重复测试通过（248 renderer 含 18 采样、61 pose/Editor、17 Node）、严格限定范围生产 TypeScript 及传递依赖检查、维护 harness 常量身份核对、四补丁独立重放 19 文件哈希匹配、正反向补丁与 12 项应用/撤回保护。

本地按用户指示只做了 **Node 冒烟：17/17 通过**（maintenance-residency + pose-feedback，与包内 Node 记录一致），未复跑 326 项全量。采样与部分测试用源码匹配的真实 WASM；GPU driver、Worker 呈现与维护资源为 mock/fixture。未运行生产构建、真实硬件 GPU 像素、Electron GUI、显示器同帧时延、FPS 或 117 完整操作回放——不能据此宣称采样失败、白块或性能问题已消除。
