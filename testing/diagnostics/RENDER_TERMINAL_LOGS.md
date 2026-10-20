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

## 更细日志：DETAIL 模式

如普通摘要丢失了请求之间的因果关系，请使用：

```sh
cd frontend/design-desktop
CORE_RENDER_DIAGNOSTICS=detail bun run dev 2>&1 | grep --line-buffered '^\[render-diag\] ' | tee ~/Desktop/core-render-detail.log
```

detail 不改变渲染开关、质量或 GPU 等待。每个 collector 最多保存 512 条标量事件，每 250ms 刷新为最多 64 条/批的 JSON batch。记录保留采集时 at/seq/requestId，不再被每秒“最新一条”替代。极端事件风暴只丢最旧记录，并明确输出 summary.dropped；不要把缺失区间误判为没有发生。worker 退出前未刷新的尾部仍可能丢失。每帧不直接 printf，但批次输出仍有一定 CPU/日志开销，比较性能时可用关闭模式作对照。

新增字段与界限：
- queue-enqueue → queue-start → compile-start/compile、hydrate-start/hydrate、prepare-wait → queue-end，并保留取消、失败、缓存与 tile/result。queueDepth 是本 worker 的请求队列计数，不包括额外的 pose/preparation 内部队列；activeRequestId 为当前请求，0 为无活动请求。generation / fillGeneration 为预览/填充版本；superseded 只说明此时 generation 已过时。
- compile 为现有编译 Promise 墙钟完成，prepare-wait 为瓦片取得预备编译结果的暴露等待，不能相加视为纯 CPU 时间。error.reasonCode 5 为 PREVIEW_CANCELLED，1 为其他错误；不输出错误文本。
- viewport-state.pageToken 是该 surface 内从 1 递增的匿名页面序号，既不包含原始页面 ID，也不包含标题。phase: 1 导航、2 等待精细帧、3 suspended、4 UI 完整契约满足。state 1 有 retained displayed frame，0 没有。targetDensity / effectiveDensity 为世界坐标采样倍率；phaseX/Y 为既有栅格相位。finalComplete 是现有 UI 的精确帧判定，不能当作物理 scanout。oldContentAgeMs 是当前 retained frame 对象自本组件观察到之后的年龄，不是文件修改时间或精确像素年龄。
- detail 模式即使是 bun run dev 使用的前端构建，也每最多 250ms 从现有呈现几何计算 coverage / sharpCoverage / nativePhaseCoverage、pixelCoverageComplete / nativeCoverageComplete。coverageMeasured=1 才表示本条测量，coverageAt 是 worker performance.now()。未测量的条目不补旧值；不要把缺失字段当 0 或 complete。这里仅测覆盖/采样几何，不做 GPU 读回，不证明最终像素颜色正确。
- cache.reasonCode: 0 复用；3 debug 禁用 exact cache；4 debug 禁用 certified reuse；5 未命中后需渲染；10 坐标槽不存在；11 编译 witness 不匹配；12 certificate 已撤销；13 单项超出预算；14 LRU 预算逐出；15 clear。原有 1/2 仍表示停泊 GPU 配置不符/device lost。cache-invalidate.reasonCode=0 仅表示共享失效函数被调用，具体上层原因尚未细分，不应猜测。
- camera-input 及输入时间字段由输入链路诊断提供；仅数值 wheel deltas / kind / sequence / timing，不记录键盘文本、事件对象或设备标识。

DETAIL cancel.reasonCode 2 表示客户端按 requestId 取消交付中的预览；附当前 generation / fillGeneration / channel，不表示 GPU 已停止运行。

### 请求类别与取消归因

request 的 purpose: 0 未声明、1 preview、2 settled、3 canvas、4 PNG/exportRegion 导出、5 控制命令；renderIntent: 0 未声明、1 preview、2 settled、3 canvas。channel: 0 canvas、1 interaction、2 control。commandCode: 0 未知、1 render（无 command）、2 display-read-pixel、3 display-capture-content、4 display-import、5 gpu-memory、6 park-gpu、7 lose-device、8 navigation-diagnostic。不会输出原始 command 字符串。

preview 标志沿用请求的可取消预览条件（tileViewport 或 livePreview），与 renderIntent 不同；finalRequest 只表示显式 settled 意图，不表示已完成。coverageTiles、tileViewport、livePreview、readback、png 为独立 0/1 标志。readback 表示显式 readback 或 PNG 请求，不推断底层实际读回。所有 request（包括控制请求）均有类别，可通过 session/requestId 关联 queue-start/end 和结果。

客户端 result/error 对精确 PREVIEW_CANCELLED 记录 reasonCode=5（有意取消），其他错误为1，无错误为0。不把含该单词的其他错误误认为取消，也不输出异常文本。cancel.reasonCode=2 表示客户端已逐个取消 pending preview 并阻止后续交付。
