# futureoxDesgin

Futureox 设计内核（Design Kernel）独立仓库：高性能 2D 设计编辑器渲染内核及配套前端。

## 目录结构

- `design-studio/` — Rust 内核 workspace
  - `crates/design-kernel` — 核心内核：图模型、几何、渲染、Sketch 文件解析
  - `crates/design-gpu` — GPU 抽象与着色器
  - `crates/design-server` — 服务端
  - `crates/design-desktop-backend` — 桌面本地后端
  - `scripts/` — 构建与测试向量生成脚本
- `frontend/design-client/` — 网页版设计客户端（React + TypeScript + Vite，WebGPU/WebGL2）
- `frontend/design-desktop/` — Electron 桌面壳
- `testing/fixtures/design/` — 内核测试向量与夹具
- `vendor/moxcms` — design-studio 的颜色管理路径依赖

## 说明

- 本仓库只包含原创代码与文档。
- Rust 构建产物（`target/`）、前端依赖（`node_modules/`）与打包输出（`dist/`、`release/`）不入库。
- 前端 `design-client` 的内核构建脚本通过 `../../design-studio` 相对路径引用 Rust workspace，目录结构需保持不变。

## 构建与测试

```bash
# Rust 内核（含测试）
cd design-studio && cargo test --workspace

# 前端（安装依赖后）
cd frontend/design-client && bun install && bun run test
```
