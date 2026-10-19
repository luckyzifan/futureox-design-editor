# 性能与画布工作流最终独立验证（2026-10-19）

基线为 Git `71d32153e6f55b3723c99708b4c4c49ac7342e67` 加已交付增量 ZIP `a9fb36a1ae40b3b30aa68a0aa5a7f2d3440c600697ab1ddae43ef0380c12c051`，以及本轮冻结修改。统一运行与直接 Vite 生产构建退出码均为 **0**。此前验证记录保持原样。

## 实际执行结果

| 阶段 | 通过 | 跳过 |
|---|---:|---:|
| runner-contracts | 23 | 0 |
| frontend-contracts | 300 | 0 |
| desktop-contracts | 157 | 0 |
| python-tools | 15 | 0 |
| typecheck | 静态检查通过 | 0 |
| frontend-vitest | 1907 | 3 |
| bun-unit | 31 | 0 |
| automation-storage | 1 | 0 |
| mcp-contracts | 46 | 0 |
| native-preparation | 3 | 0 |
| native-sidecar | 8 | 0 |

完整 Vitest 执行 268 个文件，1907 通过、3 明确跳过、0 失败。MCP 示例另有 1 次真实 Editor/WASM 生成演示成功，不加进单元测试覆盖数。TypeScript 与 Vite 是独立构建检查，不计为额外测试案例。

这些是框架报告的执行次数，不是断言数、行覆盖率或完整功能覆盖率。Node 与 Vitest 共享同一组 25 个注册案例（9 高倍率、8 图片资源、8 平移），见 `shared-case-overlap.json`；不能把各阶段总数直接称为独立案例数。历史重复运行也未累加。

## 明确未运行的外部语料

- real 117 repeated three times: independent nodes, fonts, editable groups and one-step undo
- external corpus: DESIGN_TEST_SKETCH
- external corpus: DESIGN_TEST_FIG

未配置的私有语料保留为 skipped，没有被计为通过。公开合成 Sketch、仓库自带 FIG 和截断输入检查在完整套件内真实执行。

## 首次失败与修复记录

首次完整运行发现 editor-lifecycle 边界测试未提供新监听器需要的 document 环境，产生 ReferenceError。修复仅完善测试的稳定 window/document 监听器及卸载验证，保留原有模态框、Delete、Escape 和 Space 断言，未修改产品逻辑或减弱通过条件。首次失败原文与日志哈希保留在 initial-failure-and-harness-repair.json；本报告结果来自修复后重新冻结的完整运行。

## 冻结与本轮范围

源码、测试、配置、8 个生成/运行资源和 2 个 native 二进制在统一测试和 Vite 构建前后哈希一致。`CanvasMinimap.tsx` 的删除被显式记录在冻结清单，不是漏采集文件。旧 `verification-latest-final` 全部 28 个证据文件的字节与模式保持不变。

本轮变更相对开始快照列于 `current-increment-inputs.json`。native preparation-frame 生产实现与已交付版本完全相同：候选分配器优化因尾延迟收益不确定而未交付；新增完整性测试和真实测量不得解读为已实现的传输速度提升。

运行资源 SHA-256 见 `runtime-inputs.json`；源码/测试哈希、显式删除与文档变化分别见 `frozen-source-inputs.json`、`freeze-summary.json`。

## 单独的 Rust 与微基准证据

新构建对应的完整 CPU Rust 日志已独立核对：kernel **1,185 通过、1 ignored**；backend **83 通过、1 ignored**。两项 ignored 原因保留在 `separate-rust-evidence.json`，不计为通过。

新增 kernel 微基准已在保留的旧/新二进制上另行真实运行，比较见 `../verification-performance-rust/comparison-clean.json`；它不属于这次普通测试计数。旧 backend 完整 CJK 字体尺寸/耗时基准仍未执行。其他性能和差分实验保留各自测量范围与局限，不转换为 GPU FPS 或端到端交互延迟。

## Vite 构建

直接使用新 WASM 成功生成生产包，验证源模块删除、导入和打包连接没有构建错误。构建日志与文件哈希见 `vite-build.log`、`vite-build-summary.json`；输出留在独立目录，没有混进源码增量 ZIP。没有重复调用 build:kernel。

## 边界

- 未运行浏览器、Electron GUI、真实 GPU 驱动/读回、安装包或原生 OS 对话框验收；本次 Linux 成功不代表 Windows/macOS 已验证。
- OS socket 集成此前因 listen EPERM、提权路径 bwrap 受阻而 blocked，本次未重试或绕过。内存协议/stdio、SQLite/native 子进程成功不能替代 socket 验收。
- native CPU/WASM packet、像素对比与真实 SQLite 重启测试已执行；这不等同于完整 Figma/Sketch 等价或所有画布工作流已完成真实桌面验收。

## 复跑

设置实际自有 `DESIGN_PREPARE_BINARY`、`CORE_DESKTOP_SIDECAR`、`FUTUREOX_BACKEND_TEST_BINARY`、`BUN` 路径后：

`node testing/verify-local.mjs --profile all --suites runner-contracts,frontend-contracts,desktop-contracts,python-tools,typecheck,frontend-vitest,mcp-example,bun-unit,automation-storage,mcp-contracts,native-preparation,native-sidecar --output <独立证据目录>`

该选择不重跑 Rust 编译/CPU 套件和 socket 集成；缺少必需资源会 NOT RUN 并使结果失败。本机绝对路径已脱敏。
