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
| 文字矩形 | 60,776 | 1.78 | 0.93% | — | 239 |
| 嵌套画板之外 | 2,014,984 | 3.00 | 2.72% | — | 253 |

最大差异簇是 8 个嵌套画板：原生 Sketch 给它们渲染白色底，而导入文档没有对应填充，生产导出显示父画板的深色背景。文字本身已接近原生，主要差异在边缘。

修复后（同一原件、同一相机、同一 WASM 导出）：

| 范围 | 平均差 | >16 码 | >64 码 | 最大差 |
| --- | ---: | ---: | ---: | ---: |
| 整画板 | 2.96 | 2.72% | 1.29% | 253 |
| 嵌套画板 | 1.24 | 2.52% | — | 77 |
| 文字矩形 | 1.78 | 0.93% | — | 239 |
| 嵌套画板之外 | 3.00 | 2.72% | — | 253 |

修复后整体 `>0` 差异从 50.58% 降到 48.96%，`>1` 从 9.68% 降到 7.91%。嵌套画板区域不再是主要差异。

## 根因与修复

原生 Sketch 对 `hasBackgroundColor: false` 的嵌套 artboard 仍绘制默认白底。`sketch/preview/display.rs` 已为预览路径补白底，但可编辑/导出的 `interop.rs` 只在 `hasBackgroundColor: true` 时写入背景。修复在 `interop.rs` 的 `artboard` 分支补齐与预览一致的白色底色，并避开本项目自身的导出标记，防止重导入重复叠加。回归测试 `nested_sketch_artboards_keep_the_native_white_backdrop` 覆盖嵌套画板保留白底、顶层画板不被改写。

真实 Electron release 复跑 117：20 步通过、页面错误 0、3200% 约 2.35 s、缩回约 0.66 s；高倍回放全部 `WebGPU · 清晰`，800% 约 34.7 s、3200% 约 5.1 s。100% 缩回截图因白底出现而变化，fitted 打开和 3200% 截图哈希与修复前一致。

## 剩余差距

- **文字边缘**：原生 117 使用 `DINPro-Medium`（本机无该字体文件，原生使用替代字体）；生产导入字体为默认字体。文字平均差 1.78、>16 码 0.93%，几何位置接近，差异集中在字形边缘。
- **图像填充**：`image.png` 区域 >16 码 1.87%，全屏 `Image` 背景 >16 码 2.62%；属于图像采样/颜色路径，仍需单独的图像对照。
- **矢量 AA**：标题、曲线、圆形图表边缘出现 1–2 码到 200+ 码的窄边差异；最大差集中在字形和细线边缘。
- **2× 导出（旧构建）**：原生能给 3844 × 2160，生产 PNG 当时被 1024 像素 backdrop 依赖预算拒绝。[补测记录](#整画板-png-补测)覆盖修复后的导出。
- **Figma**：本机未安装 Figma 桌面端（仅有 `FigmaAgent` 后台进程），也没有可控的 Figma 窗口或 Products 参考 PNG；现有 `public/fidelity/*` 参考包缺原始 PNG。因此本轮没有声称任何原生 Figma 像素闭合。Products FIG 只验证了导入/打开（9403 节点、4 页）。

## 边界

Sketch 对照是**原生 `sketchtool` 静态导出 vs 生产 WASM 导出**，不是原生 Sketch GUI 与 Futureox GUI 的窗口级对照；也不覆盖 2× 生产导出、跨 GPU/HDR、所有对象类型或 Figma。原生导出使用 1× 尺寸与 sRGB PNG，未做 ICC 重映射。

## 整画板 PNG 补测

在 Apple M2 Pro、macOS 26.3、Electron 44.7.0 上用原件打开画板 `117`，在图层导出面板分别设置 1× 和 2×，使用 Electron 下载链路保存。基线 `2c66db9306b9f482f068bf9e8d5d5d447552b987` 的 1× 成功，两次 2× 都报 1024 像素背景依赖超限。最终运行产物从 `784b448105ee6b0fb80e5ee49059ec16e223722e` 构建，WASM 为 release，桌面原生组件为 `desktop-dev`。

读取背景的预算遍历沿用绘制器的子节点范围，因而只计算实际绘制的布尔结果。直接 analytic PNG 导出复用区域导出的分块，减少同一背景的重复处理；每个行带仍受 8 MiB 上限约束。

| 倍率 | 实存 RGBA PNG | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| 1× | 1922 × 1080 | 2,118,605 | `05c3e58360754392d4c176007b38734cd2d825f2a4f982d877fd811c4b83c1e6` |
| 2× | 3844 × 2160 | 6,261,320 | `fae8d0974af2aadc91fd424f232eff9449e123681cffe7c79023e64016d66e87` |

窗口全程 0 页面错误，原件的 SHA-256 复核一致。对同一导入文档，原生与 WASM 各自的 1× 结果均与各自旧版逐字节一致。2× 的参考由旧内核从一份仅移除未绘制布尔操作数效果的内存副本导出。最终 WASM 的直接 PNG、区域 PNG 和该参考三者逐字节一致，窗口保存的 2× 与原生参考逐字节一致。

```sh
node frontend/design-desktop/scripts/build.mjs --fast
node scripts/run-test.mjs -- node frontend/design-desktop/scripts/check-sketch-png-export.mjs \
  --fixture="$PWD/testing/fixtures/user-regression-20261109/117.sketch"
```
