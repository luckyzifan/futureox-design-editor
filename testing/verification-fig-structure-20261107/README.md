# 和 Figma 的结构差距（2026-11-08）

用产品的 `importFig`（`backend: typescript-fig`）读仓库夹具和 `/cursor/stores/bot/compare-fixtures` 里的 `.fig`。`/cursor/stores/self/compare-fixtures`、`/workspace/test-design-files` 和 `FUTUREOX_COMPARE_DIR` 这次都不存在。没有做像素对比，也没有 Electron / GPU。

机器记录是同目录的 `report.json`。`importMs` 只包 `importFig`，不含前面的 kiwi 解码。文本样本最多 24 条。

同一内容的计数：源里的 `FRAME + SYMBOL + INSTANCE` 等于导入后的 `frame + group - 蒙版组`。多出来的节点是导入器为非首位蒙版插入的 `Mask group`。Figma 里 `resizeToFit` 的普通组会变成这里的 group。下面的“文本”是源 `TEXT` 条数和导入后的 text 节点条数。

## 仓库夹具

| 文件 | importMs | 页 | 节点 | 文本 | 导入器警告 |
| --- | ---: | --- | ---: | --- | --- |
| sections.fig | 28.456 | Page 1，Internal Only Canvas | 18 | 0/0 | 原型、变量与部分组件属性尚需手动核对 |
| stacks_wrap.fig | 13.410 | Page 1，Internal Only Canvas | 54 | 0/0 | 无 |
| corners.fig | 16.680 | Page 1，Internal Only Canvas | 10 | 0/0 | 矢量圆角的轮廓、平滑或样式覆盖尚未支持，源样式需要核对 |
| structure.fig | 27.166 | Page 1，Internal Only Canvas | 23 | 1/1，内容 `ABC` | 字体 Inter 尚未匹配，文字留下了 |

`sections.fig` 有 6 个 SYMBOL，导入成 6 个组件，没有实例。`structure.fig` 有 1 个组件和 2 个实例，实例的 `componentId` 都连上了。bot 目录里的 `corners.fig`、`stacks_wrap.fig`、`structure.fig` sha256 与仓库夹具相同。

## 下载的文件

| 文件 | 结果 |
| --- | --- |
| `01有料素材.fig` | 970.589 ms。4 页：Meher Admin Dashboard Ui Kit Light、Style Guide、Symbols、Internal Only Canvas。9063 节点。文本 1382/1382，开头是 “Back to Home”、“Whooops, that page is gone.”、“SIGN IN”。22 个组件、37 个实例都有 componentId。66 个蒙版组。字体 Poppins、ABeeZee 尚未匹配。 |
| `01有料素材 (Copy).fig` | 2386.758 ms。15 页，在上面 4 页之外还有 Core 像素与画布对照、模糊、覆盖、效果、Backdrop、Pass Through、Large Nested、Large Curves 等页。19402 节点。文本 2638/2638。22 组件、74 实例。125 个蒙版组。除 Poppins、ABeeZee 外，还有矢量圆角和独立顶点/区域样式需要核对。 |
| `06-01有料素材.fig` | 754.297 ms。3 页，没有 Internal Only Canvas。9064 节点。文本 1382/1382。22 组件、37 实例、66 个蒙版组。只警告 Poppins。 |
| `06-02有料素材.fig` | 758.705 ms。3 页：Meher Admin Dashboard Ui Kit Dark、Style Guide、Symbols。9029 节点。文本 1374/1374。22 组件、45 实例、66 个蒙版组。只警告 Poppins。 |
| `Forma 内核对照验收 2026-10-06.fig` | 33.741 ms。4 页：Page 1、Internal Only Canvas、Kernel comparison 2026-10-07、Kernel curves and filters 2026-10-07。381 节点，108 个 frame、254 个 rectangle、1 个 ellipse、18 个 vector。无文本，无警告。 |
| `01有料素材 (Copy) (1).fig` | 2289.487 ms 后整文件拒绝：`FIG 平铺的间距、缩放、旋转或对齐尚不能无损导入；原文件未修改`。源有 16 个画布，比能打开的那份 Copy 多一页 “Core Precision Regression 20261018 — temporary”，以及 2638 条文本。平铺条件是图片 `TILE` 的间距、缩放、旋转或对齐不是默认值。文件没有被导入。 |
| `gold-preview.fig` | 694.482 ms 后整文件拒绝：`FIG 节点类型 VARIABLE_SET 暂不支持；原文件未修改`。源有 2 个 VARIABLE_SET、320 个 VARIABLE、1293 个 SYMBOL、1504 个 INSTANCE、87 条 TEXT（样本 “Ag”、“Rag 123”、“Badge-lg”）、2 个画布。文件没有被导入。 |

## 差距

能打开的文件里，页名、文本条数和组件实例数量都留在文档里。Figma 的 Internal Only Canvas 会作为普通页面出现。字体只保留了文字，Poppins、ABeeZee、Inter 没有匹配到字体文件。

整文件打不开的是两处：图片平铺的间距、缩放、旋转或对齐，以及 `VARIABLE_SET`。矢量圆角的轮廓、平滑和顶点样式，以及原型、变量、组件属性，导入器自己标成尚需核对。这次没有测量像素。
