# 本地测试使用方式

从仓库根目录执行以下命令。测试规范和发布门槛分别见[测试贡献指南](../docs/TESTING_CONTRIBUTIONS.zh-CN.md)和[渲染优先验收规范](../docs/RENDERING_FIRST_ENGINEERING_CONTRACT.zh-CN.md)。

## 准备依赖

使用仓库固定的 Rust 工具链、Node.js 24+、Bun 1.4+、Python 3 和 `wasm-bindgen-cli 0.2.130`。以下命令用于首次配置和 WASM 重建。[Rust 工具链](../rust-toolchain.toml)

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
(cd frontend/design-client && bun install --frozen-lockfile && bun run build:kernel)
(cd frontend/design-desktop && bun install --frozen-lockfile)
```

Rust 变更后，从当前源码重建用于前端测试的 WASM 和受影响的原生程序。只跑 Node 合约时，按具体测试安装依赖。包含 Git LFS 指针的外部夹具需先取回对应文件。测试脚本按原始错误报告缺少的构建、库或输入。

## 按改动选择入口

| 范围 | 仓库根目录命令 |
| --- | --- |
| TypeScript 与指定 Vitest 用例 | `(cd frontend/design-client && bun run typecheck)`。用 `bun run test src/相应文件.test.ts` 指定用例，或用 `bun run test` 运行默认 Vitest 配置 |
| 共享客户端 Node 合约 | `(cd frontend/design-client && bun run test:render-contracts && bun run test:renderer-contracts && bun run test:node-entries)` |
| 相机交接或高倍率 | `(cd frontend/design-client && bun run test --config camera-handoff.vitest.config.ts)` 或 `bash test-high-zoom.sh` |
| 桌面宿主合约 | `(cd frontend/design-desktop && bun run build:host && bun run test)` |
| Rust 内核和 SQLite 后端 | `cargo test --locked --manifest-path design-studio/Cargo.toml -p futureox-design-kernel -p futureox-design-desktop-backend` |
| MCP 协议与客户端 | `(cd frontend/design-mcp && npm run check && npm test)` |
| MCP 实际本机传输 | `(cd frontend/design-mcp && npm run test:integration)`，使用测试 bridge 和真实 Unix socket |
| Electron 运行与打包 | 先构建当前应用，再按[桌面开发说明](../frontend/design-desktop/README.md#develop-and-test)运行 `test:smoke` 或打包验收。硬件 GPU 和打包交互另选具名驱动 |
| 运行器与夹具策略 | `node --test scripts/test-entrypoints.test.mjs testing/fixture-policy.test.mjs frontend/design-desktop/test/test-runner.test.mjs` |

包脚本的确切选择见 [客户端](../frontend/design-client/package.json)、[Electron](../frontend/design-desktop/package.json)和 [MCP](../frontend/design-mcp/package.json)的清单。`*.test.mjs` 通常由 Node 测试运行器收集，`*.test.ts(x)` 通常由 Vitest 收集，以包脚本和专用配置为准。本工作树按包提供执行入口，`.github/` 的 Issue 与 PR 模板不运行测试。

`test:preparation` 对照当前源码构建的原生 `design-prepare` 与 WASM。二进制使用非默认位置时通过 `DESIGN_PREPARE_BINARY` 指定。

```sh
cargo build --locked --manifest-path design-studio/Cargo.toml -p futureox-design-kernel --bin design-prepare
(cd frontend/design-desktop && bun run test:preparation)
```

显式 SQLite/sidecar 合约需要当前源码构建的 `futureox-design-desktop-backend`。运行前检查对应测试的二进制路径。`DESIGN_TEST_SKETCH`、`DESIGN_TEST_FIG` 和 `SKETCH_FIXTURE` 接收可选外部语料。`DESIGN_REQUIRE_PRIVATE_FIXTURES=1` 使前两项在缺输入时失败。

字体生成测试需要 Python 3.10+ 和 [fontTools 锁定版本](font-fixtures-requirements.txt)。先在测试虚拟环境安装该清单，再通过 `PYTHON` 指向该环境的解释器。可单独运行 `bun run test src/automation/multifont-e2e.test.ts`，默认字体与导出文件随测试清理。调试时用 `MULTIFONT_EVIDENCE` 保留输出。

## 隔离临时环境

会创建测试 profile、构建副本或临时工作树的命令使用隔离运行器。[run-test.mjs](../scripts/run-test.mjs)

```sh
node scripts/run-test.mjs -- node --test frontend/design-desktop/test/test-runner.test.mjs
node scripts/run-test.mjs --worktree=baseline=HEAD^ --worktree=candidate=HEAD -- git status --short
```

运行器从调用目录启动命令。提供 `--worktree` 时取已提交版本，在第一个 detached checkout 中开始执行，其余 checkout 可通过 `FUTUREOX_TEST_RUN_DIR/<name>` 访问。用当前含未提交变更的工作区时省略 `--worktree`。将临时安装包、SDK、配置和生成文件置于 `FUTUREOX_TEST_RUN_DIR` 或其 `tmp/` 内。仓库正常的增量构建依赖仍按构建命令使用。

运行器设置 `TMPDIR`、`TMP`、`TEMP`，退出时按顺序关闭可追踪的测试进程、注销它创建的工作树并删除临时目录。macOS 和 Linux 的 SIGINT/SIGTERM 路径覆盖该次运行的进程组。另行分离的浏览器或 Electron 会话由各自驱动关闭。尽量以前台命令启动测试。

## 输出与结论

普通合约测试输出到终端。高倍和新功能脚本使用 `--list` 查用例，使用 `--log-dir "$PWD/test-results"` 时写入日志。需要截图、CPU profile 或 JSON 明细时传给驱动输出目录。以下命令用指定文件做桌面高倍检查。

```sh
node scripts/run-test.mjs -- node frontend/design-desktop/scripts/check-high-zoom-sketch.mjs \
  --fixture=/absolute/fixture.sketch
```

临时调试时可另加 `--output="$PWD/test-results/high-zoom"`。私有对照通过参数或环境传入输入。`DESIGN_FIGMA_REFERENCES` 指向含 `cases.json` 的参考目录，`DESIGN_CACHE_FIXTURE` 指向缓存回归所需的本地作者文档 JSON。源码与历史构建有固定哈希的用例需要与之匹配的输入。

### Figma 文字像素对照

在 Figma 校准文件中运行生成脚本，用已配置的 sRGB 设置导出选中画板。保留 `KernelTextQA-*.png` 和 `KernelTextQA-*@2x.png` 文件名。准备脚本按七组 1×、2× 画板核对尺寸，并为原像素文件计算 SHA-256。[画板生成脚本](../frontend/design-client/public/fidelity/text-2026-10-09/create-in-figma.js)

```sh
node scripts/run-test.mjs -- sh -c '
  pack="$FUTUREOX_TEST_RUN_DIR/text-references"
  node frontend/design-client/scripts/prepare-figma-text-references.mjs "$1" "$pack" &&
    (cd frontend/design-client && DESIGN_FIGMA_REFERENCES="$pack" bun run test:figma-software)
' sh /absolute/path/to/figma-pngs
```

为 `test:figma-software` 加 `--prepare-only` 可检查清单、尺寸和哈希。像素验收需要原始 Figma 导出图和相应的渲染后端。

将需要长期引用的实际结论写成 Markdown。可复跑的断言、脚本、必要金图和小型固定夹具保留在代码与夹具目录。复核完成后删除本轮临时日志、截图、profile、数据库副本与构建副本。结论格式和已有记录见[验证结论](../docs/verification/README.md)。
