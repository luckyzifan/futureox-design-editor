# 架构分层与调用链

Futureox Design 在本仓库构建 Electron 桌面应用。React 渲染器负责编辑体验，Rust 内核提供文档语义和准备能力，Electron 主进程管理受控的磁盘、原生进程和平台服务。独立 Web 应用及 PostgreSQL 服务在另一仓库维护。[futureox-desgin-server](https://github.com/luckyzifan/futureox-desgin-server)

## 组件职责

| 组件 | 职责 | 源码入口 |
| --- | --- | --- |
| React 编辑器 | 手势和选择、面板、命令、作者文档事务与编辑历史 | [Editor](../../frontend/design-client/src/engine.ts)、[命令](../../frontend/design-client/src/commands/)、[自动化接口](../../frontend/design-client/src/automation/) |
| Rust 内核 | 文档校验、格式解码与编码、几何、布局、字体、CPU 渲染和绘制数据准备，编译为 WASM 或原生程序 | [design-kernel](../../design-studio/crates/design-kernel/)、[WASM 构建脚本](../../design-studio/scripts/build-web.py) |
| 浏览器渲染层 | 请求编排、预览及精修调度，驱动 WebGPU/WebGL2 和像素接纳。CPU 路径复用内核 | [KernelClient](../../frontend/design-client/src/kernel/client.ts)、[渲染 Worker](../../frontend/design-client/src/kernel/render-worker.ts)、[GPU 实现](../../frontend/design-client/src/kernel/gpu/) |
| Electron 宿主 | 受控窗口、对话框、预加载 IPC、sidecar 启动和队列、用户设置与打包 | [main](../../frontend/design-desktop/src/main.mjs)、[preload](../../frontend/design-desktop/src/preload.cjs)、[Sidecar](../../frontend/design-desktop/src/sidecar.mjs) |
| 原生准备与 GPU | `design-prepare` 通过内核构建绘制数据。`design-render` 执行原生 GPU 工作并由宿主管理资源与结果 | [准备进程](../../design-studio/crates/design-kernel/src/bin/design-prepare.rs)、[design-gpu](../../design-studio/crates/design-gpu/)、[原生渲染桥](../../frontend/design-desktop/src/native-render.mjs) |
| 原生本地后端 | 工作区、SQLite 版本、恢复、目录、原始文件检查及大型源会话 | [design-desktop-backend](../../design-studio/crates/design-desktop-backend/)、[SQLite 工作区](../../design-studio/crates/design-desktop-backend/src/workspace.rs) |
| MCP 和 Agent | MCP 适配本地传输、能力发现、工具与资源。宿主管理 Agent 进程，面板调用明确开放的工具 | [design-mcp](../../frontend/design-mcp/)、[design-agent](../../design-studio/crates/design-agent/)、[MCP 操作指南](../MCP_OPERATION_GUIDE_V1.md) |

## 从编辑到呈现

```text
用户手势／属性面板        本地 MCP
        │                   │
      编辑命令        授权、版本检查与候选操作
        └───────── Editor.change ─┘
                    │
               Rust/WASM 准入与布局
                    │
                发布作者快照
         ┌──────────┼─────────────┐
       画布请求     自动保存        显式导出
       场景准备     持久版本回执    目标与格式校验
       渲染执行     SQLite          CPU／格式编码
       接纳画面
```

事务使用不可变作者快照，原生校验通过后提交。编辑撤销使用会话历史。MCP 写入经过共享编辑事务，宿主授权和文档／会话／修订约束随请求复核。文件中的兼容扩展作为数据保留。

普通页面经 `ProgressiveSurface` 和 Worker 组织首图、交互预览与精修。大型源会话经 `LargeDocumentWorkspace` 进入 `NativeSourceSurface`，根据页、视口和源修订准备显示所用的有界工作集。完整保存与导出走各自的原生路径。[渲染架构](RENDERING.zh-CN.md) · [大源文件工作集](../LARGE_DOCUMENT_SOURCE_WORKSETS.zh-CN.md)

## 文件、存储与协作

Electron 的真实文件权限由主进程和对话框管理。渲染器使用受限接口和不透明文档／文件标识。工作副本提交使用 SQLite 的持久修订 CAS 与幂等回执。恢复历史会创建新的持久版本。编辑修订、存储修订、协作服务的版本分别维护。

桌面默认使用本地工作区。连接协作服务后，从已持久化的 SQLite 修订提交增量。网络、SQLite 工作和画布调度有各自的队列与回执。[开发契约](../DEVELOPMENT_CONTRACT_V1.md) · [文件导入与保存](../IMPORT_AND_LOCAL_OPERATION_CONTRACT_V1.md) · [工作区协议](../workspace-mcp.md)

## 测试和工程资料

用例靠近对应模块，测试工具位于 `scripts/` 和各包的 `scripts/`。格式夹具位于 `testing/fixtures/`，像素参考位于 `frontend/design-client/public/fidelity/`。需要长久引用的测试结论存为 Markdown。测试 profile、构建副本与原始报告在复核后清理。[本地测试使用方式](../../testing/README.md) · [测试贡献指南](../TESTING_CONTRIBUTIONS.zh-CN.md) · [验证结论](../verification/README.md)
