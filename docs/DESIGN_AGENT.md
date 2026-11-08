# 设计助手

桌面版优先。页面上的「设计助手」对话、页面列表悬停后的 AI，以及设置里的「设计助手」，都走本机 Rust + Tokio 进程 `futureox-design-agent`。

画布复测和导入差距写在 `testing/verification-fix-regression-20261108`、`testing/verification-figma-sketch-gap-20261108`。自动保存和撤销的现状写在 `testing/verification-autosave-undo-20261108`。

## 启动

```sh
cd design-studio
cargo build -p futureox-design-agent
cargo test -p futureox-design-agent

cd ../frontend/design-desktop
# 桌面应用会启动 ../design-studio/target/debug/futureox-design-agent
# 也可以用 DESIGN_AGENT_BIN 指向别的构建
```

默认只监听 `127.0.0.1:3927`。网页开发时 Vite 把 `/api/agent` 转到这个地址。

## 模型

设置 → 设计助手，可以保存多条连接并切换：

| 类型 | 作用 |
| --- | --- |
| API | 任意 OpenAI Chat Completions 兼容地址和密钥 |
| Token plan | 同样的 HTTP，凭证是订阅 token |
| CC Switch | [farion1231/cc-switch](https://github.com/farion1231/cc-switch) 的本机路由，默认 `http://127.0.0.1:15721/v1`。数据库在 `~/.cc-switch/cc-switch.db`，可用 `CCSWITCH_DB` 改位置 |

没有密钥时，对话仍由本机助手按技能直接改画布。配了 `GROK_ASSISTANT_BASE_URL` 和 `GROK_ASSISTANT_API_KEY` 时，优先用这条 Grok 兼容接口。不要把密钥写进仓库。

其他可选变量：`GROK_ASSISTANT_MODEL`、`DESIGN_AGENT_API_BASE_URL`、`DESIGN_AGENT_API_KEY`、`DESIGN_AGENT_API_MODEL`、`DESIGN_AGENT_TOKEN_PLAN_URL`、`DESIGN_AGENT_TOKEN_PLAN_TOKEN`、`DESIGN_AGENT_TOKEN_PLAN_MODEL`、`CCSWITCH_PROXY_URL`、`CCSWITCH_PROXY_TOKEN`、`CCSWITCH_MODEL`、`DESIGN_AGENT_BIND`。

Anthropic Messages 把连接的 `wire` 设为 `anthropic`。

## 对话里会做什么

默认技能始终在：一键出图、细节调整、布局、样式、评论、再来一版。选哪一个只看对话文字。

一键出图会新建一页可编辑画板（导航、标题、副标题、卖点、按钮、页脚）。悬停页面行才出现 AI，用来进入该页做定向修改。主对话默认改这一页；句子里点了别的页面名，就改那一页。

同一会话会把之前的用户话、助手话和工具调用整段送给模型。工具结果用真实的 `tool_call_id` / `tool_use_id`，不是工具名。超过 48 条时，较早的回合收成一条摘要，最近的回合原样保留。技能选择同时看对话和当前页上已有的画板、文字。

普通设计提问同样看整段会话，不只是带工具的那一轮。提问带上之前的用户话、助手话、计划、工具结果，以及当前页、目标页、选中和图层的文字、填充。本地助手据此回答，不改画布。远程模型的系统提示里有同一段设计上下文。范围只是设计，不写代码。这段上下文组装对应 Codex `c4f0e09912fd4c1173258ccd17e33284a876e826` 里 `clone_history` 在采样前交回整段会话的做法，按本产品的页面和图层重写，没有带入 CLI、沙箱或通用编程工具。

工具调用展开成现有设计操作（`page.create`、`node.create`、`text.set`、`style.set` 等），再经 MCP `OperationBackend` 的 `design_batch_apply` 写入当前编辑器。

## Codex

只改编了 OpenAI Codex `c4f0e09912fd4c1173258ccd17e33284a876e826` 里和这一轮有关的部分：`codex-rs/core/src/tasks/regular.rs` 的 `run_turns`，`codex-rs/core/src/session/turn.rs` 的 `needs_follow_up`，`codex-rs/core/src/session/mod.rs` 的 `clone_history`（采样前交回整段会话），以及 `codex-rs/protocol/src/items.rs` 的用户消息、助手消息、计划和 MCP 工具项。普通提问用这段会话加上当前页、目标页、选中和图层，不另起一条只有最新用户句的请求。CLI、TUI、沙箱、压缩、Guardian、图像生成和任意第三方 MCP 没有带进来。上游许可证是 Apache-2.0。Qoder 只作为多轮对话、工具循环和上下文连续的风格参照，没有拷贝厂商代码。

## Fig / Sketch

对话底部可以选择 `.fig` 或 `.sketch` 查看和当前文档的差距，也可以追加导入、打开，或把当前文档导出成 Sketch 再比较往返。这是结构差距（页面、画板、文字），不是像素验收。

用户 Downloads 里的对照文件名写在 `frontend/design-client/src/design-ai/comparison-fixtures.ts`。把真实文件放到 `FUTUREOX_COMPARE_DIR` 或 `/cursor/stores/self/compare-fixtures` 后再比。仓库里已经有的同名文件（例如 `sections.fig`、`stacks_wrap.fig`、`corners.fig`、`structure.fig`）会直接用。没有字节的文件不会用假数据补上。超过 100MB 的 `test.sketch`、`拓扑素材.sketch` 不在这次传输里。
