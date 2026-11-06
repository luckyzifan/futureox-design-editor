# fig2sketch oracle 对照与 Rust 烘焙导出（2026-11-06）

## 来源与安装

- `sketch-hq/fig2sketch`（MIT，15.5k 行 Python）克隆于 `../fixtures/fig-tools-public-20261106/`，`python3.11 -m venv && pip install -e` 后 CLI 可用（venv 未入库）。
- 对照夹具：`fixtures/design/fig-interop-v106.fig`（仓库生成的 v106 语料）与 `figma-materials-native-2026-10-08.fig`（真实 381 节点文件）。

## Oracle 对照结果

| 文件 | fig2sketch（官方 CLI） | 本仓库 fig→sketch 链（默认） | 本仓库 `export_sketch_baked`（本轮新增） |
|---|---|---|---|
| fig-interop-v106.fig | ❌ KeyError `thumbnail.png`（生成语料无缩略图，属夹具差异） | ✅ 4,492 字节，原生 sketchtool 可打开 | ✅ 同字节（0 节点需烘焙） |
| figma-materials-native（381 节点） | ✅ 1,174,543 字节 | ❌ 拒绝：缩放/剪切仿射（`fig-44-11`，rectangle） | ✅ **51,072 字节，18 节点烘焙，原生 sketchtool 打开（4 页 11 画板），再导入 381→385** |

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

## 追加（同日第三轮）：独立描边拓扑规范化——381 节点文件全通

第三类拒绝根因定位：矢量网络编码器 `network()`（vector_geometry.rs）走 **stroke 优先**曲线构建闭合轮廓，却不变量比对 **fill**——任何独立描边拓扑（stroke≠fill，含显式空描边）都会拒绝，与弧线无关（此前推测有误，实测为独立描边）。烘焙模式新增规范化：独立描边几何塌缩到填充轮廓（有损）；「空描边几何 + 活跃描边 paint」保持拒绝，避免画出原本不存在的描边。

结果：`figma-materials-native-2026-10-08.fig --bake` → 18 节点烘焙 → 51,072 字节 → 再导入 381→385 节点/4 页 → 原生 sketchtool 打开成功（4 页 11 画板）。新增单测 `baked_export_collapses_independent_stroke_topology`（默认拒绝、烘焙成功、再导入通过）；sketch+fig 契约 25 目标 **147 项全过**。默认 `export_sketch` 的三类 fail-loud 政策均未改变。

## 追加（同日第四轮）：容器仿射子树传播 + 遮罩无损重映射

`export_sketch_baked` 预处理重写为**自页面根的递归子树传播**（`baked_subtree`，`pending` 前乘祖先未消线性）：

- **剪切自由放置（旋转∘缩放）**：容器保留旋转（`frame_placement` 可表示），盒尺寸按缩放改写，纯缩放 `[S|0]` 传播给子树——`R∘S∘K = R∘(S∘K)`，几何精确；
- **带剪切且无自身盒面填充**：塌缩到映射后的轴对齐包围盒（曲线逐点精确映射），完整线性 `[L|−min]` 传播子树；
- **带剪切且有可见填充/描边**：保持默认拒绝（Sketch 无法无损表达平行四边形盒面）；
- **FIG OUTLINE 遮罩**：与 Sketch outline 遮罩（clippingMaskMode 0）裁剪语义相同；因 Figma 不渲染遮罩层自身样式而 Sketch 会渲染，烘焙模式把遮罩自身填充/描边标记为不可见（数据保留为 disabled）后重映射——两侧渲染一致。luminance 遮罩保持拒绝。默认导出的全部拒绝政策未变。

实测：`fig-0-2388` 容器仿射类拒绝消失；「有料素材」系列（9,063–19,402 节点）语义障碍全部清空，最后卡在**导出归档 16 MiB/条目预算**（页面 JSON 超限）——这是 2026-10-23 记录在案的准入政策（读取/写入镜像、保证产物可重开），翻转或走流式导出需单独决策，未擅自更改。materials 文件输出保持逐字节一致（51,072 字节）；新增容器传播单测（scaleX/Y=2 框含子矩形：框盒翻倍、子件烘焙为 80 宽显式矢量、世界原点不变）；sketch+fig 契约 25 目标 **148 项全过**。

## 追加（同日第五轮）：归档准入按内存预算动态化 + f32 旋转容差修复

按用户决策取消固定归档上限，改为**进程内存预算动态推导**（`sketch/archive.rs`）：条目 = budget/8（钳 4MiB–1GiB）、document.json = budget/4（钳 16MiB–2GiB）、总量 = budget（钳 16MiB–4GiB）、编码输入 = budget（钳 1GiB–4GiB）。zip 炸弹 200:1 压缩比守卫、前端 `IMPORT_INPUT_MAX_BYTES` 1GiB 业务下限、capacity 文档准入（budget/16 序列化预留）全部保留——这些是窗口不是墙，`CORE_DOCUMENT_MEMORY_BYTES` 覆盖一切。

修复途中发现**真 bug**：`frame_placement` 刚体判定用 1e-12 容差（按 f64 精度写），而 FIG 变换是 f32 源（45° 旋转 = 0.70710677，正交误差 ~6e-8）——真实 Figma 文件的旋转被误判为「缩放/剪切」而拒绝。容差放宽到 1e-6（f32 精度窗口，真缩放/剪切远高于此）。另补烘焙递归的 visited 集合：脱离页面树的孤儿节点森林也作为附加根处理（导出器的拒绝循环扫全部节点，而预遍历只走页面树，19k 文件因此漏扫两个 45° 旋转矢量）。

测试重组：预算相关断言从三个文件迁入独立进程的 `tests/sketch_archive_admission.rs`（`capacity::configure(64MiB)` 钉住后验证条目/文档条目/总量拒绝与 import_any 透明报错）——原先在同进程并行用例下 `configure` 与环境变量初始化竞态。被迁走的三个原测试删除预算断言部分（比率守卫用例保留原位）。

实测终验：**四份「有料素材」全部贯通**——9,064 节点×3（1.72MB，1,382 文本，3 页）与 **19,402 节点**（3.44MB，2,638 文本，15 页，2,368 节点烘焙）；19k 产物**原生 sketchtool 打开成功（15 页 78 画板）**；sketch+fig 契约 + 新准入测试 **147 项全过**；默认导出政策未变。
