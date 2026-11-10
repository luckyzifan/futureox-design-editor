# 架构分层与调用链

## 1. 客户端与交互层

[`frontend/design-client/src/`](../../frontend/design-client/src/) 为网页与 Electron 共用界面。组件负责输入、选择、手势、面板和短期展示状态；[`engine.ts`](../../frontend/design-client/src/engine.ts) 的 Editor 组织文档修改、发布与历史边界。

[`commands/`](../../frontend/design-client/src/commands/) 组织编辑命令，[`automation/`](../../frontend/design-client/src/automation/) 组织受权限与版本约束的自动化入口。两者使用现有 Editor 事务，保留校验、失败原子性和一次撤销的边界。

## 2. 协议与平台适配层

| 目录 | 职责 | 下游边界 |
| --- | --- | --- |
| [`design-client/src/kernel/`](../../frontend/design-client/src/kernel/) | WASM 调用、Worker 请求、渲染调度与画布呈现 | Rust 内核和浏览器 GPU 执行层 |
| [`design-desktop/src/`](../../frontend/design-desktop/src/) | Electron 生命周期、preload、原生进程、文件与本地能力桥接 | 本地后端及 GPU 进程 |
| [`design-mcp/src/`](../../frontend/design-mcp/src/) | MCP framing、请求转换、能力发现与资源适配 | 共享自动化操作接口 |

适配层传递 document/session/revision、请求身份和资源所有权。排队、取消、提交回执、GPU 完成与界面呈现分别处理。

## 3. Rust 领域与存储层

[`design-studio/crates/`](../../design-studio/crates/) 是同一个 Cargo workspace。

| Crate | 主要职责 |
| --- | --- |
| `design-kernel` | 文档模型、几何、布局、约束、编辑操作与历史、格式编码、材质及 CPU 渲染 |
| `design-desktop-backend` | 本地工作区、SQLite、恢复、源文件索引、源文档会话与持久化 |
| `design-server` | 设计服务的 HTTP 接口与服务端适配 |
| `design-agent` | Agent 服务接口与工具适配 |

领域修改经既有 Rust/WASM/native 接口校验。普通编辑撤销、持久化历史和存储 CAS 分别维护；文件中的扩展数据不赋予执行或宿主访问权限。

## 4. 渲染执行层

Rust 内核准备几何、布局、材质和渲染数据。浏览器执行位于 [`design-client/src/kernel/gpu/`](../../frontend/design-client/src/kernel/gpu/)，原生 GPU 执行位于 [`design-gpu`](../../design-studio/crates/design-gpu/)。CPU 回退继续使用内核渲染入口。

执行顺序为：渲染请求 → 有效版本与相机检查 → 场景准备 → 可见任务规划 → 资源准入 → 光栅与合成 → 完成回执 → 当前画面接纳。缓存复用同时绑定内容版本、采样密度、相位、设备和所有权。

## 5. 编辑、保存与导出调用链

```text
用户输入 / MCP 操作
  └── 共享命令与自动化入口
      └── Editor 事务与版本检查
          └── Rust/WASM/native 校验、布局和历史
              ├── 渲染请求 → CPU / 浏览器 GPU / 原生 GPU → 画布
              ├── 工作副本 → 平台存储适配 → 持久化回执
              └── 导出请求 → 格式与资源校验 → 导出文件
```

界面接纳异步结果前重新检查当前身份；旧请求不能覆盖新文档、已结束手势或新的修订。保存与导出使用各自的完整性契约，预览完成不代表文件已持久化。

## 6. 测试与工程资料层

- `testing/fixtures/`：格式样本、合成输入和校准数据。
- `frontend/design-client/public/fidelity/`：截图回归参考，生产构建按既有规则排除。
- `evidence/`：已纳入版本管理的验证产物。
- `docs/`：维护中的功能、接口和验收契约。
- `.agents/skills/`：项目开发与渲染优先规则。

各层检查按[渲染验收规范](../RENDERING_FIRST_ENGINEERING_CONTRACT.zh-CN.md)报告实际运行范围，测试数量与局部通过不能替代整应用验收。
