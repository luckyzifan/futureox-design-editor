# 最终独立验证（2026-10-19）

基线：`71d32153e6f55b3723c99708b4c4c49ac7342e67` 的当前待交付工作树；最终统一运行退出码 **0**，所选阶段全部通过。此记录来自第三次完整冻结后运行；早前失败/预修复运行仍单独保留，未累加次数。

## 实际执行结果

| 阶段 | 通过 | 跳过 |
|---|---:|---:|
| runner-contracts | 23 | 0 |
| frontend-contracts | 296 | 0 |
| desktop-contracts | 142 | 0 |
| python-tools | 15 | 0 |
| typecheck | 静态检查通过 | 0 |
| frontend-vitest | 1804 | 3 |
| bun-unit | 31 | 0 |
| automation-storage | 1 | 0 |
| mcp-contracts | 46 | 0 |
| native-preparation | 3 | 0 |
| native-sidecar | 8 | 0 |

Vitest：260 个文件，1,804 通过、3 个明确跳过、0 失败。MCP 示例另有 1 次成功的真实 Editor/WASM 生成演示，不计入单元测试覆盖数。

这些是测试框架报告的执行次数，不是单个断言数量、行覆盖率或完整功能覆盖率。Node 与 Vitest 重复注册同一组 25 个渲染器用例（9 高倍率、8 图片资源、8 平移），详见 `shared-case-overlap.json`；不能直接把阶段通过数相加为独立覆盖数。重复运行也不能累加。

## 明确保留的跳过

- `real 117 repeated three times: independent nodes, fonts, editable groups and one-step undo`：未配置私有 `SKETCH_FIXTURE`。
- `external corpus: DESIGN_TEST_SKETCH`：未配置可选外部语料。
- `external corpus: DESIGN_TEST_FIG`：未配置可选外部语料。

公开合成 Sketch、仓库自带 FIG 与截断输入负向检查真实执行。上述缺失语料没有被记作通过。

## 冻结与独立负向证据

运行前后源码、测试、配置、8 个生成/运行资源和 2 个 native 二进制哈希均不变。源码清单、资源哈希与二进制哈希见 `frozen-source-inputs.json`、`runtime-inputs.json`；文档/证据文件变化单独列于 `freeze-summary.json`。WASM SHA-256：`3dff5703c0b197cf26be5a94f3a5bf544c876d1950ac4118784e1c5f3abdbe21`。

统一 runner 包含实际子进程负向控制：非零退出不被伪成功文本覆盖；Python 全跳过、仅预期失败不会通过；真实通过+跳过混合情况可通过；忽略 SIGTERM 的自有子进程会在有限宽限期后收到 SIGKILL；缺失输入、空结果和错误日志路径不能伪装成成功。

首次发现的 preload 旧 API 白名单已按新增 automation 窄接口加强，保留精确顶层/嵌套允许列表、冻结检查、固定 IPC 通道与订阅清理。另两项隔离变异（泄露原始 IPC event、错误 record-edit 通道）均以退出码 1 被检测，见 `preload-mutation-controls.json`；这些预期失败实验不加进通过测试总数。

## 单独的 Rust 最终证据

根任务在 Sketch 修复后执行的 CPU Rust 最终日志，经本验证独立复核：kernel 1,178 通过；backend 83 通过、1 项明确 ignored（带完整 CJK 字体的本地尺寸/耗时基准）。见 `separate-rust-evidence.json` 和对应日志。这些不是本次统一 runner 重跑结果，未合并计数。

## 未建立的结论

- 未运行浏览器、Electron GUI、真实 GPU 驱动/读回、安装包、原生 OS 对话框或跨平台桌面验收。
- OS socket 集成此前受权限限制（listen EPERM；提权路径 bwrap 受阻），保持 blocked；本次未重试或绕过。协议内存/stdio 与真实 SQLite 子进程成功不能替代 socket 验收。
- 真实 native CPU/WASM packet、像素对比及 SQLite 重启链路已执行，但不等于完整 Figma/Sketch 等价、所有用户工作流或端到端帧率结论。

## 复跑

配置实际自有的 `DESIGN_PREPARE_BINARY`、`CORE_DESKTOP_SIDECAR`、`FUTUREOX_BACKEND_TEST_BINARY` 与 `BUN` 路径后，从仓库根目录运行：

`node testing/verify-local.mjs --profile all --suites runner-contracts,frontend-contracts,desktop-contracts,python-tools,typecheck,frontend-vitest,mcp-example,bun-unit,automation-storage,mcp-contracts,native-preparation,native-sidecar --output <独立证据目录>`

该命令不选择 Rust 重编译和 socket 集成。缺少必需资源将标记 NOT RUN 并使所选运行失败。原始本机绝对路径已在发布记录中脱敏。
