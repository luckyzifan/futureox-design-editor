# 渲染重构前基线

用户要求先写用例并测试最新代码。本目录仅包含测试、诊断取证和分析；产品代码未由本轮修改。

- [固定范围](RUN_SCOPE.md)
- [自动化与人工用例](TEST_CASES.zh-CN.md)
- [实测结果](RESULTS.zh-CN.md)
- [面向重构的代码分析](ARCHITECTURE_REVIEW.zh-CN.md)
- `fixture.json`：只读拓扑原件、相机与观察窗口。
- `entry.tsx`：实际生产源导入、NativeSourceSurface、WebGPU及像素读回。
- `report-contract.mjs`：完成证据、相位、静止稳定、新目标与旧缓存返回分开判定。

## 复跑

在仓库根目录。RUN必须是新目录；不得复用旧结果目录。测试期间不并发构建和其他性能任务。

```sh
RUN=/tmp/futureox-render-refactor-baseline-unique
node --test testing/verification-render-refactor-baseline-20261028/*.test.mjs
node testing/verification-render-refactor-baseline-20261028/freeze.mjs "$RUN" "$HOME/Downloads/拓扑素材.sketch"
```

进入冻结目录的`source/frontend/design-desktop`，使用当前机器的wasm-bindgen路径，运行：

```sh
CARGO_BUILD_JOBS=2 WASM_BINDGEN=/Users/Apple/.cargo/bin/wasm-bindgen bun run build --fast --out-dir="$RUN/products"
```

可显式设置CARGO_TARGET_DIR复用已有编译缓存；源码与最终产品仍来自冻结副本。回到原仓库根目录：

```sh
node testing/verification-render-refactor-baseline-20261028/build-lab.mjs "$RUN" v1
node testing/verification-render-refactor-baseline-20261028/run-lab.mjs "$RUN" v1
node testing/verification-render-refactor-baseline-20261028/summarize.mjs "$RUN/v1" "$RUN/results"
```

运行器在前后校验实际JS/native产物和Sketch原件，失败保留非零退出码。全览300秒未完成也是有效失败记录；仍可执行summarize收集结果。runner只终止自己启动的进程。

诊断开启`VITE_DESIGN_MOTION_QUALITY_TRACE=1`，不与无诊断数字混算。新建Surface的每例包含独立native模型加载；sourceLoadMs单列，不能称“热缓存”。只有motion/pan例内部复用同一Surface。

图像和原始报告通过既有隔离render-check入口保存。readyPixels对应`pose-N-live.png`，是在完成后立即请求的GPU读回，可能等待GPU，不能声称其为同一瞬间GUI帧；quietPixels对应`pose-N-fresh.png`，检验后续静止一致性。独立Sketch视觉oracle、真实输入与选择框同步、完整G2/G5均单列。

固定路径源码与旧工具来自既有`verification-topology-optimization-plan-20261028`，本轮独立目录避免覆盖其历史清单/运行记录。若源码在测试期间变化，保存差异清单并将结果绑定冻结版本。
