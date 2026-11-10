# 参与贡献 · Contributing

[简体中文](#欢迎参与) · [English](#english)

## 欢迎参与

感谢你愿意帮助 Futureox Design。代码、设计反馈、问题复现、文档和翻译都欢迎；第一次贡献可以从一个能清楚描述的小问题开始。

请以友善、具体的方式交流，围绕问题和改进方案讨论，尊重不同背景与经验的参与者。

## 找到一个合适的起点

- 在 [Issues](https://github.com/luckyzifan/futureox-design-editor/issues) 查找已有讨论，避免重复报告。
- [路线图](docs/ROADMAP.md)说明当前重点；[问题索引 #91](https://github.com/luckyzifan/futureox-design-editor/issues/91)汇总近期已知问题。
- 认领前可以在 Issue 中说明你的思路。较大的功能、依赖或架构调整，先讨论方向。
- 不必修改代码：清晰的复现步骤、原创最小样例和文档修正同样有帮助。

## 准备开发环境

按[首页快速开始](README.md#快速开始)启动共享客户端。Rust 版本以 [rust-toolchain.toml](rust-toolchain.toml) 为准；WASM 绑定工具固定为 `wasm-bindgen-cli 0.2.130`。

各前端包分别安装依赖，保留各自的锁文件。桌面开发步骤见 [Electron 开发指南](frontend/design-desktop/README.md#develop-and-test)。

开始实现前，按改动范围阅读：

| 改动范围 | 先读 |
| --- | --- |
| 界面、文档、项目结构 | [架构分层](docs/architecture/README.zh-CN.md) |
| 内核、文件、存储与跨平台边界 | [开发契约](docs/DEVELOPMENT_CONTRACT_V1.md) |
| 画布、渲染、交互或性能 | [渲染优先规范](docs/RENDERING_FIRST_ENGINEERING_CONTRACT.zh-CN.md) |
| 自动化与 MCP | [MCP 操作指南](docs/MCP_OPERATION_GUIDE_V1.md) |

## 提交一个范围清晰的 PR

1. Fork 仓库，从最新的 `main` 新建分支。
2. 围绕一个问题修改代码和相关文档，保持提交内容聚焦。
3. 运行与改动相关的检查，记录命令和真实结果。
4. 打开 PR，说明解决的问题、用户可见的变化、关联 Issue 和验证范围。使用 `Refs #编号` 关联部分修复；仅在问题确实完整解决时使用关闭关键词。
5. 根据评审反馈继续完善。合并时保留贡献者归属，贡献记录以 GitHub 提交记录为准。

避免提交 `target/`、`node_modules/`、`dist/`、临时日志、个人配置，以及未获授权的设计文件。新增夹具优先使用原创、可公开再分发的最小样例，并说明来源。

## 验证你的修改

选择能实际命中改动路径的检查。纯文档修改核对内容、链接和展示即可；行为修复应给出同一输入下的「旧版失败、新版通过」。

```bash
# 相机交接的定向 CPU / jsdom 回归示例
cd frontend/design-client
bun run test --config camera-handoff.vitest.config.ts
```

Rust 修改后，重建本次源码的 WASM／受影响原生程序再引用前端结果。完整测试的依赖、生成夹具、字体与产物要求见[贡献与测试要求](docs/TESTING_CONTRIBUTIONS.zh-CN.md)。当前统一运行器和 CI 仍有未纳入版本控制的依赖文件缺口，实际状态见[本轮复核报告](docs/PR_REVIEW_20261110.zh-CN.md)。

在 PR 中分别列出通过、失败、跳过和未运行的检查及原因。CPU／jsdom 的结果只证明对应路径；GPU、真实桌面窗口、文件保存重开与性能结论需要各自的证据。CI 页面见 [Actions](https://github.com/luckyzifan/futureox-design-editor/actions/workflows/local-design-cpu.yml)。

## 文档、翻译与视觉素材

- 项目名统一为 **Futureox Design**；GitHub 仓库使用 `luckyzifan/futureox-design-editor`，首页与简介保持 Rust、vector editor、UI design、Figma alternative 等功能关键词和实际开发阶段一致。
- 修改首页时同步维护 [中文](README.md)与[英文](README.en.md)的事实、命令、链接和项目阶段。
- 功能描述区分已有实现、已验证范围和未来计划。不要把局部测试结果写成全应用保证。
- 截图使用当前应用与原创示例，记录来源；品牌素材沿用[现有标识](docs/BRANDING.md)。

## English

Thank you for helping build Futureox Design. Code, design feedback, reproductions, documentation, and translations are all welcome. Keep discussions respectful, specific, and focused on the work.

Start with the [open issues](https://github.com/luckyzifan/futureox-design-editor/issues), [roadmap](docs/ROADMAP.md#english), and [current issue index](https://github.com/luckyzifan/futureox-design-editor/issues/91). Describe your approach before a substantial feature or architecture change. A clear reproduction or an original minimal fixture is a useful contribution on its own.

Follow the [quick start](README.en.md#quick-start). Use the pinned Rust toolchain and `wasm-bindgen-cli 0.2.130`; install each frontend package from its own lockfile. See the [desktop guide](frontend/design-desktop/README.md#develop-and-test) for Electron.

Fork the repository, branch from current `main`, and keep each PR focused on one problem. Explain the resulting behavior, related issue, exact checks, and limits of verification. Use `Refs #number` for partial fixes. Preserve contributor attribution when merging.

For documentation, check facts, links, and rendering. For behavior changes, demonstrate the regression on the baseline and the fix on the candidate with the same input. Rebuild WASM/native artifacts after Rust changes. The command above runs one focused CPU/jsdom suite without generated WASM. See the [testing requirements](docs/TESTING_CONTRIBUTIONS.zh-CN.md) and [review report](docs/PR_REVIEW_20261110.zh-CN.md) for full-suite prerequisites and the current missing CI inputs. Report passes, failures, skips, and checks not run separately. CPU results do not establish GPU, desktop, persistence, or performance acceptance.

Read the [architecture guide](docs/architecture/README.zh-CN.md), [development contract](docs/DEVELOPMENT_CONTRACT_V1.md), and the relevant rendering or MCP contract before changing those boundaries. Keep temporary outputs and personal configuration out of commits. Use original, redistributable fixtures with documented provenance.

Keep the Chinese and English READMEs aligned. Use the product name **Futureox Design** and the GitHub repository `luckyzifan/futureox-design-editor`. Keep search terms such as Rust, vector editor, UI design, and Figma alternative consistent with the actual features and development stage, and separate implemented behavior, verified scope, and plans. Screenshots should show the current application with original examples and reuse the existing brand assets.
