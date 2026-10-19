# 设计器渲染几何与文本迭代计划

更新：2026-10-18。类型：[设计]，含局部[源码]依据。范围：`design-studio`、`frontend/design-client`、共享 Electron 入口及对应测试。编制时所有任务均为待实施；用户随后授权启动实现并增加真实 Electron 验证。实施范围与未完成项见文末批次记录，不能把本计划的全部任务视为已完成。

本计划将 Vello、Lyon、tiny-skia、Parley、cosmic-text、Peniko、Kurbo、resvg，以及本机 Graphite、Penpot 的参考实现映射到可交付任务。先建立外部对照与性能分段基线，修正文本和描边语义，再优化区间查询、补齐 SVG 与文字功能，最后评估新的覆盖率和 compute 路线。

本计划补充[设计器现行契约](design-editor.md)与[内核后续迭代](design-kernel-hard-problems.md)，不替代已经生效的显示、导出或文件格式契约。旧阶段报告中的通过数不作为本计划的验收结果。

## 基线与适用边界

[源码] Core HEAD 为 `7defe35b4ae64ee837bfee84b2e11e94702df543`，工作区已有未提交修改。Graphite 为 `58b8aeb0e249af0c2279fdec3ffc23cdad63180c`，Penpot 为 `b633093336f482b6390728382862e6ea258aca08`。本轮抽样依据、文件 SHA-256 与收尾变化记录见[来源清单](../reviews/design-rendering-iteration-plan-sources-2026-10-18.json)。哈希标识文件，不代表整份文件已完成审计。

已存在、应保护而非重复开发的能力：

| 领域 | 当前源码基线 | 后续工作边界 |
| --- | --- | --- |
| 几何 | 设备空间误差控制、De Casteljau、退化与预算检查、曲线布尔、矢量网络 | 改进细分效率、参数关联、切线与编辑算法 |
| CPU 光栅 | 活跃边、连续边桶存储、矩形快速路径、八纵向采样/四相关采样 | 改进输出组织；不再排“移除每行 Vec 桶” |
| GPU | binary64 区间程序、覆盖率 ALU、相机/程序缓存 | 查询索引与稀疏内部表示，保留既有精度合同 |
| 文本 | UAX #9/#14/#29、Rustybuzz、回退链、可变字体、富文本、轮廓缓存 | 修正组合语义，增加彩色字形和完整编辑能力 |
| 交互 | WebGPU 同设备驻留、串行编码队列、批次让出、相机/内容取消 | 细化状态、优先级与失效；不是重做驻留架构 |
| 产品 | 曲线文字、路径偏移、变宽描边、字体面板已有入口 | 完善精度、可表达语义和跨端闭环 |

本轮排期涵盖新功能设计，不表示已经授权执行实现、发布或部署。Core 服务目录、认证授权、数据库和多人协作服务不在本计划改动范围；这些本地渲染任务不新增服务。新功能优先 Web SDR，涉及共享内核的已有 CPU/原生 GPU/WASM/WebGL2 路径必须做影响范围回归。HDR 仅保护既有行为，不新增 HDR 产品能力。Electron 复用客户端的功能仍须独立真实交互验收。

## 文件简称与修改原则

| 简称 | 项目内目录 |
| --- | --- |
| K | [design-kernel/src](../../design-studio/crates/design-kernel/src) |
| KS | [design-kernel/shaders](../../design-studio/crates/design-kernel/shaders) |
| KT | [design-kernel/tests](../../design-studio/crates/design-kernel/tests) |
| NG | [design-gpu/src](../../design-studio/crates/design-gpu/src) |
| NGT | [design-gpu/tests](../../design-studio/crates/design-gpu/tests) |
| F | [design-client/src](../../frontend/design-client/src) |
| FG | [design-client/src/kernel/gpu](../../frontend/design-client/src/kernel/gpu) |
| FS | [design-client/scripts](../../frontend/design-client/scripts) |
| DS | [design-studio/scripts](../../design-studio/scripts) |

任务卡中的文件默认是现有文件；明确写“拟新增”的才是新文件。测试文件同样区分扩展与拟新增，拟新增路径当前不作为可执行入口。实施时优先小范围提交；文件拆分仅在相应职责需要时进行。不要直接编辑 `F/generated`，WASM 绑定由 `DS/build-web.py` 生成。

字段变动须贯通 Rust/TypeScript 模型、校验、`.fd` 保存重载、撤销重做、复制粘贴、组件覆盖、导入导出和缓存键。当前文档 schema、二进制容器版本与 GPU 命令版本是独立版本；实施前分配下一个可用版本，不预先为多个任务占用同一编号。缺省字段保持历史语义，旧读取端无法表达的新语义必须明确拒绝，不能静默忽略。

## 优先级与迭代顺序

P0：建立门槛或修正核心正确性。P1：高频性能、兼容性及直接可用能力。P2：范围较大的功能完善。P3：研究与有条件试验。

成本表示包含实现和定向验收的初步规模：S 约 2–4 人日，M 约 5–10 人日，L 约 10–20 人日，XL 先做 3–5 人日可行性研究再估算。它们不是承诺工期；字体、参考图、硬件与当前并行改动可能影响实际成本。下表是依赖顺序，不是假定每轮固定两周或已安排人员；实施开始后按 B01/B02 的结果拆成实际冲刺。

| 迭代 | 任务 | 优先级 | 本轮可交付结果 | 启动依赖 |
| --- | --- | --- | --- | --- |
| R0 | B01 对照基线；B02 分段测量 | P0 | 可重放输入、明确能力表、可归因耗时 | 无 |
| R1 | T01 双向换行；T02 光标；G01 斜接上限 | P0 | 文本基础正确性和标准描边属性 | B01 |
| R2 | R01 区间查询；D01 瓦片完成状态；G04 最近点 | P1 | 减少无关计算，编辑与显示可验证 | B01、B02 |
| R3 | C01 画笔语义；S01 SVG 结构；S02 SVG 渐变；T03 字体回退 | P1 | 常用 SVG 与复杂文字可用范围扩大 | B01、T01；S02 依赖 C01 |
| R4 | G02 细分参数；G03 描边切线；T04 曲线文字；D02 依赖缓存 | P1 | 曲线工具与缓存精细化 | B02、G01；G03 依赖 G02；T04 依赖 T01/G04 |
| R5 | T05 彩色字形；T06 竖排；T07 画布文字编辑；S03 SVG 文本 | P2 | 字体功能进入完整用户流程 | T01/T02/T03；S03 依赖 S01/T04 |
| R6 | R02 稀疏区间；R03 CPU 行绘制；S04 基础 SVG 滤镜；G05 曲线偏移 | P2 | 大场景内存优化、效果互操作和曲线输出 | R01/B02；S04 依赖 S01/C01；G05 依赖 G02/G04 |
| R7 | R04 新覆盖率；R05 compute 几何试验 | P3 | 有量化结果的可选路线决策 | 前述基线稳定，B02 证明剩余瓶颈 |

R3 可在 R2 性能试验尚未达到收益门槛时推进；功能任务不必等待整个 GPU 路线完成。同一文件的修改按依赖合并，尤其是 `K/font.rs`、`K/scene.rs`、`F/model.ts` 与 shader 协议。只有实际有人力安排时才拆并行工作。

## 可以借鉴的源码

以下参考编号用于任务卡。固定提交用于复现；未来升级须重新核对，不默认采用上游最新行为。

| 编号 | 源码入口 | 可借鉴内容与边界 |
| --- | --- | --- |
| V1 | Vello [架构](https://github.com/linebender/vello/blob/9cbe466bded9fff6cf7c1dd74246e95fe74f33c0/ARCHITECTURE.md)、[strip.rs](https://github.com/linebender/vello/blob/9cbe466bded9fff6cf7c1dd74246e95fe74f33c0/vello_common/src/strip.rs)、[strip_generator.rs](https://github.com/linebender/vello/blob/9cbe466bded9fff6cf7c1dd74246e95fe74f33c0/vello_common/src/strip_generator.rs) | 借稀疏条带和完整内部区域组织。其 CPU alpha buffer 不满足本项目“GPU 包不含 CPU 覆盖率位图”合同，不能直接替换 |
| V2 | Vello [fine.wgsl](https://github.com/linebender/vello/blob/9cbe466bded9fff6cf7c1dd74246e95fe74f33c0/research/vello_shaders/shader/fine.wgsl)、[flatten.wgsl](https://github.com/linebender/vello/blob/9cbe466bded9fff6cf7c1dd74246e95fe74f33c0/research/vello_shaders/shader/flatten.wgsl)、[binning.wgsl](https://github.com/linebender/vello/blob/9cbe466bded9fff6cf7c1dd74246e95fe74f33c0/research/vello_shaders/shader/binning.wgsl)、[CPU 参考](https://github.com/linebender/vello/tree/9cbe466bded9fff6cf7c1dd74246e95fe74f33c0/research/vello_shaders/src/cpu) | 局部 winding、前缀扫描、工作分配、边覆盖率；不将实验 compute 路线当作直接替换决定 |
| L1 | Lyon [cubic_bezier.rs](https://github.com/nical/lyon/blob/da19a62491dee4d6f228d0623994cb6c11d4a0d9/crates/geom/src/cubic_bezier.rs) | Wang 段数估计、带 t 范围的展平和曲线求交 |
| L2 | Lyon [stroke.rs](https://github.com/nical/lyon/blob/da19a62491dee4d6f228d0623994cb6c11d4a0d9/crates/tessellation/src/stroke.rs) | miter、原始连接点/细分点、变宽信息；输出三角形不自动提供抗锯齿 |
| SK | tiny-skia 0.12.0 [path_aa.rs](https://github.com/linebender/tiny-skia/blob/e48b9027762d33731e60e40eb17eaa4f583b0185/src/scan/path_aa.rs)、[alpha_runs.rs](https://github.com/linebender/tiny-skia/blob/e48b9027762d33731e60e40eb17eaa4f583b0185/src/alpha_runs.rs)、[blitter.rs](https://github.com/linebender/tiny-skia/blob/e48b9027762d33731e60e40eb17eaa4f583b0185/src/blitter.rs) | 行输出、稀疏 alpha、专门绘制路径；不照搬坐标上限或静默退化 |
| P1 | Parley [line_break.rs](https://github.com/linebender/parley/blob/2a963cd2ca6827a8cf1542d4a5b955f9223be174/parley/src/layout/line_break.rs)、[cursor.rs](https://github.com/linebender/parley/blob/2a963cd2ca6827a8cf1542d4a5b955f9223be174/parley/src/editing/cursor.rs)、[测试](https://github.com/linebender/parley/tree/2a963cd2ca6827a8cf1542d4a5b955f9223be174/parley_tests/tests) | 段落与行、cluster、affinity、视觉/逻辑移动；布局比较不能只比 glyph ID |
| CT | cosmic-text [shape.rs](https://github.com/pop-os/cosmic-text/blob/f1a3461f3e8df67d2bbcfafb8bc61dc7aee5b2a6/src/shape.rs)、[fallback](https://github.com/pop-os/cosmic-text/tree/f1a3461f3e8df67d2bbcfafb8bc61dc7aee5b2a6/src/font/fallback)、[swash.rs](https://github.com/pop-os/cosmic-text/blob/f1a3461f3e8df67d2bbcfafb8bc61dc7aee5b2a6/src/swash.rs) | 整形后缺字回退、字体选择、字形输出；生产文件使用固定可追踪字体资源 |
| PK | Peniko [gradient.rs](https://github.com/linebender/peniko/blob/a8ad89c73ff985a58d70e2581d34557b66ba6cf1/peniko/src/gradient.rs)、[image.rs](https://github.com/linebender/peniko/blob/a8ad89c73ff985a58d70e2581d34557b66ba6cf1/peniko/src/image.rs) | 插值空间、alpha 语义、图像类型。Peniko 不是统一几何 tolerance 的来源 |
| KU | Kurbo 0.13.1 [param_curve.rs](https://github.com/linebender/kurbo/blob/838b69ef35f3381cefc007d86aa8364f5a6dc673/kurbo/src/param_curve.rs)、[cubicbez.rs](https://github.com/linebender/kurbo/blob/838b69ef35f3381cefc007d86aa8364f5a6dc673/kurbo/src/cubicbez.rs)、[offset.rs](https://github.com/linebender/kurbo/blob/838b69ef35f3381cefc007d86aa8364f5a6dc673/kurbo/src/offset.rs) | 最近点、弧长/反弧长、偏移，保留本项目误差与资源预算 |
| SVG | [resvg 测试集](https://github.com/linebender/resvg-test-suite/tree/d8e064337faf01bc5a9579187a56dbdbe3eacc72)、resvg/usvg 0.47.0 [源码](https://github.com/linebender/resvg/tree/3a0fdba53ccf2d346b54cc53ba7adf0ee60d0707/crates) | 标准语义参考、固定字体/资源、静态 SVG 图像对照；不能证明可编辑往返 |
| GR | Graphite [render_cache.rs](https://github.com/GraphiteEditor/Graphite/blob/58b8aeb0e249af0c2279fdec3ffc23cdad63180c/node-graph/nodes/gstd/src/render_cache.rs)、[text_context.rs](https://github.com/GraphiteEditor/Graphite/blob/58b8aeb0e249af0c2279fdec3ffc23cdad63180c/node-graph/nodes/text/src/text_context.rs)、[几何算法](https://github.com/GraphiteEditor/Graphite/tree/58b8aeb0e249af0c2279fdec3ffc23cdad63180c/node-graph/libraries/vector-types/src/vector/algorithms) | 类型/库接线、缓存依赖、曲线编辑。无需复制整个程序化节点执行系统 |
| PP | Penpot [tiles.rs](https://github.com/penpot/penpot/blob/b633093336f482b6390728382862e6ea258aca08/render-wasm/src/tiles.rs)、[render.rs](https://github.com/penpot/penpot/blob/b633093336f482b6390728382862e6ea258aca08/render-wasm/src/render.rs)、[text.rs](https://github.com/penpot/penpot/blob/b633093336f482b6390728382862e6ea258aca08/render-wasm/src/shapes/text.rs)、[SVG 导出](https://github.com/penpot/penpot/tree/b633093336f482b6390728382862e6ea258aca08/render-wasm/src/render/svg) | 可见优先、旧新范围失效、文本容器变化、效果导出；不复制依赖 Skia 的接口或无界帧策略 |
| GL | Vello [glifo](https://github.com/linebender/vello/tree/9cbe466bded9fff6cf7c1dd74246e95fe74f33c0/glifo/src) | 字形资源、COLR 和 atlas 的职责分离；atlas 作为可选优化，先完成正确输出 |

直接复制实现时记录具体文件、提交、许可与改动；第三方参考先作为开发/测试依赖，不自动进入生产 WASM。Penpot 主仓为 MPL-2.0，复用代码须单独记录边界；字体、图片和测试资源按各自许可处理。不得把父目录或旧 Futureox 路径写成项目依赖。

## R0 建立可重放的判断依据

### B01 外部对照语料与功能能力表

**P0 / M / 类型：测试基础 / 依赖：无。** [源码] 已有内部多后端像素检查和 SVG 导入脚本；本任务补外部语义对照，不重复建立一套同名成功统计。

- 修改：`FS/check-io-import.ts`、`FS/check-gpu-parity.ts`、`DS/compare-figma.py` 的适用入口；扩展 `KT/text.rs`、`KT/text_features.rs`、`KT/stroke_normalization.rs`、`NGT/area.rs`、`F/export-native.test.ts`。仅确需接口时改现有脚本，避免把不同判定标准塞入同一零差门禁。
- 拟新增：`testing/fixtures/design/reference/manifest.json`、`DS/check-reference-corpus.py`、`FS/check-svg-reference.ts`、`KT/text_reference.rs`。样例实际存入 `testing/fixtures/design/reference/`，清单记录上游相对路径、提交、SHA、许可、字体 face/axis、预期结果和所属任务。
- 借鉴：SVG、P1、CT、L1/L2。先锁定 resvg/usvg 0.47.0 及上表版本；仅使用固定本地资源生成参考，正式检查不依赖联网。
- 测试：`BASE-01` 同一输入在原生 CPU、WASM CPU、原生 GPU、WebGPU、WebGL2 的声明支持路径运行；`BASE-02` SVG 原图→resvg 与导入→内核；`BASE-03` 内核→SVG→resvg；`BASE-04` 导入后修改、撤销、保存重载；`BASE-05` 缺字体、外链资源、明确不支持语义的报告。
- 验收：首批至少 60 个独立输入：SVG 24、文本 16、几何/描边 12、覆盖率 8；每个计数有清单条目，变换组合单列。状态必须区分通过、失败、不支持、跳过和未执行。已声明支持的失败全部有归属，不用删除 fixture 提高通过率。内部同合同零差、跨引擎容差与标准语义检查分开报告。
- 交付：固定语料、能力表、可重放命令和差异页面；测试命名不能把未知实现直接标成通过。

### B02 几何编译与 GPU 工作的分段测量

**P0 / M / 类型：性能证据 / 依赖：B01 的性能样例清单。**

- 修改：`K/render_telemetry.rs`、`K/gpu.rs`、`K/area_program.rs`、`NG/device.rs`、`NG/tile_cache.rs`、`F/kernel/render-profile.ts`、`F/kernel/render-worker.ts`、`FG/webgpu.ts`；扩展现有 `design-kernel/benches/raster.rs` 和 `FS/profile-tile-compile.ts`。
- 拟新增：`design-kernel/benches/geometry_prepare.rs`、`FS/benchmark-render-stages.ts`；注册 bench 时同步 `design-kernel/Cargo.toml`。先确认既有 `examples/profile_render_preparation.rs` 是否覆盖需要，避免重复探针。
- 借鉴：V1/V2、GR/PP 的阶段和缓存职责。
- 测试：`PERF-01` 100/1000/10000 字形；`PERF-02` 同行 1/16/128/512 区间；`PERF-03` 大面积低边界路径；`PERF-04` 细碎/自交路径；`PERF-05` 1k/10k 节点平移、变色、改字、缩放；`PERF-06` 背景模糊/蒙版跨瓦片；`PERF-07` GPU 无 timestamp-query 时标为不可用。
- 验收：记录展平段数、边访问数、区间数、程序字节、上传字节、CPU 编译/编码、GPU 时间、等待、缓存命中、表面与缓存峰值；GPU 等待不与包含它的 graph 时间重复相加。冷启动、首次倍率和热缓存分开。输出硬件/驱动、浏览器、DPR、尺寸、剖面、源码与 WASM 哈希。
- 交付：选定真实热点和目标样例。没有定位到热点的底层优化不进入默认路径。

## R1 修正文本与标准描边语义

### T01 段落级双向上下文与安全换行

**P0 / L / 类型：正确性 / 依赖：B01。** [源码] `Fonts::shape` 创建 `BidiInfo`，`layout_raw` 换行后再次以行片段调用整形；潜在方向变化须由最小反例确认。

- 修改：[K/font.rs](../../design-studio/crates/design-kernel/src/font.rs) 的 `shape/layout_raw`、`Glyph/TextLine`，`K/layout.rs` 的文本尺寸/起始锚点；接口变化影响 `F/kernel/picking.ts`。可拟新增 `K/text_layout.rs` 承载段落上下文，避免复制两套实现。
- 借鉴：P1 的段落/行数据和 CT 的 bidi 重排。整形计划保留段落基级、原始 byte/UTF-16 映射、script 与 cluster；断行后按原段落层级重排，边界需要重整形时保留上下文并重新核验宽度。
- 测试：拟新增 `KT/text_bidi.rs`、`KT/text_linebreak.rs`；扩展 `KT/text_hug_anchor.rs`、`KT/text_indent.rs`。`TXT-01` 拉丁＋希伯来文＋数字/括号；`TXT-02` 阿拉伯文强制窄行与连接变化；`TXT-03` 跨行 isolate/嵌入控制；`TXT-04` 行首标点及尾随空白；`TXT-05` CRLF、空段、软换行；`TXT-06` NBSP、ZWSP、组合字符和连字边界。
- 验收：复现用例先证明旧行为问题；逻辑文本与 UTF-16 映射不变，行方向遵循完整段落，零字素拆分。除显式不可断的超宽 cluster 外，重整形后行宽不得突破约定宽度。已有 Hug、缩进、大小写映射和纯 LTR 样例无非预期变化。参考引擎差异要解释字体、语言、feature 与断行策略，不能只要求 glyph ID 相同。

### T02 方向感知的光标与选区 API

**P0 / M / 类型：正确性及后续编辑基础 / 依赖：T01。** [源码] 当前 `caret_at` 在视觉 glyph 列表按 `cluster_end > offset` 查找，`Caret` 未表达 affinity；浏览器输入目前主要由 textarea 承担，不能把内核接口修复直接算作完整编辑器交付。

- 修改：[K/font.rs](../../design-studio/crates/design-kernel/src/font.rs) 的 `caret_at/hit_caret`、`K/lib.rs` WASM 导出、`F/kernel/picking.ts` 适配；拟新增 `K/text_cursor.rs`。仅在 T07 接入完整画布编辑，不在本任务偷偷切换 textarea。
- 借鉴：P1 `Cursor` 的 logical/visual cluster 和 upstream/downstream affinity；PP 的位置与 affinity 表达。
- 测试：拟新增 `KT/text_cursor.rs`、`F/text-cursor.test.ts`。`CUR-01` RTL 视觉 cluster 为 2/1/0；`CUR-02` 双向边界同一 offset 的双位置；`CUR-03` wrap 末尾/下一行起始；`CUR-04` 连字、代理对、组合字符、ZWJ；`CUR-05` 左右键视觉移动与逻辑删除；`CUR-06` 选区跨行生成多个矩形。
- 验收：所有合法位置 hit→caret→hit 返回同一规范化位置与 affinity；明确允许的吸附规则写入 API。RTL 两端不互换；结果不落入代理对/字素内部；参数非法时返回错误。旧 offset-only 接口有明确缺省 affinity，兼容层不隐式丢掉新接口的信息。

### G01 可编辑斜接上限和 SVG 描边闭环

**P0 / M / 类型：缺失功能与互操作 / 依赖：B01。** [源码] 当前斜接比较使用固定 `r * 4`，模型没有 `miterLimit`，SVG 继承表没有该属性。

- 修改：[K/scene.rs](../../design-studio/crates/design-kernel/src/scene.rs) 的 `Stroke`、`K/stroke.rs`、`K/stroke/profile.rs`、`K/resident_strokes.rs`、`K/geometry_snapshot.rs`、`K/bounds.rs`、`K/dirty_region.rs`、`K/gpu.rs` 的支持范围；`F/model.ts`、`F/Inspector.tsx`、`F/svg-presentation.ts`、`F/import-svg.ts`、`F/Renderer.tsx`、`F/export.tsx`。检查 `K/interop.rs` 与 `K/fig.rs` 可映射字段及不能映射时的报告。
- 借鉴：L2 的 miter limit 与 join；SVG 的锐角描边样例。
- 测试：拟新增 `KT/stroke_miter_limit.rs`、`F/stroke-miter-limit.test.tsx`；扩展 `KT/stroke_normalization.rs`、`F/export-native.test.ts`。`MIT-01` limit=1/2/4/10/100；`MIT-02` 临界角两侧；`MIT-03` 变宽描边和闭合接缝；`MIT-04` 负数、NaN/Infinity 和资源上限；`MIT-05` 继承/inline 属性；`MIT-06` 调整→撤销→保存→重载→SVG。
- 验收：缺省 4 保持历史输出；新值在 CPU/GPU/导出含义一致。边界、命中、效果支持范围和缓存键随 miter 上限更新，不能只改轮廓而仍按固定 4 裁剪。非法输入不能留下部分更新。UI 仅在 miter join 时启用字段，但切换 join 不丢失已保存值。

## R2 降低重复计算并明确显示完成

### R01 GPU 扫描线区间查询索引

**P1 / M / 类型：性能 / 依赖：B01、B02。** [源码] `sampleCoverage/areaCoverage` 逐像素遍历整条子行的区间；画面瓦片裁剪不消除瓦片内部这一层遍历。

- 修改：[K/area_program.rs](../../design-studio/crates/design-kernel/src/area_program.rs)、`K/gpu.rs`、[KS/area.wgsl](../../design-studio/crates/design-kernel/shaders/area.wgsl)、`FG/area.glsl`、`FG/area-shader.ts`、`FG/types.ts`；同步 `NG/device.rs` 与 WebGPU/WebGL2 包校验。格式有变化才升级相应 GPU 命令版本。
- 借鉴：V1 的局部化表示，V2 的 binning。先实现排序区间的跳过/提前退出，再比较分块索引与二分入口；保留端点 bits、区间顺序和现有浮点相加顺序。索引只减少不相交项，不改采样位置。
- 测试：扩展 `NGT/area.rs`、`KT/gpu_tile_culling.rs`，拟新增 `KT/area_index.rs`、`F/kernel/gpu/area-index.test.ts`。`IDX-01` 1/16/128/512 区间；`IDX-02` 负坐标与整数边缘两侧；`IDX-03` 空行/孔洞/同端点；`IDX-04` 巨大外轮廓包围视口；`IDX-05` 四采样逐 sample 与八子行；`IDX-06` 截断、越界索引和版本不匹配。
- 验收：同合同五后端结果零新增差异；边界附近不得漏段或重复累计。目标场景区间读取/比较次数至少下降 50%，GPU 阶段中位目标下降 20%；基线简单场景不显著退化。达不到时间收益时保留数据和结论，不仅凭指令数启用默认路径。索引占用计入现有预算。

### D01 可见优先和分层完成状态

**P1 / M / 类型：交互完善 / 依赖：B02。** [源码] 已有队列、驻留显示、取消、批次让出和预取控制；本任务补完整状态与调度策略的统一定义。

- 修改：`F/kernel/render-work-queue.ts`、`F/kernel/render-worker.ts`、`F/kernel/render-mailbox.ts`、`F/kernel/render-profile.ts`、`F/kernel/pan-prefetch.ts`、`F/kernel/ResidentCompositeSurface.tsx`、`FG/resident-presenter.ts`。按需要修改 `K/tile_level.rs` 和 `K/tiled_renderer.rs` 的状态输出。
- 借鉴：PP `PendingTiles` 的可见/外围、缓存/未缓存划分。定义 `hasPresentedContent`、`visibleTargetQualityReady`、`prefetchReady` 的等价内部状态；绑定文档 revision、相机、小数相位、DPR、显示剖面及设备 generation。
- 测试：扩展 `F/kernel/render-work-queue.test.ts`、`F/kernel/render-mailbox.test.ts`、`F/kernel/pan-prefetch.test.ts`、`F/kernel/resident-presentation.test.ts`；拟新增 `FS/check-render-readiness.ts`。`RDY-01` 外围很慢但可见已完成；`RDY-02` 拖动抢占；`RDY-03` 连续相机更新；`RDY-04` 同时内容变化；`RDY-05` 设备丢失；`RDY-06` 最后一块提交失败；`RDY-07` 页面关闭后任务/纹理回收。
- 验收：GPU 提交或显示确认失败不能标清晰；外围任务不延迟可见完成信号；过期内容不覆盖新 revision；相机取消不破坏已完成且仍可复用的同文档瓦片。保持一个编码器所有者，交互与补画不能交叉写同一帧。无旧画面时允许真实加载态，有旧画面时不产生全帧空白。持续输入必须有可见进展，不能永远取消未完成帧。

### G04 全局最近点和矢量网络查询

**P1 / M / 类型：几何正确性与编辑性能 / 依赖：B01、B02。** [源码] 当前最近点采用 65 个参数采样加局部三分搜索；距离函数可能多峰，算法未给出全局误差保证。

- 修改：[K/vector_tools.rs](../../design-studio/crates/design-kernel/src/vector_tools.rs) 的 `nearest/controls/apply`、`K/scene.rs` 的网络索引；按实际调用修改 `F/kernel/picking.ts`。拟新增 `K/curve_query.rs`，让最近点/弧长查询共享参数信息，但不和曲线布尔求交职责混合。
- 借鉴：KU 最近点与曲线细分；GR 的连接索引。采用全局候选求解或带包围盒下界的分支限界，建立一次性顶点 ID 索引；空间索引仅在 B02 表明有收益后加入。
- 测试：拟新增 `KT/curve_nearest.rs`，扩展 `KT/offset_path.rs`、`FS/benchmark-picking.ts`。`NEAR-01` 环、尖点、多局部极小值；`NEAR-02` 起终点重合及全部退化；`NEAR-03` 端点恰为最近点；`NEAR-04` 负缩放/非均匀缩放/大平移；`NEAR-05` 等距时稳定选择；`NEAR-06` 1k/10k 边和非法拓扑。
- 验收：对独立高精度参考，选中距离误差不超过 0.05 设备像素；报告最近距离而非只比 t（等距可有多个 t）。端点作为显式候选，不能因三分区间漏掉。编辑操作引用的边 ID 稳定；预算耗尽明确报错或返回声明的近似状态。性能回归保留选中结果一致性断言。

## R3 扩大常用文件与文字的可用范围

### C01 编译画笔类型和渐变语义

**P1 / M / 类型：语义基础 / 依赖：B01。** [源码] 已有色彩管理；`Paint` 的字符串和 `Stop { offset, color }` 尚不能显式表达全部渐变策略。

- 修改：[K/paint.rs](../../design-studio/crates/design-kernel/src/paint.rs)、`K/color.rs`、`K/scene.rs`、`K/gpu.rs`、`KS/vector.wgsl`、`F/model.ts`、`FG/types.ts`、`FG/vector.glsl`。拟新增 `K/paint_ir.rs`，先把已存在的解码结果汇入类型化编译画笔，不无条件重写序列化格式。
- 借鉴：PK 的颜色/alpha/插值空间、image alpha 类型；GR 的 peniko 适配层组织。定义已解析颜色、采样空间、alpha 插值方式、extend 和图像 alpha 语义；保留现有缺省行为，新的作者字段由 S02 分配 schema。
- 测试：扩展 `KT/color.rs`、`KT/authoring.rs`、`F/model-image-adjust.test.ts`，拟新增 `KT/paint_semantics.rs`。`COL-01` 透明红→不透明蓝；`COL-02` alpha=0 的隐藏 RGB；`COL-03` 重复/逆序色标；`COL-04` 缺省与显式值一致；`COL-05` 同画笔切换文档空间；`COL-06` 旧文档保存重载及缓存失效。
- 验收：类型化重构对已有字段的渲染结果零变化；透明度只应用一次，无双重预乘。解析和验证在编译边界完成，不在每像素重新解析。对新插值规则记录标准来源与精度约定；本任务不新增 HDR 功能。

### S01 SVG 嵌套视口与基础样式语义

**P1 / L / 类型：缺失功能 / 依赖：B01。** [源码] 根 viewBox 已支持；嵌套 svg 与 style 元素当前被拒绝，局部 use、mask、clip 只有有限子集。

- 修改：[F/import-svg.ts](../../frontend/design-client/src/import-svg.ts)、`F/import-svg-viewport.ts`、`F/svg-presentation.ts`、`F/model.ts`、`F/export.tsx`。拟新增 `F/svg-resolve.ts`：解析、资源引用、继承和单位归一化与生成 DesignNode 分离。
- 借鉴：SVG/usvg 的预处理职责，PP 的 SVG 语义分层。第一批支持嵌套 viewport、百分比相对本级视口、symbol/use 的 width/height/viewBox、绝对单位、element/class/id 与 descendant 的受限 CSS、!important/继承/currentColor；选择器和属性支持表必须列清。
- 测试：扩展 `F/import-svg-viewport.test.ts`、`F/svg-presentation.test.mjs`、`FS/check-io-import.ts`；拟新增 `F/import-svg-structure.test.ts`。`SVG-STR-01` 两级不同 viewBox 与 meet/slice/none；`SVG-STR-02` 百分比基准；`SVG-STR-03` symbol/use 多实例与引用环；`SVG-STR-04` CSS 优先级和 opacity 组级合成；`SVG-STR-05` mask region/content units；`SVG-STR-06` 同时 mask+clip 的嵌套表达；`SVG-STR-07` 外部资源/脚本保持拒绝。
- 验收：支持子集按外部参考通过，节点层级和编辑变换可往返；不支持的选择器、单位或 mask 语义明确报告，不静默按默认值导入。循环、层级和节点预算有效，失败不提交部分文档。第一批不承诺完整 CSS 或动态 SVG。

### S02 色标透明度 重复镜像和偏心径向渐变

**P1 / L / 类型：缺失功能 / 依赖：C01、B01；结构引用依赖 S01。**

- 修改：`K/scene.rs`、`K/paint.rs`、`K/gpu.rs`、`KS/vector.wgsl`、`F/model.ts`、`F/ColorPanel.tsx`、`F/Inspector.tsx`、`F/import-svg.ts`、`F/Renderer.tsx`、`F/export.tsx`、`FG/vector.glsl`。按需要更新 `K/pdf_export.rs` 的能力检测，不把不支持的新画笔导成普通径向渐变。
- 借鉴：PK 的 gradient/extend/alpha，SVG 的透明色标和焦点样例。
- 测试：拟新增 `KT/gradient_semantics.rs`、`F/import-svg-gradient.test.ts`；扩展 `KT/color.rs`、`F/export-native.test.ts`。`GRAD-01` stop-opacity 与整体 fill-opacity 相乘；`GRAD-02` repeat/reflect 负参数及周期边界；`GRAD-03` 焦点居中/内部/边界/外部；`GRAD-04` objectBoundingBox 非等比对象与 gradientTransform；`GRAD-05` 多级 href 继承和循环；`GRAD-06` 同位置色标/透明端点；`GRAD-07` UI→撤销→保存→SVG。
- 验收：缺省画笔保持原输出；支持 pad/repeat/reflect 与独立色标 alpha；焦点与半径退化按明确规则处理。新增字段进入模型、shader、缓存身份和导出能力表；所有支持后端按同合同输出。各新特性独立开通，未通过的特性仍明确拒绝，不一次性宣称完整 SVG 渐变。

### T03 Script 与整形后字体回退

**P1 / L / 类型：正确性和缺失能力 / 依赖：T01、B01。** [源码] 当前回退以字素的 cmap 覆盖为主；合并片段后猜测 script，缺少明确语言输入。

- 修改：`K/font.rs` 的整形分段/回退、`K/font_glyph_cache.rs`、`K/text_path_cache.rs`、`K/scene.rs`、`F/model.ts`、`F/TextStylePanel.tsx`；必要时修改 `design-desktop-backend/src/fonts.rs` 的资源选择。拟新增 `K/text_fallback.rs`，保留字体身份和失败原因。
- 借鉴：CT 整形后缺字检测与回退、P1 的 cluster/script 组织、GR 的字体资源与布局上下文。
- 测试：拟新增 `KT/text_fallback.rs`、`KT/text_scripts.rs`；扩展 `KT/text_face_reuse.rs`、`F/TextStylePanel.test.tsx`。`FONT-01` 同一字体覆盖拉丁/天城文而 script 不同；`FONT-02` 阿拉伯连接与组合符；`FONT-03` VS15/VS16、ZWJ 和字体部分覆盖；`FONT-04` locale 改变字形选择；`FONT-05` 缺 primary、缺全部 fallback；`FONT-06` face index/variation 改变；`FONT-07` 两文档字体同名不同字节。
- 验收：依据整形结果确认可用字形，回退粒度不拆损字素或必要的整形上下文。最大候选次数有界；无可用字形时显示可追踪缺字结果，不能空白成功。字体 hash、face、axis、language、feature 等影响结果的输入进入缓存。固定资源在两端可复现；系统字体仅用于选择资源，不能让另一设备重新随机匹配。是否采用 Parley/字体库实现由本卡差异和包体测量决定。

## R4 完善曲线信息与派生缓存

### G02 带参数信息的展平和误差策略

**P1 / M / 类型：几何与性能 / 依赖：B02、B01。**

- 修改：[K/path.rs](../../design-studio/crates/design-kernel/src/path.rs)、`K/geometry_snapshot.rs`、`K/resident_strokes.rs`；拟新增 `K/geometry_accuracy.rs`。保留 `flatten_cubic` 的设备空间、退化与预算行为，新增参数范围/原始端点标记的内部结果类型。
- 借鉴：L1 Wang 估计与 `for_each_flattened_with_t`，KU 的几何精度参数。分开设备距离、局部距离、角度和弧长容差；比较递归、Wang 及必要的极值分段，不预设赢家。
- 测试：拟新增 `KT/curve_flattening.rs` 和 `design-kernel/benches/flattening.rs`。`FLAT-01` 点、直线、共线越界；`FLAT-02` S 形、环、尖点；`FLAT-03` 镜像、剪切、非等比缩放；`FLAT-04` 大坐标小差值；`FLAT-05` t 范围覆盖且单调、终点恰为 1；`FLAT-06` clip guard 内 winding；`FLAT-07` 最大预算附近。
- 验收：达到声明设备误差，验证使用独立高精度/有界参考，不仅检查采样点。报告段数、耗时、峰值分配；新展平可能改变采样边界，只有通过既有零差门槛才能替换兼容路线，否则保留旧路线、将候选用于独立质量策略。资源超限必须显式返回，不能强行截断段数。

### G03 宽描边的切线和连接连续性

**P1 / L / 类型：质量完善 / 依赖：G01、G02。**

- 修改：`K/stroke.rs`、`K/stroke/profile.rs`、`K/stroke/markers.rs`、`K/resident_strokes.rs`、`K/geometry_snapshot.rs`；边界估计受影响时同步 `K/bounds.rs` 和 `K/dirty_region.rs`。
- 借鉴：L2 区分作者端点/细分点，V2 的曲线描边思路，KU 的 stroke/offset。细分中间点按连续曲线处理，作者端点保留 join；将半线宽放大的切线误差纳入细分判定。
- 测试：扩展 `KT/stroke_profile.rs`、`KT/stroke_markers.rs`、`KT/stroke_normalization.rs`，拟新增 `KT/stroke_tangent.rs`。`STK-01` 1/16/128 单位宽曲线；`STK-02` cusp、回折、近共线；`STK-03` dash 正负 offset/零长度片段；`STK-04` 变宽极值与闭合接缝；`STK-05` 非均匀变换；`STK-06` marker 与 cap 重叠。
- 验收：新质量策略描边外轮廓误差目标 ≤0.125 设备像素，接缝无裂缝/凸起；透明描边重叠不得重复混色。已有兼容合同按 G02 的替换规则执行。编辑命中、选择框、脏区和导出使用同一描边几何，不出现视觉扩展但裁剪范围没扩展的情况。

### T04 曲线文字弧长 切线与溢出策略

**P1 / L / 类型：已有功能完善 / 依赖：T01、G04；可复用 G02 参数结果。** [源码] `Baseline` 以局部 0.0001 展平后累计弧长，`pose` 采用折线切线并将距离 clamp 到端点。

- 修改：[K/text_path.rs](../../design-studio/crates/design-kernel/src/text_path.rs)、`K/font.rs`、`K/text_path_cache.rs`、`K/scene.rs`、`F/model.ts`、`F/Inspector.tsx`、`F/kernel/picking.ts`。拟新增 `K/curve_arclength.rs`，与 G04 共享曲线查询基础。
- 借鉴：KU `arclen/inv_arclen` 与导数，GR 的曲线工具组织；Vello 不承担沿路径布局语义。
- 测试：拟新增 `KT/text_path_layout.rs`、`F/text-path.test.ts`。`TP-01` 直线/圆弧已知长度；`TP-02` S 形与连续段切线；`TP-03` 反向、负 offset、normal offset；`TP-04` 太短路径/超长文本；`TP-05` 闭合路径首尾；`TP-06` 尖点与零导数；`TP-07` 修改基线、撤销、缩放与保存。
- 验收：字形保持刚体轮廓；平滑基线位置误差目标 ≤0.05 设备像素、角度误差 ≤0.1°，尖点采用单独定义的切线规则。新增 clip/继续沿端点切线/闭合环绕的显式溢出策略，逐项验收后开放；不能把所有溢出字形堆叠在末端当成成功。旧文档缺省行为通过迁移策略明确保留或升级，不能静默改变存量设计。命中与导出复用同一 pose。

### D02 按依赖分离布局 几何 覆盖率和绘制缓存

**P1 / L / 类型：性能与失效正确性 / 依赖：B02；涉及文本的部分依赖 T01/T03。**

- 修改：`K/derived_invalidation.rs`、`K/dirty_region.rs`、`K/gpu.rs`、`K/geometry_snapshot.rs`、`K/font_glyph_cache.rs`、`K/text_path_cache.rs`、`K/resident_strokes.rs`、`K/scene_delta.rs`；`FG/resident-programs.ts`、`FG/scene-delta.ts`、`F/kernel/preparation-snapshot.ts`。
- 借鉴：GR 的上下文/内容缓存职责、PP 的文本容器变化和 old∪new∪indexed 范围。建立输入依赖表，不创建一个含所有字段的万能 key；扩展现有 lineage 与不可变数据共享。
- 测试：拟新增 `KT/derived_dependency_matrix.rs`，扩展 `KT/text_face_reuse.rs`、`F/kernel/gpu/scene-delta.test.ts`、`F/kernel/preparation-snapshot.test.ts`。`CACHE-01` 仅变色；`CACHE-02` 平移/旋转/缩放；`CACHE-03` 宽度重排、字体/axis/feature 更新；`CACHE-04` 编辑 mask/背景依赖；`CACHE-05` 组件覆盖与共享变量；`CACHE-06` 强制哈希碰撞；`CACHE-07` 多文档切换与设备重建；`CACHE-08` 100 轮编辑/撤销后的预算。
- 验收：缓存命中输出与冷启动重算逐样例一致；仅变色不重做轮廓，平移不重排文本，宽度/字体变化必须失效。范围必须覆盖旧新位置和背景读取输出。只用哈希时需有完整身份/碰撞处理，不凭单一短哈希断言相等；引用保活、LRU 和工作表面预算不相互漏算。收益用真实工作次数和时间共同证明。

## R5 补齐用户可操作的文字能力

### T05 彩色字形和 emoji 输出

**P2 / XL / 类型：缺失功能 / 依赖：T03、C01。** [源码] 当前字形主要走 `outline_glyph`，不能据此宣称已支持全部彩色字体。

- 修改：`K/font.rs`、`K/font_glyph_cache.rs`、`K/renderer.rs`、`K/gpu.rs`、`K/scene.rs`、`K/pdf_export.rs`；`F/model.ts`、`F/TextStylePanel.tsx`、`F/export.tsx`、GPU 资源管理入口。拟新增 `K/color_glyph.rs` 与版本化 glyph paint 输出类型。
- 借鉴：GL 的 COLR/字形资源职责、CT swash、GR 的字体与绘制接口。先完成 COLR v0/CPAL 与一种实际样本需要的位图格式；COLR v1 独立子阶段，SVG-in-OpenType 保持明确未支持直到完成资源/引用处理。
- 测试：拟新增 `KT/color_glyph.rs`、`FS/check-color-glyphs.ts`。`EMO-01` emoji ZWJ/肤色/旗帜；`EMO-02` VS15/VS16；`EMO-03` palette 与 alpha；`EMO-04` 位图 strike 缩放；`EMO-05` 资源缺失/预算耗尽；`EMO-06` PNG/SVG/PDF 能力报告；`EMO-07` 更换字体后的缓存回收。
- 验收：资源格式能力表逐项通过，缺字和不支持格式可见且可诊断，不生成空轮廓假成功。普通单色字体结果不变；彩色 glyph 的 advance/cluster 与整形结果一致。导出可采用明确声明的局部图像，但不能标为纯矢量。字体、palette、variation 和 strike 等相关输入进入缓存键；atlas 优化在正确性之后进行。

### T06 竖排字形替代与列布局

**P2 / L / 类型：已有功能完善 / 依赖：T01、T03；光标接线依赖 T02。** [源码] 已有 CJK 堆叠与非 CJK 旋转，不能重复排“新增 writingMode”。

- 修改：`K/font.rs`、`K/layout.rs`、`K/scene.rs`、`F/model.ts`、`F/TextStylePanel.tsx`、`F/TextEditor.tsx`；拟新增 `K/text_vertical.rs`，保持水平路径共享资源。
- 借鉴：P1/CT 的 cluster/字体处理、PP 的文本容器与编辑坐标；竖排具体语义另核对固定 Unicode Vertical_Orientation 数据和字体 vert/vrt2、垂直度量，不能假定参考库已完整实现。
- 测试：扩展 `KT/text_features.rs`，拟新增 `KT/text_vertical.rs`、`FS/check-vertical-text.ts`。`VERT-01` 中日括号/句读/长音符；`VERT-02` 拉丁/数字混排和连续旋转 run；`VERT-03` 有/无垂直度量字体；`VERT-04` 竖排替代与 variation；`VERT-05` 列高换列、左右列流向；`VERT-06` 点击、选区、删除、复制及导出。
- 验收：orientation 分类、vert/vrt2 和垂直 advance 有固定测试；列位置和光标共用坐标模型。旧 `vertical` 保留兼容映射，新增流向字段有明确缺省。字体缺垂直度量时使用规定的可复现规则。只验收第一批声明的日中竖排语义，不扩大成全部东亚排版/拼音注音支持。

### T07 内核布局一致的画布文字编辑

**P2 / XL / 类型：产品功能完善 / 依赖：T01、T02、T03；竖排编辑依赖 T06。** [源码] 当前画布输入使用 textarea；内核测量与浏览器编辑显示可能采用不同布局。

- 修改：[F/TextEditor.tsx](../../frontend/design-client/src/TextEditor.tsx)、`F/text.ts`、`F/kernel/picking.ts`、`F/pending-edits.ts`、`F/engine.ts`、`K/lib.rs`；拟新增 `F/text-edit-session.ts`、`F/TextSelectionOverlay.tsx`。保留浏览器输入/IME和可访问文本语义，由内核提供显示字形、光标和选区几何。
- 借鉴：P1 的视觉/逻辑导航，PP 的 position/affinity。先完成单文本框编辑，后做跨样式工具；不能只隐藏 textarea 然后丢失屏幕阅读器、键盘和候选框定位。
- 测试：拟新增 `F/text-edit-session.test.ts`、`FS/check-text-editing.ts`；扩展 `FS/check-pending-input.ts` 和 Electron 真实画布交互脚本。`EDIT-01` 中文/日文 IME composition；`EDIT-02` RTL 混排选区和方向键；`EDIT-03` 富文本粘贴/样式范围；`EDIT-04` 撤销、Esc、失焦提交；`EDIT-05` 外部修改冲突；`EDIT-06` 旋转/缩放/竖排下候选框定位；`EDIT-07` 键盘与可访问性；`EDIT-08` Web 与 Electron。
- 验收：输入时显示和提交后轮廓位置一致，光标沿内核布局移动；composition 中不拆字素或提前提交。取消恢复原文，冲突保留输入并显示原因；一次确认对应明确撤销单元。移动文本框无需重新整形，改变宽度需重排。任何浏览器原生输入回退均清楚区分，未验证平台不能记为已支持。

### S03 可编辑 SVG 文本与 textPath

**P2 / L / 类型：缺失功能 / 依赖：S01、T01、T03、T04；新渐变文本依赖 S02。**

- 修改：`F/import-svg.ts`、`F/svg-presentation.ts`、`F/model.ts`、`F/export.tsx`、`F/Renderer.tsx`、`K/font.rs`、`K/text_path.rs`；拟新增 `F/svg-text.ts`。支持普通文本、连续 tspan 样式、text-anchor、baseline、受限 dx/dy、textPath/startOffset；逐字符绝对定位等不能映射的语义单独报告。
- 借鉴：SVG/usvg 的文字处理与字体样例，P1/CT 的运行结果；仅将 usvg 转出的轮廓导入不能算“可编辑文本”。
- 测试：拟新增 `F/import-svg-text.test.ts`，扩展 `F/export-native.test.ts`、`KT/text_reference.rs`。`SVG-TXT-01` 多样式 tspan；`SVG-TXT-02` start/middle/end 与 RTL；`SVG-TXT-03` baseline/dx/dy 支持子集；`SVG-TXT-04` textPath 百分比 offset 与反向；`SVG-TXT-05` 空白规则；`SVG-TXT-06` 缺字体匹配与重加载；`SVG-TXT-07` 修改文字后导出与再次导入。
- 验收：文本内容、样式范围与路径绑定保留；视觉与语义往返分别通过。提供清晰的轮廓保真导出和可编辑文字导出能力说明，后者声明字体依赖。复杂定位无法无损表达时拒绝或显式转轮廓，不能静默退成普通单行文本；SVG 重载后仍可修改文字才计可编辑通过。

## R6 大场景资源与效果互操作

### R02 稀疏内部区域与区间程序压缩

**P2 / L / 类型：性能 / 依赖：R01、B02，且传输/程序内存已被证实为热点。**

- 修改：`K/area_program.rs`、`K/gpu.rs`、`KS/area.wgsl`、`KS/coverage64.wgsl`、`FG/area.glsl`、`FG/coverage64.glsl`、`FG/types.ts`、`NG/device.rs`、`FG/webgpu.ts`、`FG/webgl.ts`。
- 借鉴：V1 的 full-fill/边界条带；保留本项目 GPU 计算覆盖率。先压缩空行、重复行和完整内部块，再评估能被证明精确表示的常见端点编码；特殊端点保留当前 binary64 编码。
- 测试：拟新增 `KT/area_sparse.rs`，扩展 `NGT/area.rs`、`NGT/coverage64.rs`。`SPARSE-01` 大包围路径/孔洞；`SPARSE-02` 跨小块的细线和负 epsilon；`SPARSE-03` 高密度文字边界；`SPARSE-04` 形状在视口外但 winding 非零；`SPARSE-05` 编码/解码逐位和损坏数据；`SPARSE-06` 预算上限/取消/设备丢失。
- 验收：既有剖面零新增差异，GPU 包仍不含 CPU 覆盖率位图。目标大内部区域场景程序字节至少下降 40%，编译＋上传＋GPU 总阶段中位目标下降 20%；边界密集场景不显著退化。所有存储、索引和解码临时内存计入预算；不得靠提高预算、降低密度或提前归一化浮点尾数达标。

### R03 CPU 行区间直接绘制

**P2 / L / 类型：性能与内存 / 依赖：B02，CPU mask 分配/扫描已为热点。**

- 修改：[K/raster.rs](../../design-studio/crates/design-kernel/src/raster.rs)、`K/renderer.rs`、`K/paint.rs`、`K/blend.rs`、`K/memory.rs`、`K/raster_surface.rs`；拟新增 `K/span_blitter.rs`。矩形、纯色和适合的渐变优先；需要邻域的滤镜和复杂 mask 保留密集路径。
- 借鉴：SK AlphaRuns/Blitter 的职责；保留本项目 f32/线性颜色与四相关采样，而非统一量化成 tiny-skia 的 u8。
- 测试：拟新增 `KT/span_blitter.rs`，扩展 `design-kernel/benches/raster.rs`、`KT/tiled_renderer.rs`、`KT/color.rs`。`SPAN-01` 大范围稀疏路径；`SPAN-02` 纯色/渐变透明合成；`SPAN-03` clip/mask 组合；`SPAN-04` 需要滤镜时选择密集路径；`SPAN-05` 四 sample 合成后 resolve；`SPAN-06` 工作预算和中途错误。
- 验收：同合同 CPU 输出逐位/逐字节一致，复杂样例不误用直接绘制。目标场景 mask 临时峰值下降至少 50%，总帧时间不显著退化；局部路径收益不能被描述为整个文档内存减半。保持交点计算顺序，不使用未经证明的逐行 x 累加替换。

### S04 SVG 基础滤镜的可编辑导入与矢量导出

**P2 / L / 类型：缺失互操作能力 / 依赖：S01、C01、B01。** [源码] 内核已有 blur/shadow 等效果，SVG 导入拒绝 filter，导出对效果报告限制；本任务打通可等价表达的子集。

- 修改：`F/import-svg.ts`、`F/export.tsx`、`F/Renderer.tsx`、`F/model.ts`、`K/effects.rs`、`K/scene.rs`、`K/dirty_region.rs`；拟新增 `F/svg-filter.ts`。若标准 Gaussian 与现有兼容效果不同，保留独立语义，不凭经验倍数映射。
- 借鉴：SVG 的 filter units/region/primitive 样例，PP 的 `render/svg` 组织。第一批仅接纳能证明等价的 `feGaussianBlur`、`feOffset`、单色 flood/composite/merge 形成的阴影链及对应导出；一般滤镜 DAG 另列后续。
- 测试：拟新增 `F/import-svg-filter.test.ts`、`FS/check-svg-filters.ts`，扩展导出与 dirty-region 测试。`FLT-01` x/y 不同 stdDeviation；`FLT-02` objectBoundingBox/userSpaceOnUse；`FLT-03` 显式 filter region 裁切；`FLT-04` SourceAlpha 与 SourceGraphic；`FLT-05` 组透明度与内部重叠；`FLT-06` 非支持输入/环/超预算；`FLT-07` 跨瓦片阴影；`FLT-08` 修改效果后 SVG 往返。
- 验收：每种开放链都有外部视觉参考与参数编辑闭环，滤镜范围和颜色插值被准确处理。不能等价的链明确拒绝或走已标识的视觉导出；不把整页 PNG 包装当作矢量滤镜完成。现有 Figma 效果剖面不改变，保存重载不丢 filter 语义。

### G05 保留曲线的偏移与拓扑来源

**P2 / XL / 类型：已有功能完善 / 依赖：G02、G04、B01。** [源码] `Node::paths` 已有 `path_offset`，当前以展平、描边扩展和布尔构造结果；本任务改进输出曲线与来源关联。

- 修改：`K/scene.rs` 的 `Node::paths`、`K/curve_boolean.rs`、`K/vector_tools.rs`、`K/bounds.rs`、`F/model.ts`、`F/Inspector.tsx`；拟新增 `K/curve_offset.rs`。来源映射需要新增版本化数据时，明确区分原始网络、派生结果与“展开为路径”结果。
- 借鉴：GR `offset_bezpath.rs`、KU `offset.rs`、L1 曲线求交；现有 flo_curves 保留完整 Boolean 拓扑职责，不能用求交点函数替换全部布尔语义。
- 测试：扩展 `KT/offset_path.rs`、`KT/authoring.rs`，拟新增 `KT/curve_offset.rs`、`KT/topology_provenance.rs`。`OFF-01` 正负偏移/圆角/斜接；`OFF-02` 凹形自交和细颈消失；`OFF-03` cusp/重合段/切触；`OFF-04` 开路径、孔洞、反向轮廓；`OFF-05` 编辑原始控制点后的重算；`OFF-06` 切割后选择 ID/撤销；`OFF-07` 结果预算超限。
- 验收：偏移曲线误差按声明精度有界；不可能维持原拓扑时显式记录合并/分裂关系，不能伪造一对一 ID。作者几何可恢复，“展开为路径”才提交派生几何；保存重载与导出一致。过多拟合段明确报错，不能跳过困难段后返回部分路径。是否默认采用新算法由稳定性和性能决定。

## R7 有条件的渲染研究

### R04 新面积覆盖率质量策略

**P3 / XL / 类型：可选质量能力 / 依赖：B01、B02、G02。** [源码] 当前一般路径 analytic 路线为八纵向采样加横向积分，矩形单独精确；不将其描述为所有路径的连续二维精确积分。

- 修改候选：`K/raster.rs`、`K/coverage.rs`、`K/fidelity.rs`、`K/area_program.rs`、`K/gpu.rs`、`KS/area.wgsl`、`FG/area.glsl`、`F/model.ts`、`F/RenderProfilePanel.tsx`。拟新增 `K/area_coverage.rs`；算法进入实验命名空间，默认配置不变。
- 借鉴：V2 fine coverage 和 V1 边界累计；SK 只作为额外对照，不是精确面积 oracle。比较边面积累计、提高采样和自适应策略，分别量化误差/速度/内存。
- 测试：拟新增 `KT/area_quality.rs`、`DS/check-area-quality.py`。`AA-01` 0.01–1px 斜线/薄三角形；`AA-02` 锐角和旋转细节；`AA-03` 小字号与分数移动；`AA-04` evenodd/nonzero、自交/重叠/孔洞；`AA-05` 不透明相邻图形与半透明重叠；`AA-06` 瓦片边界；`AA-07` 极端变换和设备差异。
- 验收：简单几何采用闭式或独立高精度积分参考，复杂样例采用收敛验证并标记参考误差；不能只把多采样图当成真值。建议质量目标为受控样例 coverage 绝对误差 ≤1/255，并消除已登记漏采反例；B01 冻结最终逐类阈值。不得覆盖现有兼容/导出剖面或放宽其零差标准。自交和 fill rule 未通过则不开放给通用文档。

### R05 Compute 几何准备可行性试验

**P3 / XL / 类型：研究决策 / 依赖：B02 证明 CPU 几何准备仍占主要成本，R01/R02 已评估。**

- 候选修改：`K/gpu.rs`、`NG/device.rs`、`FG/webgpu.ts`；拟新增 `KS/compute_geometry.wgsl`、`NG/geometry_prepare.rs`、`NGT/compute_geometry.rs`。第一阶段保持生产默认编译器不变，以开发开关/独立 benchmark 接入。
- 借鉴：V2 flatten/binning/path_count/tile_alloc 和 CPU reference。分开评估 GPU binning、prefix allocation、展平；先选一个已定位热点。WESL/模块化 shader 组织可一并研究，避免继续依赖函数名字符串切片拼装，但不为此先重写全部着色器。
- 测试：`CMP-01` 动态大量路径；`CMP-02` 少量图形/小字号；`CMP-03` 分配溢出与重试上限；`CMP-04` dispatch 取消和设备丢失；`CMP-05` winding/clip/超大坐标；`CMP-06` Metal 与至少另一 GPU/驱动族；`CMP-07` 无 compute 的 WebGL2/CPU 保持可用。
- 验收：研究完成标准为可复现结果及采用/保留/放弃决定，不要求必然采用。默认接入另需同合同正确性、预算/取消、至少两类硬件与目标端到端收益。若 f32 GPU 几何不能维持 binary64 兼容合同，只能作为明确的新策略，不能冒充等价加速。不得引入无幂等的无限重试或在溢出时吞掉路径。

## 跨任务验收标准

### 正确性分层

| 门槛 | 适用任务 | 必须满足 |
| --- | --- | --- |
| A 纯优化等价 | R01/R02/R03、D01/D02、C01 的内部重构 | 同输入、字体、相机、剖面和输出域；RGBA8 逐字节、声明支持的浮点路径按既有原始位合同比较；零新增差异 |
| B 已确认行为修复 | T01/T02/G04 等 | 先保留失败反例与正确语义依据；只允许登记的预期变化，不能拿旧错误图锁死修复，也不能顺手更新无关 golden |
| C 新功能兼容 | G01/S01/S02/T03/T04/T05/T06/T07/S03/S04/G05 | 字段缺省时旧文档不变；新值在 UI、模型、保存重载、撤销、缓存、渲染、导出形成闭环；不支持后端明确报告 |
| D 跨引擎视觉 | resvg/Parley/cosmic-text/tiny-skia 对照 | 先统一字体/颜色/变换/feature；语义与几何单独断言，抗锯齿采用逐类冻结门槛；不把跨引擎有差异等同于本内核必错 |
| E 新质量或后端 | G02/G03 的非等价候选、R04/R05 | 独立策略和质量门槛；已有剖面不漂移；参考误差、硬件限制、失败输入完整保留 |

跨引擎图像比较使用约定色彩空间的预乘 RGBA，透明像素的无意义 RGB 不作为几何错误；同时单独检查 alpha、边界位置、内部色彩和整体能量。B01 先冻结语义类别及阈值；对于需要设计阈值的实验，记录数值与理由，不能在看到失败后自动放宽。

字体测试固定字体字节、face index、axis、OpenType features、locale 和 Unicode 数据版本。若参考布局不同，先判断差异来自引擎策略还是实现缺陷；Unicode conformance、明确作者语义和已确认产品合同优先于“与某库相同”。

### 性能测量与采用门槛

所有性能数值在本计划中均为[设计]目标，不是当前已达到结果。

- 固定同一设备、电源模式、驱动、浏览器、编译模式、DPR、视口、文档与字体。基线/候选交替运行，至少 5 轮；热态每轮预热 20 次、采样 100 次。冷态另起进程/设备/缓存并单列至少 5 次，成本较高的场景如需减少样本必须显式标记。
- 输出每轮中位、p95、最大值和原始样本；不把少量样本最大值称为长期生产 p99。GPU timestamp 不可用时，保留不可用状态；CPU wall time 不冒充 GPU 时间或 input-to-photon。
- 对默认启用的性能优化，目标场景阶段耗时中位提升目标 20%，总流程不倒退；非目标场景的 p95 回退预算 5%。若自然波动超过预算，则延长测量并暂不下结论，不直接判成功。
- 简单交互以内容更新 p95 ≤33.3ms 为第一阶段目标；16.7ms 是后续 60Hz 目标，GPU 提交时间/rAF 次数不能证明真正上屏帧率。复杂效果、冷倍率和完整精细画面分别报告，不混入一个 FPS 数。
- 不通过减少 DPI/DPR、调整字体/场景、关闭效果、提高内存预算或更改采样合同获得“同等质量提速”。已存在的 transient 显示策略单列测量，不能代表精确导出路径。
- 至少记录工作表面、几何程序、缓存、显示纹理、上传/读回的峰值和累计量；100 轮操作后的有界缓存允许保留，但对象、任务及待回收资源不得随循环线性增长。

### 测试矩阵与命令入口

这是后续实施时的入口，本次未执行。只运行任务影响范围；修复和新增功能必须包含相关真实业务断言。需要数据库/服务时使用 UUID 隔离实例和独占端口；本计划的大多数内核测试不需要服务或数据库。

| 层级 | 内容 | 说明 |
| --- | --- | --- |
| Rust 单元/集成 | 对应 KT、内部模块测试、错误预算、schema | 算法 oracle 应独立，不能仅把实现复制到测试 |
| TypeScript | 模型、面板、队列、导入导出、缓存 | `bun run test` 调用 Vitest；不以纯 DOM mount 证明功能 |
| WASM | 重建后实际加载、字体、布局、保存/渲染 | 哈希绑定当前 Rust 源码，防止旧 WASM 通过新 TS 测试 |
| GPU | 原生 GPU、WebGPU、WebGL2 真实读回 | shader 编译或命令包一致不等于实际像素通过 |
| 浏览器 E2E | 输入/拖动/导入/编辑/导出/重开 | 单独核验 revision、相机和真正显示完成 |
| Electron | 共享 UI 的真实桌面输入与文件流程 | 浏览器通过不能代替 Electron；包验证仅在发包任务中执行 |
| 性能 | B02 场景分组与 A/B | 同质量合同；诊断探针关闭后的时延另测 |

内核任务可以从仓库根目录运行以下现有入口，新增 test target 创建后再加入对应命令：

```bash
cargo test --offline --locked --manifest-path design-studio/Cargo.toml \
  -p futureox-design-kernel --test text --test text_features --test stroke_normalization
cargo test --offline --locked --manifest-path design-studio/Cargo.toml \
  -p futureox-design-gpu --features hardware-tests --test area --test coverage64
```

第二条需要真实 GPU；未加 feature 的 ignored 结果不能算通过。依赖未缓存时先在获准的实现环境准备依赖与锁文件，离线失败应如实报告。

前端现有入口在 `frontend/design-client` 下执行：

```bash
bun run typecheck
bun run test -- src/import-svg-viewport.test.ts src/export-native.test.ts
bun run build:kernel
bun run test:io-import
bun run test:pending-input
bun run test:render-alignment
```

纯 Node/Bun 的 `.test.mjs` 按现有专用脚本执行，不把所有测试混交 Vitest。创建新浏览器脚本时遵循现有独占端口/临时目录与 finally 回收约定。实际实现提交前执行 `python3 scripts/check-foundation.py` 及相关前端检查；该脚本会调用 Cargo，本次仅计划文档变更不运行它。

### 新功能完成定义

每个新增字段或功能都须提供一个真实用户流程：创建或导入 → 在面板/画布修改 → 渲染可见 → 撤销/重做 → 保存 `.fd` → 重开 → 导出 → 外部查看。涉及复制、组件实例、共享样式或字体资源的任务增加相应链路。部分后端暂不支持时，能力提示必须在用户操作前可见；不能在保存后才发现字段被丢弃。

验收记录包含任务 ID、测试 ID、状态、输入/字体/输出哈希、源码与生成物哈希、设备/版本、命令退出码、原始差异与性能样本。失败、跳过、不支持和未执行都保留，任何“完成”只覆盖清单中实际断言。

## 暂不进入主排期的扩展

| 方向 | 原因与重新进入条件 |
| --- | --- |
| 整体替换为 Vello 或 Skia | 现有精度/材质/导出合同较多；R05 先证明局部收益与兼容边界 |
| 通用 Graphite 式节点编辑系统 | 属于独立产品能力；G05 先完成曲线派生与可恢复作者数据，不扩成节点执行平台 |
| 完整 SVG CSS、任意 filter DAG、动态 SVG | S01/S04 只开放明确子集；有实际用户文件与测试再扩展 |
| 自动断词词典、复杂注音/数学排版、全套 OpenType 彩色格式 | T01/T03/T05/T06 先完成共同数据模型和高频格式；按语料频率排序 |
| 字形 SDF/MSDF 与所有文字 bitmap atlas 化 | 会影响缩放质量和既有覆盖率合同；先测轮廓、整形与区间成本，再决定用途 |
| 新 HDR UI、云端协作或新增服务 | 不属于本轮渲染/几何与文字功能排期，保持现有边界 |

## 文档维护与启动清单

本次文档交付只包含本计划、来源哈希清单和文档入口链接。文档/链接校验结果记录在来源清单中；产品测试和性能数据均为未运行，不引用历史通过数填充。

启动 R0 时先刷新来源清单中变化的代码、确认工作树归属、锁定语料与参考版本；只实施 B01/B02。R1 开始前将每个文本风险收敛成具体反例，并给 G01 分配 schema/缓存/导出的关联变更。每轮结束只更新完成任务的契约和证据，未完成任务继续保持待实施；不因代码入口已经存在就关闭用户流程验收。

### 首批实现范围（2026-10-18）

[源码] 按后续授权优先处理 Electron 接通与测量。`allowsResidentSdr` 将精确算术和呈现方式分开；Electron 可使用与 raster worker 相同的 GPUDevice，保留 `desktopFullMath`、原采样和效果计算。非相关采样的 RGBA32F 驻留工作池按现有视口预算计算，不再因关闭显示用近似算术而被强制留在 256 MiB；动态策略原有 1 GiB 上限保持，显示纹理、几何缓冲及交互缓存仍另计。

[源码] 正常密度的复杂捕获遇到工作表面上限时，以相同计算相机和世界像素网格分块，完整组完成后才替换旧姿态；失败或取消释放未呈现的组。全视口精确编译沿用区域捕获已有的 32 MB 聚合程序额度（8,000,000 个 f32），单路径及扫描工作上限保持。世界坐标捕获的效果 halo、姿态范围判断显式使用输出矩形。带 HQ resolve 的请求继续普通精确绘制，不把不同坐标域的交互窗口直接用于裁剪。

[源码] `DS/benchmark-wasm-variants.mjs` 提供固定文档、字体、产物哈希和五轮交替 CPU 编译测量。Web 与 Electron 共用编译后的验证页面，桌面入口为 `frontend/design-desktop/scripts/build-render-checks.mjs`，只在显式隔离测试模式提供 fixture 和结果通道，不开放普通产品 IPC 权限。GPU 计数区分普通光栅读回、位图传递、驻留捕获；主动取色、QA 截图与计时读取不计入普通光栅传输。

[范围] B01 已补光学表示对照与真实复杂文档的跨端入口，但尚未完成“24 SVG＋16 文本＋12 几何＋8 覆盖率”的完整外部语料集。B02 已补 WASM 对照和参数上传/呈现链路证据，完整 GPU 时间与各规模语料仍须逐项补齐。D01 的原子呈现、取消和资源回收得到针对性扩展，三层完成状态的全部矩阵尚未关闭。R1–R7 的其余模型、Unicode、SVG 与新几何任务保持待实施。

[决策] SIMD、wasm-opt 和相关采样玻璃稀疏参数场均作为可选实验；没有足够稳定的端到端收益就不默认开启。PNG 并行与完整 Engine 池尚未接入：它们不在当前画布热路径，需独立证明导出拼接、请求隔离及并发内存上限。完整 Figma 等价仍是未达成目标，内部零差不能替代外部 Figma 参考比较。

本批实测与未解决项见[跨端渲染验证记录](../../testing/review/design-rendering-runtime-2026-10-18.json)。其中 WebGL2 光学实验保留一次未稳定复现的差分；不能仅引用重跑成功而删除该失败。
