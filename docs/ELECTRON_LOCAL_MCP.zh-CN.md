# Electron 本地版：让外部 AI 使用 Futureox Design MCP

适用于在**同一台电脑、同一系统用户**下运行的桌面编辑器和 AI 客户端。推荐用 **stdio**：客户端启动安装包自带的适配器，获得当前授权允许的完整 `design_*` 工具目录。使用者不需要源码、npm 或系统 Node。模型由客户端提供。

## 第一次连接

1. 打开 Electron 本地版，进入一个普通可编辑的设计文档。在系统菜单中选 **自动化 → MCP 连接与权限…**。如果只需要当前文档，也可以直接选 **启用本机自动化（只读）** 或 **（读写）**。
2. 先用只读试连。要改图时选读写；要读写本地文档库或设置时，在「工作区与文档库」「应用偏好」中单独选择，然后点击启用并在原生对话框中确认。文档读写不会隐含这两项权限。
3. 在同一面板点 **复制 stdio 客户端配置**（Claude、Kimi、DSH）或 **复制 Codex TOML**。前者是含 `mcpServers.futureox_design` 的 JSON，后者是可直接放入 Codex 配置的 TOML。**复制连接详情**得到的是原始授权信息，不是客户端配置。
4. 按下表接入。配置里的绝对路径取自正在运行的安装包，含空格的路径也无需额外转义。保持编辑器打开，到客户端发一句：**“用 futureox_design 读取当前设计的名字和选区，把结果告诉我。”**

| 客户端 | 怎么接 | 怎么确认 |
|---|---|---|
| Claude Code | 把复制的 JSON 保存成个人临时文件（如 `/absolute/private/futureox.json`），运行 `claude --mcp-config /absolute/private/futureox.json`。如果使用已有个人 MCP 配置，只合并 `futureox_design` 条目。 | 在新会话输入 `/mcp`，选中该服务，然后要求读取文档。[Claude Code 官方说明](https://code.claude.com/docs/en/mcp) |
| Codex 桌面 / Codex CLI | 将 **复制 Codex TOML** 的内容加入个人 `~/.codex/config.toml`。已有同名表时替换该表及其 `.env` 子表，不重复添加。Windows 对应用户目录下的 `.codex/config.toml`。重新加载 MCP 或开启新客户端会话。 | CLI 可先用 `codex mcp list` 查登记，再用 `/mcp` 或上面的读图指令验证；仅能列出配置不代表已连通。[OpenAI 官方文档](https://developers.openai.com/codex/mcp/) |
| Kimi Code CLI 2.x | 将 JSON 中的条目合并到个人 `~/.kimi-code/mcp.json`，或在 TUI 的 `/mcp-config` 中录入相同的 command、args、env。不要设置远端 `environment_id`。 | 开新会话，运行 `/mcp` 并读取文档。[Kimi Code 官方文档](https://www.kimi.com/code/docs/kimi-code-cli/customization/mcp.html) |
| 旧版 Kimi CLI 1.x（命令可能叫 `kimi-cli`） | 交互会话可用 `--mcp-config-file`。执行连接检查时，将复制的 JSON 保存为私有临时目录下的 `mcp.json`。 | 运行 `KIMI_SHARE_DIR=/absolute/private/futureox-qa kimi-cli mcp test futureox_design`，使用该临时目录的配置连接并列出工具。[旧版 CLI 官方说明](https://moonshotai.github.io/kimi-cli/en/reference/kimi-mcp.html) |
| DeepSeek Harness（DSH） | 在启用的 profile / Cordis 作用域注册 `@deepseek-ai/dsh-mcp-client`，字段映射见下面。它使用每个服务一个插件条目的格式。 | 重新载入此 profile，查找 `mcp__futureox_design__design_document_get`。[DSH 官方 MCP 客户端说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md) |

**DSH 配置示例。** 从复制的 JSON 的 `mcpServers.futureox_design` 取出 `command`、`args` 和 **完整 env**；将下面的占位符替换为对应值。Windows 路径在 YAML 中可用单引号。使用含 MCP 客户端插件的本地 profile。

```yaml
- id: mcp-futureox
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: futureox_design
    transport: stdio
    command: '<复制的 command>'
    args: ['<复制的 args[0]>']
    env:
      ELECTRON_RUN_AS_NODE: '1'
      FUTUREOX_DESIGN_SOCKET: '<复制的 socket 或命名管道>'
      FUTUREOX_DESIGN_SESSION: '<复制的会话 ID>'
      FUTUREOX_DESIGN_BRIDGE_TOKEN: '<本次授权的 token>'
```

复制的配置只供本机个人使用。使用私有配置文件（macOS/Linux 可设为 `chmod 600`），不要把临时 token 贴到模型对话、命令行参数或项目仓库。复制出来的 `env` 里除了三个 `FUTUREOX_DESIGN_*` 和 `ELECTRON_RUN_AS_NODE`，还可能有 `HOME`、`PATH`、`TMPDIR` 等启动变量。有的客户端会用这份 `env` 替换子进程环境，所以要整份保留，不要只留下 token。若不想将 token 写入 Codex 配置，可用 `env_vars` 转发启动客户端时已有的三个 `FUTUREOX_DESIGN_*` 环境变量，并继续在 MCP 子进程配置中设置 `ELECTRON_RUN_AS_NODE = "1"`，同时保留上面的启动变量。不要给整个桌面应用或当前终端全局设置 `ELECTRON_RUN_AS_NODE`。

## 验证读写和撤权

- 只读：用 `design_document_get`、`design_selection_get` 读取当前实例。当前目录以客户端的 `tools/list` 为准。
- 读写：让客户端读出 `documentId`、`session`、`revision`，再创建一个命名矩形。写请求使用本次读到的 `expectedRevision`。用 `design_preview_capture` 看设计内容，用 `design_history_undo` 撤销。预览是 CPU 导出的设计像素，不含桌面窗口。
- 撤权：选 **自动化 → 停用本机自动化**。旧连接不能继续修改、读取文档或读取服务端缓存的导出资源。已经交给客户端的字节不可能收回。切换文档或重新启用后，请复制新授权并重连。

## Figma 风格客户端或 HTTP

需要 `get_metadata`、`get_design_context`、`get_screenshot` 等兼容工具时，在 MCP 连接与权限面板选 **复制 Figma 兼容 stdio 配置**。JSON 中的 `futureox_design_figma` 会启动随应用打包的 `figma-cli.mjs`。只有具备编辑权限的连接才会列出 `use_figma`，打开已保存文档还需要工作区写入授权。

HTTP 客户端可从「复制连接详情」取 **原样的 `figmaMcp.url`**，每次请求带 `Authorization: Bearer <本次 token>`。回环监听器以 JSON 响应 MCP POST 请求，GET 事件流返回 `405`。该入口一次服务一个 HTTP 客户端会话，不同客户端可各用独立 stdio。 [Figma 兼容入口的工具和参数](FIGMA_MCP_FACADE.md)

## 包内位置和排错

| 现象 | 处理 |
|---|---|
| 客户端看到 `get_metadata` 等工具 | 当前使用 Figma 兼容入口。要使用完整的 `design_*` 目录，可选「复制 stdio 客户端配置」。 |
| 出现另一个编辑器窗口或客户端没有收到握手 | 检查 MCP **子进程**的 `ELECTRON_RUN_AS_NODE=1`，以及分开的 `command` 和 `args`。也可将 command 改为本机 Node 22+ 的绝对路径，删除该变量，保留脚本路径和另外三个变量。 |
| 无法连接、旧资源过期、权限不足 | 确认编辑器和客户端同机、同账户，文档未切换。重新启用所需范围，更换整份会话配置；已超时的写请求应先读回版本，再决定是否重试。 |
| 只有浏览器版、原生 Sketch 源预览或大文档源视图 | 浏览器不监听 MCP；请在桌面版打开支持普通 Editor 编辑的文档。 |
| 安装包移动后命令找不到 | 启动新位置的应用并重新复制配置。macOS 资源在 `.app/Contents/Resources/design-mcp/`，Windows/Linux 在应用的 `resources/design-mcp/`。本指南随包保存为 `design-mcp/README.zh-CN.md`。配置里的脚本路径可以经过符号链接；适配器用解析后的文件判断自己是不是入口。 | |

开发者在 `frontend/design-desktop` 运行 `bun run package:local`。该命令构建本机平台的 release 包，并核对适配器文件、用包内 Electron 启动两个 stdio 入口、连接本机 HTTP、读取资源后再撤权。默认不启用服务，也不改外部客户端的个人配置。跨平台包需在对应平台构建验证。

## v0.0.0.1 的 macOS 发布包复测

2026-11-18 使用发布的 arm64 DMG，在独立目录和临时编辑器配置中启动应用。DMG 的 SHA-256 为 `730207741e9edcfa73716d1a04c327423414d37afffeaf06001864fa0ecb5aec`，发布记录绑定源码提交 `58f0d7542fb7e7bfcc4ab48fecf82b96727b7ea0`。各客户端使用从该应用导出的临时 stdio 配置。[v0.0.0.1 发布记录](https://github.com/luckyzifan/futureox-design-editor/releases/tag/v0.0.0.1)

| 客户端 | 观测结果 |
| --- | --- |
| Codex CLI 0.167.0-alpha.4.1 | 使用临时 App Server 会话连接包内适配器。读取文档和选区、创建矩形、读取 PNG 资源、撤销均通过。停用授权后，旧文档请求和 PNG 资源请求均被拒绝。 |
| Kimi CLI 1.47.0 | `mcp test` 完成握手，读写授权下列出 136 个工具。使用这份 CLI 随附的 MCP 客户端读取、编辑、读取 PNG、撤销，停用后旧文档和图片均被拒绝。 |
| Claude Code 2.1.83 | `mcp get` 和非交互会话初始化均显示连接成功。合成文档测试在模型鉴权阶段失败，后续编辑、截图与撤销仍待验。 |
| Kimi Code 2.5.2 | ACP 初始化成功。隔离配置下创建会话返回 `-32000`，尚未进入 MCP 握手。 |
| DSH | 本机未找到可启动的客户端。 |
