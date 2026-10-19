# 端点标记与大图模糊标定（2026-10-11）

本轮目标：把 `design-kernel/src/stroke/markers.rs` 的端点几何常数标定为
Figma 外部像素相同，并补上 Figma 模糊输出噪声的盲区探针。

## 已核实的事实（不需要 Figma 也能复用）

- **官方端点枚举**（`@figma/plugin-typings` 的 `plugin-api.d.ts`，2026-10-11 抓取）：
  `StrokeCap = NONE | ROUND | SQUARE | ARROW_LINES | ARROW_EQUILATERAL | DIAMOND_FILLED | TRIANGLE_FILLED | CIRCLE_FILLED`。
  连接线另有 ERD 变体。**没有 SQUARE_FILLED，也没有 BAR**；Forma 的 square/bar
  端点是产品自加项，不参与 Figma 对照。
- **官方几何语义**（[Figma 帮助：Apply and adjust stroke properties](
  https://help.figma.com/hc/en-us/articles/360049283914-Apply-and-adjust-stroke-properties)）：
  Line arrow 是**两条与端点成 45° 的线**，使用与路径**相同的描边宽度**，长度固定
  不可调；Triangle/Reverse triangle/Diamond 未公布数值。注意当前 `markers.rs` 的
  Arrow 折线半角为 atan(0.5)≈26.57°，与官方 45° 不符——这是外部像素差异的直接
  候选之一，等标定 PNG 一起回填。
- `.fig`/REST 侧历史枚举名（fig2sketch `converter/style.py`、`shape_path.py` 核实）：
  `LINE_ARROW`、`TRIANGLE_ARROW` 是旧名，导入兼容时需要一并映射。
- **渲染引擎静态工件（可离线逆向）**：Figma 的 C++ 引擎以 WASM 形式公开在
  static.figma.com，无需登录即可下载（gzip 传输，需 `curl --compressed` 或
  手动 gunzip）。2026-10-11 已取回并解压至 `/tmp/figma-engine/`：
  fullscreen-wasm（52MB 解压后）、render-worker-wasm（29MB）、jsvm-cpp（0.75MB）。
  wabt 的 wasm2wat 不识别其操作码，**binaryen（`gh release download version_123
  -R WebAssembly/binaryen -p "*arm64-macos*"`）的 wasm-dis 可以**：render-worker
  已转出 577MB WAT（`/tmp/figma-engine/render-worker.wat`）。已排除的假线索：
  30°+√3/2 聚簇是被内联的宽高比/六边形数学助手；`f64 3.6` 是属性单位换算；
  0.5522847498（圆的贝塞尔常数）×4/×8 出现在 fullscreen 的 #2797/#3374，是
  圆形几何候选但未证实与标记相关。引擎 WASM 无 name section（符号已剥离），
  无 "ARROW_EQUILATERAL" 等枚举字符串（数值枚举）；后续深挖建议用 binaryen
  全量 WAT + 调用图分析。
- **GRAIN 无 seed**：用本项目 `import-fig.ts::decodeFig` 解码
  `testing/fixtures/design/figma-materials-native-2026-10-08.fig`，9 个 GRAIN
  效果全部只携带 `noiseSize/clipToShape/radius` 等字段，全文档 0 个 seed 键
  （复现：`bun /tmp/dump-fig-effects.ts` 一次性脚本，核心为 decodeFig + 递归搜索）。
  kiwi schema 的 `seed` 是可选字段而 Figma UI 从不写它——噪声场是 noiseSize 的
  固定确定性函数，逆向搜索不需要处理文档级随机性。GRAIN 位移场的完整结构
  分析另见本目录 `grain-notes.md` 与 `grain-ramp-analysis.py`。
- **frost 噪声周期实测**：对 `optics-2026-10-08/OpticsQA-frost-{1,2.01,4}-4x.png`
  做 2px 高通后的行列自相关（`noise-periodicity.py`），lag 为 64 的整数倍
  （64/128/192/256/320/384/448）处全部为正峰 0.42–0.88，lag 为 32 的奇数倍
  （96/160/288）处为负峰约 −0.47…−0.55，其余 lag ≈ 0。这是 32px 基格多倍频
  梯度噪声的指纹（相邻格点反相关、整数倍周期同相），与既有 3-octave、
  基格 32px 的 Perlin 族模型一致；448 处的抬升来自低频内容污染，不作为
  周期证据。**GRAIN 与 frost 不同：GRAIN 在 64px 内无平铺**（见 grain-notes）。
- **模糊噪声盲区确认**：现有 BlurQA 语料全部为 128×128，放不下一个 256px
  周期；Bjango（bjango.com/articles/blurradiuscomparison）实测的 Figma 模糊
  注噪（256×256 平铺、整体偏暗 1/255）在本语料上原则上不可观测。Board B 的
  640×512 探针就是为补这个盲区。

## 使用

1. 在 Figma 插件控制台（或 MCP）对本目录 `create-in-figma.js` 整体求值。
2. 导出所有 `KernelMarkerQA-*`（PNG 1× 与 4×）和 `KernelBlurQA-*`（PNG 1×），
   sRGB，按 case id 命名存到本目录。
3. 标定推导：
   - 端点几何常数 = (每端 renderBounds 超出 NONE 基线的量) / strokeWeight，
     10 档权重用于检验是否线性（若非线性，记录分段或 + 常数项）。
   - `ARROW_EQUILATERAL` 按名应为等边三角（顶角 60°），用 4× PNG 验证。
   - 模糊 PNG 用 `noise-periodicity.py` 检查 256 周期；若存在，按周期网格
     提取噪声表并并入 tent 管线后的一个注噪阶段；若不存在，记录“导出路径
     无注噪”并关闭该假设。
4. 常数回填 `markers.rs` 后，跑 `tests/stroke_markers.rs` 与既有 GPU 对照。

## 边界

- `absoluteRenderBounds` 的浮点读数只用于快速推导比例，最终以 PNG 字节为准。
- Board B 的背景模糊探针依赖 Figma 导出对 backdrop 的处理与画布内一致；
  如不一致，单独记录，不并入结论。
