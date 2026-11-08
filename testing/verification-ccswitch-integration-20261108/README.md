# CC Switch 代码接入（2026-11-08）

上游是 [farion1231/cc-switch](https://github.com/farion1231/cc-switch) 提交 `b184a88c99428571d718d10d1a1403e9502cd28b`。许可证是 MIT，Copyright (c) 2025 Jason Young。声明写在 `design-studio/crates/design-agent/src/ccswitch.rs` 文件头。

带进来的是供应商行（`settings_config`、`meta`）、`ProviderRouter::select_providers` 的「当前供应商 / 故障转移队列」顺序，以及 `Provider::resolve_usage_credentials` 里几种凭证形状：Anthropic `env`、OpenAI `env`、扁平 `base_url`/`api_key`、`options.baseURL`、Codex `auth` 加当前 `model_provider` 的 `base_url`。`usageScript.templateType = token_plan` 记成 Token plan，其余记成 API。

没有带进来的是 CC Switch 桌面界面、本地 `127.0.0.1:15721` 代理进程、熔断器、OAuth 注入，以及 Claude/Codex/Gemini 的配置写回。设计助手选中一条记录后，自己向那条上游发设计对话。数据库缺失或选中的记录没有地址和密钥时，才退回连接上自己填写的地址；再失败就用本机设计回答。

启动顺序没改：环境里有 `GROK_ASSISTANT_BASE_URL` 和 `GROK_ASSISTANT_API_KEY` 时先用 Grok，否则用本机助手。设置里仍可切到 API、Token plan 或 CC Switch。

## 测到的

`cargo test -p futureox-design-agent`：20 通过。其中包括：

- 列表不包含数据库里的 `do-not-leak` 和 `plan-secret`。
- 选中的 Token plan 排在故障转移队列前面。
- 一条设计提问先打向 `127.0.0.1:1` 的无效 API，失败后改打本机模拟的 Token plan。响应里的授权是 `Bearer plan-secret`，助手名带 `token-plan`。没有真实上游，也没有编造耗时。
- 桌面 host 测试保存 API 和 Token plan、读取这份形状的 sqlite、用 `profile_id` 选中 CC Switch，状态 JSON 里没有密钥。

## 还没接上的

- 不写回 `~/.cc-switch/cc-switch.db`，也不替用户启动 CC Switch 代理。
- 熔断、半开探测、官方账号 OAuth 卡片没有做。Codex 配置里除当前 `base_url` 以外的 TOML 字段不解析。
- 这一轮没有可用的远程模型密钥，所以没有对真实 Grok 或 CC Switch 上游计时。
