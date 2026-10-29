# 拓扑 Sketch 优化计划与修改前真实测试

实施计划见 [PLAN.zh-CN.md](PLAN.zh-CN.md)。本目录新增验证入口、报告断言和复跑工具，未修改产品渲染实现。真实测试固定使用下载目录的 `拓扑素材.sketch`，通过生产导入、完整原生快照与当前 `NativeSourceSurface` 执行。

已完成两轮真实运行，结果和修改优先级见 [RESULTS.zh-CN.md](RESULTS.zh-CN.md)。全览300秒仅完成1/16，报告保持FAIL。latest-results指第二次冻结构建，不能覆盖测试期间又发生的4个GPU文件修改。

## 已冻结的范围

- 原件：118272240 bytes，SHA-256 `b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12`。
- ZIP 64 成员完整；306 顶层素材，124354 源图层节点。原生模型期望124447节点，包含转换/合成结构；不同计数口径不相互替代。
- 工作树 HEAD `2954a77fe22a12f806d91351ec95e5186f9b562a` 加冻结时全部生产修改，逐文件 hash 见 [baseline.json](baseline.json)。运行期间后续源码改动不并入结果。
- 800×600 CSS 画布、实际 DPR；唯一额外构建参数 `VITE_DESIGN_MOTION_QUALITY_TRACE=1` 用于实际绘制片段的密度观测。它有诊断开销，不与无诊断历史运行比较速度。
- 测试宿主只在隔离副本中选择固定原件，复用正式文件读取/身份校验；没有给产品新增路径权限、调试端口或生产测试后门。

## 复跑

在仓库根目录运行，`RUN` 必须是不存在的新目录；Cargo 缓存可复用，但本轮测试期间不要并发其他构建或性能任务。

```sh
RUN=/tmp/futureox-topology-baseline-unique
node testing/verification-topology-optimization-plan-20261028/freeze.mjs "$RUN" "$HOME/Downloads/拓扑素材.sketch"
cd "$RUN/source/frontend/design-desktop"
CARGO_BUILD_JOBS=2 bun run build --fast --out-dir="$RUN/products"
```

返回原仓库根目录后：

```sh
node --test testing/verification-topology-optimization-plan-20261028/report-contract.test.mjs
node testing/verification-topology-optimization-plan-20261028/build-lab.mjs "$RUN" v1
node testing/verification-topology-optimization-plan-20261028/run-lab.mjs "$RUN" v1
node testing/verification-topology-optimization-plan-20261028/summarize.mjs "$RUN/v1" "$RUN/results"
```

`WASM_BINDGEN` 与 `CARGO_TARGET_DIR` 可以显式指定到已有工具/缓存位置。冻结目录内的前端/桌面依赖通过符号链接复用原仓库已安装依赖；Rust、WASM 与 JS 产品实际重建。新机器须先具备本仓库工具链。

定向回归在冻结目录的 `frontend/design-client` 执行：

```sh
bun run test src/kernel/NativeSourceSurface.test.tsx src/kernel/NativeSourceSurface.pipeline.test.tsx src/canvas-native-source-wiring.test.tsx src/kernel/canvas-raster-plan.test.ts src/kernel/navigation-zoom.test.ts src/kernel/source-render-snapshot.test.ts --maxWorkers=1
```

## 如何解释结果

`summary.json` 分开记录：原件导入/快照、原生模型载入、首块可见、当前视口完成、编译累计、graph/checkpoint/finish、draw calls、分类处理像素、峰值字节、取消和最终像素。各阶段存在重叠，不相加冒充总时间；GPU timestamp 未启用，graph 不是纯 GPU 时间。

`local-400-repeat-*` 会重建渲染器和重新载入原生模型，是相同视口的重复构建，**不是已有热瓦片缓存平移**。`motion-return` 才复用同一 surface 并快速变更相机。

实际 GPU 内容读回与隔离 GUI 截图分开保存。测试相机由控制器驱动，不是可信系统输入；没有验证紫色选框同步或物理输入到显示器延迟。最终相机/DPR/密度、非空内容和同视口像素一致有可执行断言；没有独立 Figma/Sketch 像素 oracle，因此不会把一致性称为完整效果保真。

失败、缺结果、超时都保留为 FAIL；完整 G2 延迟数值目标未确定，保持 BLOCKED。5% 是未来候选的配对保留目标，本轮只有基线，不宣称优化已完成。完整 G5 和其他文件另行验证。

构建/测试环境修复过程见 [WORKLOG.md](WORKLOG.md)，初次失败日志不覆盖。
