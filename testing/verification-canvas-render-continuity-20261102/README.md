# 2026-11-02 画布呈现续：缩小覆盖、合成降级、旋转框、标签锁

CPU-only Electron 上四类仍能看见的问题。不是 33 ms 可见 P95、100 ms 全场景精修或完整 G2/G5。预算、瓦片上限和实验开关没有放宽。选区蓝仍是 `#3459d4`。没有设计 API，没有协作服务器，没有导出或插件 API 改动。

## 1. 快速缩小后画板空、粘贴板露出来

CPU 参考表面在相机一变就丢掉已经画完的帧。缩小过程中屏幕上只剩更早的小裁切，周围是 `#eeeff3` 粘贴板。

现在：同一文档上已经画完的帧，如果盖住当前视口，或者比屏幕上那张盖住更多，就留下并按新相机摆放。更紧的放大帧不会换掉更宽的画面。没有画面时，第一张画完的帧先放上去。

CPU 全源瓦片用 `putImageData` 时，相邻瓦片各自四舍五入会在共享边上裂开一条粘贴板缝。原点改为向下取整，共享边保持合上。

低密度驻留仍然不能当成完成覆盖，也不能取消还在画的连续性预览。这条是上一轮已经在 `navigation-coverage` 里的规则，本轮没有放宽。

## 2. 合成预算 / 2048 光晕

`render` 的降级还在：精确的 `render_surfaces_regions` 仍先返回原来的光晕或预算错误。CPU 瓦片走的 `render_device_rect` 以前不降级，整块失败后前端还会涂成白砖。

现在这条瓦片入口在压力错误后重试一次显示降级：放不进账本的效果略去，填充留下。预算数字没改。参考表面和渐进表面不再把这两类错误画成整帧红字；已有画面留着。一块都还没有时最多再试一次，不把宿主错误句盖到画布上。

## 3. 旋转时蓝框先动

仿射 rebase 算出的矩阵是把实时选区拉回「当前纹理」的那一档。进行中丢掉这档矩阵，蓝框就先转到新角度。现在这档矩阵留着，框和仍在显示的纹理一起。

手势跟随的快照自己带着框。没有那层快照、而呈现的仍是旋转前的文档时，DOM 蓝框用按下时的姿态，不跟实时预览先转。

## 4. 导入或打开时切标签

已打开过的文档仍先用会话缓存。没有缓存时不再在大约一秒后放弃。同一标签继续排队，间隔从 200 ms 收到 2 s，大约四分钟后才停。提示不是 “Another file operation is in progress”。

## 已跑

- `cargo test -p futureox-design-kernel --lib device_rect_halo_keeps_the_fill_instead_of_failing_the_tile`（通过）
- `cargo test -p futureox-design-kernel --lib small_analytic_frame_matches_exact_surfaces`（通过）
- `frontend/design-client`：`bunx vitest run` 上述六个文件，46 项通过。其中包括 `reference-zoom-frame`、`selection-chrome-pose`、`cpu-tile-frame`、`interaction-affine`、`navigation-coverage`、`workspace-tab-cache`。
- 本地用 `python3 design-studio/scripts/build-web.py --profile dev` 生成了 WASM，仿射像素测试加载的是这份开发构建。生成物在 gitignore 里，没有进提交。Electron 要先跑 release 的 `build:kernel`，瓦片降级才会进桌面包。

未跑：Electron GUI、WebGPU、release 桌面包、完整内核测试集。

## 旋转之后的缩小

GUI 复测：旋转约 34° 之后，一次快速缩小把更宽的画面换成了粘贴板加一小块橙色，蓝色菱形也不再包住纹理。原因是那一帧的渲染视图还停在放大档，`current()` 仍为真，紧裁切盖掉了宽画面；选区却留在旋转提交时的相机上。

现在实时相机已经缩小，就不再接收盖住更少视口的完成帧。CPU 选区跟实时相机，和参考表面的 CSS 贴合同一帧。

## 未声称

- 33/100ms、完整 G2/G5、Mac 桌面逐像素一致。
- 旋转不是 Figma 那种即时位图扭曲。松手后的精确图仍可能晚到。
- 放不下的模糊可以变锐。精确入口仍先报错。
- 没有 Electron 手工通过记录。
