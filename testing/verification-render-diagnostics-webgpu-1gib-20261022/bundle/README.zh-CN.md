# 117 最新诊断与 WebGPU 默认 1 GiB 增量

适用基线：ee97b408860990e2aa89c5510c11eb05ca8a3ba6。此包只包含已验证的诊断增量，以及当前 Electron/WebGPU/TypeScript 路径默认工作资源预算改为 1 GiB 的改动。

## 包含与不包含

- 构建时源码输入、WASM 输入及错误码字典来源摘要；Error 自身持有的实际失败分配快照。用既有 session/requestId 等关联，不记录文档内容，不增加逐帧哈希或额外 GPU 等待。
- TypeScript/WebGPU 默认工作预算为 1,073,741,824 字节。移除该路径根据场景降回 256/512 MiB 的默认策略。明确配置的合法 host limit 仍保留；设备单资源上限、预算准入和 fence 释放边界仍保留。没有一次性预分配1GiB，也不是整个进程/显卡显存上限。
- 原生 Rust design-gpu 的预算改动没有包含：它尚未通过真实 crate 构建验收，仍保留原256MiB默认。不能说所有 native 路径已经改为1GiB。
- 不含加载 UI、页面就绪、缓存维护、预览范围、颜色空间、GPU算子或CPU编译性能的其他候选补丁。没有将117已修复、无白屏、全程清晰或实时FPS达标作为结论。
- analysis/ 是旧日志的结论与限制；components/ 保留两个独立增量。诊断组件文档中“不改变预算”只描述该组件，整个包另含已明确说明的WebGPU默认预算变化。

## 安全应用与撤回

先保留当前工作，并关闭编辑器/构建进程，期间不要并发修改同一路径。需要 Python3 和 Git。

1. python3 apply_increment.py check /absolute/path/to/Core
2. python3 apply_increment.py apply /absolute/path/to/Core
3. 按项目既有方式重新构建。采集时用 CORE_RENDER_DIAGNOSTICS=detail，再复现117动作并保留新日志。

撤回本包：python3 apply_increment.py rollback /absolute/path/to/Core

工具只写 manifest.json 的18个路径。检查基线提交、每个旧/新文件 SHA-256、包内负载、符号链接和受影响文件的暂存修改。拒绝覆盖不匹配内容；不会 checkout、reset、改索引、清理其他文件或下载依赖。不提供force选项；遇到STOP先核对原因，不要手工强盖。

每个文件替换是原子的，多个文件不是整体原子事务。中断后可重试或rollback，但只接受全部文件各自仍是精确旧/新字节状态；任何后续编辑都将阻止覆盖。无关暂存内容保留。撤回只删除本包新增且仍精确匹配的文件，恢复本包改动的原文件。不会撤销文档数据或应用运行时副作用。

## 验证与复测边界

最终精确18文件子集：160项Vitest（7套）、50项Node、12项应用/撤回保护检查通过；285个参与源码文件核对没有非预期改动，原生Rust仍为基线。严格检查受影响TypeScript依赖图通过。

见 evidence/ 的原始结果和 VALIDATION.json。已运行既有/新增诊断测试、WebGPU预算CPU测试与合并源码测试；测试数量分别列出，不把重复跑过的用例相加。受影响遥测和Vite配置的局部TypeScript检查通过。

未运行完整项目typecheck、生产Vite/Rust/WASM构建、实际Electron Worker/GUI、GPU像素或117整机验收。Node MessageChannel 测试不是Electron/GPU验收。预算提高不会自动解决等待、失败回退、画面模糊或物理显存不足。

producerWasmInputSha256 仅是构建输入摘要，不证明实际加载的WASM/原生二进制；Git HEAD不证明源码clean；serve/HMR和未注入的host身份明确未知。完整解释在 source/docs/RENDER_ROOTCAUSE_DIAGNOSTICS_20261022.md。
