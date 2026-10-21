# Local Design 验证入口

`node testing/verify-local.mjs --profile portable` 是统一 CPU/合约入口。它不安装依赖、不构建缺失产物、不启动浏览器或 GPU。依赖/WASM/字体缺失是 `not-run`，整体非零退出；子进程失败、超时、无测试或全部跳过同样不能变成通过。

## 可复现命令

```sh
node testing/verify-local.mjs --list
node testing/verify-local.mjs --profile contracts
node testing/verify-local.mjs --profile portable --output test-results/portable
node testing/verify-local.mjs --profile native --output test-results/native
node testing/verify-local.mjs --suites frontend-contracts,mcp-contracts
```

- `contracts`：全部前端 Node 文件 + 单独 `render-policy.test.ts`；桌面非 socket、非实际 SQLite 的顶层 Node 文件；Python 工具单测；MCP 非 socket 合约；运行器反例。
- `portable`：contracts + TypeScript + 完整 Vitest + MCP 原创合成示例（真实 Editor/WASM，内存传输）+ 四个自动发现的 `bun:test` 脚本。Bun GPU 命名脚本测试 CPU 策略，不会因此获得真实 GPU 结论。
- `native`：真实 Rust 内核/本地后端、准备进程与 WASM 对比、sidecar 保存/SQLite、自动化 SQLite/IPC 边界。先构建 `design-prepare` 和 `futureox-design-desktop-backend`；不会自动采用其他 checkout 的二进制。
- `all`：portable + native。依然不包括 socket、GUI、GPU、性能基准或 WASM scalar/SIMD 实验。
- `socket-integration`：仅显式 `--suites socket-integration` 选中。需要所在机器允许实际 Unix socket/Windows pipe；被环境拒绝时必须保留阻塞状态，不能换地址或权限绕过。

可用环境变量：`BUN`、`PYTHON`、`CARGO` 指定工具；`CARGO_TARGET_DIR` 指定同源码构建目录；`DESIGN_PREPARE_BINARY`、`CORE_DESKTOP_SIDECAR`、`FUTUREOX_BACKEND_TEST_BINARY` 指定可核验的实际 CPU 二进制。不能拿旧二进制的通过冒充新代码验证。

`python-tools` 被 contracts/portable 选中，需要 Pillow；真实字体夹具还需要固定的 fonttools。请事先在自己的虚拟环境中显式安装 `testing/python-tools-requirements.txt` 和 `testing/font-fixtures-requirements.txt`，并将该解释器通过 `PYTHON`（及其 `bin` 目录的 `PATH`）提供给运行器。CI 在 portable 前执行同样的两份依赖清单。运行器和测试不会自动安装、改系统 Python、代换参考图或因缺包跳过断言；导入依赖失败仍以非零结果保留。

macOS 的临时目录可能经过 `/var` 符号链接。自建测试夹具应在创建后用 `realpath` 取得实际目录，再交给严格原生路径准入或断言 shell 的实际 cwd；不能为测试关闭应用的符号链接校验。

## 证据和分类

每次运行生成每套完整 stdout/stderr 日志与 `results.json`（schemaVersion 1），记录操作系统、Node、HEAD/脏工作区、精确命令、当前测试文件 SHA-256、`passed/failed/not-run/not-selected`。Vitest 另存官方 JSON 的测试总数/通过/失败/待执行。不同框架的计数口径不同，不把 suite、文件、包数量相加成断言数，也不把 `not-selected` 算通过。测试文件哈希不是全部产品源码哈希。

- CPU-real：实际 WASM 文档/几何/字体/CPU 像素，Rust/SQLite/sidecar
- mock-DOM/host：React 模拟 DOM、替身 GPU 驱动、VM 中生产回调、IPC 进程替身
- in-memory-protocol：MCP/自动化字节流，不证明 OS socket ACL 或实际应用授权 UI
- native-OS blocked/not-run：Windows/macOS 安装包、真实窗口/对话框/剪贴板、GPU 像素与设备丢失，必须单独给环境和执行结果

CI 定义在 `.github/workflows/local-design-cpu.yml`，三平台独立执行并归档。编写 workflow 不等于已经在 GitHub、Windows 或 macOS 跑过。没有发布、上传代码、账户或云协作步骤。

## 私有夹具不得伪绿

已删除从 `~/Downloads` 探测私人文件并 `expect(true)` 的测试。默认使用仓库合成 Sketch 和现有 FIG 夹具实际导入，并用截断数据要求失败。

`DESIGN_TEST_SKETCH` / `DESIGN_TEST_FIG` 未配置时，外部语料测试显示明确 skip。设置 `DESIGN_REQUIRE_PRIVATE_FIXTURES=1` 时缺任一输入必须失败；明确配置了不可读/空文件也失败。`append-document` 的 `SKETCH_FIXTURE` 扩展测试保留显式 skip，区别于公开合成测试。现有外部导出夹具的许可/再分发审查仍未完成。

## 反伪绿回归

`runner.test.mjs` 实际运行隔离子进程，要求退出 37 即使 stdout 写着“999 passed”仍失败；验证超时、缺程序、不可写日志、空/全部跳过套件失败。`fixture-policy.test.mjs` 验证缺输入、required 模式、空文件和目录。原 `test-entrypoints.test.mjs` 的假 Vitest 只证明 shell 运行器合同，不声称执行产品测试。

历史源代码断言依然有用，但仅归为结构合同。`export-ownership` 的生产回调现在按 AST 边界提取并支持多个懒加载 import；`import-ownership` 的准备对象适配与生产一致，提前返回会立即失败而非永远等待；`text-justify` 调用真实 WASM；`scratch-deep-detach` 调用真实 Editor 并验证撤销/重做和后代。没有声称所有旧测试都已逐条审计。
