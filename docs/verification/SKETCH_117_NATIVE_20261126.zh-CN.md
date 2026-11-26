# 117.sketch 原生 Sketch 对照（2026-11-26）

本轮用本机原生 Sketch 2025.1.3 的 `sketchtool` 导出 117 画板，再与当前生产 WASM 的 Sketch 导入/PNG 导出逐像素比较。对照发现并修复了一个导入差异：嵌套画板的原生白色底没有进入可编辑文档。Figma 本机没有可用的桌面端，因此没有执行受控的原生 Figma 对照。

## 环境与输入

- Apple M2 Pro，16 GiB，macOS 26.3。
- Sketch 2025.1.3（203472），`/Applications/Sketch.app/Contents/Resources/sketchtool/bin/sketchtool`。
- `117.sketch` SHA-256 `d494693eadf269e7fa29e4cc56e893f5890c02f4d96f4561065c851818a85d70`，1 页、752 个节点；画板 `117` 为 1922 × 1080。
- 当前 release WASM SHA-256 `ab467dd7f0b81bdd47c9ef47d9f2b2894d92a0b309eed31189ab1eb692ea1b6b`；桌面构建 profile `release`。

## 方法

```sh
sketchtool export artboards testing/fixtures/user-regression-20261109/117.sketch \
  --formats=png --scales=1,2 --output=<native>
```

生产 WASM 读取同一原件，`import_sketch_json` 后 `render_png` 输出同画板 1× PNG：

- 画板世界原点 `(-410, 358)`；1× 为 1922 × 1080，view `{x: 410, y: -358, zoom: 1}`。
- 原生 2× PNG 为 3844 × 2160；当前整画板 `render_png` 在 2× 报 `PNG backdrop dependency padding exceeds its 1024-pixel budget`，未取得同尺寸生产导出。
- 比较使用 RGBA/RGB 逐像素最大通道差；文字矩形和嵌套画板矩形来自同一导入文档。夹具、截图与 result.json 留在本机 `test-results/native-parity-20261126/`，不提交。

## 结果

修复前（1×，2,075,760 像素）：

| 范围 | 面积 | 平均差 | >16 码 | >64 码 | 最大差 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 整画板 | 2,075,760 | 6.23 | 4.63% | 3.20% | 255 |
| 嵌套画板（8 个） | 44,096 | 185.42 | 92.65% | — | 255 |
| 文字矩形（旧掩码，不完整） | 60,776 | 1.78 | 0.93% | — | 239 |
| 嵌套画板之外 | 2,014,984 | 3.00 | 2.72% | — | 253 |

最大差异簇是 8 个嵌套画板：原生 Sketch 给它们渲染白色底，而导入文档没有对应填充，生产导出显示父画板的深色背景。该表的文字行使用不完整的矩形掩码，不能作为文字差距结论；完整文字帧见下方更正。

修复后（同一原件、同一相机、同一 WASM 导出；alpha 合成后统计）：

| 范围 | 面积 | 平均差 | >16 码 | >64 码 | 最大差 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 整画板 | 2,075,760 | 2.77 | 2.61% | 1.18% | 253 |
| 文字帧（106 个） | 200,902 | 21.89 | 24.43% | 11.63% | 253 |
| 标题溢出“称” | 3,186 | 40.98 | 1,747 px | 541 px | 250 |
| 图像填充（排除文字） | 961,979 | 0.64 | 0.12% | 0.03% | 232 |
| 嵌套画板（8 个） | 44,096 | 1.24 | 2.52% | — | 77 |
| 其他矢量/界面 | 865,656 | 0.64 | 0.136% | — | 246 |

修复后整体 `>0` 差异从 50.58% 降到 48.96%，`>1` 从 9.68% 降到 7.91%。嵌套画板区域不再是主要差异；**文字帧加标题溢出共 50,820 个 >16 码像素，占全部 54,230 个的 93.7%**。

测量更正：早期结果表的“文字矩形 1.78/0.93%”只覆盖了不完整的文字矩形（60,776 px），漏掉大部分文字帧和标题溢出，不能作为文字差距结论。完整 106 个文字帧为 200,902 px、49,073 个 >16 码像素；标题溢出另 1,747 个。右侧最后 2 列是原生透明、WASM 不透明白底的比较伪差；alpha 合成后最大差 4，不应计入渲染差距。

## 根因与修复

原生 Sketch 对 `hasBackgroundColor: false` 的嵌套 artboard 仍绘制默认白底。`sketch/preview/display.rs` 已为预览路径补白底，但可编辑/导出的 `interop.rs` 只在 `hasBackgroundColor: true` 时写入背景。修复在 `interop.rs` 的 `artboard` 分支补齐与预览一致的白色底色，并避开本项目自身的导出标记，防止重导入重复叠加。回归测试 `nested_sketch_artboards_keep_the_native_white_backdrop` 覆盖嵌套画板保留白底、顶层画板不被改写。

文字是修复后的最大残差：117 使用的七个源字体族（YouSheBiaoTiHei、DINPro-Medium/Regular、Alibaba PuHuiTi Regular/Medium/Bold、Barlow-Medium）均未嵌入。导入把它们改写为 `default` 并保留源字体元数据（`interop.rs:5483-5512`）；WASM 造型以包内 NotoSansSC 收尾（`font.rs:1796-1814`），原生 Sketch 使用本机替代字体。逐层整数重对齐只能去掉约 9.4% 的 >16 码像素，主要差异是字形轮廓和度量；三个 40 pt KPI 标签整体高约 2 px；标题的蓝色阴影由 #177 跟踪。

2× 整画板失败来自 117 的 7 个 Sketch type-3 background blur（radius 18.39398）。support 为 `3·r·√2·zoom+2`：1× 为 560.3，2× 为 1106.6；`checked_backdrop_padding` 在 1024 上限拒绝，`backdrop_demand` 也找不到更小的可认证范围。与已关闭的 #1045（Figma 512×384 光栅）不是同一触发。

真实 Electron release 复跑 117：20 步通过、页面错误 0、3200% 约 2.35 s、缩回约 0.66 s；高倍回放全部 `WebGPU · 清晰`，800% 约 34.7 s、3200% 约 5.1 s。100% 缩回截图因白底出现而变化，fitted 打开和 3200% 截图哈希与修复前一致。

## 剩余差距

- **文字（主导）**：106 个文字帧平均差 21.89、>16 码 24.43%；加标题溢出共占全部 >16 码像素的 93.7%。源字体未嵌入，WASM 以 NotoSansSC 收尾，原生使用本机替代字体；不是简单的全局偏移，逐层整数重对齐只能消除约 9.4%。标题阴影另见 #177。
- **图像填充**：排除文字后 `image.png` 区域 >16 码仅 0.12%、平均差 0.64；#890 的关闭与当前结果一致，不需要把它继续当作主要残差。
- **矢量 AA**：嵌套画板内剩下 2.52% 的 >16 码像素，主要是雷达网格细线（最大差 77）；归入 #891 的矢量边缘问题。
- **右侧 2 列**：原生 PNG 边缘透明、WASM 不透明白底造成的测量伪差；alpha 合成后最大差 4。
- **2× 导出**：原生能给 3844 × 2160；整画板生产 PNG 导出被 1024 像素 backdrop 依赖预算拒绝（7 个背景模糊，2× support 1106.6）。瓦片画布可以到 3200%，但导出路径需要分块或按缩放认证。
- **Figma**：本机 `Figma Desktop.app` 只是 1.6 MB 的 URL handler stub，无法启动客户端。`public/fidelity/` 有 20 个根 Figma PNG，但只有 `rotated-curve` 有提交的无头像素门；`text-2026-10-09` 缺原始 PNG。因此本轮没有声称任何原生 Figma UI/操作/渲染闭合。Products FIG 只验证了导入/打开（9403 节点、4 页）。

## 边界

Sketch 对照是**原生 `sketchtool` 静态导出 vs 生产 WASM 导出**，不是原生 Sketch GUI 与 Futureox GUI 的窗口级对照；也不覆盖 2× 生产导出、跨 GPU/HDR、所有对象类型或 Figma。原生导出使用 1× 尺寸与 sRGB PNG，未做 ICC 重映射。