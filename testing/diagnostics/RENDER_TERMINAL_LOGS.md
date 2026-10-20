# 渲染终端日志（macOS / Electron）

在 frontend/design-desktop 目录执行 `bun run dev`，默认打开新增的渲染诊断。日志直接输出到同一个终端，不需要打开开发者工具、不需要截图。正式打包程序默认关闭且不会接受这个开发环境开关。

只保存经过字段白名单处理的新增渲染日志（推荐发这个文件）：

```sh
cd frontend/design-desktop
bun run dev 2>&1 | grep --line-buffered '^\[render-diag\] ' | tee ~/Desktop/core-render.log
```

macOS 自带 grep 如果不支持 `--line-buffered`，去掉该选项即可（显示可能延迟，但退出时会刷新）。若希望同时保留构建和原有终端输出：

```sh
bun run dev 2>&1 | tee ~/Desktop/core-dev-full.log
```

完整原始日志可能包含旧日志中的本地路径等信息，请在分享前检查。新增 `[render-diag]` 数据仅含固定事件名、数字与布尔值，不包含文档内容、图片、文件路径、节点名、凭据或错误堆栈。复现时按通常方式打开文件，缩放、平移、拖动、切换页面，再正常退出即可。

关闭诊断进行对照：`CORE_RENDER_DIAGNOSTICS=0 bun run dev`。
已构建开发程序直接启动：`CORE_RENDER_DIAGNOSTICS=1 bun run start`。
没有改变已有渲染特性开关、画质、运算顺序、提交频率，也没有增加 GPU fence、读回或截图操作。

## 如何读日志

- `v=1`；`session` 是随机的客户端实例编号（重建 worker 时保留），`source` 区分 main/worker/host；`seq` 是各来源日志顺序；`at` 是 Unix 毫秒。请求使用 `requestId`；相机使用 `sequence`。多个客户端、原生宿主各自独立编号，不能用 seq 跨来源排序。
- `request` / `camera-request` 是请求相机；`camera-submit` 是现有呈现回调所报告的已提交相机，并非显示器扫描输出。`compositorFrames` 是提交计数，不是物理 FPS。附带已有 coverage / sharpCoverage / nativePhaseCoverage、pixelCoverageComplete / nativeCoverageComplete（仅源数据可用时）。
- `tile` / `result` 包含现有 raster/compile/graph/finish/checkpoint、缓存命中/逐出、字节占用等数值；`milliseconds` 在 result 中是客户端请求往返时间。`hydrate` 是 CPU 侧图片 hydration 墙钟耗时。`compile` 是编译承诺完成耗时，包含等待，不等于单独 CPU 执行耗时。
- `queue-start.waitMs` 是 worker 工作排队；`queue-end.durationMs` 是工作墙钟。`fence.queueWaitMs` 是已有队列完成等待，不是 GPU 时间戳。resourceEpoch / completedResourceEpoch 沿用已有资源生命周期记录；fence 回调可能在调用者更新 completedResourceEpoch 前记录。
- fence.reasonCode: 1 readback、2 timing、3 prefix-scratch、4 interaction、5 periodic、6 admission、7 checkpoint、8 cancel、9 initialization、10 park。
- `prefix` 包含已有 acceptedLines / declinedLines / acceptedPixels 计数、mapMs、申请 scratch 时 availableBytes / scratchBytes、region width / height / radius。prefix.reasonCode 1 表示 scratch 预算不足，0 表示预算足够（不保证后续 GPU 接受）。当前 GPU 计数器没有完整逐原因直方图；不能从 aggregate declinedLines 判断具体指数范围/分母/128 位界限拒绝原因。本次不修改 shader 或扩大读回。
- `filter` 是已有 passTimings（未启用原有 GPU timing 时可能没有数据），mode / radius / width / height / count / ms 沿用已有含义，没有为了日志启用 GPU profiling。
- `cache.reasonCode` 1 配置不匹配、2 device lost。oldConfig / newConfig 位 0..4 分别是 managed、hdr、linearLight、certified、displayMath。只记录布尔配置位，不记录缓存键/文件名。
- `stale-drop.reasonCode` 1 已无请求接收者、2 旧相机序号；`cancel` 1 preview cancellation。`error` 1 渲染请求失败、2 worker reset、3 dispose、4 presentation error；不打印异常文本。
- `gpu-exit` / `renderer-exit` 附 exitCode / quitRequested / permitClose。reasonCode 0 unknown、1 clean-exit、2 abnormal-exit、3 killed、4 crashed、5 oom、6 launch-failed、7 integrity-failure、8 memory-eviction。退出附近的 GPU 被终止不自动等于运行时崩溃。

## 有界采样与边界

每个 main/worker collector 每秒最多 8 条即时记录，随后每种固定事件仅保留最新字段与聚合次数；下一秒输出 summary.suppressed 与聚合记录 sampleCount。所有事件种类有限，内存只保存每种事件的一个标量记录，不保存场景、图像或完整帧历史。聚合 sampleCount 是本窗口同类事件次数，原始 filter count 保留为最后一次采样值；这是定位用日志，不是逐帧完整 trace。工作结束或退出前尚未刷新的一小段 worker 聚合可能丢失。

日志仅能证明 CPU 事件、已有 GPU 队列完成信号及提交情况；不能证明真实屏幕已显示、物理帧率或视觉流畅。可与原有手动 navigation capture / queue timing 配合，但新增默认日志不自动开启它们。
