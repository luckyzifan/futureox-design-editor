# FIG / Sketch 导入后的背景、滤镜与表面预算审计

日期：2026-10-19。仓库：`__DESIGN_REPO__`。

## 结论

当前源码确实保留了“离屏背景效果不再无条件扩大当前 tile”的修复，以及限定条件下的大半径前景模糊条带执行。不能据此认定任意 `.fig` / `.sketch` 都不会再遇到异常背景、巨大表面、内存预算失败或视觉差异。

本次实际执行了仓库现有真实 FIG 的解析、截断输入负向检查，以及两处真实背景模糊节点的 12 个 CPU/WASM 编译点，全部成功。没有运行浏览器、真实 GPU、Electron、OS socket，也没有读取/重试此前被拒绝的私有样本。未修改产品源码、原始样本和既有验证记录。

还发现两个静态兼容缺口：普通 Sketch 导入没有重建原生 mask chain / mask mode；native Sketch display 投影没有建模背景模糊 saturation，也没有相应告警。它们可能造成内容遮罩或背景外观不同，但本次未用用户原始文件复现具体画面。应作为下一轮定向回归与修复候选，不能包装成已经复现并修复。

## 1. 版本与证据归属

- Git 基线：`71d32153e6f55b3723c99708b4c4c49ac7342e67`。审计的是当前工作树，不把所有已有未提交改动归为本轮改动。
- 前一累计增量 ZIP SHA-256：`c11eb9c4f1ea87c2ae5cf4508e5fe054e0ed328779309083fc43b150c2bca686`。其中 `gpu.rs` 与 `interop.rs` 当前字节与归档内条目一致；没有把它们与后续无关 AI 工作混算。该 ZIP 是增量，不包含的文件不代表缺失产品源码。
- `renderer.ts`、FIG 导入器和 native Sketch display 投影相对 Git 基线没有工作树差异。
- 本次 WASM SHA-256：`e002c8fe2efc46b09fed04bbc21404c5b7bdfb773e12081c41cfc004c824ea1b`，与 `testing/verification-ai-workspace-final/runtime-inputs.json` 留存运行资源一致。没有临时重编译或替换 WASM。
- 完整源文件哈希及历史证据比对见 `import-background-source-manifest.json`。

## 2. 必须区分的实际入口

### 普通编辑画布导入

`App.tsx:223–243` → `persistence.ts:25–33` → `import-file-worker.ts:7–19,31–64` → `import-worker.ts`：

- `.fig`：`import-worker.ts:41–42` 调 TS `importFig`，不是 Rust `interop::import_fig` / fig2sketch。FIG 的页面背景、mask / clip 和效果映射分别在 `import-fig.ts:491–497,535–549,578–619`。
- `.sketch`：`import-worker.ts:16–22` 调实际 WASM `import_sketch_json`，其共享兼容转换在 `interop.rs:1695` 和 `2237` 起。正常 Gaussian=0、Background=3 的映射在 `701–757`；阴影半径、偏移与 spread 原值传入，未为节省内存截小。
- 文件入口 32 MiB 上限；worker 30 秒时间预算；FIG 解压 64 MiB 与 20,000 条 source nodeChanges 上限。这些是明确拒绝的输入边界，不是“任何合法设计文件都能打开”的保证。
- 默认 FIG 当前生成 `analytic`、无 colorManagement 的文档；`kernel/picking.ts:124–135` 保留已声明 profile。不能把所有 FIG 都当成 managed / integrated 模糊路线。

### 独立 native Sketch 会话 / 预览

`frontend/design-desktop/src/sketch-session.mjs:23–57` → `sketch.session.open`；另有 `main.mjs:513–529` 的只读 inspect 入口。这条路径保留 native 文档 ownership，不是普通导入的别名。

`design-desktop-backend/src/sketch_preview.rs:58–140` 先尝试有限 legacy preview（512×384、128 nodes、2 MiB），失败再尝试 display snapshot（48 MiB 资源包上限）。display 由 `design-kernel/src/sketch/preview/display.rs` 映射，前端 `sketch-display.ts:6–16` 取所选画板，再经 `SketchDisplayPreview.tsx:47` 的 KernelSurface 绘制。

legacy preview 的严格字段白名单会拒绝未知效果，不能用其小场景通过说明 native display 的背景、阴影和蒙版已全部保真。native display 使用默认 managed sRGB/Figma profile（`display.rs:723–737`），与普通 FIG 默认 profile 不同。

## 3. 已保留的背景与预算修复，及其边界

1. **离屏效果依赖按区域分析**：`gpu.rs:719–740` 的 `foreground_region_supported`、`1377–1486` 的 `required_halo` 按当前区域及祖先 support 递归；`1278–1283` 不再直接把页面最大 padding 当作分配表面。真正相交的背景效果仍保留邻域，不能删掉，否则会损失跨 tile 采样。
2. **有证明的无贡献背景省略**：`gpu.rs:699–716` 的 `irrelevant_backdrop` 仅在不透明、normal、无 mask 等条件满足时移除被完全盖住的 backdrop；透明、边缘、复杂混合保持原依赖。
3. **背景 capture 的相位与裁剪**：`coverage.rs:3–27` 保留对象 fractional texel phase；`renderer.ts:1944–1977,2144–2156` 从 `backdropBox` capture / blur，再按原 footprint 合成。不得将 capture 直接压成输出 tile 而遗漏邻域。
4. **条带大模糊不是通用背景模糊方案**：`renderer.ts:2191–2286` 的 `filterSourceSupported` / `streamIsolatedFilter` 要求 managed、非 displayMath、integrated、非 displayFilters；无 passthrough/clip/mask/maskId/描边；单一无 gradientBlur 的前景 blur，或零偏移、零 spread 的外阴影；半径 64–2048、输入边长不超过 8192、精确 lattice 等。背景模糊、复杂蒙版、多个滤镜或普通偏移阴影不会走这个分支。
5. **预算仍会明确失败**：`gpu.rs:1485–1486` 对 extent 超过 16,777,216 像素拒绝；TS `working-set-budget.ts` 非 nativeDisplay 基础预算 256 MiB，nativeDisplay 512 MiB 起至 1 GiB 封顶。这是策略预算，不是显卡可用显存测量。`renderer.ts:576–601` 先回收安全缓存，再显式抛错。
6. **半径限制要按路线解释**：TS `renderer.ts:2475–2478` 的通用 integratedBlur 分支 >512 像素报错，前面 displayFilters 分支及符合条件的条带分支另行处理；默认 analytic/unmanaged FIG 的 `integratedBlur=false` 不走这个 512 检查。Rust `design-gpu/compositor.rs:1858–1864` 自己仍有 >512 检查，`device.rs:758–775` 为 256 MiB 表面池。不能把 TS 条带能力视为 Rust compositor 也已具备。
7. **切小 tile 不一定救得回来**：`preview-tiles.ts:45–78` 在预算失败时保精度递归拆分，到边长 64 为止；它不减小物理 blur support，也不处理半径限制错误。若主因是巨大 halo / 多重效果，而非输出 tile 尺寸，仍可能失败。这不是可以用降采样或删效果掩盖的问题。

## 4. 尚存兼容风险

### A. 普通 Sketch mask chain / mode 映射缺口（优先）

- `interop.rs:1462–1464` 只设置 `node.mask=true`；`1502–1508` 和 `1788–1800` 原样递归子节点。
- 该 importer 不读取 `shouldBreakMaskChain` / `clippingMaskMode`。共享模型 `scene.rs:936–944` / 前端 `model.ts:360–363` 在父节点里只找第一个可见 mask。
- 对照 native display 的 `display.rs:551–584`，它明确按 break 重建隔离组，并处理 outline mask 与 alpha mask。
- 因此普通导入中的多条蒙版链、链中断、outline mask 与 alpha mask 有语义不一致风险，可能表现为背景/邻居被不该有的 mask 裁掉或穿出。当前导入测试没有覆盖这些输入语义。未作源码修复，也未新造样本冒充真实用户文件。

### B. 背景 blur saturation 路径不一致

- 普通 importer `interop.rs:834–850` 会保留 source blur，并明确发出 `background-blur-saturation-not-modeled`。
- native display `display.rs:449–470` 只读取 type/radius；没有读 blur.saturation，也没有同类 warning（该文件仅在 `786–788` 添加字体替换 warning）。
- 对 saturation≠1 的真实 Sketch 文件，现有 display 投影不足以保证原图相同。这属于兼容性而非纯性能问题。

### C. 高倍率真实相交 backdrop 的内存负担仍存在

现有 `gpu_regional_backdrop.rs` 的 `an_opaque_fill_makes_its_interior_backdrop_unobservable` 测试，先证明不透明覆盖可省略，随后将 opacity 改为 0.5，并明确断言高倍率 compile 返回错误。测试本身承认透明相交依赖仍可能触及已有 admission 上限。

同一套 `intersecting_backdrops_retain_their_dependency_neighbourhood`、`continuous_coverage_edges_and_layer_opacity_keep_their_backdrops` 保护效果正确性，不能把这些较大的邻域都当作应删掉的冗余。

## 5. 真实文件与测试究竟验证了什么

### 本轮直接执行

现有 `testing/fixtures/design/figma-materials-native-2026-10-08.fig`：46,667 B，SHA-256 `5c9145494700f3784c967fd00c18442c57a3e7a65c722c4d2ea5b72ee13da4da`。

- 实际 TS parser + model validation：3 页、381 节点；2 shadow、29 blur、2 background-blur、17 glass、9 texture；3 alpha mask。保留一条矢量区域样式兼容提醒。截断到 12 B 实际拒绝。
- 对真实 `blurred surface`、`lens`（均 background radius=4），选择中心和边缘，物理 zoom=2/16/64，即 DPR2 下 100%/800%/3200% 的相机等效值；每次 64×64 物理 viewport，12 次 CPU/WASM compile 均成功，半径保持 4。
- working extent 分别 96×96、320×320、1088×1088。最后一种单个 RGBA32F 面的理论字节数约 18.06 MiB；这是由 extent 计算的单面尺寸，不是实际 GPU 峰值测量。12 次均 `integratedBlur=false`、`coherentSamples=false`。
- 这只能证明当前已存 parser/WASM 对这些真实位置的编译不报错。没有绘制 GPU 像素、验证原应用画面、模拟完整 UI 导入，也不覆盖原始 117 或大素材 FIG。
- 可复现脚本与原始输出：`import-fixture-probe.ts/.json/.log`，`import-fixture-compile-probe.ts/.json/.log`。都位于本报告同目录；产品树无新增文件。

### 留存历史证据

`testing/verification/117-electron-3200-20261019.json` 记录真实 `117.sketch`（SHA-256 `d494693eadf269e7fa29e4cc56e893f5890c02f4d96f4561065c851818a85d70`）在 macOS arm64、Electron/WebGPU、DPR2 的原故障视区、标题/数字文字和 3200% 清晰度验收；有 16,384 channel 图像片段比较为零差异。此报告的 16 个源码哈希中，当前 15 个一致，只有 `gpu.rs` 已发生后续变化。因此是有价值的历史定点证据，不是当前全文件/全视口重新验收。

历史 `leaf-final-comparison` 的两个 background 项对应 `large-blur-probe.ts:60–69` 的不透明实心 fill、layer opacity=1 场景；它们主要证明“背景被不透明覆盖时省略仍等价”，不是半透明背景实际可见时的普遍精度证明。

最新 `verification-ai-workspace-final/README.md` 明确保留三项 skipped：real 117、外部 DESIGN_TEST_SKETCH、外部 DESIGN_TEST_FIG。`__tests__/design-file-import.test.ts:22–51` 的公开 Sketch 是合成单矩形；真实 committed FIG 的断言仅为有效文档/非空节点及截断拒绝，并没有背景像素 oracle。通过总数不能替代这些缺口。

## 6. 最小真实文件回归矩阵（下一轮门禁）

| 真实文件 / 场景 | 普通导入 | native Sketch display | 关键验收 | 当前状态 |
|---|---|---|---|---|
| 仓库 committed FIG：两个 background blur 中心/边缘 | 100/800/3200%，DPR1/2 | 不适用 | 半径/alpha/蒙版保留；边缘与相邻 tile 无接缝；峰值表面与错误日志 | 本轮仅 DPR2 等效 CPU compile 12 点成功；GPU 未跑 |
| 原 `117.sketch` 故障视区、标题/数字文字 | 冷开、缩放、平移、精修 | 同一文件所选画板 | 与旧参考/原 Sketch 的像素、背景、blur/shadow；完整图层数、编辑与 undo | 有历史定点 GPU 证据；本轮样本缺失、未重试 |
| 原 `01有料素材 (Copy).fig` 多页素材 | 首屏、含背景模糊页、跨页切换 | 不适用 | 记录首个可见帧/最终精修；页面背景和 alpha gradient；既有 19,949 editable nodes 不被删减 | 仅历史导入/性能记录；本轮文件缺失 |
| 有真实可见半透明背景 blur、相邻多个 blur、非零偏移/spread 阴影的原文件 | 中心/边缘/缩放边界 | Sketch 时双路对照 | 相交/离屏依赖正确；64 tile 仍失败时显式报告；不削效果 | 待提供/定位原文件；不能用不透明背景 probe 代替 |
| 有两条 mask chain、break、outline/alpha mask 的真实 Sketch | 必测 | 同一文件对照 | 遮罩只作用正确后继；背景/邻居不丢失；源 mask mode 保留 | 静态缺口，尚无真实文件验证 |
| blur.saturation≠1 的真实 Sketch | 警告和保真边界 | 必测 | 与原 Sketch 对比饱和度；不静默忽略字段 | 普通路径已有警告；native display 静态缺口 |

最后三项需真实原文件，并为每份固定 SHA、原应用版本、画板/节点、相机、DPR 和参考图。只要缺少真实样本或授权运行环境，就保持“未验证”，不把跳过写成通过。

## 7. 不牺牲功能或精度的后续准则

- 优化先做依赖裁剪、透明/常量证明、生命周期和同像素条带执行，不无条件移除背景 blur / 阴影 / mask，也不降低密度、截半径、改 alpha、替换颜色空间。
- mask chain、saturation 属于语义补齐；须先固定真实输入及反例，再修改共享转换和 native display。不要为追求“能打开”把未知语义无声变成普通矩形或扁平图。
- 对复杂效果保留精确保守路线，不能因为无法走优化分支就改视觉；失败应有可定位的真实错误及资源诊断。
- 每次优化需结构/编辑能力回归、CPU/WASM packet 对比、真实 GPU 原始像素/边界比较三层证据。吞吐、内存峰值、首屏时间与正确性分别报告。
- 本次仅交付审计和已有真实 FIG 的有限只读验证；不包含产品修复，也不承诺所有导入文件正确。
