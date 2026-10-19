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

- 本仓库包含项目源码、测试夹具和经过补丁修改的第三方依赖（如 `vendor/moxcms`）；公开发布前请核对许可证、素材来源和再分发条件。
- Rust 构建产物（`target/`）、前端依赖（`node_modules/`）与打包输出（`dist/`、`release/`）不入库。
- 前端 `design-client` 的内核构建脚本通过 `../../design-studio` 相对路径引用 Rust workspace，目录结构需保持不变。

## 构建与测试

```bash
# Rust 内核（含测试）
cd design-studio && cargo test --workspace

# 前端（安装依赖后）
cd frontend/design-client && bun install && bun run test
```

## 2026-10-19 渲染修复交付

请先阅读 `RENDER_REPAIR_NOTES.zh-CN.md` 和 `testing/TEST_COVERAGE_GAPS.zh-CN.md`。本次交付为基于 d9a9038a 的增量源码文件 ZIP；包内文件已整合修改，需配合基准仓库使用，非预编译 Electron 安装包。

- 保真优先：不通过自动缩图、有损重新编码、提高 mip 等级或跳过可见内容来隐藏资源不足。预算不足明确报错。
- 可执行测试结果与未执行项以交付记录为准；新增测试不等于已经通过真实 GPU 像素验证。
- `test-high-zoom.sh --help` / `test-new-features.sh --help` 提供针对性测试入口。
- 未替项目选择开源许可证，也未上传或发布修改。

## 2026-10-19 渲染增量验证

第二轮路径与边界见 [渲染路径说明](RENDER_PATH_PHASE2.zh-CN.md)，算法资料见 [参考来源](RENDER_ALGORITHM_REFERENCES.zh-CN.md)，原生 CPU/WASM 验证见 [准备与几何检查](testing/NATIVE_PREPARATION_CHECKS.zh-CN.md)。产品 GPU 默认路径保持；云端 CPU 测试不等于实际 GPU 帧率或像素验收。

第三轮 GPU 表面与调度增量见 [内存专项说明](RENDER_MEMORY_PHASE3.zh-CN.md)。本轮包含 Rust 内核修改，需重建 WASM 与桌面本地准备程序；测试记录见 testing/verification-phase3。
