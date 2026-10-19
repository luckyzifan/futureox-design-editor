# 本轮验证记录

环境：Node.js v24.19.0；没有安装依赖、没有构建应用或运行 GPU。

以下命令在仓库根目录执行，全部是针对性验证；日志中仅将本仓库绝对路径替换为 `<REPO>`，保留测试结果。

```sh
node --test frontend/design-client/src/image-import.test.mjs frontend/design-client/src/kernel/canvas-effect-sampling.test.mjs frontend/design-client/src/kernel/render-diagnostics.test.mjs frontend/design-client/src/kernel/cpu-frame-contract.test.mjs
node --test frontend/design-client/src/kernel/gpu/renderer-regressions.test.mjs
node --test frontend/design-desktop/test/native-render-queue.test.mjs frontend/design-desktop/test/native-render-lifecycle.test.mjs frontend/design-desktop/test/sidecar.test.mjs frontend/design-desktop/test/sidecar-lifecycle.test.mjs frontend/design-desktop/test/main.test.mjs frontend/design-desktop/test/preload.test.mjs
node --test testing/test-entrypoints.test.mjs
```

结果：38 + 17 + 68 + 12 = **135 通过、0 失败**。这些数量不包含未执行的 Rust/Vitest/浏览器/GPU 测试，也不累计多次重复运行。

- 前端契约：浏览器文件读取/图像解码 API 使用测试替身；执行实际导入、采样判定、诊断、CPU 路由模块。
- 渲染器契约：执行实际 GpuRenderer 和图管理代码；GPU/WASM 边界使用明确的记录/拒绝式替身。不是像素读回测试。
- 桌面契约：含主进程/preload 模拟和真实受控子进程的退出测试；不是 Electron GUI 验收。
- 脚本契约：隔离目录中的假 Vitest 验证退出码、参数和日志，不能算选中的业务 Vitest 已运行。

同一组 17 个渲染契约用例针对原 d9a9038a renderer 的对照结果为 8 通过、9 失败；修复后 17 通过。该对照用于证明新用例识别旧缺陷，仍不等于 GPU 保真验证。

另通过 shell/JavaScript/部分 TypeScript 语法检查和 `git diff --check`；这些不替代完整 TypeScript 类型检查或 Rust 编译。

明确阻塞：缺少 Cargo/rustc、Bun、前端 node_modules、生成的 WASM/绑定。因此 Rust 测试、Vitest、完整构建/类型检查均未运行。真实 GPU、Electron 画面与 3200% 像素比较未执行。

## 待具备工具链后运行的 Rust 门禁

新增内核回归 13 项（另替换/加强旧用例），原生 GPU 缓存新增 6 项普通单元和 2 项需硬件的用例；本轮均未执行，不纳入 135 项通过数。

```sh
cd design-studio
cargo test --offline --locked -p futureox-design-kernel --lib paint::tests::
cargo test --offline --locked -p futureox-design-kernel --lib renderer::linear_tile_residency_tests::
cargo test --offline --locked -p futureox-design-kernel --lib preparation::tests::
cargo test --offline --locked -p futureox-design-kernel --test linear_tile_cache --test interactive_tier
```

这些命令会进行针对性编译，离线缓存不足时应明确失败；不要将失败改成跳过后计为通过。原生 GPU 硬件门禁应在授权且支持的 GPU 环境独立执行。
