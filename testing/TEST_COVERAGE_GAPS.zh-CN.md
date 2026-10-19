# 现有测试盘点与开源前缺口

日期：2026-10-19。基准提交：`d9a9038a2c015db0d1ee9a21734f9b906f4c2c49`；本报告同时考虑本轮未提交的修复。

## 结论与范围

现有测试涉及内核、导入、编辑、渲染、桌面桥接和构建工具，但目前不能以一个默认命令证明全部测试已运行，也不能把历史结果文件或单元测试通过当成真实 GPU 画质、性能及开源发布验收。

本次完成了全仓测试文件、框架、脚本入口及夹具类别的静态盘点，并对关键入口、配置、样例测试和来源记录进行了人工阅读。没有逐条复核全部测试断言，没有运行完整测试矩阵，也没有测得语句/分支覆盖率。本轮执行证据与尚待验证的内容分开列出。

可复现文件清单见 [test-inventory.json](test-inventory.json)。其中每个测试/脚本文件都有相对路径、框架、类别及当前内容 SHA-256；文件数不是测试用例数或通过数。正则识别的提示仅用于定位，例如读取源文件也可能是在读取正常夹具，不能据此判断测试无效。

重新生成清单，无需安装依赖、编译或启动浏览器：

```sh
node testing/inventory-tests.mjs > /tmp/futureox-test-inventory.json
```

Git 工作区会枚举已跟踪文件及未被忽略的新文件；导出的源码包会遍历源码目录并排除依赖、构建输出及符号链接。清单不是测试运行器，也不进行秘密扫描。

## 入口与实际覆盖范围

| 类别 | 现有入口/位置 | 前提与默认入口边界 |
| --- | --- | --- |
| 前端 Vitest | `frontend/design-client/package.json` 的 `test`；`src/**/*.test.{ts,tsx}` | 全局 `src/test-setup.ts` 初始化真实 WASM 和字体。纯逻辑测试也会受该依赖约束。 |
| 前端 Node 合约 | `src/**/*.test.mjs`、`src/kernel/render-policy.test.ts` | Vitest 显式不收集这些文件。新增 `test:render-contracts` 只选择本轮四个文件，并非全部历史 Node 合约。 |
| 前端 Bun 测试 | `scripts/test-adaptive-budget.ts`、`test-advanced-gpu-optimizations.ts`、`test-high-zoom-mipmap.ts`、`test-integration-gpu-optimizations.ts` | 使用 `bun:test`，不属于默认 Vitest glob。文件名和导入存在不等于执行有效性已验证。 |
| 桌面 Node 单元/桥接 | `frontend/design-desktop/package.json` 的 `test` | `node --test test/*.test.mjs` 仅收集该层，使用模拟进程/驱动的测试不能替代真实 Electron/sidecar。 |
| 桌面真实运行时 | `test/runtime/{preparation,sidecar,workspace}-runtime.test.mjs` | 三个嵌套文件不被桌面默认 glob 收集；实际 Rust 二进制及各脚本所需环境必须单独准备。仅 preparation 有独立 package script。 |
| Rust | `design-studio/crates/*/{src,tests}` | 包含内联与集成测试。kernel、desktop-backend、server 与需要图形设备的 design-gpu 应分开记录；本轮未编译、未运行。 |
| Python unittest | `design-studio/scripts/test_{build_web,compare_figma_reuse,figma_cpu_reference}.py` | 三个脚本测试构建/比较工具；不等于运行实际完整内核构建。 |
| WASM scalar/SIMD | `design-studio/scripts/test_wasm_variants.mjs` | 需显式提供两组已构建产物目录，当前环境没有这些产物。 |
| 浏览器/真实 GPU/Electron | client/desktop 的 `scripts/check-*`、`smoke.mjs` 等 | 许多脚本使用 Playwright、Vite、应用二进制或私有本地夹具，不是普通 Node 单元测试。不得无差别批量执行。 |
| 性能基准 | Rust `benches/`、`scripts/benchmark*` | 需固定硬件、后端、分辨率、DPR、文档、预热和容差；不是已有 CI 性能承诺。 |
| 数值/像素/导入夹具 | `testing/fixtures/`、`public/fidelity/`、`public/color-fixtures/`、字体及测试 fixture 模块 | 盘点包括生成器和来源记录；其中一部分是设备或外部应用输出，来源和可再分发性需分别确认。 |

本轮快照的具体数量以清单 `summary` 为准；其中 vendored 测试单列，不能与项目自有测试混算。

## 本轮已修复并验证的入口问题

原 `test-high-zoom.sh` 使用个人电脑绝对路径，吞掉 Vitest 失败，隐藏输出，执行全量前端构建，并无条件打印“43 个测试通过”。原 `test-new-features.sh` 通过 grep “Finished/passed”和文件存在性推断成功，打印固定“1433 passed”，最终仍可能给出全部通过提示。

替换后的两个脚本：

- 从脚本位置解析仓库，可在其他工作目录和带空格路径运行。
- `--list` 展示精确选择；`--help` 无需依赖即可执行。
- 使用已经安装的本地 Vitest，只执行明确列出的单元测试。
- 检查 Node、Vitest、WASM、生成的 JS 绑定和字体；缺失返回 `2` 并标注 `NOT RUN`。
- 不安装依赖、不构建应用/内核、不启动浏览器/GPU，也不读取用户 Downloads。
- 将 stdout/stderr 同时保存至唯一日志目录；测试失败保留原始退出码，日志写入失败同样返回非零。
- 不猜测通过数量，不把实现关键词或旧 dist 文件当成成功证据。

```sh
bash -n test-high-zoom.sh test-new-features.sh
./test-high-zoom.sh --list
./test-new-features.sh --list
node --test testing/test-entrypoints.test.mjs
```

执行结果：入口回归测试 **12/12 通过**。这些测试使用隔离的临时源码副本及假 Vitest，验证路径、参数、双路日志、原始退出码 `37`、缺依赖、缺绑定和非法参数；特意让失败进程输出“999 passed”，仍必须失败。它们验证的是运行器合同，不是上述业务测试已通过。

在当前真实工作区分别调用两个脚本，均正确返回 `2`：缺少 `node_modules/vitest`、`public/kernel/design_kernel_bg.wasm` 和生成绑定，没有伪报成功。当前工具为 Node `v24.19.0`、Python `3.12.14`；没有 Bun、Cargo、rustc。

本轮新增渲染诊断及轻量生产逻辑测试入口的范围，另见 [RENDER_DIAGNOSTICS.md](../frontend/design-client/RENDER_DIAGNOSTICS.md)。诊断中的密度是呈现纹理元数据，不是自动证明像素清晰度的判定标准。

## 必须保留的测试缺口

### 1. 完整测试发现与结果门禁仍未建立

- `vitest.config.ts` 注释提到独立 `verify-contracts` harness，但基准提交的已跟踪文件和 package scripts 中没有该入口。仅调用前端 `test` 会遗漏历史 `.mjs` 合约及 `render-policy.test.ts`。
- 桌面默认 `test` 不包括三个 runtime 文件；前端四个 `bun:test` 脚本、Python、WASM variants 也不由 Vitest 统一执行。
- 未见已跟踪 `.github/workflows/`、覆盖率阈值、全矩阵报告汇总或禁止意外测试遗漏的门禁。
- 应先为每类建立明确的 required/optional、前提、跳过原因和结果归档，再形成统一入口。不能把需要真实 GPU 的脚本直接塞入无设备的默认单元测试任务。

### 2. 部分已有断言强度不足，尚未全部改写

- `src/__tests__/text-justify.test.ts` 的四项断言检查本地创建的数组/对象，没有调用产品排版或验证函数。它无法证明中文、末行、换行、字距、双向文字和实际 justify 布局正确。
- 原 high-zoom 测试包含常量比较/复制计算；本轮针对相关渲染逻辑补充了生产路径测试，但不据此宣称全部历史测试已完成语义审查。
- 后续应优先检查“只比对象常量”“复制算法作为期望值”“只 grep 源码”“只查文件存在”的测试，并用真实公开函数、独立数值/图像参考或可触发回归的负例替换。读取源码的测试可守护结构性约定，但不应冒充运行时行为验证。

### 3. 已核实的不可移植路径与缺失夹具

以下是检查时实际存在的引用，不表示这些私有资料应被直接公开：

| 引用入口 | 问题 |
| --- | --- |
| `frontend/design-client/scripts/test-gpu-deep-optimization.ts` | 硬编码 `/Users/Apple/Downloads/117.sketch` 及本地 `.fig` 文件。 |
| `frontend/design-desktop/scripts/test-gpu-automated.ts` | 硬编码 `/Users/Apple/Downloads/117.sketch`。 |
| `frontend/design-client/scripts/check-exact-prefix-recovery.ts` | 固定依赖 `testing/review/design-desktop-macos-gui-2026-10-10/hdr-performance/combined-fixture.forma`，当前源码树中不存在。 |
| `frontend/design-client/scripts/check-exact-cache-hit-cost.mjs` | 默认同一缺失文件，可通过 `--fixture` 指定替代输入。 |
| `frontend/design-client/scripts/check-exact-tile-cache.ts` | 默认同一缺失文件，可通过 `DESIGN_CACHE_FIXTURE` 指定替代输入。 |
| `frontend/design-client/scripts/check-figma-software.ts` | 默认引用 `testing/review/design-desktop-macos-gui-2026-10-10/glass-current-iteration/references`，当前目录不存在。 |

应提供可再分发的合成替代夹具，或把可选本地测试的输入要求与跳过状态写清楚。不要自动下载未知来源资料，也不要把缺输入算成通过。`117.sketch` 的特定文件名分支仍见于部分已有脚本，需要同时审核通用夹具和专用期望的边界。

### 4. 实际画质、缩放和恢复矩阵尚未执行

以下均为待执行验收，而非已通过结论：

- 100%/200%/400%/800%/3200% 与 DPR 1/2/3，文档内图像缩放/旋转、裁剪及小图与超大图。
- WebGPU/WebGL2/CPU 及 Electron 实际呈现路径；放大/缩小时 mip 选择、透明边、滤镜、颜色空间、截图与导出的一致性。
- 显存预算不足、驱动错误、设备丢失、取消、旧帧晚到、快速连续缩放/平移后的恢复与资源回收。
- 真实 sidecar 的保存、恢复、崩溃重启、并发 revision 冲突、跨平台权限与文件对话框。
- Rust 编译、目标集成测试、完整 Vitest/typecheck、两种 WASM 构建变体和浏览器 GUI。

应将每次运行的提交/补丁、运行命令、文档哈希、硬件/后端/系统、DPR、日志、截图和明确 skip/fail 状态一起归档。先测同一文档/视口的回归，再比较性能。单元测试、密度字段和诊断 JSON 都不能单独证明“3200% 不失真”或固定 FPS。

### 5. 安全和服务端端到端验证仍需独立安排

盘点看到了文档准入、路径授权、IPC 安全和工作区测试，但本次没有进行安全审计或完整攻击面验证。`design-server` 发现的是 `validation.rs` 内联单元测试；未发现独立 server 集成测试目录。真实 HTTP/数据库迁移与事务、鉴权边界、畸形/超大压缩输入、导入资源耗尽和持久化故障应明确列入单独验收，不能由当前文件数量推断已经覆盖。

## 开源前静态准备情况

以下只陈述仓库证据与尚需决策的事项，不是法律判断，也不替维护者选择许可证。

- 根目录未见项目 LICENSE、NOTICE、CONTRIBUTING、SECURITY 或 CODE_OF_CONDUCT。源码已有 `private: true`/`publish = false` 标记；修改发布方式和许可证属于另行决定的发布工作。
- `vendor/moxcms/` 保留 `LICENSE.md`、`LICENSE-APACHE.md` 和本地补丁说明；发布时应保留并核对第三方清单，不能用根项目许可证代替依赖许可。
- `public/fonts/NotoSansSC.ttf` 有 `OFL.txt` 和 `source.json`；本次核对字体 SHA-256 与 source 记录一致。
- `testing/fixtures/design/io/` 明确记录合成来源及生成器；三个图像文件 SHA-256 均与 provenance 记录一致。
- 多组 `public/fidelity/` 与 Figma 夹具有 provenance，记录外部应用导出、文档 key、节点或哈希。这有助于复现，但不自动证明全部素材的公开分发授权。发布前需核实原始设计、外部导出、文件内元数据及相关许可，并移除不应公开的私人内容。
- `.gitignore` 已排除多类凭证及本地配置，但忽略规则不会清理历史提交。未见独立秘密扫描配置或历史扫描证据。
- 本次对 1,463 个已跟踪、少于 5 MB 的 UTF-8 文本文件作有限格式扫描：私钥头、GitHub token、AWS access key、Slack token、OpenAI key 形态未匹配。另有 320 个二进制/大文件未扫描。未扫描 Git 历史、压缩包内部或通用高熵秘密；这不是“没有秘密”的认证。正式发布前仍需完整历史和二进制内容的独立审查。

## 建议的完成顺序

1. 将入口失败传播修复和本轮生产逻辑单元测试纳入正常验证；保留本报告的未验证项。
2. 准备固定工具链与 WASM/桌面产物，补齐所有框架的测试发现和可复现命令，区分真实设备任务。
3. 替换或隔离私人/缺失夹具；改写断言强度不足的高风险测试。
4. 执行完整功能、实际呈现和恢复矩阵，保存每个环境的结果，不沿用历史“全部通过”数字。
5. 由维护者完成项目许可、第三方资料、私人元数据及完整秘密扫描审查，再另行决定公开发布。

本轮未安装工具链、未全量构建、未启动 GPU、未提交、未推送、未公开仓库。
