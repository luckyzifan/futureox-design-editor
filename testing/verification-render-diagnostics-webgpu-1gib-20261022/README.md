# 117 渲染根因诊断与 WebGPU 默认 1 GiB 工作预算合并记录（2026-10-22）

将 `core-117-diagnostics-webgpu-1gib-ee97b40-20261022.zip` 增量合入主线。包 SHA-256 见 [SHA256SUMS](bundle/SHA256SUMS)（其中 `__pycache__/apply_increment.cpython-312.pyc` 一行按 Python 运行时产物处理，未入库，其余 58 个文件齐全）。适用基线 `ee97b408860990e2aa89c5510c11eb05ca8a3ba6` 与合并时 HEAD 完全一致，因此直接执行包内哈希守卫的 `apply_increment.py apply`（18 个路径全部命中，无手工改动），未走三方合并。

## 合并内容

- **诊断增量（10 个文件）**：构建时源码/WASM 输入/错误码字典身份、Error 携带的实际失败分配快照、worker→主线程中继的标量遥测。用既有 session/requestId 关联，不记录文档内容，不增加逐帧哈希或额外 GPU 等待。详见 [docs/RENDER_ROOTCAUSE_DIAGNOSTICS_20261022.md](../../../docs/RENDER_ROOTCAUSE_DIAGNOSTICS_20261022.md) 与 [错误码字典](../../../docs/RENDER_FAILURE_DICTIONARY_V1.json)。
- **TypeScript/WebGPU 默认工作预算 1 GiB（8 个文件）**：默认 1,073,741,824 字节，移除按场景降回 256/512 MiB 的默认策略。显式配置的合法 host limit、设备单资源上限、预算准入和 fence 释放边界保留。没有一次性预分配，也不是进程/显卡上限。原生 Rust design-gpu 的预算**未包含**，仍为原 256 MiB 默认。

原包 `analysis/` 为旧日志结论；`components/` 保留两个独立增量；`bundle/baseline/`、`bundle/source/` 随记录入库，包内 `apply_increment.py rollback` 仍可按字节精确撤回这 18 个路径。

## 本地复跑结果（2026-10-22，合并后源码）

与包内 [VALIDATION.json](bundle/evidence/VALIDATION.json) 同命令复跑，结果一致：

| 项 | 包内记录 | 本地复跑 |
| --- | ---: | ---: |
| Vitest（7 套：renderer、working-set-budget、reclaim-maintenance、prefix-budget、image-table-lifetime、static-image-blur-renderer、render-failure-telemetry） | 160 通过 | **160 通过** |
| Node（render-terminal-diagnostics、render-producer-identity、render-diagnostics、render-failure-budget-fields） | 50 通过 | **50 通过** |
| 受影响依赖图严格 typecheck | 通过 | **通过**（本地 tsc 需 `--ignoreConfig`，其余参数同） |

包内另有 12 项针对临时 Git 夹具的应用/撤回保护检查（[apply-rollback-tests.json](bundle/evidence/apply-rollback-tests.json)），本次未重跑：合并使用的是同一脚本且其自身对每个文件做前后哈希校验。

## 未覆盖边界（不得宣称）

未运行完整项目 typecheck、生产 Vite/Rust/WASM 构建、实际 Electron Worker/GUI、GPU 像素或 117 整机验收；Node MessageChannel 测试不是 Electron/GPU 验收。`producerWasmInputSha256` 仅是构建输入摘要，不证明实际加载的 WASM/原生二进制。预算提高不自动解决等待、失败回退、画面模糊或物理显存不足，也不是延迟或 FPS 达标结论。
