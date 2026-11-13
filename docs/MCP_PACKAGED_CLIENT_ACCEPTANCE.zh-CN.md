# 安装包上的外部 MCP 客户端验收

这是检查清单，不是 Claude Code、Codex、Kimi 或 DeepSeek Harness 已经连上安装包的证据。`tools/list`、开发目录里的适配器，或本文件所在的云端脚本，都不能代替安装包验收。

## 云端能做的

```bash
node frontend/design-desktop/scripts/mcp-client-acceptance.mjs
node --test frontend/design-desktop/test/external-mcp-clients.test.mjs
node frontend/design-desktop/scripts/verify-packaged-mcp-path.mjs
```

`verify-packaged-mcp-path.mjs` 会用当前平台的 Electron 打一个未签名包，从包内 `resources/design-mcp/src/cli.mjs` 和 `figma-cli.mjs` 启动，并走握手、读取、编辑、截图、撤销和停用后拒绝旧资源。它使用替换后的子进程环境，并且经过符号链接路径。这仍然不是某个外部 AI 客户端的实机会话，也不是产品 GUI。

脚本对每个客户端只探测命令是否在 `PATH` 上：

| 状态 | 含义 |
| --- | --- |
| `missing_environment` | 本机没有该客户端 |
| `present_not_exercised` | 找到了命令，但没有做安装包上的实机会话 |
| `not_run` | 设置了 `FUTUREOX_MCP_CLIENT_LIVE=1`，仍未启动安装包和客户端 |
| `passed` | 当前脚本不会给出这个状态 |

报告不写 token。`FUTUREOX_RELEASE_EXECUTABLE` 只被记成「给出了路径、没有启动」。

## 还要在有安装包的机器上做

对 Claude Code、Codex、Kimi Code CLI、Kimi CLI 1.x、DeepSeek Harness 分别记录：

1. 用安装包里的 `design-mcp/src/cli.mjs` 做握手。
2. 读取当前文档。
3. 编辑一个对象。
4. 取得设计内容截图。
5. 撤销。
6. 停用本机自动化后，旧资源被拒绝。

每条都要记下包的路径、构建和平台。缺哪个客户端就写缺环境，不要把另一个客户端或开发目录的成功抄过来。接入步骤仍以 [Electron 本地 MCP](ELECTRON_LOCAL_MCP.zh-CN.md) 为准。

打包后的 GUI 检查是 `frontend/design-desktop/test/packaged-local-mcp.mjs`。加上 `--clients` 时，它会附上客户端探测结果，并明确 `externalClientAcceptance: false`。本环境没有安装包，所以没有启动这个 GUI 脚本。

## 同一目标的打包路径（2026-11-13）

linux x64，Node 22.23.4，Electron 44.7.0。命令：

```bash
node --test frontend/design-mcp/test/cli.test.mjs frontend/design-desktop/test/figma-mcp-host.test.mjs frontend/design-desktop/test/external-mcp-clients.test.mjs frontend/design-desktop/test/packaged-mcp-path.test.mjs
node frontend/design-desktop/scripts/verify-packaged-mcp-path.mjs
```

`verify-packaged-mcp-path.mjs` 退出 0。它用 `@electron/packager` 打出当前平台的未签名包。启动的是包内 Electron `futureox-desgin`，不是开发目录里的 `node`。`cli.mjs` 和 `figma-cli.mjs` 与当前源码字节相同，路径在包的 `resources/design-mcp/src/`，并且是经过符号链接再启动的。子进程只拿到复制配置里的 `env`。

| 入口 | 握手 | 读取 | 编辑 | 截图 | 撤销 | 停用后拒绝旧资源 |
| --- | --- | --- | --- | --- | --- | --- |
| `cli.mjs` | passed | passed | passed | passed | passed | passed |
| `figma-cli.mjs` | passed | passed | passed | passed | 无该工具 | passed |

`figma-cli.mjs` 不提供 `history.undo`。同一次桥接里，`cli.mjs` 的 `design_history_undo` 撤销了 `figma-cli.mjs` 刚做的编辑。桥接是进程内夹具，套接字、打包后的 Electron 和两份适配器是真的。这不是产品 Editor 窗口，也不是签名安装包。`frontend/design-desktop/test/packaged-local-mcp.mjs` 没有运行。

以前从符号链接路径启动适配器时，进程会直接退出，客户端等不到握手。这次符号链接路径能完成上表。

五个外部客户端都是 `missing_environment`。它们的握手、读取、编辑、截图、撤销和撤权都是 `not_run`。`externalClientAcceptance` 为 false。报告没有 token。`cli.mjs` SHA-256：`3eecb2294be89a776000de6cbed0cde2045644cacc9eddf38c059d365e41f7d3`。

## 云端结果

2026-11-09，linux x64：

- `node --test frontend/design-desktop/test/external-mcp-clients.test.mjs`：3 通过。
- `node frontend/design-desktop/scripts/mcp-client-acceptance.mjs`：退出码 0。Claude Code、Codex、Kimi Code CLI、Kimi CLI 1.x、DeepSeek Harness 都是 `missing_environment`。安装包和握手、读取、编辑、截图、撤销、撤权都是 `not_run`。

## 本机合并复核（2026-11-10）

在 `63ed940bc` 基线上复核，环境为 macOS arm64、Node 24.12.0。修正命令探测对 POSIX shell 的依赖：现在直接检查 PATH 中的可执行文件，Windows 按 PATH 分隔符、PATHEXT 与环境键大小写规则查找，不启动任何 AI 客户端。探测异常也经过配置令牌脱敏。

- 同一异常令牌反例在原 PR 上失败，修正后通过；全部 6 项探测、报告、真实临时 PATH 与参数化 Windows 路径规则测试通过，无跳过。
- 实际清单脚本退出 0：本机 Claude Code、Codex、Kimi Code CLI、Kimi CLI 1.x 为 `present_not_exercised`，DSH 为 `missing_environment`。所有外部客户端动作仍为 `not_run`。
- 探测模块、清单脚本及打包 GUI 入口的 `node --check` 通过。没有运行正式安装包、真实外部客户端握手或 Windows 实机流程。
- 现有 MCP 协议、资源、stdio、HTTP 门面与会话回归：110 项通过，0 失败、0 跳过。
