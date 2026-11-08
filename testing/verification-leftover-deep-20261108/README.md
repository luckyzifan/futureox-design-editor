# 深测：导入余项、渲染和页面助手（2026-11-08）

同一台云端 Linux。开发 WASM `93dcca0ce6a5d00bee9c95b42a877cff5dbb062163b9424febd5ab3379fec147`。视口 640×480，`render_rgba`。没有 Electron、GPU 或上屏延迟。没有像素对比。Figma 桌面版和 Sketch 在这台机器上跑不了，没有它们的帧时间。

对照数字来自上一轮同一方法的再测，记在 `testing/verification-fix-regression-20261108/README.md`。那一轮 WASM 是 `d352c6da4decf7f06e5a47c90c26a6c4ff9fa0c6d219d3a72e3d24a6774a4c8b`。

## 导入

产品路径仍是 `importFig`，再走 `matchBundledImportFonts`，然后 `validateDocument`。`/cursor/stores/bot/compare-fixtures` 里能打开的 `.fig` 都过了校验。Internal Only Canvas 留在文件里，不进用户页列表。

| 文件 | 用户页 | 文本节点 | 实例 | 变量 | 警告 | 字体替换 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `sections.fig` | 1 | 0 | 0 | 0 | 0 | 无 |
| `stacks_wrap.fig` | 1 | 0 | 0 | 0 | 0 | 无 |
| `corners.fig` | 1 | 0 | 0 | 0 | 0 | 无 |
| `structure.fig` | 1 | 1 | 2 | 0 | 0 | 无 |
| `01有料素材.fig` | 3 | 1382 | 37 | 0 | 0 | 无 |
| `01有料素材 (Copy).fig` | 14 | 2638 | 74 | 0 | 0 | 无 |
| `01有料素材 (Copy) (1).fig` | 15 | 2638 | 74 | 0 | 0 | 无 |
| `06-01有料素材.fig` | 3 | 1382 | 37 | 0 | 0 | 无。Poppins-BoldItalic 对上斜体文件 |
| `06-02有料素材.fig` | 3 | 1374 | 45 | 0 | 0 | 无 |
| `Forma 内核对照验收 2026-10-06.fig` | 3 | 0 | 0 | 0 | 0 | 无 |
| `gold-preview.fig` | 1 | 87（用户页大纲 8） | 1504 | 320，2 个集 | 91 | 无 |

`gold-preview.fig` 里，原先「没有唯一目标」的布尔属性现在写进组件。多个图层共用一条属性时，其余目标在 `alsoTargets`。文件里没有 `componentPropRef` 的那条 Input 以 `unbound` 保留，不假装绑到某个图层。实例覆盖里的 `strokePaints` 写成描边；描边宽度、对齐和四边宽度在有描边颜料时一起读进去，不再单独报「暂不能执行」。`styleIdForFill` 是空 guid 时表示取消共享填充，显式 `fillPaints` 留下。能对上的填充样式写入 `styleRefs.fills`。

矢量圆角：闭合直线轮廓仍按顶点半径烘焙。只带手柄镜像、或半径为 0 的描边端点样式，不再当成没烘焙的圆角。`01有料素材 (Copy) (1).fig` 和 `gold-preview.fig` 这次没有「矢量圆角」或「顶点或区域样式」警告。`corners.fig` 仍然是 0 条警告。

## 仍在 gold-preview.fig 里的 91 条

- 16 条组件属性赋值指向当前主组件上没有的定义。
- 1 条 `styleIdForFill` 对不上已导入的填充样式。
- 实例覆盖里还没执行的字段包括 `size`、`proportionsConstrained`、圆角、效果、文本度量、堆叠、插件数据和变量消耗表。
- 1 条零尺寸线条仍按精确路径保留。
- 共享文字样式记下了 Inter 家族名，不是导入失败。

这些不是被删掉的警告。大素材文件这次是 0 条警告。

## 渲染

效果开启，3009 个节点，34 帧都完成。zoom 32 没有再出现 `Compositing memory budget exceeded`。

| 项 | 上一轮 ms | 这一轮 ms |
| --- | ---: | ---: |
| zoom 6.4，效果开 | 3296.299 | 3445.129 |
| zoom 25.6，效果开 | 1801.746 | 1893.408 |
| zoom 32，效果开 | 1840.720 | 1889.988 |
| zoom 32 平移 p95 / 最大，效果开 | 1862.839 / 1868.679 | 1962.908 / 1979.455 |
| 效果关，放大最慢 | 699.216 | 618.449 |
| 效果关，平移 p95 / 最大 | 688.642 / 714.248 | 613.931 / 643.333 |
| 效果关，从 32 缩回最慢（zoom 25.6） | 767.989 | 704.225 |
| `01有料素材.fig` 第一帧 zoom 0.1 | 3269.409 | 3136.200 |
| 同上，importFig / load_document | 1078.688 / 1306.884 | 1046.075 / 985.340 |
| 同上，缩回 0.1 | 954.059 | 826.157 |

效果关掉的高倍帧和这份素材的首帧比上一轮低，仍是几百毫秒到 3 秒。效果开启、阴影还在视口边上的 zoom 6.4 没有降下来。空的模糊窗口现在直接写成 0，不再对每个空像素做整段有理数卷积；这一帧的时间不在那些空像素上。

33 ms 可见、100 ms 精修、完整 G2/G5 没有达到。上面的数字就是这台机器上的开发 WASM `render_rgba`。

## 页面助手

没有 `GROK_ASSISTANT_API_KEY` 或 `DESIGN_AGENT_API_KEY`。没有打远程模型，也没有编造回答或耗时。

跑过的是本机会话：

- `cargo test -p futureox-design-agent`：16 通过。其中包括多轮 OpenAI / Anthropic 的真实 `tool_call_id`，以及追问「这个按钮是什么颜色？」能看到之前的用户句、助手句、计划、工具结果和当前填充 `#3459d4`。本地回答不发出工具调用。点名「设置」页时，细节调整改那一页，而不是停在当前页。
- `agent-page.test.ts`：一键出图改文档，撤销去掉「秋日特惠」页，重做恢复，`SaveCoordinator` 看到脏版本。和 `sections.fig` 的结构比较仍能看到这句标题。
- `page-hover.test.tsx`：页面行悬停才出现 AI，提交后的目标是当前页。
- `frontend/design-desktop/test/design-agent-host.test.mjs`：保存 API 和 token plan、切换当前连接、读取 CC Switch 形状的 sqlite，不回显密钥。

范围仍是页面、画板、文字、颜色、字体和布局。测试断言回答里不出现代码声明。

## 这一轮还跑过的回归

画布覆盖、缩放、平移、瓦片，加上 `fig-document`、`import-fig-text`、页面助手：11 个文件、99 个测试通过。字体匹配、组件属性和描边覆盖的单测通过。矢量样式的 Rust 测试 `handle_mirroring_and_round_caps_are_consumed_without_inventing_corners` 通过。

`cargo test -p futureox-design-kernel --lib` 没能编过，因为工作区里没有 `testing/fixtures/design/coreimage-color-controls-vectors.json` 和 `spectral-q4-natural-vectors.json`。这不是这次改动删的。模糊逐位测试因此没有在这个 lib 测试里重跑。空窗口写成 0 和有理核在全零输入上的结果相同。
