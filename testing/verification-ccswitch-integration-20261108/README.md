# CC Switch 只做切换上游（2026-11-08）

上游是 [farion1231/cc-switch](https://github.com/farion1231/cc-switch) 提交 `b184a88c99428571d718d10d1a1403e9502cd28b`。许可证是 MIT，Copyright (c) 2025 Jason Young。声明写在 `design-studio/crates/design-agent/src/ccswitch.rs`。

用到的只有供应商行里的地址和密钥：`base_url` / `baseUrl` / `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`，以及对应的 key。`usageScript.templateType = token_plan` 把这条记成 Token plan，否则记成 API。设置里点一条，下一轮设计对话只打到这一条。

没有接入故障转移队列、本地 `127.0.0.1:15721` 代理、熔断器、OAuth、Codex TOML，或 CC Switch 的桌面界面。选中的地址失败时，这一轮改用本机设计回答，不会自动改打下一条。

启动顺序没改：环境里有 `GROK_ASSISTANT_BASE_URL` 和 `GROK_ASSISTANT_API_KEY` 时先用 Grok。设置里仍可切到已保存的 API、Token plan，或 CC Switch 里的一条。

## 测到的

`cargo test -p futureox-design-agent` 覆盖了这些：

- 列表不包含数据库里的密钥。
- 点名 `codex:plan` 只选出这一条；不点名时用当前那条。
- 同一份数据库里先选 API，设计提问的授权是 `Bearer api-secret`，Token plan 的模拟服务收到 0 次。再改成 Token plan，授权变成 `Bearer plan-secret`，API 模拟服务不再被打到。没有真实上游，也没有编造耗时。
- 桌面 host 测试仍能保存 API 和 Token plan，并选中一条 CC Switch 供应商，状态 JSON 里没有密钥。
