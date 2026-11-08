# 和 Figma、Sketch 的差距（2026-11-08）

后续深测和还没对齐的项写在 `testing/verification-leftover-deep-20261108/README.md`。下面是这一轮当时的数字。

这台云端电脑是 Linux，没有装 Figma 桌面版，也没有 Sketch（Sketch 是 macOS 应用）。下面没有它们的帧时间。我们自己的数字来自同一台机器上的开发 WASM `d352c6da4decf7f06e5a47c90c26a6c4ff9fa0c6d219d3a72e3d24a6774a4c8b`、640×480、`render_rgba`。修复后的第一轮和同一 WASM 的再测都写在 `testing/verification-fix-regression-20261108/README.md`。没有做像素对比。

## 我们测到的渲染

修复前，效果开启、3009 个节点：zoom 25.6 是 14314.744 ms，zoom 32 在 5626.462 ms 失败，错误是 `Compositing memory budget exceeded`，平移没有开始。

修复后同一 WASM 再测一轮（光栅没有再改）：zoom 25.6 为 1801.746 ms，zoom 32 为 1840.720 ms，34 帧都完成。zoom 32 的平移 p95 1862.839 ms，最大 1868.679 ms。zoom 6.4 仍是 3296.299 ms，阴影还在视口边上。

效果关掉，同一轮：放大最慢帧 699.216 ms，平移 p95 688.642 ms、最大 714.248 ms。从 32 缩回最慢是 zoom 25.6 的 767.989 ms。

`01有料素材.fig` 这一轮：第一帧 zoom 0.1 为 3269.409 ms，导入 1078.688 ms，文档加载 1306.884 ms，缩回 0.1 是 954.059 ms。

这些都不是浏览器上屏时间，也不能当成 Figma 或 Sketch 的帧率。Figma 和 Sketch 的桌面帧时间没有测，因为这两个应用在这台机器上跑不了。

## 导入和结构

| 项 | 这次的结果 |
| --- | --- |
| 图片平铺的缩放、旋转、间距 | `01有料素材 (Copy) (1).fig` 能打开。属性进图案填充，不再整份拒绝。 |
| `VARIABLE_SET` | `gold-preview.fig` 能打开。2 个变量集、320 个变量、1504 个实例都有 componentId、87 个文本节点。 |
| Internal Only Canvas | 留在文件里，页面列表不把它当用户页。 |
| `sections.fig` | 用户页只有 Page 1。变体组件还在。不再出现「原型、变量与部分组件属性尚需手动核对」。原型交互如果有，仍只保留数据，不能直接播放。 |
| `corners.fig` | 矢量圆角警告没有了。平滑圆角写进几何。大文件里仍有一部分顶点样式警告。 |
| 字体 | Inter、Poppins、ABeeZee、DejaVu Sans 按家族匹配捆绑文件。这一轮 `structure.fig`、`01有料素材.fig`、`gold-preview.fig` 的字体替换和缺失列表是空的。Noto Sans SC 已用于画布中文渲染，不写进每份文档。`06-01有料素材.fig` 的 Poppins-BoldItalic 仍改用 Poppins Bold。未捆绑的家族在警告里给官方下载地址。 |

## 还没对齐的地方

Figma 和 Sketch 的桌面渲染、协同、插件市场，这里跑不了，也就没有它们的性能数字。

我们这边还没对齐的，是测到或导入时写下来的这些：

- 效果开启时，阴影还在视口边上的帧仍要数秒（再测 zoom 6.4 为 3296.299 ms）。
- 效果关掉的高倍帧再测放大最慢 699.216 ms，缩回 zoom 25.6 为 767.989 ms。`01有料素材.fig` 首帧再测 3269.409 ms。
- `gold-preview.fig` 的部分组件属性没有唯一目标，被跳过。实例覆盖 `styleIdForFill`、`strokePaints` 还不能执行。
- 大素材里仍有矢量圆角的轮廓或顶点样式没有全部烘焙。
- 33 ms 可见、100 ms 精修、完整 G2/G5 没有测。
