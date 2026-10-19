# 设置、工作区、变量与 MCP 示例最终独立验证（2026-10-19）

基线：Git `71d32153e6f55b3723c99708b4c4c49ac7342e67` 加此前已交付性能/画布增量 ZIP `e7fea613c2aafbcd277dc6648bd8b425d65f18683c6ad8089577aabad4858d51`。本轮首次冻结完整运行通过，源码无需验证后修补。所有统一阶段、额外检查及直接 Vite 生产构建退出码均为 **0**。

## 完整 CPU 运行

| 阶段 | 通过 | 明确跳过 |
|---|---:|---:|
| runner-contracts | 23 | 0 |
| frontend-contracts | 300 | 0 |
| desktop-contracts | 180 | 0 |
| python-tools | 15 | 0 |
| typecheck | 静态检查通过 | 0 |
| frontend-vitest | 2045 | 3 |
| bun-unit | 31 | 0 |
| automation-storage | 1 | 0 |
| mcp-contracts | 46 | 0 |
| native-preparation | 3 | 0 |
| native-sidecar | 8 | 0 |

完整前端 Vitest：**275 个文件、2045 通过、3 skipped、0 失败**。TypeScript 是静态检查，不是额外测试案例。

额外独立执行：真实 Rust/SQLite 工作区选择与重启隔离 **2/2**；原生 main 回调边界审查 **3/3**；设置/关闭/工作区控件 React/jsdom 审查 **6/6**；变量与组件继承审查 **13/13**。原生回调与设置审查各含明确的变异负向见证；见原始完整日志和 `additional-results.json`。它们不证明真实 OS 对话框、Electron 窗口或浏览器验收。

这些数字是框架报告的执行次数，不是断言数、行覆盖率或互不重叠的功能总数。Node/Vitest 共享 **25** 个渲染器注册案例（9 高倍率、8 图片资源、8 平移），详见 `shared-case-overlap.json`。不累加历史重跑，不把各阶段相加称为独立覆盖数。

## 明确跳过

- real 117 repeated three times: independent nodes, fonts, editable groups and one-step undo
- external corpus: DESIGN_TEST_SKETCH
- external corpus: DESIGN_TEST_FIG

三个私有/外部语料未配置，保持 skipped，未计为通过。仓库自带与合成输入检查照常实际运行。

## MCP 演示与新计划重放

旧 MCP 示例另有 **1/1** 次真实 Editor/WASM 演示成功。新示例是对**此前已经由助手编写并检查过的设计计划的独立确定性重放**，另有 **1/1** 演示通过，并在该测试内部完成 13 项回归检查；不能再把这 13 项加成 13 个框架测试，也没有在本次聚合验证中产生新的 AI 设计决策或调用外部模型。

实际路径为内存 MCP NDJSON → OperationBackend → 共享操作 API → Editor/WASM，使用 392 个设计操作及 3 个已检查的微调操作，生成 3 页、262 节点，并真实验证 FD 重开、编辑、undo/redo、document.import 重映射、写入守卫、回滚、损坏校验和与上下文游标。不是 mock 操作结果。最终结构检查三页均无报告问题；这不证明美感、重叠布局或像素等价。HTML/CSS 是静态近似输出，不包含应用交互。

紧凑结果见 `replay-manifest.json`、`replay-regressions.json`、`replay-checks-after.json` 与输出哈希。新重放的大型 FD、原始文档/传输记录、HTML/SVG 资源和重复字体保留在外部证据目录，不放入源码 ZIP。原始 draft/final 检查与已交付示例完全保留，未被本次重放覆盖。

## 真实工作区存储

新 SQLite 测试使用哈希已核对的真实 Rust 后端子进程，通过 stdio 操作两个临时目录工作区，验证多文件/多页跨进程重启、数据隔离及旧数据库字节不变；另一个案例验证未来 schema 的候选存储被拒绝、旧选择和原数据仍可访问。紧凑记录见 `workspace-sqlite-records.json`。实际临时数据库和 sidecar 文件不进入源码 ZIP。

## 冻结与既有证据

测试与 Vite 前后，**1891** 条源码/测试/配置/执行输入记录、8 个生成/运行资源、2 个 native 二进制和 5 个外部审查输入保持哈希、字节及模式一致；没有文档漂移。`CanvasMinimap.tsx` 的既有删除显式记录为 deleted，没有遗漏。相对上一已交付冻结的本轮修改见 `current-increment-inputs.json`。

旧 `verification-latest-final` 的 **28** 文件与 `verification-performance-final` 的 **32** 文件全部与上一已交付冻结逐字节/模式相同。原始示例与已交付样例 ZIP 的 **94** 个文件也在本轮前后完全一致，详见 `previous-evidence-preservation.json`。

365 条 design-studio 源码记录、WASM 与 native 二进制均与上一批次一致。因此本轮没有重跑 Rust 全量套件；引用的既有 CPU 结果是 kernel **1,185 通过、1 ignored** 与 backend **83 通过、1 ignored**，见 `unchanged-prior-rust-evidence.json`。新增 kernel 忽略微基准已在上一批次另行执行；旧 backend CJK 字体微基准仍未执行，均不并入本轮通过计数。

## 审查发现与边界

冻结前审查曾复现并推动修复真实问题，包括设置关闭时模态层阻塞、异步工作区切换中的 peer 启动窗口、状态刷新、数字等价草稿、锁定选择绑定、跨集合原型模式及组件继承。完整审查记录见 `independent-settings-review.md` 与 `independent-variables-review.md`。本报告来自修复后冻结的完整运行；审查中的历史 targeted 次数不叠加到本次结果。

当前明确限制：不能证明安全继承迁移的“模式改名 + 值修改”复合批次及经过临时名称交换已有模式名，会原子拒绝并要求拆分操作。普通双射多改名与随后继承更新实际通过。设置保留范围是当前应用 profile；独立原生 peer profile 不保证共享偏好。原生 peer 门禁针对当前 host 所拥有及待启动的窗口，并非机器全局窗口租约。

直接 Vite 生产构建通过，日志保留大于 500 kB chunk 与无效动态导入警告。构建输出哈希另存；没有启动服务或重复 build:kernel。

未运行浏览器、真实 GPU、Electron GUI、OS 原生目录选择、安装包或 Windows/macOS 验收。socket 集成此前因 listen EPERM 及提权路径 bwrap 受阻而 blocked，本轮未重试或绕过。内存/stdio 与真实 SQLite 成功不替代 socket 或原生 GUI 验收。IndexedDB 持久化相关 DOM 测试仍使用边界 double，不代表真实浏览器崩溃耐久性。

## 复跑

设置真实自有 `BUN`、`DESIGN_PREPARE_BINARY`、`CORE_DESKTOP_SIDECAR`、`FUTUREOX_BACKEND_TEST_BINARY` 后，从仓库运行：

```sh
node testing/verify-local.mjs --profile all --suites runner-contracts,frontend-contracts,desktop-contracts,python-tools,typecheck,frontend-vitest,mcp-example,bun-unit,automation-storage,mcp-contracts,native-preparation,native-sidecar --output "$EVIDENCE/run"
CORE_WORKSPACE_EVIDENCE_DIR="$EVIDENCE/workspace-sqlite" node --test --test-timeout=120000 --test-reporter=tap frontend/design-desktop/test/runtime/workspace-selection-runtime.test.mjs
python3 testing/verification-ai-workspace-final/restore-review-inputs.py --repo "$PWD" --output "$REVIEW_OUTPUT"
node --test --test-timeout=120000 --test-reporter=tap "$REVIEW_OUTPUT/review/native-switch-boundary.test.mjs"
cd frontend/design-client
node node_modules/vitest/vitest.mjs run --config "$REVIEW_OUTPUT/review/vitest.config.mjs"
node node_modules/vitest/vitest.mjs run --config "$REVIEW_OUTPUT/variable-review/vitest.config.mjs"
FUTUREOX_AI_PHASE=final FUTUREOX_AI_REFINEMENTS="$REPO/testing/verification-ai-generation/agent-refinements.json" FUTUREOX_AI_GENERATION_DIR="$EVIDENCE/ai-replay" node node_modules/vitest/vitest.mjs run --config ../design-mcp/examples/ai-generation.vitest.config.mjs
node node_modules/vite/bin/vite.js build --outDir "$EVIDENCE/frontend-dist"
```

`REPO` 指向仓库；`EVIDENCE` 和 `REVIEW_OUTPUT` 必须是新的仓库外绝对路径。复跑时缺少必需资源会 NOT RUN 并使结果失败。外部审查的 `.source.txt` 是脱敏源码视图，恢复路径后才能执行；原始执行输入与脱敏副本的哈希分别保留。本机绝对路径均已脱敏。`publication.sha256` 与外部批准清单绑定本目录全部发布证据。
