# 117 定向原因定位诊断 V2 合并记录（2026-10-22）

将 `core-117-targeted-diagnostics-v2-1e4a3ba-20261022.zip` 增量合入主线。适用基线 `1e4a3ba07b6922444801e81ba2ad3fbc7f7d5733` 与合并时 HEAD 完全一致，执行包内哈希守卫的 `apply_increment.py apply`（18 个路径全部命中，无手工改动；脚本与上一增量包字节一致，SHA-256 `7779f3b2…165f8`）。归档见 [bundle/](bundle/)，完整性清单 [SHA256SUMS](bundle/SHA256SUMS)（`__pycache__` 一行按运行时产物处理未入库）。

## 合并内容（纯诊断，非渲染修复）

- 原生直接抛字符串时记录失败边界、原始值类型和固定调用来源；[错误字典 V2](../../docs/RENDER_FAILURE_DICTIONARY_V2.json) 新增 39 条源码核实的静态字面量。
- 分配失败区分 acquire、materialField 预估/实际字节等 12 类位置，附 Error 持有的常量时间账本快照。
- 留存 imageAtlas、浮点/HDR/输出、compact/axes 与实际工作预算来源等有界配置。

基线已含 WebGPU 默认 1 GiB，本包不再改预算；原生 Rust 未改动。详见 [GAPS_V2](../../docs/RENDER_FAILURE_GAPS_V2.md) 与 [RUNTIME_CONFIGURATION](../../docs/RENDER_RUNTIME_CONFIGURATION_V1.md)。

## 验证边界

包内 [VALIDATION.json](bundle/evidence/VALIDATION.json) 记录：171 项 Vitest（9 文件）、57 项 Node、受影响依赖图严格 typecheck、12 项应用/撤回保护与 293 文件源码核对通过。**依用户要求，本次合并未在本地复跑这些测试**；包内结果是唯一测试证据。未运行生产构建、真实 Electron Worker、GPU 或 117/FIG 整机验收。
