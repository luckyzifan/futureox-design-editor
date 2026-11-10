# 贡献与测试要求

欢迎围绕可复现问题提交 PR。测试应约束真实行为，不能只让检查变绿。本指南是提交要求，不代表已有测试全部完成审计，也不代表项目已经完成开源许可或跨平台发布验收。

## PR 必须交代

- 问题、影响范围、最小复现步骤，以及本次修改不覆盖什么。
- 修复前如何失败、修复后如何通过。优先保留同一测试、输入和依赖；修复前证据可来自隔离副本，不能偷偷放宽断言。
- 精确命令、提交或工作区版本、工具链、WASM/原生二进制来源、日志与实际结果。区分通过、失败、跳过、未运行、未选择。
- 若修改渲染、保存、撤销、授权或异步生命周期，覆盖相关取消、失败、过期结果、重复操作与最终状态。
- 性能改进说明工作量、输入节奏、计数、机器与测量边界；稳定的调用/分配/发布计数优先于单次计时。不得为变快删去应有工作或降低画质。

## 回归必须能失败

至少给出一个与修改相关的反例或负对照：旧实现、截断/非法输入、过期会话、被拒授权、实际失败子进程等。负对照失败是预期证据，不能改写成产品通过。

- 禁止 `expect(true)`、只断言测试自己拼出的常量、仅打印日志、捕获异常后当作通过。
- 异步断言必须 `await` 或返回 Promise；等待回调要有截止时间，并在提前返回、连接关闭时失败。
- 循环和 `every()` 前确认样本非空；不要让空输入避开全部断言。
- 预期错误要验证具体错误及状态；不得全局吞掉未知异常、控制台错误或子进程非零退出。
- 修复不能只改 mock 让它符合错误实现。源码字符串检查属于结构合同，需要相应运行时证据才能声明行为修复。
- 可选测试缺输入必须显式 skip 并写原因；必测项缺依赖/夹具必须失败或标为未运行，不能提前 return 伪装成功。

## 本地入口

根据改动范围选择包内入口。以下命令从仓库根目录运行：

```sh
# 共享客户端类型与渲染合同
(cd frontend/design-client && bun run typecheck)
(cd frontend/design-client && bun run test:renderer-contracts)

# 相机交接的定向 CPU / jsdom 回归
(cd frontend/design-client && bun run test --config camera-handoff.vitest.config.ts)

# 桌面资源合同与 MCP 协议
node --test frontend/design-desktop/test/branding.test.mjs
(cd frontend/design-mcp && npm run check && npm test)

# Rust 原生后端
cargo test --locked --manifest-path design-studio/Cargo.toml -p futureox-design-desktop-backend
```

更多入口见[共享客户端](../frontend/design-client/package.json)、[桌面宿主](../frontend/design-desktop/package.json)和[MCP 适配器](../frontend/design-mcp/package.json)的 scripts。Vitest 与 Node test 套件分别运行；不要把 Node 套件交给 Vitest 的默认 glob。

检查不会自动安装依赖或补构建。使用 Rust/WASM 的套件需要当前源码生成的 WASM、字体和依赖；原生运行时测试还需要同一源码构建的 `design-prepare`、桌面后端等 CPU 二进制。不得用旧 checkout 的产物冒充验证。日志和生成报告写入已忽略的 `test-results/`，不要提交临时输出。文件数、测试数、断言数和覆盖率不是一回事。

## 夹具、替身与边界

- 默认优先使用可公开再分发的原创合成夹具，记录来源和许可。现有外部导出样本的再分发许可仍需独立审查。
- `DESIGN_TEST_SKETCH` / `DESIGN_TEST_FIG` 未配置时是明确 skip；设置 `DESIGN_REQUIRE_PRIVATE_FIXTURES=1` 后缺输入必须失败；明确配置了空文件或不可读文件也必须失败。`SKETCH_FIXTURE` 是另一个明确标注的可选扩展语料。
- React/jsdom、VM 生产回调、mock IPC/GPU 驱动只证明对应模拟边界；真实 Editor/WASM、Rust/SQLite/sidecar 也仅证明实际执行的部分。
- 内存 MCP 字节流不能证明 OS socket 权限、实际桌面授权窗口或外部客户端接入。真实 socket 通过 `frontend/design-mcp` 的 `npm run test:integration` 显式选择，权限阻塞必须保留，不能换地址或绕过限制。
- CPU 像素测试不等于 GPU 像素、设备丢失、原生窗口/对话框/剪贴板、安装包或签名验证。Linux 结果不能代替 Windows/macOS；性能实验与 GUI/GPU 验收另附实际环境和证据。

## 执行结果与平台范围

命令非零退出、超时、缺少必需输入及空/全跳过套件均不能记为通过。保留完整日志、实际运行范围和跳过原因；成功字样不能覆盖实际失败。Python 的 skip 和 expected failure 也不能单独充当成功执行证据。

当前检查按包独立运行。未来增加 CI 时，依赖文件、运行器和夹具必须已纳入 Git，工具链版本须与锁文件一致。跨平台验收应在对应平台实际执行，不能由一台机器的结果推导。
