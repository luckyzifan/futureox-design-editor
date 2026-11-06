# fig2sketch oracle 对照与 Rust 烘焙导出（2026-11-06）

## 来源与安装

- `sketch-hq/fig2sketch`（MIT，15.5k 行 Python）克隆于 `../fixtures/fig-tools-public-20261106/`，`python3.11 -m venv && pip install -e` 后 CLI 可用（venv 未入库）。
- 对照夹具：`fixtures/design/fig-interop-v106.fig`（仓库生成的 v106 语料）与 `figma-materials-native-2026-10-08.fig`（真实 381 节点文件）。

## Oracle 对照结果

| 文件 | fig2sketch（官方 CLI） | 本仓库 fig→sketch 链（默认） | 本仓库 `export_sketch_baked`（本轮新增） |
|---|---|---|---|
| fig-interop-v106.fig | ❌ KeyError `thumbnail.png`（生成语料无缩略图，属夹具差异） | ✅ 4,492 字节，原生 sketchtool 可打开 | ✅ 同字节（0 节点需烘焙） |
| figma-materials-native（381 节点） | ✅ 1,174,543 字节 | ❌ 拒绝：缩放/剪切仿射（`fig-44-11`，rectangle） | ⚠️ 前进两关后仍拒绝：弧线椭圆 `fig-44-9` 的矢量网络发射不变量（Independent fill geometry） |

两者架构同构：都解码 `.fig` 内嵌 kiwi schema（schema 随 Figma 版本漂移，读写不写死版本）。我们的语义验证覆盖到 v106（>106 解码但警告未测试）。

## 本轮 Rust 落地（fig2sketch 语义对齐第一步）

新增 `interop::export_sketch_baked`（选择性烘焙，默认 `export_sketch` 的 fail-loud 政策不变）：

1. **叶子仿射烘焙**（对齐 fig2sketch `apply_transform`）：非刚体放置的叶子把线性变换烘进曲线点，frame 取映射后的单位盒包围盒，平移保留。奇异矩阵仍拒绝。
2. **参数化显式化**：`ellipse`（含弧/环）经 kappa 三次贝塞尔近似（k=4/3·tan(Δ/4)，每 ≤90° 一段）、`star`/`polygon`（像素空间复刻导出器归一化点数学，corner_radius 走 rounded_polygon）、`rect`（圆角一致走 rounded_polygon，混合圆角退化为直角=有损）转为显式矢量几何。
3. demo `sketch_roundtrip_demo --bake` 暴露该模式并报告烘焙计数。

验证：`sketch_format_contract::baked_export_converts_scaled_leaves_the_default_export_refuses`——默认导出对 scaleX=2 的矩形报 Unsupported，烘焙导出成功、再导入宽 80/高 40、世界原点 (10,5) 不变；v106 文件烘焙模式输出与默认逐字节一致（0 烘焙）。sketch+fig 契约 25 个目标 146 项全过。

## 剩余缺口（下一增量）

- `figma-materials-native` 烘焙链最后卡在弧线椭圆（饼/环）的矢量网络发射不变量 `fill != closed`（vector_geometry.rs:283）——需要发射侧接受多环/饼形填充，或烘焙侧拆分为独立闭环。
- 未处理 `.deck`（Slides）与 `fig-makee`（Make）签名（openfig 研究笔记）；无夹具不盲加。
- fig2sketch 的实例 override detach、字体特性等 15.5k 行语义面未逐项对账；本轮只对齐了几何放置与参数化两类最高频拒绝。
