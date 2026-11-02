# 2026-11-02 低倍缩放覆盖、合成降级、旋转粘滞与标签切换

CPU-only Electron 上四类现象的原因和本轮改动。不是 33 ms 可见 P95、100 ms 全场景精修或完整 G2/G5。

## 1. 快速缩小后画板空

导入的大 FIG 在约 2%–6% 时许多画板空白或只有零星块，放大到约 18% 后同一批画板是满的。这不是把背景涂白。

原因：`navigationHasCoverage` 默认密度是 0。任意低密度驻留只要几何上盖住视口，就会被当成“已经覆盖”，从而取消还在画的连续性预览，并且不再申请能填上缺口的预览。视口预览一旦被选成整帧替换，还会把已经画好的同修订瓦片藏掉，屏幕上只剩页面底色。

改动：就绪覆盖使用导航预览自己的采样密度。更粗的驻留可以继续显示，但不能取消那次预览。视口预览改成垫在同修订驻留下面，只隐藏另一修订的像素。缩放过程中，同修订、与视口相交的历史瓦片保持可见。

## 2. Compositing memory budget exceeded / 2048 光晕

CPU 合成账本是 256 MiB（`COMPOSITING_BYTES`），和 GPU 工作集是两本账。Sketch 上的玻璃、模糊和阴影会为中间表面申请整块像素；一张放不下就整帧返回 `Compositing memory budget exceeded`，界面把这句话画成红字。极端放大时，模糊半径乘上缩放后的设备像素光晕超过 2048，渲染在落笔前返回 `Combined filter dependency halo exceeds 2048 device pixels`，已经能画的填充也一起丢掉。

精确入口没放宽：直接的 `render_surfaces_regions` 仍返回原来的光晕错误。`render` 在这类压力错误之后才降级：视口按 128 设备像素分块，光晕收到放得进 1600 万像素表面的范围内，设备半径超过 512 或光晕超过 2048 的效果这一轮不画。填色和描边留下。一块都画不出来时仍返回原来的错误。已有驻留时，前端不再把这两句错误盖成整帧失败。

## 3. 旋转时蓝框先动

仿射 rebase 会停掉当前姿态会话，并用冻结基准把选择框转到新角度，纹理仍是上一姿态。蓝框先转，像素后闪。

本轮不把轴对齐的合成四边形改成任意仿射（那会改采样）。rebase 尚未换上新纹理时，选择框留在当前纹理上，新捕获发布后框和像素一起换。不是 Figma 那种即时位图扭曲。

## 4. 忙碌时切标签

主进程 `exclusive()` 把打开、导入和 `workspace-open` 串成一把锁。导入还占着锁时切标签，宿主返回 `BUSY`，文案是 “Another file operation is in progress”。编辑器把这句当成操作失败。

文档标签在会话忙时只排队。宿主锁忙但本机已有该文档快照时，先用缓存打开画布，锁释放后再读盘核对。没有缓存就排队，不再弹出那句失败。

## 已跑

- `cargo test -p futureox-design-kernel --lib extreme_zoom_halo_keeps_layer_content_instead_of_failing_the_frame`
- `cargo test -p futureox-design-kernel --lib renderer::memory_tests::bounded_planner_skips_descendants_of_geometry_culled_frames`
- `cargo test -p futureox-design-kernel --lib imported_closed_ellipse_network_uses_reduced_gaussian`
- Vitest `navigation-coverage.test.ts`（20 项，含低密度不视为完成覆盖）

未跑：Electron GUI、WebGPU、完整内核测试集、WASM 重建后的桌面包。

## Electron 复测

1. 在 `frontend/design-client` 执行 `bun run build:kernel`，再启动 CPU-only Electron。本轮 Rust 降级要进 WASM 之后才在应用里生效；覆盖和标签逻辑在 TypeScript。
2. 打开约 5896 层的 FIG。缩到约 2% 和 6%，已画过的画板应留在画面上，空白区域应被更粗的预览补上，而不是整屏只剩底色。再放到约 18%，同一批画板应仍是满的。
3. 打开会报合成预算的 Sketch。不应再整帧只剩红字；极端放大时填充应还在，放不下的模糊可以变锐。
4. 旋转一个图层：蓝框不应先于当前像素单独转走。松手后的精确图仍可能晚到。
5. 导入或打开尚未结束时切换另一个已打开标签。应切到缓存或排队，而不是 “Another file operation is in progress”。
