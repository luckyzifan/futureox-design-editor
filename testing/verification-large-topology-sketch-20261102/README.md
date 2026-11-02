# 2026-11-02 大拓扑 Sketch 的 CPU 首屏

Electron `--core-cpu-only` 上，大拓扑 Sketch 打开后不能整帧合成到内存爆掉、红字空画布或多分钟无像素。不是 33 ms 可见 P95、100 ms 全场景精修或完整 G2/G5。

仓库里没有约 113MB 的拓扑原件。本轮用两类能在本机复现的规模：

- 合成解析帧：256×256 视口、半径 800 的高斯（设备光晕约 2402）。精确 `render_surfaces_regions` 仍返回光晕/预算错误；`render` 留下填充和页面底色。
- 源画板主机：快照按 113×1024² 字节、18000 节点、420 个根描述。CPU 策略不把整板交给 GPU 纹理，按屏幕瓦片交位图。117.sketch（约 752 层）仍走原来的整帧精确路径，无效果的小帧与精确表面逐字节一致。

## 原因

1. 解析显示先画整帧。一张视口加光晕的 f32 表面是 16 字节/像素。目标、图层和两张滤波缓冲叠在一起，或光晕扩过 1600 万像素，就超过 256 MiB 合成账本（`COMPOSITING_BYTES`）。失败之后虽然会按 128 设备像素重试，但每一块都重新准备几何；放不下时整帧返回原来的错误，界面没有像素。
2. 大于 64 MiB 的 Sketch 在桌面走完整画板。`--core-cpu-only` 没有 GPU 候选，空瓦片列表仍会去画整幅视口；真正的瓦片结果又因没有 `gpuTile` 被丢成「完整源画布尚未取得 GPU 显示纹理」。画面停在准备或红字。

低倍覆盖、已有驻留上的预算错误、标签缓存没有改语义。Figma 轮廓仍先走 `render_once` 里的分块。色彩管理和像素预览不走预算预判。

## 改动

- 解析帧在光晕或四张表面的下限已经放不进账本时，直接降级，不再先做一次注定失败的整帧。降级块共用一次几何准备。单块表面上限是账本的八分之一（仍不超过 1600 万像素）。放不进的效果这一轮不画，填充留下。块失败时保留页面底色；只有非压力错误且一块都没画成时才返回错误。精确 `render_surfaces_regions` 仍先报错。
- CPU 源画板的空瓦片列表只完成快照准入。随后的瓦片用与 GPU `gpuViewport` 相同的原点做 CPU 相机，一块一块交出位图。压力错误变成不透明白块，不让整板失败。画面用 2D 画布拼这些位图，不要求 GPU 纹理，也不把画布交给 GPU presenter。
- 已有驻留时，图层表面 1600 万像素和 Gaussian sigma 压力同样不盖掉当前帧。

## 已跑

`cargo test -p futureox-design-kernel --lib memory_tests`：21 通过，0 失败，3 个既有大用例忽略。其中包括：

- `extreme_zoom_halo_keeps_layer_content_instead_of_failing_the_frame`
- `small_analytic_frame_matches_exact_surfaces`（无效果小帧与精确表面逐字节一致）
- `oversized_analytic_blur_keeps_fill_when_the_frame_cannot_fit`（256×256，半径 800）
- `bounded_planner_skips_descendants_of_geometry_culled_frames`

`node --experimental-strip-types --test src/kernel/cpu-tile-frame.contract.test.mjs`：2 通过。

Vitest（跳过会加载 WASM 的 setup，因为本环境没有已生成的 `design_kernel` 绑定）28 通过：`cpu-tile-frame.test.ts`、`navigation-coverage.test.ts`、`native-source-cpu-tiles.test.tsx`、`NativeSourceSurface.test.tsx`。GPU 路径的既有源画板测试仍通过。

未跑：Electron GUI、WebGPU、约 113MB 原件、WASM 重建后的桌面包、完整内核测试集、带 setup 的完整 Vitest。Rust 改动要 `bun run build:kernel` 之后才进入应用里的 WASM。

## 复测

1. 在 `frontend/design-client` 执行 `bun run build:kernel`，再以 `--core-cpu-only` 启动 Electron。
2. 打开大于 64 MiB 的 Sketch，或本机那份约 113MB 拓扑。应出现分块进度（`正在绘制 n / total`），然后是 `CPU · 已显示`。不应整屏只有红字，也不应先卡在一次整帧合成上。
3. 缩放到单层模糊放不进账本的位置。填充应还在，放不下的模糊可以变锐，页面底色留在画不出的块上。
4. 打开 117.sketch。首屏仍可在数秒内离开「正在绘制画布…」。低倍已画内容、合成预算降级和标签缓存保持原行为。
