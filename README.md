# Futureox Design

[简体中文](README.md) | [English](README.en.md)

**开源、本地优先的 2D 设计编辑器，受 Figma 和 Sketch 启发。**

**An open-source, local-first 2D design editor inspired by Figma and Sketch.**

Futureox Design 希望为界面设计、矢量编辑和设计文件处理提供一个开放、可扩展的工作空间，让设计师和开发者一起参与构建自己的设计工具。

Futureox Design aims to provide an open, extensible workspace for interface design, vector editing, and working with design files, built together by designers and developers.

项目包含 Rust 内核、网页与桌面共享的客户端、Electron 桌面应用和本地 MCP 适配器，围绕统一的画布、文档模型和编辑流程持续演进。欢迎提出想法、反馈问题、提交修改，一起让 Futureox Design 变得更好。

## 项目层级

```text
design-kernel/
├── frontend/
│   ├── design-client/          # 共享界面、编辑入口、WASM 与浏览器渲染适配
│   ├── design-desktop/         # Electron 宿主、原生桥接与打包
│   └── design-mcp/             # 本地 MCP 协议适配
├── design-studio/
│   ├── crates/
│   │   ├── design-kernel/      # 文档、几何、布局、历史、格式与 CPU 渲染
│   │   ├── design-gpu/         # 原生 GPU 设备、资源与渲染执行
│   │   ├── design-desktop-backend/ # 文件、SQLite、恢复与源文档会话
│   │   ├── design-server/      # 服务端接口
│   │   └── design-agent/       # Agent 服务适配
│   └── scripts/                # 内核构建、检查与测试向量生成
├── docs/
│   ├── README.md               # 按主题组织的文档入口
│   ├── architecture/           # 分层职责与调用链
│   ├── rendering/history/      # 历史渲染交付说明
│   ├── features/               # 功能契约
│   └── history/                # 历史开发记录
├── testing/                    # 回归测试、夹具与验证工具
├── evidence/                   # 已纳入版本管理的验证证据
├── vendor/                     # 带原始许可证的本地依赖
└── .agents/skills/              # 项目工程规范
```

界面与自动化进入同一个编辑事务；桌面宿主提供本地能力，Rust/WASM/native 承载领域校验、布局与渲染语义。详细职责和调用顺序见[架构分层](docs/architecture/README.zh-CN.md)。

## 开发与验证

Rust 工具链由 [rust-toolchain.toml](rust-toolchain.toml) 固定。前端使用 Bun；Rust/WASM 修改后，先重新构建实际加载的内核。

```bash
# 在仓库根目录运行 Rust 测试
cargo test --locked --manifest-path design-studio/Cargo.toml --workspace

# 进入共享客户端，安装依赖并构建内核
cd frontend/design-client
bun install
bun run build:kernel
bun run typecheck
bun run test
```

桌面构建与运行见 [design-desktop](frontend/design-desktop/README.md)，自动化接入见 [MCP 操作指南](docs/MCP_OPERATION_GUIDE_V1.md)。客户端构建脚本通过 `../../design-studio` 引用 Rust workspace，需保持这两个目录的相对位置。

## 文档与测试素材

- [文档索引](docs/README.md)：架构、渲染、存储、自动化和功能契约。
- [开发契约](docs/DEVELOPMENT_CONTRACT_V1.md)与[渲染验收规范](docs/RENDERING_FIRST_ENGINEERING_CONTRACT.zh-CN.md)：实现边界和验证要求。
- [测试入口](testing/README.md)：测试命令、回归夹具与验证范围；截图、格式样本和校准夹具用于回归测试。
- [第三方声明](THIRD_PARTY_NOTICES.md)：随源码或产物保留的依赖、字体与授权文本。

`target/`、`node_modules/`、`dist/`、`release/` 等构建输出不入库。历史交付说明集中在 [docs/rendering/history](docs/rendering/history/README.md)，其测试结果按对应版本与环境解释。

## 参与贡献

欢迎大家参与 Futureox Design。功能开发、问题修复、性能优化、界面设计、文档翻译和测试反馈，都是有价值的贡献。

- **反馈问题或提出建议**：通过 [Issues](https://github.com/luckyzifan/futureoxDesgin/issues) 描述使用场景、复现步骤和预期行为。
- **提交修改**：欢迎通过 [Pull Requests](https://github.com/luckyzifan/futureoxDesgin/pulls) 分享改进；较大的功能或架构调整可以先开 Issue 讨论。
- **开始开发**：参考上方开发命令、[架构分层](docs/architecture/README.zh-CN.md)和[贡献与测试要求](docs/TESTING_CONTRIBUTIONS.zh-CN.md)，在 PR 中说明修改内容及相关验证结果。

## 致谢

感谢每一位提出建议、报告问题、提交修改、完善文档和参与测试的朋友。无论是一处文字修正，还是一次功能或性能改进，你的贡献都在帮助 Futureox Design 成长。

感谢[所有贡献者](https://github.com/luckyzifan/futureoxDesgin/graphs/contributors)，也感谢项目所依赖的开源社区。相关依赖和授权信息见[第三方声明](THIRD_PARTY_NOTICES.md)。

## 许可证

本项目自有代码采用 [MIT License](LICENSE)。

Copyright (c) 2026 Cookieboty and contributors

第三方依赖、字体、素材和工具遵循各自的许可证，详见[第三方声明](THIRD_PARTY_NOTICES.md)。
