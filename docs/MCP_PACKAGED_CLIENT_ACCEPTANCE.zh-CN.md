# 安装包上的外部 MCP 客户端验收

这是检查清单，不是 Claude Code、Codex、Kimi 或 DeepSeek Harness 已经连上安装包的证据。`tools/list`、开发目录里的适配器，或本文件所在的云端脚本，都不能代替安装包验收。

## 云端能做的

```bash
node frontend/design-desktop/scripts/mcp-client-acceptance.mjs
node --test frontend/design-desktop/test/external-mcp-clients.test.mjs
```

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

## 云端结果

2026-11-09，linux x64：

- `node --test frontend/design-desktop/test/external-mcp-clients.test.mjs`：3 通过。
- `node frontend/design-desktop/scripts/mcp-client-acceptance.mjs`：退出码 0。Claude Code、Codex、Kimi Code CLI、Kimi CLI 1.x、DeepSeek Harness 都是 `missing_environment`。安装包和握手、读取、编辑、截图、撤销、撤权都是 `not_run`。

