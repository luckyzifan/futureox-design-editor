# 2026-11-23 测试清理与复跑

整理按本地 `fd75554695a65f583634ef11c4bf51bf4688486c` 及当时的工作区修改执行。环境为 macOS 26.3 arm64、Node 24.12.0、Bun 1.4.0、Rust 1.99.1、wasm-bindgen 0.2.130。此次执行覆盖测试、原生准备和文档入口。

## 清理结论

- 仓库根的旧 `test-results/` 清理前占用约 151 GiB。已注销其中 131 个 Git 测试工作树，停止一个遗留的隔离 Electron 测试进程，并删除旧工作树、应用副本、测试 profile、日志、截图和原始报告。
- 历史 Markdown、回放代码和未提交差异留在本机忽略目录 `testing/local-history/20261123/`，约 65 MiB。另保留一个去重的私有回放夹具。三个无其他引用的 detached 基线用本地 `refs/futureox-test-history/20261123/` 保留。
- 已恢复需要版本化的 SVG／画布参考实现和 Sketch 回归夹具。旧架构阶段稿的测量结论合并到历史记录，当前调用链使用新版架构说明。[固定回归输入](../../testing/fixtures/regression/README.md) · [历史验证](HISTORICAL_ACCEPTANCE_202610.zh-CN.md) · [当前架构](../architecture/README.zh-CN.md)

## 实际执行结果

客户端先执行 `bun run build:kernel`。WASM SHA-256 为 `d43ef7b51fff65f593b235b53647008ddfef8de5693fc42684c50b5eba98941a`。同工作区的 debug `design-prepare` SHA-256 为 `91d43ef2a6e17c9a29be52c73c7811256fb5d3ec3682a5a41209c69b0548bb6f`，SQLite 后端为 `687966ff39cfe68682dd4d474d638049de6ffdeddb62870cbe39ddcefe7fd7cb`。

| 检查 | 结果 |
| --- | --- |
| 客户端 `bun run typecheck` | 通过 |
| 客户端 `bun run test src/path-network.test.ts src/export-metadata.test.ts src/sketch-followup.test.ts src/automation/raster.test.ts` | 86 通过。旧 SVG 对照的根元素标记更新为 sRGB，其余输出逐字节比较 |
| 客户端 `bun run test src/automation/multifont-e2e.test.ts` | 1 通过。Python 3.14.4 虚拟环境按清单安装 fontTools 4.61.1 |
| 客户端 `bun run test src/__tests__/design-file-import.test.ts` | 2 通过，2 个私有输入未提供而跳过 |
| 客户端 `bun run test --config ten-hertz.vitest.config.ts`、`bun run test --config vitest.scene-reuse.config.ts` | 分别 99 与 10 通过。场景复用使用当前实现 |
| 根目录 `bash test-high-zoom.sh`、`bash test-new-features.sh` | 分别 41 与 55 通过，默认输出到终端 |
| 根目录 `node --test scripts/test-entrypoints.test.mjs frontend/design-desktop/test/test-runner.test.mjs frontend/design-client/src/kernel/gpu/composite-draw-plan-cpu.test.mjs`、`node --test testing/fixture-policy.test.mjs` | 分别 28 与 2 通过。五轮临时运行累计写入至少 80 MiB，回收后未留运行目录 |
| 根目录 `cargo test --locked --manifest-path design-studio/Cargo.toml -p futureox-design-kernel --test sketch_uswds_colors_measure` | 4 通过，覆盖 Sketch 文本导入和字体基线 |
| 桌面 `bun run test:preparation` | 3 通过。旧脚本按 JSON 读取二进制场景时失败，更新为 FGSC 后核对原生与 WASM 节点、场景计划、几何与像素，并校验原生资源归属 |
| MCP `npm run check && npm test`、`npm run test:integration` | 语法检查通过，110 项协议合同与 5 项真实 Unix socket 测试通过。初次隔离运行路径超出 Darwin 长度限制，缩短测试端点名称后通过 |
| MCP 三页面 draft 示例 | 1 通过。默认运行曾因可用内存拒绝完整字体文档。核对启动内存后用 384 MiB 测试会话重跑，生成了 manifest |
| SQLite 脚本 `python3 testing/automation-sqlite-benchmark.py --backend <debug-binary> --build-kind debug --iterations 100` | 通过。真实后端完成元数据写入、查询和重启核对 |
| macOS 打包交互脚本的缺清单负对照 | 使用临时空壳路径验证退出 1，显式结果包含缺清单错误，私有测试目录已清理 |
| 文档与脚本检查 | 项目 Markdown 的 362 个相对链接与锚点检查通过。Shell、Node 和恢复的 4 个 Python 脚本语法通过 |

全量默认测试、历史场景复用负对照、私有语料、MCP 示例 final 阶段、真实 Electron 窗口、硬件 GPU、签名安装包及完整 G2/G5 未运行。组合或发布验收需要对应的平台和实测输入。[本地测试使用方式](../../testing/README.md)

## 远端 main 基线复核

以 `6cc60b00f5981a0ca8747db1fec8578a712528bd` 为基线移植测试整理。两份 SVG 参考和四份 Sketch 夹具从远端已有路径逐字节迁移。复跑环境为 macOS arm64、Node 26.0.0、Bun 1.4.0 和 Rust 1.99.1。

- 重建发行版 WASM，SHA-256 为 `700d289a3c09085fbf0f6555acd3a683fdc9ecc54808dd0f9293d05f451864e5`。TypeScript 检查通过。路径、导出、Sketch、CPU PNG 和设计导入 5 个套件为 88 通过、2 个外部语料跳过。
- 原生准备 3 项通过。使用同源 debug `design-prepare`，SHA-256 为 `0301463f522631d1b61b21a668e99b0e9b5e50b89aa5fb9fa6fcd053897c496b`。Sketch 字体回归 7 项通过，1 项需要额外的外部预览而保持 ignored。
- 运行器、合成计划和夹具策略 30 项通过。MCP 112 项合约及 5 项真实 Unix socket 测试通过。358 个项目内 Markdown 相对链接和锚点检查通过。
