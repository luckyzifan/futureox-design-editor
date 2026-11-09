# 源码与目录整理验证（2026-11-09）

## 范围与基线

基线：`3757e601e5a51d485e813fd4543e6fbaded75d25`。本轮整理源码说明、删除未接入领域行为的约束操作码占位和动画特性占位，并建立项目分层与文档索引。七份根目录历史渲染说明移入 `docs/rendering/history/`。

约束轴与 Anchor 的实际映射保留；动画准入继续由关键帧内容、请求覆盖参数和内核可用性决定。回归截图、格式样本、校准夹具及第三方授权文本未修改。

## 环境与产物

- 平台：Darwin 25.3.0 arm64。
- Rust/Cargo：1.99.1；Bun：1.4.0。
- WASM：`wasm32-unknown-unknown`、release、标量构建，未运行 wasm-opt。
- WASM 文件：`frontend/design-client/public/kernel/design_kernel_bg.wasm`，39,938,244 字节；SHA-256：`16a3a481eda0a8501429db9bf1ea2f9c5ab47f5c19379193de77f4ea9ef1b212`。
- 75 个变更源码/测试文件的摘要：`4bf5aa2ecf70fc6260e54267b172c82c36b595c29f12ba58520cfe8c14f88bdc`。按路径排序，每项依次写入 UTF-8 路径、NUL 和该文件 SHA-256 的 32 字节，再计算整体 SHA-256；文件集合为本次提交中 `design-studio/` 与 `frontend/` 下的变更。

## 实际检查

以下命令在仓库根目录运行，注明工作目录的除外；各项退出码均为 0。

| 检查 | 命令或范围 | 结果 |
| --- | --- | --- |
| 原生内核 | `cargo test --locked -p futureox-design-kernel --lib`，目录 `design-studio/` | 889 通过，10 项原有忽略，0 失败 |
| WASM 重建 | `python3 design-studio/scripts/build-web.py --profile release` | 构建并生成客户端绑定 |
| 类型检查 | `bun run typecheck`，目录 `frontend/design-client/` | 重建前后均通过 |
| 前端回归 | 下方 Vitest 命令，目录 `frontend/design-client/` | 10 个文件、113 项通过 |
| 文档链接 | 根 README、文档索引、架构说明、移动后的历史说明及历史入口 | 88 个相对链接有效 |
| 差异检查 | `git diff --cached --check` | 无空白错误 |
| 夹具与授权文本 | 对照基线检查 `testing/fixtures/`、`public/fidelity/`、`vendor/`、`public/licenses/` 与第三方声明 | 无变更 |

```bash
bun x vitest run src/animation-orchestrator.test.ts src/kernel/tile-cache.test.ts src/kernel/tile-cache-boundaries.test.ts src/kernel/exact-tile-cache.test.ts src/kernel/owner-tile-cache.test.ts src/kernel/tile-scheduler.test.ts src/kernel/interaction-density.test.ts src/kernel/interaction-density-admission.test.ts src/kernel/canvas-raster-plan.test.ts src/kernel/render-quality.test.ts --maxWorkers=2
```

进程输出摘要：

```text
test result: ok. 889 passed; 0 failed; 10 ignored; 0 measured; 0 filtered out; finished in 35.59s
Test Files  10 passed (10)
Tests  113 passed (113)
```

## 验证边界与回滚

本轮属于维护整理，未改变渲染数学、预算或实验默认值。未执行新的硬件 GPU、GUI、完整 G2/G5 或性能测量，不据此关闭渲染体验与时延验收门。需要撤销本轮整理时，对清理提交执行普通 `git revert`，保留后续提交与已有历史。
