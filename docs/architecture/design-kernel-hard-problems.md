# 设计内核后续迭代与验收

## 2026-10-19 精确计算提交检查点

[源码／已验证，局部] 固定长度整数进位链替换采样与系数证书中的动态局部循环；有理 tent 系数容量扩展至 2048，较多 taps 同步收紧证书的指数跨度，保持 signed128 上界。系数包可保留 Q64，现有 Q48 计算由整数右移 16 位精确恢复，不改用近似浮点系数。独立 Fraction 语料对应 Rust 3 项证书测试，以及 WebGPU/WebGL2 各 251 项实际 GPU 检查均通过。

[提交检查点／未完成] 私有候选的宽整数前缀、GPU 失败像素压缩、分段 resolve 和裁剪滤镜仍为未应用试验补丁；3200% 未通过时延验收。当前工作不宣称全部倍率实时、完整 Figma 等价或全页面回归完成。验证范围与后续事项见[检查点记录](../../testing/review/design-coldzoom-checkpoint-2026-10-19.json)。

## 2026-10-19 所有权、序列化和缓存命中成本

[源码] Engine 的 authored/derived document 改为内部 `Arc` 共享快照，修改时分离；外部 Document/JSON 模型不变。worker 不再深拷贝整份节点表。GPU 编译借用 Prepared，program cache 用节点 ID 借用查询和数值子键，命中前不再分配 ID。已准备叶节点的保守完整边界用于提前剔除，避免再次读取路径与计算同一边界。

[源码] 编辑/撤销预算使用精确计数 writer，纯平移只计算始终序列化的 transform 字段字节差。SceneDelta 在静态文档 revision、完整请求、文本量化与 mip 配置均相同时，直接生成与原编码逐字节一致的空增量；编辑、相机变化、reset、失败、超大请求及动画继续走正常编译。缓存不以近似哈希代替完整身份或版本校验。

[源码] 字体轮廓与文本路径缓存改为 `RwLock`：热命中只查询 HashMap、更新原子访问标记并共享 Arc，不再独占锁内删除/插入 BTreeMap。淘汰改为有界 second-chance，保留各 16 MiB 及 4096/2048 条目的限制；路径身份仍使用完整输入和字体 lineage。独占写锁再次检查重复构建，读者持有的 Arc 不因淘汰失效。它改变缓存驻留顺序，不改变几何与渲染算法。

[设计取舍] 不按 `clone` 次数批量改类型：异步任务和撤销快照需要稳定所有权，借用不能跨越失效的作者状态。ID 热命中使用 `&str` 查询即可避免分配，无需改变外部 String/schema；共享文档第一次修改仍会分离，基准单列 fork 后编辑，避免只计廉价 fork。动态分发、smallvec、Cow 和显式 SIMD 没有本轮同场景的收益证据，暂不全局引入；尤其不以浮点近似或降低预览质量换取吞吐。

[已验证] 初始检查点 `6d179e45b` 已推送；最终同机交错测量中，10k 节点原生 worker 创建由 26.572 ms 降至 0.295 ms，热编译由 8.705 ms 降至 4.331 ms，packet 由 8.743 ms 降至 4.921 ms。8 worker 的 8 万次字体路径热命中由 156.509 ms 降至 30.536 ms。固定输入的 packet 与 CPU 像素哈希一致。这些是 CPU 热路径数据，不是页面 FPS。

[已验证] 与校验过 743 份运行时源码的冻结包相比，WASM 10k 节点 fork 由 19.653 ms 降至 0.296 ms；fork 后立即编辑并编译仅由 47.988 ms 降至 46.145 ms，说明首次修改的整图分离仍有成本。相同静态请求的空增量由 11.306 ms 降至约 0.0013 ms，只有版本、相机和配置完全相同时适用。原始样本、产物哈希、失败尝试和范围见[本轮验收记录](../../testing/review/design-optimization-2026-10-19.json)。

[源码／测试修正] 基线 `gpu_interaction_program_budget` 的 600×600 预期已过时，冻结旧源码也会失败。现分别验证 514×514 的小瓦片预算、600×600 全视口预算及 exact/interactive 几何一致性，没有放宽运行时预算。旧页面脚本中的 CPU localStorage 选择与 `.kernel-reference` 等待不再代表现行 WebGPU 产品路径，相关脚本改为真实呈现合同并保留 shader 相对目录。

[已验证] Rust 三个相关 crate 的 129 个测试目标累计 1205 通过；默认忽略项另行执行：26 项真实 GPU 测试、2 项本机专项通过。GPU 语料包含 265 场景 × 两个剖面。冻结/当前 WASM 的 75 项 CPU 像素比较一致。前端 1377 通过、1 跳过；页面证据及桌面实际窗口检查分别记录，不把跳过和导航次数计作通过。

[实测限制] 752 节点 Web 四轮画布截图哈希一致，但冷缩放约 1.0–1.6 秒，未证明整页普遍加速。Electron 保留既有完整精度策略，复杂文档冷缩放仍约 9–24 秒，适配选区约 329% 时新旧包都触发 GPU 工作表面预算限制；本轮没有提高预算或降质来隐藏它。缓存微基准收益不解决此完整精度渲染瓶颈，不能据此宣称全 Figma 功能、全部倍率或任意输入等价。

[已修复] 本轮还修复两项既有像素问题：缩小预览的直通 alpha 使用 half-up 舍入；WebGPU scalar coverage 标记移到空闲 uniform 251，避免覆盖渐变变换的 b 系数。作者场景 CPU/WebGPU/WebGL 现在零差异，门槛由旧 2/255 收紧至 0；这两项是对旧错误输出的修复，不声称旧 GPU 每个像素都保持不变。

更新：2026-10-10。类型：[现行实现] / [设计]；范围：`design-studio`、`frontend/design-client` 及其测试。

## 2026-10-10 撤回预览降质

[源码] 按用户要求撤回预览专用的硬件近似算术、双线性采样替换、浮点近似滤波与渐变替换；预览重新使用既有确定性着色器、精确几何参数字段和有理卷积。保留瓦片缓存、取消机制、双缓冲换帧及 GPU 完成后再回收纹理。

[源码] 不再把文档采样配置强制替换成 `figmaSubpixel`，不再生成低清概览/中间层或等待后再提高密度；按当前缩放与设备像素密度直接请求精确结果。整帧路径也取消按耗时/预算降密度的重试，资源超限明确报错。等待时可保留上一已完成画面，尚未完成的视口不标为清晰。

[本机局部已验证] 53 个材质输入 × WebGPU/WebGL2，共 106 项实际 GPU 预览与参考对比通过，保留输入的 analytic/figma 配置；RGBA8 每字节、HDR 浮点原始位均零差。前一轮允许字节误差的预览试验已撤回，其性能数据不能当作本版结果。详细证据见[精确预览恢复记录](../../testing/review/design-desktop-macos-gui-2026-10-10/exact-preview/README.md)。历史全量五端/Figma 外部 PNG 门禁仍只代表其冻结产物，本轮没有重新运行全量门禁。

## 2026-10-09 代码质量审查修复

[源码] 变量宽高使用共享几何缩放语义，保持矢量网络、布尔操作数及组件尺寸一致；文字变量/组件文字属性使用字素边界安全的富文本范围重建。极端效果在整数转换与 padding 求和前检查预算，调试构建返回错误而不是整数溢出。转描边轮廓按来源保留透明度、混合、效果坐标和原始效果形状，填充/描边不跨越无关兄弟节点重排；导入 SVG 的 H/V/Z 标准化使用正确参数顺序并回归闭合/竖线语义。

[验证边界] 最终测试、当前源码和实际 WASM/产物哈希见[本轮质量修复台账](../../testing/review/core-quality-repair-2026-10-09.json)。轮廓验证区分指定矩形全图一致与曲线/效果内部区域验证，不声明所有轮廓抗锯齿边界都逐像素相同。旧阶段数据保留为对应源码的历史证据。大文档全量同步解析的性能风险未因这些正确性修复而自动消除。

## 2026-10-09 局部修复：组件变量覆盖与共享样式默认值

[源码] 组件展开在合并属性值、内部实例覆盖与外部限定路径覆盖后，对变化的
`bindings` / `styleRefs` 重新解析对应图层。原先只在展开前解析主组件，可能得到
“绑定已切换为 B、宽度仍为 A”的不一致结果。优先级保持为：显式字段与组件属性值
高于变量绑定，变量绑定高于共享样式；复合字段（如 `fills`）的显式覆盖保护整个字段。
嵌套实例使用最终选中的主组件解析引用，保留既有内外覆盖合并规则，不在展开后对
整个文档无条件二次解析，避免冲掉显式宽度、文字与画笔覆盖。

[源码] 展开前只解析主组件等原始图层与实例放置点的绑定可见性，不解析待重建的
派生实例图层及放置点缓存的几何/画笔字段。否则 `fills: []` 这类合法显式覆盖虽能
屏蔽 `fills.0.opacity`，保存后的下一次解析仍会在旧缓存的缺失数组项上失败。
该边界用于 `components::changes` 和 renderer；独立 `design_system::resolve` API 的
全节点变量解析用途保持不变。

[源码] 共享样式 JSON 先按既有 Paint / TextStyle / Effect 类型补齐默认值，随后解析
变量路径；因此省略可选 `opacity` / `weight` 的合法样式仍可绑定这些属性。
未扩大变量可绑定字段、别名深度、组件预算或 schema 范围；缺失引用、类型错配与
别名循环仍然拒绝。

[已验证，局部] 新增六项组件回归，修复前四项失败、两项保护性用例通过；共享样式
可选默认值与派生图层覆盖后重载回归各自修复前失败。修复后组件 20 项与 authoring
8 项共 28 项通过，
覆盖主/子图层、嵌套覆盖、活动模式与别名、样式后绑定、显式字段/组件属性值优先级、
重复解析、错误拒绝，以及原生 CPU 像素与 GPU 场景包宽度。加上 animation、editing、
image_cache、text_hug_limits，定向回归 50 项通过。最终源码在 Linux x86_64 / Rust 1.96.0
下完整 kernel **430 项通过**，零失败、零 ignored，doctest 为零项；全 target Clippy
（`-D warnings`）、定向 rustfmt 与 diff whitespace 检查通过。运行前后五份内核源码/
测试文件 SHA-256 不变。以上通过数不与旧 v8/v9 的 kernel/server 组合分母或前端
五执行端场景分母混用。

[已验证，真实 WASM] 最终 Rust 源码使用固定 Rust 1.96.0 / wasm-bindgen 0.2.128
重新构建，Node 24 加载实际生成的 WASM、初始化并加载打包字体，六组定向烟测通过。
其中新增的空画笔覆盖两遍解析/重载检查在前一 WASM 上复现缺失绑定路径错误，
新产物覆盖子图层/实例根、继承/替换绑定、GPU 场景编译与 CPU 渲染均通过。
该检查不是 Vitest、浏览器交互验收或设备 GPU 执行。

复现入口为 [`tests/components.rs`](../../design-studio/crates/design-kernel/tests/components.rs)
和 [`tests/authoring.rs`](../../design-studio/crates/design-kernel/tests/authoring.rs)：

```bash
cargo test --offline --locked --manifest-path design-studio/Cargo.toml \
  -p futureox-design-kernel --test components --test authoring
cargo test --offline --locked --manifest-path design-studio/Cargo.toml \
  -p futureox-design-kernel
cargo clippy --offline --locked --manifest-path design-studio/Cargo.toml \
  -p futureox-design-kernel --all-targets -- -D warnings
```

[验收边界] 本节的 GPU 断言检查共享编译器输出，不等于真实 GPU 执行或新的 Figma
对照。旧 v8/v9 五端门禁与外部参考图仍是原快照，未在本次局部修复中重新验收；
服务部署、保存 API 与多人协同也不由这些内核测试证明。

## 2026-10-09 迭代：系数普查、文字内部语料与编辑延迟基线

[系数普查，量化而非豁免] g32/c32 逼近的 1 ULP 系数差异首次完成输出级普查：对台账记录的反例四边形与系统生成的非方形/original512 留出四边形（两种附件边、两种方向、两组渐变、四次 ±1 ULP 扰动）共 15,827,808 次求值，161 个像素的最终 UNORM8 字节翻转（约 1/98k），每次翻转不超过一个量化步；反例四边形本身 3 个翻转像素。这证明该差异类在抖动边界上**原则上可外部观察**，不是"低于量化"；72 张真实 Figma 样本未出现该类翻转，属于已量化残余风险。普查由 `texture_replay::coefficient_holdout_tests` 逐数钉住（含 0x3b8897e7 模型位复现测试），任何系数模型变更必须重新推导。记录见[系数普查台账](../../testing/review/design-kernel-exact-2026-10-08/texture-coefficient-census-2026-10-09.json)。回退路径裁切差异与真实非方形/original512 纹理的外部留出同受 Figma 参照依赖，归入下述文字对照的参照流程一并解决。

[文字内部语料，五端零差] 共享语料从 258 场景扩展到 **265**：新增 7 个文字场景（拉丁基本、分数定位、多字号含 30.5 分数字号、中英混排、多行 1.4 行高、正负字距、分段样式 run 含分段字号与颜色触发富文本 span 展开）。全部使用既有默认字体 NotoSansSC（五端同字节加载），7 场景 × 三剖面 × 五执行端（原生 CPU/Metal、WASM CPU、WebGPU、WebGL2）逐字节零差，实测通过独立原生渲染与两次浏览器子集运行交叉验证。文字真实 Figma 外部对照的建场景脚本与 cases.json 已就绪：[text-2026-10-09](../../frontend/design-client/public/fidelity/text-2026-10-09/create-in-figma.js)（Noto Sans SC 云字体，导出 PNG 1x 后由 compare-figma.py 逐字节对比）；导出步骤待执行，在此之前不宣称外部文字保真。

[编辑延迟基线与回归门禁] 新增 `benches/editing_frame.rs` 与 `tests/editing_latency.rs`：单节点补丁 + 整帧重渲的交互延迟首次有基线和门禁。release 实测（本机）：200 节点 @1280×800 中位 15.7ms/P99 16.3ms（接近 16ms 目标）；500 节点 @1920×1080 中位 36.5ms/P99 49.6ms；1500 节点 @1920×1080 中位 42.6ms/P99 54.3ms。结论：小画布接近但未满足16ms目标，1080p 中大画布约为目标 3 倍，整帧重渲是主导成本；按基准先行原则未做缓冲池类的微优化，脏区域/分块缓存是下一步架构方向。debug 门禁（300 节点 @800×500，P99 ≤ 700ms）已进入 kernel 测试。数值与边界见[延迟台账](../../testing/review/design-kernel-exact-2026-10-08/editing-latency-2026-10-09.json)。

[2026-10-10 云端 CPU 补验] 上段数字、运行硬件与台账仍为 2026-10-09 历史证据。新云端 Linux x86_64 / AMD EPYC、Rust 1.96 release 的 editing+full-render sampled P99 为 33.76/69.19/70.71 ms，分别对应 200/500/1500 节点、1280×800/1920×1080/1920×1080 与 37/37/17 个样本，均未满足 16ms 目标；完整场景、native CPU 像素回归与独立 raster 数据见[恢复后限定验证记录](../reviews/recovery-validation-2026-10-10.md)。当前 benchmark 的 percentile 按 `round(q × (n − 1))` 取排序样本，在 n=37 或 17、q=0.99 时均选中样本最大值，不是生产长期 P99 保证。700ms 灾难性退化门禁通过不表示 16ms 达标。本云端批次没有 GPU 执行，本文既有 Metal/WebGPU/WebGL2 和多端结果仅保留为各原始快照，未由本次 CPU 运行重新验证。


[本轮完整门禁 v9] [v9 完整门禁](../../testing/review/design-kernel-exact-2026-10-08/internal-full-gate-v9.json)通过：**265 场景 × 三剖面**，1,047 项五执行端直接读回零差（v8 的 1,026 + 新文字 7×3，分母一致可加）；kernel 427 项（含新增系数普查与延迟门禁测试）、native 11 项、算术 6 项、前端 213 项全部通过。v9 台账仅记录本次实测字段；v8 的源码前后稳定与独立清单审计字段不在本轮重新推导，仍以 v8 快照为准。外部 Figma 72/72 证据不变；文字外部对照待 PNG 参照。
首轮基线为 `73bdf8bc`。内存/图片阶段见[首轮台账](../../testing/review/design-kernel-memory-images-2026-10-07.json)，基础数值与门禁见[前轮精度台账](../../testing/review/design-kernel-parity-2026-10-07.json)，采样改动见[精确采样台账](../../testing/review/design-kernel-sampling-2026-10-07.json)，浏览器 Figma 对照、闭合描边与极小半径修复见[前轮台账](../../testing/review/design-kernel-figma-2026-10-07.json)，当前实现与复测进度见[落地台账](../../testing/review/design-kernel-implementation-2026-10-07.json)，2026-10-08 的全量文献补充见[文献台账](../../testing/review/design-kernel-research-2026-10-08.json)。各阶段通过数和文件哈希不能混用。

本文按当前源码推进。已删除“内核尚无撤销”“产品代码不存在”“屏外蒙版应显示内容”等失效提案及旧行号，不再维护已被替代的手工内存计数路径。产品范围和格式兼容边界仍由[设计器架构](design-editor.md)定义；本轮不改变默认服务目录。

## 当前校准轮：导出算术与背景重放（72 样本与完整回归通过）

[最新正式实现，外部原图已归零] 采用玻璃名义边界的有限捕获计划后，原生 CPU/Metal 与浏览器 WASM CPU/WebGPU/WebGL2 对保留的 Figma 浏览器 PNG **各 72/72 整图零差异**，见[可视对照](../../testing/review/design-kernel-exact-2026-10-08/nativeworld-exact.html)与[五端独立审计](../../testing/review/design-kernel-exact-2026-10-08/figma-only-five-end-exact-2026-10-09.json)。216 项浏览器/原生读回比较和 72 项原生 CPU/GPU 配对均为零，证据完整性检查通过。此前 7 张失败图累计 2,920 个错误像素全部修复，65 张已通过图逐字节不变，没有新增错误。输入坐标、参考 PNG 和零容差标准没有改变；[模型选择与正式接入记录](../../testing/review/design-kernel-exact-2026-10-08/glass-finite-calibration-2026-10-09.json)区分了私有数值候选、真实 Engine 渲染与 GPU 执行证据。

[本次修正] `Replay.lens_bounds` 保留未经整数覆盖和 AA 抖动的设备边界；捕获 q 取其与父框、512 瓦片的交集。`TilePlan::filter_plan()` 生成有限下采样与双向滤波区域，独立保留原始插值起点；Q8 顶点量化后按 binary32 面积与倒数构造梯度，UV 求值只在指定位置使用一次舍入 FMA。各 GPU 根据同一几何计划独立绘制源图和三次滤波，没有上传 CPU 最终颜色。合法空区域保持透明，非有限或溢出输入仍报错，原有内存/工作量/时限不变。

[WASM 边界验证] [28 项元数据入口检查](../../testing/review/design-kernel-exact-2026-10-08/glass-wasm-metadata-2026-10-09.json)通过：13 项接纳、15 项拒绝，覆盖现有 viewport/halo 尺寸与像素数上限、坐标、采样编号及必填 `lensBounds`。只调用计划生成，没有渲染大画布；不能把它算作巨幅 GPU 渲染通过。

[新增控制的正式入口复测] 三张父框尺寸控制（128²、256×128、256²）已经通过当前五执行端逐 RGBA 字节比较，见[正式复测记录](../../testing/review/design-kernel-exact-2026-10-08/capture-extent-production-2026-10-09.json)。这些控制单独保存，没有加入 72 张外部样本或 258 个内部场景的分母。

[上一检查点，未通过] [纹理重放与色散修正检查点](../../testing/review/design-kernel-exact-2026-10-08/world-texture.html)为 **65/72 整图零差异，7 项失败**，全部原生 Metal/CPU 直接比较为零。参考 PNG 与世界坐标输入保持不变；资源生命周期与适用范围修复前后的两份冻结二进制在全部 72 图上逐字节相同。剩余图的最大通道差均为 1/255，仍按失败处理；case 11 共修复 96 像素、另有 2 像素新错，未称无逐像素退步。[Figma 剖面五端独立核验](../../testing/review/design-kernel-exact-2026-10-08/figma-only-five-end-external-2026-10-09.json)已完成：各端均为 65/72，全部 216 项浏览器/原生像素比较与 72 项原生 CPU/GPU 配对为零；该外部范围仅为 figma 剖面。旧[归零坐标 56/72](../../testing/review/design-kernel-exact-2026-10-08/index.html)、[世界坐标 57/72](../../testing/review/design-kernel-exact-2026-10-08/world-fma.html)为不同阶段冻结结果，不能混合通过数。

[本次单项修正] 捕获坐标的 centered multiply/add 已改为一次 RNE FMA，原生 Metal 384×2 实际回读与独立 Dawn 16,384×6 合成分量共同验证其运算位置。完整 [72 样本原生复扫](../../testing/review/design-kernel-exact-2026-10-08/world-fma.html)仍为 57/72 整图相同，色散半强度的错误像素 73→72，其余 71 图逐字节未变，全部原生 GPU/CPU 比较为零；v6 完整门禁已完成且源码稳定，见[冻结报告](../../testing/review/design-kernel-exact-2026-10-08/internal-full-gate-v6.json)。该快照不包含之后的纹理正式入口与自然 8tap 修正。

[当前内部完整回归，源码稳定] [v8 完整门禁](../../testing/review/design-kernel-exact-2026-10-08/internal-full-gate-v8.json)通过：258 场景 × 三剖面，1,026 项五执行端直接读回零差异；Rust kernel/server 425 项、native 11 项、算术 6 项、前端 213 项通过。Clippy 与 Foundation 通过，508 份源码/输入哈希前后相同，独立重新枚举没有新增、删除或变更。该快照覆盖 GPU 命令 7 的有限玻璃捕获；72 张 Figma 外部通过由独立报告证明，未合并两套验收分母。

[上一内部完整回归，源码稳定] [v7 完整门禁](../../testing/review/design-kernel-exact-2026-10-08/internal-full-gate-v7.json)通过：258 场景 × 三剖面，1,026 项五端直接读回零差异；Rust kernel/server 422 项、native 11 项、算术 6 项、前端 213 项通过，Clippy 与 Foundation 通过。508 份源码/输入哈希前后相同，独立重新枚举文件也没有新增、删除或变更。该快照包含纹理正式入口、GPU 参数复用、结构适用范围与八次色散修正；外部 Figma 失败仍独立保留。此前 v6 的 502 份稳定源码等历史检查点原样保留。

[源码] schema 仍为 5，GPU 命令为 **7**。连续圆角玻璃几何、Q8 坐标/Q4 颜色采样、精确 UNORM8、四次独立抖动导出和常量颜色累积已接通。背景重放只接纳经过结构检查的不透明矩形场景；各 GPU 根据图元和参数自行绘制、缩小、双向滤波及取色，没有上传 CPU 最终颜色。渐变从色标生成 1024×2 查表，各端独立采样和抖动；513×257 主画布、282×270 偏移及正常混合隔离组共 284,121 像素的独立模型全零，限定验证这三类场景中 source x/y mod 512 相位。纹理的 1024² 源捕获使用其原始局部像素坐标，不套用主画布 mod 512 规则。

[修复与性能证据] 捕获网格锚定根画板设备原点，保持相机裁剪前后的完整源捕获；已验证 4× 样本中心裁剪与完整图相应区域逐字节一致。CPU profiler 定位反复通用采样/字节转换后，改用 RGBA8 中间缓冲、预编译轴向取样和 Q4 数值表，在不改变像素结果、256 MiB 预算与累计工作量限制下，冻结 4× 样本 release 渲染从约 16.37 秒降至 1.80 秒。完整门禁不再依赖放宽超时。该性能值只对应已测输入与本机。

[数值验证，不等于整图验收] 已纠正诊断分支影响 GPU 融合运算的问题：无诊断分支的噪声权重为 FMA(common, scale, RN32(bias+312))。新图在原生/WASM 与独立 Dawn 的 3,158,028 个梯度分量、10,485,760 个实际位移分量和 61,440 个连续留出分量上逐位一致；旧诊断图作为历史证据保留。裁剪权重必须使用复合 fast-log/exp 对应的有限域修正，不能用两个独立五次方根相乘代替；4081² 个 Q4 alpha 对在原生/WASM 和自然 Dawn 控制中全域逐位相同；新 GPU helper 用同一张纯数学 atlas 独立重建权重，Metal、WebGPU、WebGL2 三端各全域 16,654,561 对零差异，非法 alpha/索引也单独验证。浏览器全域验证是额外独立专项，未混称普通场景门禁已自动执行该专项。带符号 FMA 新增 28,328 个 Fraction 独立向量，累计 109,629 个算术向量在 CPU、实际 Metal、WebGPU、WebGL 四端全零。以上数学表只有合成数值函数数据，没有参考图像像素或供应商程序内容。

[纹理捕获，接入中] 新增共享捕获计划、RGBA8/Q4 效果采样及保留浮点精度到父画布 source-over 的回写阶段。[6 组 × 4 次采样的效果/回写阶段](../../testing/review/design-kernel-exact-2026-10-08/texture-numeric-stages-2026-10-09.json)与独立 GPU 读回逐字节一致，另有 128 组合成 Fraction 回写向量检测多余的 RGBA8 存储。复核发现初版捕获计划及其 8 组向量共同漏掉 clipped-only 源 cached bounds 求交；已按 captureView × render-space AABB 的原矩阵次序修正并通过修订后的 8 组向量。所有阶段源图的非零像素均位于新 ROI 内，24 次效果/回写复测仍全零；向量一致不能代替调用路径完整性。空源捕获仍可能回退 original，未把它当作可跳过效果。该数值快照先于正式场景接线；当前 CPU 入口已接通，原生与浏览器 GPU 正在独立验收。

[当前纹理实现，已通过内部完整回归] 裁剪与未裁剪的前向坐标分别保留自然着色器的融合边界；修正后共享模型与正式 CPU 入口的 7 个非零纹理全部整图零差。从 GPU 命令 6 起传递源绘制计划与颜色无关参数，由各 GPU 独立生成源图、执行效果、保留 Q4 精度回写父图；不上传 CPU 颜色。原生 Metal、WebGPU、WebGL2 的 7 图专项均与 CPU 及参考像素一致。模型限定平移矩形叶子、单个不透明裁剪根框及受支持画笔，整节点预检后才选择新路径。有效范围还限定至整节点最多 65,536 个 canonical tile；在前置结构判定中超出者沿用既有路径，直接计划 API 的工作量错误仍明确返回。低强度效果在验证后 O(1) 判直绘，避免无效全局枚举。源四边形 g32/c32 插值仍是近似；[适用范围与系数反例](../../testing/review/design-kernel-exact-2026-10-08/texture-replay-scope-2026-10-09.json)已记录一个通过结构筛选却有 1 ULP 系数差的输入，尚无该输入的最终 Figma PNG 结论。7 图相同不构成任意输入证明。有效但空源的情况整节点回退，原回退路径已有的裁切差异仍待解决。

[纹理资源修复] [三 GPU 消费路径专项](../../testing/review/design-kernel-exact-2026-10-08/texture-consumer-validation-2026-10-09.json)保存逐项输入、读回及资源证据。旧参数生命周期在正确 4× 输入上实际触发 256 MiB 错误；新路径复用一块固定 1024² RGBA32F 参数纹理，重写前提交此前读取，保持队列顺序且全程计入 16 MiB。原生与 WebGPU 的已测 4× 峰值分别为 74,850,372 / 76,591,232 字节，输出与 CPU 相同；跨 tile 裁切也相同。预算与超时没有提高。合法 2050×128 输出的 WASM 元数据守卫已按现有 GPU viewport/halo 范围对齐，未提高整体像素预算。大半径 original512 分支的完整 Engine CPU 仍受原合成内存预算拒绝；另以四个 32² 父平面运行当前共享重放，阶段级 CPU 与三 GPU 的 1,024 字节相同，该证明不冒充完整 Engine 或 Figma 外部通过。

[上一玻璃实验，保留失败证据] 自然八次色散累积保留末项负权重，按逐项 FMA 后乘总权重倒数；独立 4,081 个 Q4 中间均值逐位验证通过。[配对官方控制](../../testing/review/design-kernel-exact-2026-10-08/spectral-pair-controls-2026-10-09.json)在 4,712 像素内相同，与导出前冻结预测一致；模型在该内部区域仍有 124 像素不符。半强度候选错误 72→0，另一张 444→350；其中 96 像素修复、2 像素新错，正式 72 张复扫已确认上述变化，不能称无逐像素退步。当时使用父框边界的统一有限下采样使 frost 2.01@4× 的错误 271→655，未采用；不能将它与本次采用玻璃名义边界的有限区域方案混为一谈。25 位倒数插值系数候选在新增 40 组中失败 10 组，也未采用。

[新增控制] [7 张独立控制图](../../testing/review/design-kernel-exact-2026-10-08/texture-control-evidence-2026-10-09.json)进一步限定问题：同世界坐标的矩形、顺/逆四边形三张 PNG 与原未裁剪样本文件字节完全一致；正反 RGB 色标的 1024×16 渐变两图与当前数学模型全 RGBA 零差异；将两种问题纹理改为纯黑后，透明度边缘两图也全 RGBA 零差异。该控制阶段尚有两个蓝色单字节错误，随后由纹理前向运算图修复；各阶段证据分别保留。新控制不拼入 72 样本的分母，也不证明查表低位/所有采样权重已完全识别。新 [GPU 裁剪权重专项](../../testing/review/design-kernel-exact-2026-10-08/texture-clip-gpu-2026-10-09.json)单独保存三 GPU 全域读回与环境。

[证据边界与后续] 导出采用四次抖动各自缩小、逐次 RGBA8 累积；普通 source-over 与常量颜色累积有不同 FMA 图。真实世界坐标与归零坐标可能经过不同 binary32 舍入，恢复坐标阶段曾将 frost 1.5@1× 的最大差 15 降至 1，本次有限区域方案进一步将该图及另外 6 张剩余失败图归零。复杂图元、嵌套效果、超出已测光学参数及其他硬件仍未获得外部逐像素通过证明。论文提供数值合同和可证伪候选，不能单独证明 Figma 实现或完全一致。

## 已实施：CPU 合成内存与图片生命周期

[源码] `memory.rs` 为每次 CPU 合成（分块模式下为每块）建立 256 MiB **缓冲载荷字节**预算。`Surface` 在分配前申请 `像素数 × size_of::<Pixel>()`，当前 Pixel 为 16 字节；首个画布、四个采样平面、效果输出和副本共用同一预算。`Arc<Surface>` 的共享引用只计一次，真正复制使用可失败的 `try_clone()`。旧 `live + pixels * 4` 检查和各分支手工减计数已移除。

[源码] 填充/描边覆盖的 f32 mask 按调用矩形作保守预留；模糊前缀和/矩、形态学队列、玻璃的距离场也预留载荷。预留随对象释放，错误提前返回不会污染下一次渲染。效果函数返回 `Result`，将预算错误传回 Engine/WASM/HTTP 调用方，不用 panic 或空画面伪装成功。单块累计 surface 工作量仍有 2 亿像素上限，现在包括根画布和效果副本。

[合同边界] 256 MiB 不是进程 RSS 上限：文档/路径/扫描边表、解码图片、最终 RGBA/PNG/浮点输出及运行时/分配器开销仍各有独立边界。`peakCompositingBytes` 仅记录上述预留峰值；`peakLayerPixels` 和 `allocatedLayerPixels` 改为覆盖真实 surface 生命周期，不能再与旧漏计值直接比较。旧版本能成功但超过新预算的场景现在明确失败，没有继续使用旧阈值的兼容开关。

[源码] 安装合法文档时，图片缓存保留仍被节点填充/描边、组件覆盖、共享 paint 样式和动画 pose 引用的 URI；无引用项移除并重算解码像素用量。色彩管理配置变化继续整体失效；拒绝的 patch 不改变缓存。URI 内容没有变化且色彩配置相同的图片继续共用原解码 Surface。

[边界] 本轮没有新增 LRU、mipmap、跨文档全局缓存或摘要资产仓库。完整 URI 键、解码中间缓冲、活跃图片总量和文档深拷贝仍需另测；保留解码对象不等于全编辑链路已增量化。

## 后续实施顺序

### 当前精度合同与落地结果

[合同] 用户确认的目标是 CPU、原生 GPU、WebGPU、WebGL2 同输入逐字节一致。普通输出比较全部 RGBA8 字节；色彩管理文档同时比较线性 RGBA32F 的每一位。缺设备、错误回退、编译失败、缺比较对象和非零差异均失败。不能使用已有的 1/255 或 HDR 相对容差测试代替该门禁。外部 Figma PNG 相似度仍是另一项验收。

[源码] 根目录执行 `python3 design-studio/scripts/check-precision.py`。默认执行三个 profile、全部共享场景、原生硬件算术测试、Rust/WASM、前端和真实 Chromium；端口由本次 Vite 进程申请，测试回收自己的浏览器/进程。`--profiles` / `--stages` 仅用于诊断子集，只有全范围成功才能将 `fullAcceptancePassed` 置为 true。硬件测试须启用 `hardware-tests`，默认 cargo 的 ignored 项不计为硬件验收。

[源码] 共享语料 `testing/fixtures/design/precision-corpus.json` 当前为 265 场景（2026-10-09 起 7 个文字场景入册），包含新增非均匀 ICC/PQ/HLG 图片、内核自身的非零玻璃位移/照明、分数 HDR 半径和连续纹理位移，覆盖动画时间点、蒙版、渐变、图像、平滑曲线、描边 cap/join/dash/profile、效果与文字（拉丁/中英混排/多行/字距/分段样式）。Rust/native/browser 使用同一文档与选项；保存失败请求、各端原始读回及零容差比较结果。最后的 `cross` 阶段直接连接 native CPU、native GPU、WASM CPU、WebGPU、WebGL2 的原始读回，不能假定两种 CPU 构建自动相同；缺文件或尺寸错误亦失败。有限语料通过不是任意输入、任意硬件的正确性证明。

[源码] 精细剖面固定保留四个相关采样平面，不再由文档中的无关 paint/backdrop 选择量化图。CPU/GPU 共用 `geometry_snapshot` 的设备几何与 binary64 扫描线交点。analytic 为八行连续横向覆盖；两个精细剖面保留四个固定采样位置。`AreaProgram` 保存交点区间及端点原始位，GPU 自行求覆盖，不上传 CPU 覆盖位图或颜色。相同位模式的区间程序共享存储。内部 `GpuScene` 版本为 7；历史命令 4 的通过数仍对应其旧源码。

[源码] 线性渐变采用带范围/误差检查的 64 位定点仿射坐标；字节颜色插值和部分合成使用整数舍入。HDR 中间纹理从 RGBA16F 升为 RGBA32F，上传、读回及预算按 16 字节/像素计；显示 canvas 的格式另行保留。HDR 禁用硬件 source-over，使用明确的着色器混合；CPU/GPU 统一采样平面求和顺序。

[边界] RGBA32F 中间层载荷是旧 RGBA16F 的两倍，预算没有随之放宽；大 HDR 场景可能更早触发显式资源错误。GPU 分块与跨端资源准入仍需单独收敛，不能据小画面精度通过声称所有合法大文档均可渲染。

[已验证，局部] Python `Fraction` 和整数平方中点生成 68,245 个独立数值预期，涵盖有限 binary32 加/乘/除、非正规数、带符号零、溢出、平方根、64 位定点缩放、颜色插值及新增 1,044 个极小半径积分模糊侧瓣/支撑系数。`generate-precision-vectors.py --check` 检查共享预期未漂移。CPU 和三个实际 GPU 后端直接运行生产 shader helper 的比较结果见台账。已复现并修复黑色渐变端点在极小参数下错误归零，以及 GLSL 保留字/浏览器 WGSL 常量限制导致的编译失败。

[已验证，合同变化] 描边的两个精细剖面旧 hash 因改为最终单次 resolve 而改变。更新前对全部 36 种描边组合逐像素运行独立采样计数、定点舍入和稳健方向判定参考；analytic 的旧 hash 保留。原六个 Figma 矩形观测值原样保存在 `figma-rectangle-reference.json`：其中 (28,8) 的外部灰度 144 与内部单次 `roundEven(255×9/16)=143` 不同，没有改写外部参考以宣称匹配。

[上一阶段边界] 217 场景 × 三剖面的全范围门禁已通过，876 项五种执行端直接读回比较为零。语料包括 8 个非正规数场景、1 个极近色标场景和 16 个实际 Figma 半径/倍率场景，均进入完整 Rust/WASM/native/WebGPU/WebGL2 门禁。命令、日志和源码快照见当前台账。有限语料不能证明所有输入；设备预算、复杂场景性能、Figma 外部算法及独立玻璃/纹理参数仍有未完成项。

[源码/已验证] HDR 材质保留原始直通 RGB/alpha，避免 CPU 预乘再反除后才传给 GPU 所引入的舍入。16 种混合、亮度蒙版和 pass-through 使用相同的 RNE 运算顺序；四种渐变的 binary64 坐标和排序色标编译成仅包含左右索引及 f32 权重的参数场，GPU 从颜色常量独立计算。69 个分数透明度/渐变/混合场景已零差异。固定分母 epsilon 会把相邻合法色标的 0.5 权重变为约 0.0284，已以正区间不变量替代；非正规数图层乘法与采样缩放顺序亦已补齐回归。

[源码/已验证] `vendor/moxcms` 保存 0.8.1 原始来源哈希、许可证和 5 项审计修改：统一显式 FMA，关闭架构 SIMD 默认路径并以编译错误阻止重新启用，TRC/gamma 使用精确度更高的 pxfm 幂函数。`check-moxcms-patch.py` 是门禁步骤，验证全部 119 文件及允许修改。9 张非均匀 ICC/PQ/HLG 图片的 native/WASM 差异已消除。pxfm 的测得误差界不等于所有输入正确舍入证明；其他 CPU/GPU 架构仍需真实运行。

### 独立材质参数与版本边界（2026-10-08）

[源码] schema 5 增加 `Effect.glass={depth,refraction,dispersion,lightAngle,lightIntensity}` 与 `Effect.texture={noiseSize:[x,y],clipToShape}`；外层 radius 分别表示玻璃 frost 和纹理位移半径。节点、效果样式与动画中的新字段均受版本/范围验证；编辑器、导入器、服务端同步支持新版本。参数接通阶段 GpuScene 升为 4，纹理重放轮升为 6，本次有限玻璃捕获升为 7，旧命令版本明确拒绝。旧文档的无结构参数语义不自动改写。

[源码] `material.rs` 生成颜色无关的分形位移字段，并实现边缘 alpha 的五次方根。CPU 用 125 位以内的整数幂比较舍入中点，GPU 用四个 u32；1,287 个新增独立预期由 Decimal160 计算候选，再用 Fraction 中点五次幂认证。新代码通过 WGSL 生成对应 GLSL。RGBA32F 参数纹理可随 byte 或 float 色彩表面使用，池复用同时检查格式；WebGL 元数据只有采样用途，不要求浮点 framebuffer。

[源码/修复] canonical glass 的深度、折射、色散与照明独立参与计算。CPU 原先按父框截短玻璃几何，产生了假的距离场边界；现在先计算效果所需的完整几何，再应用祖先裁剪。halo 包含整个深度范围，即使 refraction 为零，色散/照明仍可使用距离场。裁剪纹理不再把普通半透明填充 alpha 平方。新增参数支持动画插值，光线角度按最短角度路径；裁剪模式或材质模型不同的关键帧不进行错误的连续插值。

[验收边界] 新增 32 个场景，覆盖 23 个实际 Figma 同参数材质与 9 个 HDR/仿射变体。最初三组 analytic 失败已由几何范围和 halo 修复，96 组浏览器逐位比较为零。参数接通阶段的 249 场景、schema 5 完整门禁通过，999 项跨执行端读回为零；该阶段源码哈希以[材质台账](../../testing/review/design-kernel-materials-2026-10-08.json)为准。外部 [23 场景报告](../../testing/review/design-kernel-materials-2026-10-08/index.html)仍失败；物理合理的折射模型、SVG 分形噪声和参数完整性都不是 Figma 私有算法的证明。


### 文献核验、光照校准与 4× 导出（2026-10-08 后续轮）

[已验证] 在参数接通阶段上继续迭代，扩展到 **258 场景 × 三剖面**，完整门禁通过；**1,026 项**五执行端读回比较为零。另将原 23 个材质、30 个磨砂半径/倍率探针、11 个光照诊断及 8 个模型定稿后导出的角度样本组成 [72 场景外部对照](../../testing/review/design-kernel-optics-2026-10-08/verified/index.html)：1,080 项外部比较、864 项内部比较，内部全部为零且没有缺失后端；三个剖面均为 **0/72 严格通过**。命令、原图哈希、模型边界与源码快照见[本轮台账](../../testing/review/design-kernel-optics-2026-10-08.json)。

[源码/已验证] 新玻璃光照把约一个文档像素宽的定向亮边与按深度衰减的明暗渐变分开；scale 显式传给各 GPU，保持相同运算和舍入次序。`calibrate-glass-lighting.py` 用三个指定样本的直边拟合四个共同系数，保留接近拟合结果的二进制精确常量 15/16、2、1/2、1/8；它是经验模型，不是 Fresnel/BSDF 的物理推导或 Figma 私有算法。旧强光样本最大差 **84→56/255**、RGBA 平均绝对误差 **1.027359→0.139938**；四个正交角度最大差 **62–63→20–21/255**。模型固定后新增的 8 个角度/倍率样本全部改善，样本 MAE 的均值 **0.814738→0.139712**。原 23 材质中的其余 18 个输出字节未变；折射、色散、磨砂与噪声的外部失败继续保留。

[源码/已验证] 新探针复现 9 个 4× 磨砂的 CPU 预算失败。原因是 512 输出像素的 tile 在 figma 的 2× 内部采样后变成 1024 像素工作块。现在 RGBA/浮点路径按内部密度限制 tile；256 MiB 预算没有提高。9 个失败均消除，新增跨横/纵 tile 接缝的独立区域读回测试，全后端对照通过。未据 debug 渲染耗时声明性能提升；更复杂层级仍受原资源上限约束。

[文献实验] `analyze-optical-evidence.py` 校验原 PNG 哈希后执行 90 项中心行候选比较。按 Kovesi 2010 的奇数宽度三次/五次 box、sigma=radius/2、1×/2×/4×候选采样及最终 RNE，在 8 个已启用模糊样本上的绝对差总和为 206–642；独立积分 tent 为 14。所测 box 候选未优于当前候选，因此未替换生产滤波器；这不能排除不同半径映射、偶数 box 或中间量化方式。参考 [Kovesi 作者全文](https://peterkovesi.com/papers/FastGaussianSmoothing.pdf) 的式 3、5；[测量结果](../../testing/review/design-kernel-optical-measurements-2026-10-08.json)保留每个候选的全部误差。

[文献实验] 按噪声综述的相关性/频谱方法，对 size 8/16 的横纵位移坡面取 128×128 内区；观测频谱重心由约 0.09 降至 0.045 cycles/pixel。固定 SVG 晶格的 cubic/quintic fade 候选相关系数仅 −0.196～0.198，未采用新噪声。8-bit 反演保留量化不确定度，功率谱相似不能证明逐像素等价；quintic 实验也不是完整 Perlin 2002 的三维算法。恒定 G 色标的红色渐变内区仍出现 118/119/120，未发现所测 2/4/8/16/32 像素平移的严格重复；这些观测不能唯一确定误差扩散或阈值图，未在生产端盲加抖动。

[诊断边界] `analyze-glass-distance.py` 对本轮内核圆角 mask 独立重放 JFA，再与 SciPy 精确格点 EDT 比较：23 个格点距离不同，但两像素亮边内没有差异；格点距离减半像素与连续圆角边界仍可差约 0.492 设备像素。这是一张 mask 上的独立算法诊断，并非 GPU 中间阶段读回；不能把剩余角部误差全部归因于 JFA，也不能声称换成精确 EDT 就能修复连续边界。后续优先测背景捕获/重采样和连续边界法线，再扩展复杂几何与透明背景。

[文献核验] 新增参考有用，但使用层次不同：规范约束数值合同；滤波/噪声/抖动文献提供可证伪候选；曲线、布尔、文字和协作论文属于相应子域的后续方向。本轮核读相关可访问正文与规范，未宣称通读全部付费书籍。已纠正 WebGL2/GLSL ES 版本、PCG 与坐标哈希的区别、由细分引用直接推出当前误差界、以及 PDF 透明组与 pass-through 同构的过强表述；Gabor 候选须使用作者勘误稿。

### 精确双线性采样与中性效果（2026-10-07）

[源码] 新增 `sampling.rs`、`sampling.wgsl` 和 `sampling.glsl`，定义有限 binary32 颜色与 `[0,1]` binary32 插值分数的双线性表达式。九个展开项的乘积不先舍入，使用以 2^-447 为单位、19 个 u32 字的带符号累加器，末尾只做一次 ties-to-even。容量覆盖该输入域中的非正规数和抵消；精确零规范为 +0。WGSL/GLSL 的常量与端点判断按位进行，避免驱动将不同非正规数或带符号零合并。它保证给定采样参数的插值合同，尚不保证各端上游坐标计算自动相同。

[源码] CPU 常见路径以 f64 计算候选值，构造保守误差区间；只有两端转换为同一 f32 位模式才接受，否则进入整数精确分支。这不是放宽最终误差门槛。HDR 图片、折射、背景重采样和线性阴影使用 `sample_linear`；byte-surface 剖面保留其现有量化合同。无效输入保留为非有限结果，由帧输出验证拒绝，不在采样函数中触发 panic 或伪造有效像素。

[已验证，局部] 独立 Python `Fraction` 生成 7,008 个双线性预期，CPU、原生 GPU、WebGPU、WebGL2 逐位比较；另有 10,201 个恒色采样位置和完整叶节点零效果测试。共享场景新增 ICC/PQ/HLG 的 1:1、8×与分数倍率、旋转纹理及中性背景槽。原三张标色图片回归的浮点差异已消除；它们是恒色图，不能据此宣称任意图像坐标/变换已完全收敛。

[源码] texture 的有效位移为零时跳过采样。全中性 glass 不捕获并重新平均背景。CPU 与原生 GPU 共用 `scene::selected_backdrop`，浏览器实现同一规则：先选第一个可见背景槽，再判断强度；零强度不能误激活后面的 glass。新增叶节点对照测试；可见效果对 pass-through 组隔离的既有语义另行保留，不把叶节点结论外推到所有组。

[性能边界] 初版精确路径在一次 native release 微基准中，131,072 次变化像素采样约 51.1 ms；加入可证明舍入的快速路径后约 4.6 ms，同次旧路径约 1.0 ms。该记录不代表整帧或跨设备性能。初版 GPU 代码还触发过超过 30 秒的首次编译；改成紧凑循环、减少大结构传参，并向驱动提供固定的运行时程序界限（19 字、9 项）后，通过了原时限下的浏览器回归。SDR 编译独立的 byte-surface 程序，不携带 HDR 累加器。新源首次请求仍观察到 WebGPU 约 11 秒、WebGL2 约 2 秒，启动开销仍有优化空间；未延长产品渲染时限。

### 文献方案的实际落地与实验边界

[源码] `rational_filter.rs` 将 authored binary64 半径变成精确整数系数/公共分母。Tent 与 Gaussian 的均匀箱式阶段均由 CPU、WGSL 和生成 GLSL 使用相同系数；每次点积最后仅做一次 binary32 RNE。独立 `Fraction` 参考包含 644 个卷积向量及 11 张 Gaussian 逐阶段图像。Gaussian 保留滑动和，用包含舍入误差的区间判断；区间跨越 binary32 舍入边界时调用精确分支。

[源码/已验证] `certified_filter.rs` 用 TwoSum 补偿前缀和、一阶矩以及向外舍入的 binary64 区间计算宽 Tent；只有区间两端落在相同 binary32 位模式时才采用候选。抵消、极值、透明边界及 clamp 与逐项精确卷积逐位比较。依据是 [Shewchuk 的误差自由变换](https://www.cs.cmu.edu/~quake/robust.html)与 [Higham 的求和误差分析](https://nhigham.com/wp-content/uploads/2023/10/high93s.pdf)，不是概率置信区间或容差放行。M2 Pro release 微基准中，256²、r=64.125 从约 233 ms 降至 63 ms；r=16 的直接卷积更快，实测 r=32 的分界后只对宽核启用前缀路径。不能外推为整个编辑器加速倍数。

[源码] `sampling::coordinate_grid` 统一位移纹理及图片的坐标编码：保留独立整数格点和 binary32 小数，不把两者重新相加而丢失低位。`ImageCoordinates` 与 CPU 共用 binary64 变换、cover/contain/stretch、paint transform 和采样偏移。字段只携带坐标，GPU 仍对自己的颜色纹理执行采样。每字段 16 字节/像素，单字段 64 MiB，上传计入帧预算；相关采样平面需要各自的地址。这增加 CPU 编译、上传与显存成本，并非免费的一致性保证。

[源码/已验证] 玻璃两条 CPU 合成路径已统一为有固定顺序的 JFA 和同一浮点计算链；analytic 的 chamfer 分支已移除。JFA 仍是近似格点距离场，不能称为连续曲线精确距离。针对 WebGL2 连续覆盖调用捕获到 Metal GPU Hang/PageFault；覆盖 ALU 的临时数组改为每次 GPU 调用独享并逐次初始化的 scratch 后，真实数值与场景回归恢复，不保留强制读回/同步绕过。

[源码/已验证] 平滑圆角改为 Bézier 过渡与圆弧段模型，邻边按实际半径分配预算；smoothing=0 仍保留真圆弧。真实 Figma 新增 16 组轮廓，导出原矩形及展平路径共 32 张 PNG。正平滑及零半径的 15 组，当前公式与直接回放 Figma 控制点的内核 PNG 相同；外部 PNG 仍有边缘差异。control-point 几何界不替代最终零字节比较。普通 SVG 导出忽略平滑的观察也保留，不能拿它当完整轮廓真值。

[实验] `calibrate-corner-model.py` 比较已知 2:1 控制柄公式、最小二乘和 15 次评估的 GP/EI 贝叶斯优化，训练/留出数据固定。解析比例在此小型试验的留出控制点误差最小；有限离散网格和预算限制了 GP 结果，不能据此否定贝叶斯优化。贝叶斯适合离线探索未知滤波/材质参数；[DiffVG](https://people.csail.mit.edu/tzumao/diffvg/)适合从目标图拟合几何。两者均不能代替字节合同。当前已知曲线公式不需要训练神经模型，没有把学习权重或参考像素补丁放入内核。

[源码/实测落地] 后续 16 个真实浏览器样本分别在 1×、2×、4× 导出，限定了 SDR layer blur 的启用条件：最终设备半径小于 0.5px 时不滤波。`fidelity::layer_blur_active` 考虑 figma 剖面的内部 2× 密度；CPU 调用与 GPU 场景参数编译共用该函数，后端不各自猜阈值。42 组半径/倍率/剖面回归验证边界两侧，另断言 HDR 不继承此 SDR 观测。已使基础小半径和脉冲 0.25 场景与 Figma 零差，但边界以上的末位和滤波形状仍未完全匹配。

[历史 81 图基线，2026-10-08] 当时 Figma 真实 PNG 的采样/量化、滤波形状、玻璃完整参数和纹理噪声模型尚未收敛。两阶段 byte resolve 和 float32/UNORM 试验未达到零差异，未采用。48 张旧参考重导出原字节不变；新增 23 张材质、10 张模糊脉冲和 16 张半径/倍率实际浏览器导出，81 个场景的三剖面/五执行端报告见[逐像素对照](../../testing/review/design-kernel-figma-2026-10-08/index.html)。内部比较为零，61 个共同参数样本仅 analytic 13 个、figma 12 个、figmaSubpixel 12 个与 Figma 完全相同。原图及精确参数、ZIP/PNG 哈希保留；没有改写参考图来消除失败。


### 逐项文献研究与下一步算法（2026-10-07）

以下保留当时的研究候选与实施顺序；参数接通、五端内部门禁及本次 72 图外部结果以本文顶部的当前检查点为准，尚未覆盖的几何和场景不随样本通过自动关闭。

[历史研究与后续设计] 以下保留逐项文献依据；当前已落地部分以上一节和当前台账为准。已核对前轮台账的 20 个源码/测试快照均未变化。查阅范围是论文原文/作者公开材料、可访问的书籍章节/目录及规范，未声称通读付费书籍。数学探针、链接与作用边界见[研究记录](../../testing/review/design-kernel-research-2026-10-07.json)。本节方案是针对本项目的工程推导；引用的论文没有替本项目证明整条渲染管线。

**1. 四后端的数值合同。** [源码] 现有精确加乘除、开方及双线性原语是局部合同，仍有坐标、滤波及玻璃公式直接使用宿主/驱动浮点。[文献] Goldberg 1991 的[浮点综述](https://docs.oracle.com/cd/E19957-01/806-3568/ncg_goldberg.html)、Higham《[Accuracy and Stability of Numerical Algorithms](https://nhigham.com/accuracy-and-stability-of-numerical-algorithms/)》第二版提供舍入和误差分析基础；[WGSL §15.7.5](https://www.w3.org/TR/WGSL/#reassociation-and-fusion)明确允许重排及符合条件的融合。同一公式、同一源码乃至 WGSL 转 GLSL，都不足以证明字节一致。IEEE [754-2019](https://standards.ieee.org/ieee/754-2019/) 是基本运算、舍入与格式的规范文本；[WebGL 2.0 的 GLSL ES 3.00 约束](https://registry.khronos.org/webgl/specs/latest/2.0/)是 WebGL2 端的直接规范依据，不能用 GLSL ES 3.20 的特性替代；Müller 等《[Handbook of Floating-Point Arithmetic](https://doi.org/10.1007/978-3-319-76526-6)》汇总舍入、补偿与正确舍入算法。规范与手册提供合同语言和术语，不构成任何驱动实现的合格证明。

[设计] 为每个受约束算子列出输入位宽、计算域、边界条件、融合规则、舍入时刻、非正规数/零/非法值规则，生成可序列化的公共参数和运算描述。先保留两条显式合同：四后端必须执行同一确定计算；与独立高精度参考的误差另行验证。不能只把 CPU 改成 f32 就当作修复。定位时依次读回参数、坐标、覆盖、每次滤波、混合前后及最终转换的位模式，找首次分歧。优化必须证明同一舍入结果；不能仅以小于 epsilon 接受不同结果。

**2. HDR 模糊：精确权重和精确点积。** [源码] `effects.rs::linear_tent_blur` 使用 f64 前缀和/矩，原生和浏览器 GPU 将半径转为 f32，并在 shader 内计算系数、顺序累加 f32；差异在进入 RGBA8 之前已出现。[文献] Neal 2015 的[superaccumulator](https://arxiv.org/abs/1505.05571)适合建立精确累加参考；Demmel、Ahrens、Nguyen 2016 的[可复现求和](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2016/EECS-2016-121.html)说明归约的顺序独立性可以专门设计。必须区别可复现、精确和正确舍入；对已经舍入的乘积精确求和，也不能恢复被乘法丢掉的位。Ogita、Rump、Oishi 2005《[Accurate Sum and Dot Product](https://doi.org/10.1137/030601818)》给出 TwoSum 补偿求和/点积的标准算法与误差界，`certified_filter.rs` 的补偿前缀和属于该谱系。Heckbert《[Filtering by Repeated Integration](https://doi.org/10.1145/15922.15921)》(1986) 与 Crow《[Summed-Area Tables for Texture Mapping](https://doi.org/10.1145/964965.808600)》(1984) 是前缀和实现箱式卷积的原始出处；Wells《[Efficient Synthesis of Gaussian Filters by Cascaded Uniform Filters](https://doi.org/10.1109/TPAMI.1986.4767776)》(1986) 与 Kovesi《[Fast Almost-Gaussian Filtering](https://doi.org/10.1109/DICTA.2010.30)》(2010) 提供均匀箱式级联逼近 Gaussian 的理论依据与阶数/质量参考。它们是滤波结构与参考的出处，不是 Figma 采用同一实现的证据。

[数学已核验/运行未验证] 独立分段积分 `tent(t) × max(0,1-|t-distance|)` 得到半径 2.5 的权重 `[1,25,72,104,72,25,1]/300`，正好对应该研究轮失败场景的滤波半径。半径 3 则为 `[1,6,12,16,12,6,1]/54`。本次用 Fraction 核验了八个半径的系数、非负性、对称性和单位质量，未调用生产 `tent_weight` 生成预期。

[设计] 首个实现试验限定当前积分 tent：共享 Rust 参数编译生成整数分子/公共分母；每个方向精确计算 `sum(pixel_i*n_i)/D` 后一次舍入到 f32。输入 f32 可精确分解成带符号整数乘二的幂；累加未舍入乘积，最终除法保留余数参与 ties-to-even。不是把本应精确的有理权重先量化为 Q24。保持现有横向再纵向的两个 materialization 边界；改成整张二维卷积只舍入一次属于另一个合同。任意合法半径和变换尺度须证明分母/累加器容量，不能从 2.5 的例子直接宣称全域支持。CPU 可研究带证明的区间快路径；GPU 先建立正确参考，再评估行扫描/前缀优化和寄存器、纹理、编译成本。

[验收] 恒色、单脉冲、阶跃、正负 HDR、次正规数、相消、刚好半 ULP、透明边界/夹边、两个方向的单独读回；同一权重下四后端 f32 位相同，并与 Fraction 参考相同。不能用 RGBA8 相同掩盖浮点层的差异。此方案收敛内部滤波；是否匹配 Figma 的 blur 必须另测。

**3. 非零纹理位移：先解决格点选择。** [源码] CPU 执行逆变换→`floor`→噪声→正变换；GPU 使用 f32 逆矩阵及设备空间位移。双线性权重已一致，不保证两端选中了同一组 texel 或同一个噪声格点。[文献] [Shewchuk 1997](https://www.cs.cmu.edu/~quake/robust.html)提供误差过滤、接近判定边界才精确回退的思路；其方向/圆内判定代码不能直接冒充本项目的 floor/矩阵逆算法。

[数学已核验] 像素中心 0.5、平移 0.50000001，在原 binary64 参数的精确运算下局部坐标为负，floor=-1；将逆平移存入 f32 后为 -0.5，局部坐标为 0，floor=0。这是格点跳变反例，非本轮新渲染帧，也未归因所有已有纹理失败。

[设计] 统一坐标参数的表示、像素中心、负坐标 floor、边界和平局规则；格点候选的误差区间跨整数时精确验证，不能加 epsilon 强行推到某一侧。稳健求逆/格点判定可转为行列式及整数比较，需单独证明范围。对仿射 `p=A*l+t`，位移后采样点在实数域可化简为 `p+A*delta`，减少 CPU 逆/正变换抵消；化简后仍需规定有限精度计算合同，不能只改一端。逐阶段比对格点编号、噪声值、采样点及插值分数。试验覆盖格线两侧、负坐标、旋转/镜像/剪切、极端缩放和平移；零位移严格恒等。

**4. analytic：覆盖算法必须一致。** [源码] `rasterize` 是八条纵向采样线配合横向区间覆盖，并非完整解析面积积分；当前四后端已共用区间几何及确定的覆盖运算。[文献] Manson、Schaefer 2013《[Analytic Rasterization of Curves with Polynomial Filters](https://josiahmanson.com/research/scanline_rasterization/scanline_rasterization.pdf)》将区域积分转为边界积分，适合建立曲线覆盖参考。论文假设输入形状不重叠，重叠需预处理；不能据此直接宣称已解决分组、透明层及蒙版合成。Loop、Blinn 2005《[Resolution Independent Curve Rendering Using Programmable Graphics Hardware](https://doi.org/10.1145/1186822.1073303)》与 Manson、Schaefer 2011《[Wavelet Rasterization](https://josiahmanson.com/research/wavelet_rasterization/)》是 GPU 曲线解析覆盖的另外两条路线；Catmull 1978《[A Hidden-Surface Algorithm with Anti-Aliasing](https://doi.org/10.1145/965139.807360)》、Carpenter 1984 的 [A-buffer](https://doi.org/10.1145/964965.808585) 与 Abram 等 1985《[Efficient Alias-Free Rendering Using Bit-Masks and Look-up Tables](https://doi.org/10.1145/325165.325177)》构成覆盖度采样的历史谱系，figmaSubpixel 的固定采样位是其中的成员。这些为长期解析覆盖试验提供候选与定位，不改变现行八行区间覆盖合同。

[设计] 近期先明确并实现现行八行区间覆盖的四端合同，包含半开边界、winding、相同边集、排序和平局、覆盖精度及浮点合成。以 native 缺失入口和逐阶段一致性为明确交付。长期的真正解析覆盖另设算法试验：曲线按像素边界分割、边界积分、稳健退化处理，再验证多形状重叠。独立面积参考可检查几何误差，但最终精度门禁仍是零位差；增加硬件 MSAA 样本数不是相等性证明。原相关采样平面纪律必须保留，不能先各自平均蒙版/子层再假定它们的空间相关性仍在。

**5. 平滑圆角：换成匹配的曲线模型。** [历史问题] 原 `Path::rectangle` 使用指数 `2+3*smoothing` 的超椭圆；当前已替换为实测的 Bézier/圆弧构造。[资料] Figma 的《[Desperately seeking squircles](https://www.figma.com/blog/desperately-seeking-squircles/)》讨论 Bézier 过渡与圆弧段、边长消耗和控制柄比例；它提供模型依据，不保证 2017 的描述逐项等同于当前实现。Farin《[Curves and Surfaces for CAGD](https://www.farinhansford.com/books/cagd/toc.html)》第 5 版可用于 Bézier 导数、细分和几何连续性基础。Moreton、Séquin 1992《[Functional Optimization for Fair Surface Design](https://doi.org/10.1145/133994.134035)》定义 class-A/G² 曲线的质量标准；Levien 2009 博士论文《[From Spiral to Spline](https://levien.com/phd/thesis.pdf)》系统化螺线到样条与 G² 连续。二者是圆角造型质量的参照系，不能替代对 Figma 实际轮廓的测量。Lane、Riesenfeld 1980《[A Theoretical Development for the Computer Generation and Display of Piecewise Polynomial Surfaces](https://doi.org/10.1109/TPAMI.1980.4766968)》提供曲线/曲面细分的理论参照；de Figueiredo《[Adaptive Sampling of Parametric Curves](https://doi.org/10.1016/B978-0-12-543457-7.50032-2)》(Graphics Gems V) 提供自适应取样方法。当前弦段距离上界仍需按实际停止准则单独证明，不能由引用题名推出已获得误差界。

[设计] 先从现有专用 Figma 样本读取/导出矢量轮廓，扫描 smoothing=0…1、不同长宽、半径上限和不对称四角，验证公开构造的参数规则。拟合对象应为共享参数规律与轮廓，不是固定 PNG 的补丁。建立规范的 Bézier/圆弧路径后，CPU/GPU/拾取/导出共用该路径。设备空间自适应细分只负责控制离散误差，不能改变目标轮廓。验收同时包括端点/切线、半径受限行为、几何误差上界和真实 PNG；更强的曲率连续性也不能擅自替换 Figma 实际造型。旧 superellipse 样本仍用于它自己的几何合同，不可冒充 Figma 真值。

**6. 玻璃：分开验证距离场、数值链和效果参数。** [源码] 采样合成路径的 CPU/GPU 都有 JFA；距离、梯度、归一化、折射和高光仍含各自浮点表达式。[文献] Rong、Tan 2006 的 [JFA](https://www.comp.nus.edu.sg/~tants/jfa.html)明确是近似距离变换。Felzenszwalb、Huttenlocher 2012 的[距离变换](https://cs.brown.edu/people/pfelzens/papers/dt-final.pdf)适合作为 CPU 精确参考，Cao 等 2010 的 [PBA](https://www.comp.nus.edu.sg/~tants/pba.html)是 GPU 精确 EDT 的候选，移植到 WGSL/WebGL2 的可行性和成本仍需实测。精确 EDT 指定格点种子的最近距离，不等于连续矢量边界的精确距离。

[设计] 先读回 JFA 每阶段种子 ID 和距离平方，再检查 sqrt、梯度、长度、折射坐标和高光的首次差异。若种子已相同，先修正规范算术；不能把当前错误全部归因于 JFA。选种采用可证明不溢出的整数距离平方及固定平局排序。随后用精确 EDT 衡量 JFA 的算法误差，再决定是否替换。用 [PBRT 第四版折射/Fresnel 章节](https://www.pbr-book.org/4ed/Reflection_Models/Specular_Reflection_and_Transmission)建立物理合理参考，但物理参考不能保证复现 Figma 的二维风格化效果。依据官方 [Effect API](https://developers.figma.com/docs/plugins/api/Effect/)补独立 depth、refraction、dispersion、lightAngle、lightIntensity、frost 参数；逐项启用校准，以色条/棋盘格观察折射，以灰背景观察照明，以 RGB 边界观察色散。当前 amount/opacity 的近似映射必须继续排除在同参数验收之外。

**7. 纹理外观与缩放：噪声模型、尺寸、裁剪、滤波。** [文献] [Perlin 的 Improved Noise 参考实现](https://mrl.cs.nyu.edu/~perlin/noise/)可提供平滑梯度噪声候选；Jarzynski、Olano 2020《[Hash Functions for GPU Rendering](https://jcgt.org/published/0009/03/02/paper.pdf)》有助于选确定的整数哈希。没有证据表明 Figma 采用其中某个算法。PBRT 第四版的[纹理采样](https://www.pbr-book.org/4ed/Textures_and_Materials/Texture_Sampling_and_Antialiasing)与[图像纹理过滤](https://www.pbr-book.org/4ed/Textures_and_Materials/Image_Texture)提供采样足迹、MIP 和 EWA 的依据。Perlin 1985《[An Image Synthesizer](https://doi.org/10.1145/325165.325247)》是梯度噪声的原始论文；Lagae 等《[A Survey of Procedural Noise Functions](https://doi.org/10.1111/j.1467-8659.2010.01827.x)》(2010) 给出整域地图；Cook、DeRose 2005《[Wavelet Noise](https://doi.org/10.1145/1186822.1073264)》与 Lagae 等《[Procedural Noise Using Sparse Gabor Convolution](https://graphics.cs.kuleuven.be/publications/LLDD09PNSGC/)》(2009) 是受限频带候选，缩小重采样时可避免走样；O'Neill《[PCG](https://www.pcg-random.org/paper.html)》(2014) 讨论伪随机数生成器家族；将其用于无状态坐标哈希还需要选择输出置换与坐标编码，并独立验证，不能把有状态 PRNG 直接当成二维噪声模型。噪声与哈希候选仍须以位移场统计和 PNG 测量选择，不因文献地位预设 Figma 采用其中某个。 Gabor 作者页面明确列出公式 19–22 的勘误；后续实验须采用作者修订稿，尚未将该算法移入生产。

[设计] 在第 3 项格点合同通过之后，再独立比较单像素随机位移、平滑梯度噪声等候选；通过相关长度、功率谱、位移场与 PNG 测量选择模型。补 noiseSize/二维尺寸、振幅、seed/相位和 clipToShape，先测清裁剪发生在位移前还是最终样本覆盖阶段。缩小需要足迹过滤；直接上 MIP/EWA 只能改善抗锯齿，仍须固定层级、权重、舍入和颜色域，不能依赖硬件采样器默认值获得位一致。测试缩放/动画连续性、格点边界、透明边缘、夹边/透明边界，不能只看一张静止图片。

**8. 渐变、蒙版、描边的 1 色阶与 ICC/PQ/HLG。** [资料] Porter、Duff 1984《[Compositing Digital Images](https://keithp.com/~keithp/porterduff/p253-porter.pdf)》的预乘表示与合成代数是基础；原文也明确讨论仅有 alpha 时对像素内重叠的假设。[W3C Compositing and Blending](https://www.w3.org/TR/compositing-1/)给出预乘合成及分组规则；色彩转换需按 [ICC v4](https://www.color.org/v4spec/)与 [ITU-R BT.2100](https://www.itu.int/rec/R-REC-BT.2100)固定色域、传递函数及亮度定义。原生/CSS/PNG 的实现选择仍需单独验证，不应假定标准定义了 Figma 的每次中间量化。Wallace 1981《[Merging and Transformation of Raster Images for Cartoon Animation](https://doi.org/10.1145/800224.806813)》是预乘合成的另一篇源头；PDF ISO 32000-2 第 11 章的 isolated/knockout 透明组模型可用于对照，但本项目 pass-through 的隔离、效果与蒙版规则仍须逐项验证，不能直接宣称同构。Stokes 等《[A Standard Default Color Space for the Internet: sRGB](https://www.w3.org/Graphics/Color/sRGB.html)》(1996) 是 sRGB 的一手论文；PQ 的原始提案为 Miller、Nezafat《Perceptual Signal Coding for Maximum Dynamic Range》(SMPTE 2014，后标准化为 ST 2084，无公开全文链接)。1/255 渐变差异及“恒定 G/B 色标输出仍变动”的观测指向输出端抖动候选：Floyd、Steinberg 1976《An Adaptive Algorithm for Spatial Greyscale》(Proc. SID 17(2)，无公开全文链接)、Ostromoukhov 2001《[A Simple and Efficient Error-Diffusion Algorithm](https://doi.org/10.1145/383259.383326)》与 Ulichney《[Digital Halftoning](https://books.google.com/books/about/Digital_Halftoning.html?id=2P4hvscEjRYC)》(1987，MIT Press)。抖动核与阈值矩阵的形状必须由密集输入测量确定，文献只提供候选族。

[设计] 列清 decode→颜色空间变换→预乘→过滤/混合→解预乘→encode→输出量化的边界，并注明哪些输入已预乘、哪些阶段处于线性域。Alpha 不执行颜色传递函数；零 alpha 的隐藏 RGB 不能污染过滤。HDR 线性合同和 Figma SDR 兼容合同分别验证。对于 1/255 差异，扫描半字节附近的输入、透明度、嵌套 mask/group、负 RGB 与超白，读回中间状态，定位是 coverage、预乘、resolve、解预乘还是导出量化，不能全局改 `.round()` 追一张图。补非均匀 ICC/PQ/HLG 图片、斜坡/棋盘/透明边、缩放和倾斜采样，现有恒色图通过不能覆盖这些路径。

**9. Figma 外部基准的测量方法。** [已知证据] 同节点的浏览器和 MCP 导出不完全一致；当前严格基准继续固定真实浏览器 PNG、1×、sRGB、参数回读与哈希。[设计] 对 blur 先导出脉冲、水平/垂直阶跃和不同亮度/透明度，在密集半径、缩放、对象位置上扫描，测支撑宽度、质量、对称性与一维/二维可分离性，保留未参与模型选择的样本。滤波形状候选方面，[SVG 1.1 §15.17 feGaussianBlur 的实现注记](https://www.w3.org/TR/SVG11/filters.html#feGaussianBlurElement)给出可检验的具体公式：s≥2.0 时三次连续 box-blur 构成分段二次卷积核，对 Gaussian 核误差约 3%，box 尺寸 d=floor(s·3√(2π)/4+0.5)，d 为偶数时改用两个尺寸 d 与一个尺寸 d+1；现行 [Filter Effects Level 1](https://www.w3.org/TR/filter-effects-1/) 保留 feGaussianBlur 定义但未携带该注记。结合 Figma SVG 导出把图层模糊映射为 feGaussianBlur 的既有观察，可直接用该公式的整数 box 尺寸与支撑宽度作为脉冲响应测量的具体假设；仍不构成 Figma PNG 渲染器采用同一实现的证明。8-bit 导出有量化误差，不能仅凭一个脉冲唯一确定隐藏的连续核。只有实测支持时才选择 Gaussian、box 或 tent 等模型；当前 radius=0.25 的差异已经说明旧有限样本拟合不能外推。内部确定性、数学误差界、Figma 原始字节和性能分别记录；任何近似方案都不能把“较接近”写成零差异通过。

| 实施次序 | 可执行的下一项 | 放行条件 |
| --- | --- | --- |
| A | HDR 2.5 半径的有理系数/精确点积参考，然后扩展半径域 | 每方向 f32 等于独立参考，四后端为零位差；记录吞吐/编译/内存。 |
| B | 纹理格点/采样坐标与玻璃中间阶段读回 | 首次分歧有反例；修复保持参数精度、退化/平局规则一致。 |
| C | analytic 三类后端共用覆盖及合成合同 | 原生入口可执行；全部受测场景零位差，拒绝/缺失不能计通过。 |
| D | Figma 平滑圆角模型及 blur 扫描 | 模型在留出轮廓/PNG 上验证，保留独立几何误差与严格像素两项结果。 |
| E | 玻璃、纹理及色彩参数补齐并扩展组合语料 | 同参数输入才能进入兼容验收；全量既有用例零回退，严格失败持续可见。 |

### 论文与实现的对应关系

前四条为 2026-10-07 研究轮既有对照；其余为 2026-10-08 全量文献扩充补充，完整清单与作用边界见[文献台账](../../testing/review/design-kernel-research-2026-10-08.json)。2026-10-08 的文献补充轮只增加引用与对照；本次实现与运行结果以本文顶部的新检查点为准。

[本次应用，2026-10-09] 浮点文献用于把数学等价的公式拆成可核对的舍入步骤；WGSL 的重排与融合条款用于约束 GPU 实现。当前玻璃路径明确区分普通 binary32 运算、一次舍入的 FMA、Q8 位置量化以及各阶段 RGBA8 存储。论文并未给出本次采用的玻璃边界或 Figma 私有运算图；这些由预先固定候选、独立数值控制及真实 PNG 比较选择。没有按样本 ID 切换算法或提高容差。

- [Goldberg：What Every Computer Scientist Should Know About Floating-Point Arithmetic](https://docs.oracle.com/cd/E19957-01/806-3568/ncg_goldberg.html) 的正确舍入原则落到整数 guard/round/sticky、单次 ties-to-even 和独立有理数测试。没有将“同写一个 float 公式”视为可移植证明。
- [WGSL §15.7.5](https://www.w3.org/TR/WGSL/#reassociation-and-fusion) 允许运算重排和融合，因此受合同约束的基本运算通过整数实现，不能依赖源代码括号阻止 FMA。
- [Shewchuk：Adaptive Precision Floating-Point Arithmetic and Fast Robust Geometric Predicates](https://www.cs.cmu.edu/~quake/robust.html) 的误差界/精确回退思想用于独立描边参考的方向判定；这不是对生产 Boolean/所有几何谓词已稳健化的声明。
- [设计] [Demmel 等：Efficient Reproducible Floating Point Summation and BLAS](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2016/EECS-2016-121.html) 用于下一步滤波归约设计评估。CPU f64 前缀矩与 GPU f32 卷积的差异尚未消除；不能简单降低 CPU 精度或放宽比较来关闭问题，须对照独立高精度卷积及性能/内存实测。
- [设计] Tiller、Hanson 1984《[Offsets of Two-Dimensional Profiles](https://doi.org/10.1109/MCG.1984.275995)》与 Elber、Lee、Kim 1997《[Comparing Offset Curve Approximation Methods](https://doi.org/10.1109/38.586019)》为 `stroke.rs` 的轮廓展开、宽描边与尖点/自交分析提供参照；现行展开合同与预算不变。
- [设计] 曲线布尔的稳健性升级地图是 Fogel 等《[CGAL Arrangements and Their Applications](https://doi.org/10.1007/978-3-642-17283-0)》(2012) 与 Li、Pion、Yap《[Recent Progress in Exact Geometric Computation](https://doi.org/10.1016/j.jlap.2004.07.006)》(2005) 的 exact predicates/exact constructions 模型；flo_curves 0.001 容差折中的替换须单独评估代价，本轮未改动。
- [设计] 文字：Knuth、Plass 1981《[Breaking Paragraphs into Lines](https://doi.org/10.1002/spe.4380111102)》是换行的经典算法；Betrisey 等《[Displaced Filtering for Patterned Displays](https://doi.org/10.1889/1.1832941)》(SID 2000) 是 RGB 子像素滤波与色条纹控制的一手文献，figmaSubpixel 长期保留时的参照。
- [设计] moxcms pxfm 幂函数若要求正确舍入，参照 Ziv《[Fast Evaluation of Elementary Mathematical Functions with Correctly Rounded Last Bit](https://doi.org/10.1145/114697.116813)》(1991) 与 [CR-LIBM](https://crlibm.gitlabpages.inria.fr/)；这高于当前“测得误差界”的标准，本轮未改 moxcms。
- [设计] 第三阶段协作的问题空间正典：Shapiro 等《[Conflict-free Replicated Data Types](https://hal.inria.fr/inria-00609399/document)》(2011) 与 Kleppmann 等《[Local-first Software](https://www.inkandswitch.com/local-first/)》(2019)；接入协作协议前须按其模型重审 schema。
- [基础] 误差自由变换的出处是 Knuth《[TAOCP Vol. 2](https://www-cs-faculty.stanford.edu/~knuth/taocp.html)》与 Møller 1965（BIT 5《Quasi Double-Precision in Floating Point Arithmetic》，无公开链接）；`certified_filter.rs` 向外舍入区间快路径的形式基础是 Moore 一系区间分析，见《[Introduction to Interval Analysis](https://doi.org/10.1137/1.9780898717716)》(SIAM 2009)。

| 顺序 | 当前问题/状态 | 下一次交付及停止条件 |
| --- | --- | --- |
| 1 | [源码] CPU 内存计费和图片生命周期已修改 | 先通过红绿回归、完整 Rust/WASM、本机 GPU 和像素基线比较；结果与失败项写入台账。 |
| 2 | [局部已验证/持续扩展] 192 场景门禁通过，新边界场景已增至 201 | 持续扩展输入并全范围复测，必须零差异。后续接入专用 CI 硬件 runner，不能将本机执行描述为 CI 已强制。 |
| 3 | [源码] coherent 采样图已固定并增加无关节点差分 | 扩展透明 paint、嵌套 backdrop 与瓦片边界；有限回归不外推为所有组合已证明。 |
| 4 | [源码/待验证] 折线 Boolean 与曲线 Boolean 是不同入口 | 先补同输入、不同填充规则/尺度、量化键碰撞与预算拒绝的交叉测试；修正不实错误消息。拓扑失败应保留作者输入和可恢复错误，不能擅自返回空路径。合并实现前列明 stroke outline/shape builder 的语义和预算变化。 |
| 5 | [设计] shader 与合成代数的重复维护 | 先收集 WGSL/GLSL/stencil 回退在现有夹具上的差异，再评估单源生成或共享 IR。Naga 是待实验候选，未接入、未证明所有目标可用；迁移先通过编译、资源布局、覆盖和完整像素检查。 |
| 6 | [设计] 所有权、整图复制与跨边界传输 | 基于实际编辑 trace 拆文档/派生场景/资源/统计；建立不可变渲染输入，再安排瓦片并行。分别测 JSON 场景搬运、文字颜色变更的轮廓失效和 native 纹理池，禁止用单点微基准代替整帧/交互结果。 |
| 7 | [设计] schema 与服务端生命周期 | 对照前端特性探测和 Rust 验证增加共享语料；补版本不匹配、渲染时限/取消、访问记录及版本/回执保留策略。删除版本或回执前先定义幂等窗口与恢复合同，不直接清理数据。 |

## 需要校准的评审结论

- [源码] 多份合成器、手写 shader 仍存在；硬件测试通过 `cfg_attr(not(feature="hardware-tests"), ignore)` 控制。此前显式运行过硬件样例不代表默认 CI 自动执行；本轮本机结果也不替代未来的强制门禁。
- [源码] `Surface::rgba8` 的最终直通 alpha 输出和 GPU readback 使用 half-up；中间预乘 UNORM/Q24 使用 ties-to-even。本轮保持直通 alpha 出口合同，改动的是中间计算、采样图与精度格式；外部 Figma 参考不能随内部基线更新而覆盖。
- [源码] alpha mask 的 opacity=0.3 本身仍有可见覆盖，不能归类为“完全遮蔽”。黑色 luminance、图像透明像素、paint 颜色 alpha 等仍需拾取/渲染专项对照；现有充分空蒙版判定只覆盖受限的叶形 solid paint。
- [源码] 单个 `unwrap`/`expect` 的计数不能证明可触发崩溃；需要由文档准入、矩形边界和真实调用路径给出反例。对外输入的失败必须有明确错误，但不能把已证明的内部不变量统一改成静默跳过。
- [未验证] 浏览器 `Renderer.tsx` 与 Rust SVG 导出的实际用户调用链、效果拒绝与栅格化边界需要分开核对，不能仅因二者都输出 SVG 就认定同一个交付路径。

## 每轮本地验收

1. 先在保存的源码/产物基线上复现具体反例，再改动；保留失败证据。新功能或错误门槛变化须说明适用范围。
2. 运行受影响 Rust 测试与全 workspace 检查；GPU 改动必须显式运行硬件用例。运行当前源码构建的 WASM、前端测试/类型/构建；需要实际交互时补浏览器，未运行的范围明确标注。
3. 数值修改必须对照固定像素/几何基线。本轮新增 `bun scripts/check-cpu-baseline.ts <保存的 design_kernel.js>`，从同目录加载对应 WASM，逐场景/剖面对比 CPU RGBA SHA-256。它不证明 Figma 一致性或 GPU 一致性。
4. 执行 `python3 scripts/check-foundation.py`、格式/lint 和文档链接核查；按实际变更更新测试目录。只记录本轮真实命令退出状态，不沿用旧报告的通过数。
5. 一轮只收敛已验证的路径与说明；下一项继续按独立反例和验收推进。发布、推送与线上数据操作另按用户授权执行。
