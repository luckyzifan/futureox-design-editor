# 云端复测：高倍缩放和 Fig 导入（2026-11-08）

同一台云端 Linux，开发 WASM `d352c6da4decf7f06e5a47c90c26a6c4ff9fa0c6d219d3a72e3d24a6774a4c8b`。视口仍是 640×480，`render_rgba`。没有 Electron、GPU 或上屏延迟。没有像素对比。

修之前的数字来自 `testing/verification-canvas-perf-cloud-20261107/README.md`。

## 根因

效果开启、放大到 32 时失败在 `Compositing memory budget exceeded`。阴影的设备像素晕边等于世界半径乘缩放，工作表面是视口再向外扩这一圈。四个这样的表面（目标、图层、模糊、着色）超过 256 MiB。

同一条模糊在半径变大后，滑动求和的误差上界按「窗口加整行」的平方估计，于是每一像素都退回整段有理数卷积。zoom 25.6 因此用了 14314.744 ms，下一帧在分配阶段失败，平移没有开始。

视口落在不透明填充内部、阴影够不到画面时，这一圈缓冲里没有可见阴影。现在这种帧不再为阴影扩缓冲。阴影真的进入视口时，晕边被收到合成账本放得下的范围，模糊继续用可证明的滑动求和，不再逐像素重算整段核。效果没有关掉。

## 3009 个节点，效果开启

修之前：zoom 25.6 为 14314.744 ms，zoom 32 在 5626.462 ms 失败，错误是 `Compositing memory budget exceeded`。

修之后这一轮通过，34 帧都画完（10 帧放大加 24 帧 zoom 32 平移）：

| zoom | 修之前 ms | 修之后 ms |
| ---: | ---: | ---: |
| 0.1 | 1007.789 | 1020.926 |
| 6.4 | 3273.237 | 3715.349 |
| 12.8 | 5751.888 | 1787.962 |
| 25.6 | 14314.744 | 1995.644 |
| 32 | 失败 | 2032.417 |

zoom 32 平移：修之前没有开始。修之后 p95 2037.482 ms，最大 2085.492 ms。从 32 缩回这一轮没有单独再跑；放大序列本身包含从 0.1 到 32。

zoom 6.4 仍是 3715.349 ms，和修之前的 3273.237 ms 同一量级。这一帧的阴影还在视口边上，全分辨率解析光栅还在。

## 3009 个节点，效果关掉

| 项 | 修之前 ms | 修之后 ms |
| --- | ---: | ---: |
| 放大到 32 的最慢帧 | 628.553 | 655.535 |
| zoom 32 平移 p95 / 最大 | 646.631 / 692.602 | 637.517 / 658.943 |
| 从 32 缩回的最慢帧（zoom 25.6） | 749.386 | 757.136 |

这组没有掉到另一数量级。关掉效果时本来就没有那条超限的晕边缓冲，时间仍在解析光栅上。

## `01有料素材.fig`

| 项 | 修之前 ms | 修之后 ms |
| --- | ---: | ---: |
| importFig | 1360.966 | 1097.215 |
| load_document | 1060.567 | 1020.761 |
| 第一帧 zoom 0.1 | 3203.369 | 3284.989 |
| 缩回 0.1 | 818.938 | 840.655 |

首帧仍是约 3.3 秒。这一页在 zoom 0.1 时大部分内容都在视口里，时间花在第一次解析光栅，不是合成内存超限。

## 覆盖、缩放、平移、瓦片

`coverage-stack`、`navigation-coverage`、`navigation-zoom`、`pan-preview`、`cpu-tile-frame`、`source-opening-preview`、`overview-coverage` 通过。同一次还通过了 `fig-document` 和 `import-fig-text`。合计 9 个文件、96 个测试。`import-fig-fidelity`、`import-fig-shared-contract`、`import-fig-layout` 在加载夹具时就失败，因为工作区里没有 `testing/fixtures/design/figma-materials-native-2026-10-08.fig` 和 `fig-interop-v106.fig`。模式平铺的 Rust 测试 10 个通过。

## Fig 结构

产品路径是 `importFig`，字体再走和导入 worker 相同的 `matchBundledImportFonts`。`validateDocument` 对下面能打开的文件没有报错。用户页用 `userPages`，Internal Only Canvas 留在文件里，不进页面列表。

| 文件 | 结果 |
| --- | --- |
| `01有料素材 (Copy) (1).fig` | 打开。15 个用户页，Internal Only Canvas 隐藏。2638/2638 条文本，19412 节点，74 个实例。平铺的缩放和旋转不再整份拒绝。 |
| `gold-preview.fig` | 打开。用户页 Page 1，Internal Only Canvas 隐藏。320 个变量、2 个变量集、87/87 个文本节点（用户页大纲里 8 条，其余在隐藏页的组件母版上）、1504 个实例都有 componentId、1293 个组件。 |
| `sections.fig` | 打开。用户页只有 Page 1。原先那条「原型、变量与部分组件属性尚需手动核对」没有了。组件属性是变体定义，组件集名称仍在。 |
| `corners.fig` | 打开。矢量圆角那条警告没有了。平滑圆角写进了矢量几何。 |
| `01有料素材.fig` | 3 个用户页，1382/1382 条文本，37 个实例。 |
| `06-02有料素材.fig` | 3 个用户页，1374/1374 条文本，45 个实例。 |

## 同一 WASM 再测一轮

光栅代码没有再改。同一台机器、同一份 `d352c6da4decf7f06e5a47c90c26a6c4ff9fa0c6d219d3a72e3d24a6774a4c8b`，又跑了一轮。数字和上一轮同一量级，没有当成变快。

效果开启，34 帧都完成：zoom 0.1 为 1050.318 ms，0.2 为 962.840 ms，0.4 为 1218.311 ms，0.8 为 2238.968 ms，1.6 为 1747.015 ms，3.2 为 2709.166 ms，6.4 为 3296.299 ms，12.8 为 1599.925 ms，25.6 为 1801.746 ms，32 为 1840.720 ms。zoom 32 平移 p95 1862.839 ms，最大 1868.679 ms。

效果关掉：第一帧 367.225 ms，放大最慢 699.216 ms，平移 p95 688.642 ms、最大 714.248 ms。从 32 缩回：25.6 为 767.989 ms，12.8 为 698.884 ms，6.4 为 586.143 ms，3.2 为 524.238 ms，1.6 为 379.191 ms，0.8 为 363.057 ms，0.4 为 278.963 ms，0.2 为 302.312 ms，0.1 为 306.779 ms。p95 和最大都是 767.989 ms。

`01有料素材.fig`：importFig 1078.688 ms，字体加载 562.281 ms，load_document 1306.884 ms，第一帧 zoom 0.1 为 3269.409 ms。放大 0.25 / 0.5 / 1 / 2 为 568.574 / 306.558 / 187.863 / 86.512 ms。zoom 2 的四次平移为 87.286、86.002、91.443、85.174 ms。缩回 1 / 0.5 / 0.25 / 0.1 为 188.977 / 299.776 / 657.809 / 954.059 ms。页名是 Meher Admin Dashboard Ui Kit Light，文件里 4 页、9063 个节点。

## 字体再导入

同一轮 `importFig` 加 `matchBundledImportFonts`（`/tmp/fig-structure-fonts.json`）：

- `structure.fig`、`01有料素材.fig`、`01有料素材 (Copy).fig`、`01有料素材 (Copy) (1).fig`、`06-02有料素材.fig`、`gold-preview.fig` 的 `fontSubstitutions` 和 `fontMissing` 都是空的。Inter、ABeeZee、Poppins 对上了捆绑文件，不再落到 Poppins 顶替。
- `06-01有料素材.fig` 仍有一条：`Poppins-BoldItalic` 没有斜体文件，显示为 Poppins Bold。
- `01有料素材.fig` 这条报告的警告数是 0。`(Copy) (1)` 仍有矢量圆角轮廓/平滑/样式，以及独立顶点或区域样式。
- `gold-preview.fig` 仍打开：用户页 Page 1，Internal Only Canvas 隐藏，320 个变量，文本节点 87，用户页大纲文本 8，实例 1504，组件 1293，校验通过。警告 117 条，其中包括没有唯一目标的组件属性（Input 0、Label 2、Placeholder 2、Tags 2、Date Range List 3、Time 2）和矢量样式。

## 仍然存在的差距

- Poppins-BoldItalic 没有斜体文件，显示为 Poppins Bold。
- 大素材和 `gold-preview.fig` 里，仍有矢量圆角的轮廓、平滑或顶点样式没有全部烘焙，警告保留。`corners.fig` 这一份已经不再警告。
- `gold-preview.fig` 里 Input、Label 等组件属性没有唯一目标，定义被跳过并写进警告。实例覆盖 `styleIdForFill`、`strokePaints` 还不能执行。
- 效果关掉时的高倍帧仍约 700 ms。`01有料素材.fig` 首帧这一轮是 3269.409 ms。效果开启、阴影还在视口边上时，zoom 6.4 这一轮是 3296.299 ms。
- 33 ms 可见、100 ms 精修、完整 G2/G5 没有测。Electron、GPU 和上屏延迟没有测。
