# 拓扑素材：高倍率阴影、切换与滚动修复

本记录区分源码、单元/CPU 证明、真实 Electron/WebGPU 行为。没有完成全 G2/G5，也不能把旧帧仍可见或“没有报错”当作完成精修。

## 10月26日检查点（最新进展见文末10月27日续轮）

源码已接入**默认的有界 SDR 画布阴影入口**，不依赖原有四个全局实验开关。私有证明由实际上传的原始系数生成，并绑定 GPU 资源、物理尺寸及精确半径；拷贝公开字段、替换资源、任意写入或关闭该入口都不能继承证明。HDR 与非画布输出不进入新增默认入口。内存预算、纹理尺寸、64 KiB 系数包和普通 `tent` 的 2048 上限保持原样。

- 全局实验关闭后的 9 组 Metal 浮点对照：全部逐位零差异，含 2240 / 2240.125 / 4096、alpha-only、极端值与非有限回退。见 `bounded-shadow-hardware.json`。
- 矩形/椭圆 × 中心/内侧/外侧描边的 6 组完整图形 GPU 对照：全部逐位零差异，确认实际分条源路径被执行。见 `stroke-shadow-hardware.json`。首例包含冷编译，不用其 wall time 宣称性能倍数。
- 默认运行版本已记录 3200%、DPR2、target/effective density=64、`finalComplete=1`，相机为 UI `x=-239801.2040071957, y=-161515.73097340637`。这是已测视口证据，不能扩展为整份文件所有位置通过。
- 用户随后触发的约1755%位置对应“入库”图标的两片带描边底座（下文记录）。源码与完整 GPU 描边 oracle 已覆盖，**该精确 GUI 位置的最终复测尚未完成**。
- Mac 锁屏后，CUA 明确拒绝继续并要求手动解锁。已向用户请求解锁。日常窗口尚未替换；最新待复测构建为 `/tmp/futureox-topology-ready-build-20261026`。当前验证窗口与用户缓存保留。

本轮未实现通用 mip 调度替换、把整个 React 相机路径移到 Worker，亦未完成16ms级交互、全G5矩阵或完整HDR/export验收。现有日志不足以把所有卡顿归因于React。


## 已确认的根因

- 最初 3200%（DPR=2，渲染 zoom=64）中心相机：`x=-460584.99999999994, y=-354075.99999999994`。旧构建申请 12698×6463 RGBA32F，单表面 1,313,074,784 bytes，超过 1 GiB GPU 工作预算。拆外层瓦片后仍申请约 1.18 GiB。
- 日志 `failureAllocationPassMode` **存储 mode+1**。记录 48 表示实际 mode47 填充合成，不能解释成 mode48 采样合并。对话中早期误读已更正。
- 真实模型的阴影 `D5E7EF42-2758-4DBC-A638-F86198DA7690`（radius35，offset10/15）被旧保守 halo 误纳入中心附近瓦片。受限的 managed/figmaSubpixel 纯色叶子支持范围证明将其剔除；4 个旧巨型编译区域 → 0，保持滤镜半径与所有预算。
- 另一视口：选择“路径”文字后适合选择，zoom=38.85880458613523（界面1942.9402%，DPR2），相机 `x=-301077.91163427074, y=-245114.0618509239`。偏移阴影不能使用原来的零偏移分条路径；多张约5684×4409浮点表面超预算。
- 分条阴影候选 v3 消除了该立即分配失败，但首块实际 `finishMs=5862.1`，下一块触发30秒预览看门狗。重置后 CPU 回退又报 `Combined filter dependency halo exceeds 2048 device pixels`。这不是修好，候选失败保留。
- v4 对有限纯色叶子裁掉已知透明的输入区域，同时保留 prefix 的输出必须在输入内的约束。首块编码像素 512,298,443 → 308,665,887，等待GPU完成 5862.1 → 3748.6ms，峰值纹理 972,212,224 → 613,444,144 bytes；整个请求仍超时，不能验收。

## 新日志

`CORE_RENDER_DIAGNOSTICS=detail` 下记录：实际纹理宽高/硬件尺寸上限/像素字节数/分配位置，按 shader mode 与 coverage/paint/merge/copy/effect 分组的编码 draw 计数；frameKey 与瓦片规划的主线程耗时。只输出受限数值，不输出文档、任意异常文本或堆栈。

- 基线 `live-render.log`：初始20瓦片66,429 draws；覆盖17,108，复制14,548，合并12,653，填充合并12,268，普通填充6,928，滤镜844，其他2,060，呈现14。计数不是各类GPU耗时。
- frameKey（阶段40）1398次，最高约0.1ms；瓦片规划（阶段41）12次，最高约5.2ms。不能据此将此前166–184ms停顿直接归因到这两段。
- `renderResetCode`：0未知、1请求/预览看门狗、2渲染Worker错误、3准备Worker错误、4文档同步超时、5关闭。失败码136=CPU组合滤镜halo限制，137=瓦片预览超时。重置原因与后续回退错误分别记录。
- drawMode63是诊断用的stencil coverage分类，61是solid batch；实际shader mode60为color-controls，归入effect。

重算日志摘要：

```sh
node testing/verification-topology-navigation-20261026/summarize-render-log.mjs INPUT.log OUTPUT.json
```

## 源码修复与验证边界

- PatternTile alignment 与 Rust 序列化契约对齐，旧 TS 校验拒绝合法 `[start,start]`。真实页面切换控件页773场景节点（加依赖953）已在GUI载入且完成绘制；负控制与修复后4项测试见 alignment 日志。
- CanvasScrollbars 拖动冻结滑块范围；从 flushPendingView 后的相机建立映射；向渲染器传递 held/released；取消/丢捕获/换页释放状态；忽略旧 pointerId。6项测试通过，真实控件页拖动滑块50→52。
- Rust 新支持证明只做离屏剔除，不缩小仍被消费的效果输入。3项原生测试通过，真实素材CPU编译对照见 compile-probe / compile-probe-after。
- 偏移阴影分条：独立计算 shadow读取窗口与sharp foreground窗口，逐轴证明f32双线性相位一致，必要时扩大窗口；仍保留源坐标、原生滤镜系数、四采样顺序、H/V舍入边界。
- v5：仅在旧prefix不能加速的大半径小数阴影上计算alpha，保留RGBA存储与拷贝、原有整数/可加速prefix路径。GUI验收待续；不可把此候选称作完整修复。

## 构建与隔离

默认用户实例PID61119未被本次重启。测试使用复制的官方Electron运行时与独立临时profile，没有覆盖源Sketch；源文件始终按源工作集路径读取。测试窗口名称含“渲染诊断（自动预算）”。

- 基线：`/tmp/futureox-topology-diagnostics-build-20261026`
- culling/scrollbars：`/tmp/futureox-topology-candidate-v2-build-20261026`
- shifted shadow：`/tmp/futureox-topology-candidate-v3b-build-20261026`
- source support：`/tmp/futureox-topology-candidate-v4-build-20261026`
- alpha：`/tmp/futureox-topology-candidate-v5-build-20261026`

各目录内build-manifest绑定实际源码/产物。第一次候选构建因构建期间日志分类源码发生变化被一致性检查拒绝；一次测试导入Surface类型错误修正后重建。保留失败日志，不将其算作通过。未提升GPU/文档预算，未启用默认关闭的whole-tent、wide-rational或降质实验。


## 后续候选与最终默认入口

v5 同一1942.9402%视口终于完成20瓦片（界面“WebGPU · 清晰”），但GPU完成等待累计125,554.3ms、编码3,969,515,216像素位置，仍不合格。显式宽前缀候选把同视口等待降到28,317.6ms；再只处理阴影alpha后降到9,748.4ms。以上都是队列完成的CPU等待累计，不是GPU timestamp或输入到光子时间。冷编译、编码与准备另外记录，不能把这些比值当作整编辑器FPS倍数。

3200%时半径35的阴影实际半径为35×32×DPR2=2240。原先绕过2048分条入口后，会再次申请约12248×10188的完整表面。新增 `RationalKernel::large_tent` 是独立构造器，普通 `tent` 仍拒绝>2048；新构造器保留精确质量和64KiB包容量预检。首次验证暴露了容量assert和GPU旧上限拒绝加速，两者的失败报告均保留。一次测试发生device lost，后续重跑未复现，原因未认定。

新默认入口仅由实际 WebGPU 私有上传证明授权，缓存键隔离于旧运算符。支持半径上限4096，但只有完整支持范围在既有矩形、纹理与总字节限制内才可执行，并不承诺任意对象/效果都可在4096渲染。对只有大阴影的场景，在通过窗口准入后延迟准备prefix管线，并重新检查取消；4MiB scratch仍经原准入。可用 `VITE_DESIGN_BOUNDED_SHADOW_TENT=0` 禁用该默认入口；这不是抬高预算的开关。

用户新位置的日志为render zoom=35.101904052856575、相机 `x=-252966.15636880978,y=-167570.0467469671`。两节点 `4D85D82E-1CF0-4D02-9220-1A23665FA217` 与 `7131EEE0-3D81-4671-9CB1-1A47D53863E1` 均为纯色、单描边、偏移阴影。旧source支持谓词拒绝所有描边。现在只有分条滤镜入口可以显式接受已编译area描边，保留填充→子图→描边顺序和inside/outside覆盖乘法；其他image-only缓存/近似入口仍使用旧的无描边谓词。已知零区域裁切计算填充与描边支持并集。

最终检查：`scoped-shadow-tests.log` 127项通过；`default-regression-tests.log` 78项通过；`final-node-regressions.log` 84项通过；类型检查及构建成功。它们存在覆盖重叠，不相加成全仓库测试数。最后小范围检查与最新构建见 `final-targeted-tests.log` / `ready-build.log`。

### 验收边界

| 门 | 状态 | 本轮范围 |
|---|---|---|
| G1 | PASS（局部） | UI输入→既有Editor→Rust场景/系数→WebGPU；独立源码/产物manifest |
| G2 | 部分视口PASS；最终1755%复测BLOCKED | 当前Mac锁屏，不能把单个3200%视口推广为全应用 |
| G3 | PASS（15组硬件算子/图形案例） | 全HDR/export与组合矩阵NOT_RUN；默认新增入口排除HDR/非画布输出 |
| G4 | PASS（观测） | 编码draw、CPU阶段、GPU完成等待分别记录；未测物理呈现延迟 |
| G5 | NOT_RUN | 未执行固定六格及全部真实档完整矩阵 |
| G7 | BLOCKED（最终联合运行） | 构建manifest、实验算子hash与报告hash已保存；最终冻结构建的GUI/整套硬件复跑待解锁 |
| 日常应用替换 | BLOCKED | 等用户解锁后保存/复测/重启，未声称当前日常窗口已更新 |

原始逆向资料中的每瓦片6–12ms不是实测oracle。这里的原生像素密度完成、主线程rAF、GPU等待和实际操作顺滑度是四种不同证据。


## 最后构建与恢复入口

`ready-build.log` 成功，`ready-build-provenance.json` 绑定2249个源输入及30个产物hash；`final-targeted-tests.log` 33项通过，`final-node-regressions.log` 84项通过，`diff-check.log` 无错误。`hardware-report-assertions.log` 的退出码0验证已有15个硬件报告案例；它不是另一次GPU运行。已有默认/描边硬件报告没有独立的完整预运行源码快照，因此最终冻结产物还需在解锁后复跑，不用事后hash冒充预先冻结证据。

Mac锁屏时保留的窗口：日常原窗口（本轮未重启）；旧“渲染诊断（自动预算）”；较新的“默认修复验证”。后两者都是隔离profile。用户曾操作它们，所以未在锁屏时强行关闭或替换。恢复操作前应按应用完整路径和窗口标题重新确认，保存当前内容，再切换构建；不能在旧窗口仍运行时仅替换其dist链接。

新默认构建 `/tmp/futureox-topology-ready-build-20261026` 已准备，尚未复制到日常 `frontend/design-desktop/dist`。最新验证窗口的路径/PID见 `default-runtime.json`，旧候选见 `large-shadow-runtime.json`；PID仅为当时记录，操作前须核实进程路径，不能盲用旧PID。

## 2026-10-27 继续：真实页面流程的新阻塞

桌面已解锁。使用新联合源码、全局旧实验关闭的构建 `/tmp/futureox-topology-20261027-baseline` 重开源文件：

- “入库”140×140 编组，1755.0952%：16 瓦片完成；`finishMs` 累计7389ms。平移后render相机`(-252965.7282210959,-167569.93564560584,35.101904052856575)`，与前次失败位置接近（并非逐位相同），8块新瓦片完成。
- 同一图标3200%，render相机`(-461926.92150742223,-306238.64199543616,64)`：16瓦片、43436 draws，`finishMs`累计5745.1ms；GUI为“WebGPU · 清晰”。见 `continuation-3200-stroked.png` / `.ax.txt` 和 `continuation-live-render-v4.log`。
- 正反向平移观测窗口起点1793063091580：主线程最大帧间隔233.8ms，仍不能称流畅。它不是GPU timestamp或输入到光子延迟。
- 通过真实界面导出完整文件：原档/导出均64成员，解压后所有成员逐字节相同，3页顶层对象209/55/42，见 `continuation-export-integrity.json`。副本已通过GUI重新打开。不是只导出当前4022节点的工作集。
- 控件整页载入并达到“清晰”，953可见/依赖节点（原生场景773节点）。旧搜索“入库”跨页残留导致图层显示0，已增加页面/会话边界重置；3项mounted React测试验证切页、同ID工作集替换和同页相机保留查询。

### 派生文档准入与页面范围

约101.2MB文档限额的真实窗口中，深色页原生首段11根、20714节点、94,633,100字节通过；后续编辑准备得到107,604,294字节时被WASM拒绝。**原生源范围准入不能证明派生模型也能进入Editor。** 具体派生字段增长还需单独分解，不将所有差额直接归因于节点数。

新增场景请求`limit`只收窄连续源根数量，不选择或抬高内存策略。只有实际`DOCUMENT_RESOURCE_LIMIT`/`DOCUMENT_TOO_LARGE`准备失败，且范围超过一个根、仍持有同一源/请求且未取消时，UI才在相同offset以更小范围重试。前后页保存精确offset/limit；失败仍恢复原画布及其原生保存基线。前端14项、宿主9项、原生范围测试通过；新分支的最终真实GUI命中仍待复测。

`continuation-page-segments-before.log` 是同一101.2MB额度下的真实原生全源遍历：控件1段42根，深色2段55根，浅色5段209根；全部306根顺序覆盖、无重复。**这是原生转换，不能替代后续Editor派生和GPU。**

### 深色页大PNG阻塞与分行候选

另一自动预算窗口的深色首段能进入Editor，但GPU图阶段失败：`Decoded image budget exceeded: 5162x2784 source pixels cannot fit without loss; automatic downsampling is disabled`。实际原档另有4张超过8388608像素的PNG，均为8位、非交错。这个故障与阴影表面、源页预算不同。旧日志code0现补为严格固定格式的141分类，不泄露源文件/异常内容。

`image_rows.rs` 与WASM `ImageRowDecoder`提供独立的有界PNG行流：沿用原始ICC/cICP、image crate通道转换、原生工作色与预乘计算，每段最多262144像素/4MiB RGBA32F。只处理已明确支持的非交错、无旋转、8位展开PNG，普通整图解码、16位输入准入、HDR颜色算法和现有预算不变。GPU仍分配经原账本准入的原尺寸纹理；失败销毁未发布纹理，完整连续行验证后才授予finite标记，不伪造整图滤波范围证书。暂不声称JPEG/交错/旋转大图支持或异步行上传延迟已验收。

- `image-rows-native-final.log`：3项通过，包含8个颜色/通道配置的逐位对照、大图原路径仍拒绝、截断尾部拒绝。
- `image-rows-client-tests.log`：68项通过；首轮类型错误已在`image-rows-typecheck-v2.log`修复通过。
- `row-upload-hardware-20261027.json`：Apple Metal3，非fallback，完整19,564分量的整图/分行GPU上传零差异；真实5162×2784 PNG的57,484,032分量零差异，56段，最大4,129,600字节。完整图数学对照来自原生小图测试；真实大图这一项证明原生行输出到GPU存储没有改变。4912.8ms包括解码、上传、回读与再次原生校对，不是画布FPS。
- 两次硬件夹具声明错误（schema/fine coverage）保留在`row-upload-fixture-*-failure.json`，不计为通过。
- `image-rows-desktop-build.log`因共享原型文件变化拒绝；`image-rows-desktop-build-v2.log`完整成功，产物`/tmp/futureox-topology-20261027-image-rows-v2`。
- 静态硬件包`/tmp/topology-hardware-frozen-20261027-v3`的来源/产物冻结在`frozen-hardware-20261027.json`。早期v1/v2夹具包另存清单，测试不再依赖HMR。

### 未采用的队列候选

`VITE_DESIGN_RASTER_BACKPRESSURE=1`让CPU编码任务在已有GPU提交完成后再续写，等待期间可处理相机消息，不回收帧资源或推进资源epoch。50项生命周期/取消测试通过。首屏相同66429 draws的单次样本，graph+finish约8566→8934ms，等待主要搬到了checkpoint；尚无完整运动收益证明，因此**默认关闭**，最终图片修复构建也关闭它。不要把finish等待减少当作加速。

仍需完成：新默认大图构建的真实深色/浅色范围载入及3200往返、自动缩段GUI命中、冻结构建的阴影硬件复跑、全部页面导航/滚动/编辑收敛与日常窗口更新。全G2/G5仍未关闭。

10月27日冻结包硬件复跑已完成：9组大阴影、6组完整描边图形、2组图片上传均零位差异，见 `hardware-20261027-assertions.json` 与三个当日报告。该断言文件是已有硬件结果的只读核对，不是新一次GPU运行。

## 2026-10-27 用户改为全源单画板、取消产品容量上限

新需求以[全源单画布容量契约](../../docs/SOURCE_CANVAS_CAPACITY_20261027.zh-CN.md)为准。前面页面分段验证仍是历史证据，不是当前交付目标。已完成原生 `large.canvasLayout` 和桌面桥接；尚未将全部素材接到一个实际可编辑呈现面。

本次源索引用显式堆帧替代递归调用，取消 128 层/16 KiB 键/百万条目以及 Sketch 源归档 4096 成员、200 倍压缩率拒收。导航位置采用原生地址宽度；桌面与保存回执的对象键不再使用固定十进制位数上限。源偏移精确性、物理存储空间、实际长度/CRC、重复成员与危险路径校验保留。

- `source-index-unlimited-tests.log`：24 项通过，覆盖 1,000,001 个对象、20,000 层嵌套、128 KiB 键/元数据、深层无效语法/重复键及原始字节保持。
- `source-capacity-native-tests-v2.log`：53 项通过、8 项显式忽略；4097 个素材成员、高压缩比 JSON、长成员名完整导出与缓存恢复通过。初次新增夹具缺少必要 meta.json 失败保留在 `source-capacity-native-tests.log`，补齐夹具后重跑。
- `single-canvas-catalogue-native.log` / `single-canvas-catalogue.json`：真实原文件 SHA-256 `b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12`，306 素材，浅色 209 / 深色 55 / 控件 42；55 artboard / 47 group / 162 shapePath / 42 symbolMaster。布局提示范围为 16760 × 30640.180053710938。此为数据索引，不是像素验收。
- `source-capacity-client-tests.log`：15 项通过，包含保存回执键、原工作区失败恢复及图层搜索恢复。`source-capacity-host-tests.log`：桌面桥接测试。
- `image-rows-unlimited-source-tests-v2.log`：原生 4 项通过，超过 8192 的高图和 4097 × 4096 的源保留全部像素，与小原生参考逐位一致。初次独立预期用了除以 255，而 image crate 的转换舍入不同；失败在 v1 日志中保留，改为原生小参考后重跑。继续追加 16 位与超过 12 MiB 编码测试，结果见后续 v3/v4 日志。
- `image-row-source-routing-tests.log`：56 项通过；超大编码/尺寸的 PNG 会进入分行路径，GPU 上传仍受实际设备和存活资源校验。

这些改动不等于所有图片格式、所有工作集或全局渲染已无固定拒收。主画布尚未接上源瓦片取数，不能声明完成用户的全源单画板目标。没有修改原始拓扑素材。

补充结果：`single-canvas-catalogue-native-v2.log` 用新堆帧解析器重跑真实源索引及完整导出，306 个素材齐全、64 个归档成员解压内容 SHA-256 全等，47.24 秒（包含索引、导出和双份归档解压核对，不是渲染耗时）。`image-rows-unlimited-source-tests-v4.log` 六项通过，补充 16 位四种通道逐位对照及超过 12 MiB 编码 URI 的完整条带读取。完整 Rust/WASM/Electron 构建 `source-capacity-desktop-build-v6.log` 通过，构建时间戳 `2026-10-27T04:43:20.151Z`，2265 个输入文件记录于独立产物 manifest。该构建尚未证明全源单画布呈现。

v6 实机续验：独立 Electron 的标准“导入 Sketch / FIG / SVG / PDF”入口载入 `topology-verified-20261027.sketch`（此前核对过其全部 64 成员与原文件一致）。源页切换到深色，当前动态预算载入 1–6/55，图层面板显示 12212。5162 × 2784 PNG 在实际 GPU 路径完成 56 条、14,371,008 像素上传，最大条带 4,129,600 字节；数值日志 `imageRowOutcome=1`，CPU 解码/上传提交跨度约 2413.8ms。最终真实界面显示“WebGPU · 清晰”，截图/AX 见 `source-capacity-v6-deep.png`、`source-capacity-v6-deep.ax.txt`，日志 `source-capacity-v6-gui.log`。这关闭了这一个大图片/累计缓存拒收用例，不是全源单画板或交互帧率验收。主页“打开设计文件”仍只接受 FD，Sketch 目前走独立导入入口。

源转换缓存后续候选（晚于 v6，尚未重建到 GUI）：按会话源版本保存不可变转换窗口到独立临时磁盘目录，缓存损坏时从原源重建；取消/源修改不发布旧内容，原生编辑基线不变。`source-window-cache-native-initial.log` 53 项通过、8 忽略；专门的复用/损坏/取消/版本更新/冷成员导出测试 `source-window-cache-tests.log` 通过。真实 4022 节点 / 30,823,039 字节画板两次返回同一 SHA-256 `18f645800e8961c2230e3433ca7e4eefa7a6ddebeab587e8103291ab8fa370b9`；完整 native scene 调用 2.478s → 0.657s（`source-window-cache-real.log`）。这是同进程首次/再次源转换数据，不是 GUI 切换总延迟或 GPU 渲染收益。

原生单画板后续候选：新增 `large.canvasSnapshot`，通过既有 codec/共享 Document 合并全部源根，平移到完整目录的位置，并包在一个不裁切的真实 frame 中；原始源与编辑基线保持独立。完整 JSON 留在原生磁盘，不送入前端单字符串。`single-canvas-native-snapshot-tests.log` 小夹具验证一个画板包含全部原子树、坐标、缓存复用、取消保持以及原源导出字节不变。`single-canvas-native-snapshot-real.log` 真实拓扑完成：306 根、124447 节点、573894001 字节、SHA-256 `19a5d13571b1917c71f3ffa7cd4f2a42fc44b52af051c6a7b9614b1755639259`；原生生成约 105.25 秒，整轮含索引/复制约 129.41 秒；`time -l` 最大 RSS 1554481152 字节。原生输出为本轮临时验证文件，不是 GUI 完成或发布包。接入原生准备器、完整画布、选择/属性修改/保存仍在进行。

原生准备链路续验：初次直接读取完整模型在主进程继承的 138174464 字节预算下误拒 124447 个节点（`native-source-preparation-real-initial.json`）；此时 Node 的 macOS free-memory 读数未包含 inactive 队列。主进程现已使用固定 vm_stat 查询，另给主进程授权的原生源快照建立私有请求作用域：逻辑源字节/节点/页不再套 JS/WASM 载体配额；该作用域不能由文档字段设置，线程隔离、嵌套及异常恢复测试通过，普通调用和几何/格式/设备校验不变。该内存驻留原生模型仍不是任意规模场景的磁盘分页完成证明。

`native-source-preparation-real-v2.json`：完整 573894001 字节模型流式读入并签发状态回执约 11.489 秒；首个 64×64 范围的 GPU 程序编译约 16.123 秒、227344 字节，均成功。仅为原生读取/编译，不是 GPU 像素或 GUI。桌面 source capability 测试 17 项、连同内存/传输测试共 25 项通过；原生准备器 17 项通过。前端源 worker 仅发送标量 token/owner，专门 client/状态/准备通道测试 `native-source-worker-tests.log` 47 项通过，TypeScript 检查通过；尚未连接完整工作台呈现。诊断方法编号新增曾插在中间导致旧编号测试失败，已改为末尾追加，失败与修复日志分别保留。

原生全源呈现候选继续接入：`NativeSourceSurface` 使用既有原生编译、GPU worker 和 resident presenter，视口/瓦片状态保留在命令式缓存中；“清晰”仅在当前视口的完整原生密度瓦片得到实际显示 ACK 后发布。独立 `native-source-check.html` 用于真实 GUI 检查，尚未替代主工作台；编辑、保存和冷对象选择仍未接入。第 v7 次完整构建遇共享目录中新 SVG 导出模块当时缺少符号而失败，日志保留；重新读取时该模块已有后续补齐，未回退/重写其他任务代码，开始 v8 重新构建。

v8 整图 GUI 失败证据：验证页直接使用测试 HTML 路径时被生产 IPC 页面身份检查拒绝（`native-canvas-v8-gui.log`），没有关闭或绕过 sender 校验。另建隔离验证资源目录，将同一已构建验证页作为 index.html 入口；原始 v8 构建不改，入口映射和 hash 记录在其独立 entry manifest。实际选择此前 64 成员已核对的 `topology-verified-20261027.sketch`，sourceHash `498098eb5e390e7088245c267a01896b1b832ad61098faddb1fba35f5ac8da86`，展开 831806447 字节。306 素材 / 124447 节点进入原生准备，但首个视口瓦片递归细分后失败：代码 131 / `Scene path budget exceeded`，26 次编译、14 次 graph 尝试，94.37 秒仍未交付首块可见瓦片。该候选不通过全图呈现。

同时发现验证组件错误提示改变高度后自动触发重试，错误又被“计算中”覆盖。已增加错误锁存，尺寸变化不再自行重试；v8 失败截图 `native-canvas-v8-path-limit.png` 和完整日志 `native-canvas-v8-entry-gui.log` 保留。后续 v9 将原生源作用域中的场景路径计数从固定 2000000 改为精确计数/地址溢出检查；普通路径策略与实际区域/设备分配检查保持原状。边界测试 `native-source-path-capacity-tests.log` 通过，必须重建并重新跑真实画面后才能宣称故障关闭。

v9 代码检查：`native-source-error-latch-tests.log` 真实挂载 React 控制器，模拟不可恢复渲染错误及随后视口高度变化，确认只发送初始同步和一次绘制，不自行循环重试；测试通过。v9 完整 Rust/WASM/桌面构建 `native-canvas-desktop-build-v9.log` 通过。下一次整图 GUI 仍需独立判定，不能用边界测试或构建替代。

v9 全图运行越过路径计数拒收，但首次绘制在 30 秒预览 watchdog 被终止，代码 137（`native-canvas-v9-gui.log`、`native-canvas-v9-timeout.png`）。原生首块程序约 13.8 秒编译成功，终止前 GPU driver 已持续提交到 97626 draw calls，并非没有工作进展。后续新增独立工作进度：实际编译完成、真实编码并提交的 draw-call 进展才续期预览 watchdog；重复/无效消息不能续期，进度消息不触发瓦片回调或“清晰”状态。`native-source-progress-tests.log` 70 项通过，v10 构建通过。性能成本仍需继续量化，续期只是避免误杀，不能称作加速。

v10 能在原生全量场景中完成 21.305% 的视口显示，真实截图 `native-canvas-v10-ready-21percent.png` 同时包含浅色/深色素材。该轮镜头在全览结束前发生缩放，不能作为固定全览时序或 FPS 配对。回到适合画板后触发另一固定门槛：`GPU frame command work budget exceeded`（27），截图 `native-canvas-v10-command-limit.png`；已有画面保留。核对发现新验证组件直接用了文件的 Figma 导出 profile，漏掉正常画布已有的 canvasSamplingProfile 映射；v11 改为复用正常画布 profile（保持四相关采样、原有浮点策略），尚未独立跑 GUI。

后续 v12 去掉 uniform allocator 的每帧 262144 条指令拒收，保留原有小 arena、队列顺序提交后复用及计数精确性。真实 production driver 的缩小 arena 测试跨旧边界核对所有提交字节/顺序，并确认 arena 未增大。GPU submit/fence 日志补充已有 pass 分类计数，便于持续观察昂贵尚未结束的图，而不是等整块完成才看到分解。

v12 取消指令总量配额后持续完成真实瓦片，无 27/131 错误，但全览仍慢。首块实际 252936 draw calls，其中 coverage 61100、paint 39724、merge 66469、effect 2098、paint+merge 25604、copy 36925；约 19.45s 编译、53.05s graph，属于多次重试/分块的累计开销。日志 `failure-summary` 94 表明普通 8 MiB 聚合几何程序门槛触发区域重编译。后续候选让原生源使用既有 32 MiB 聚合 packet 路径，保留单路径/设备存储校验和区域细分，不改变像素算术。

同时增加新视口优先：相机跨越两个密度档以上或离开在绘瓦片时，取消已经无用的原生编译/光栅工作；仅取消预览，不取消源保存/导出。编码阶段仍沿用现有 GPU 资源提交/退役边界。原生测试误用了不存在的 `gpu::tests` 过滤器，`native-source-packet-native-tests.log` 实际为 0 tests，不能列为通过的渲染测试；该增量仍待真实编译/GUI及正确的原生用例验证。

v12 完整平铺全览已实际显示：点击“适合画板”后缩放 2.467%，GUI 显示 306 素材 / 124447 节点 / WebGPU · 清晰，画面同时可见浅色、深色、控件。证据 `native-canvas-v12-fit.png`、`native-canvas-v12-fit.ax.txt`。该运行中镜头有多次外部操作，不能用全过程 wall 时间当固定首次载入/FPS 配对；复杂瓦片仍达数十秒。本阶段只证明完整源模型的一张画板呈现，正式编辑工作台、3200% 全源视口、保存/重开和平铺布局编辑尚未闭合。


### 正式工作区 v15 与原生时长/相机修正（2026-10-27）

- v15 完整构建通过，正常 `index.html` 工作区从菜单打开 `topology-verified-20261027.sketch`，实际进入 306 素材、124447 节点的原生单画布；左侧为素材列表，单击定位全局位置，双击仍进入已有局部属性编辑。这是正式呈现接线，不是直接全源编辑完成。
- 本轮修正素材行缺少 CSS 类、返回按钮宽度、局部编辑时素材列表占满侧栏的问题。新增原生显示状态持续标记，当前相位、全部瓦片和实际提交 ACK 才能显示“清晰”；加载/绘制状态不再写成“文件已就绪”。
- v12 后续运动仍见 30 秒预览错误；原生大源的一个编译阶段可超过该时长。现在 source render 不设前端固定时长拒收，私有授权的原生 source lane 不设 120 秒处理时长拒收；普通输入/任务仍保留原协议。取消、线程/设备错误、序列和所有权校验保留。客户端 25 项和宿主 6 项定向测试通过（见 `native-source-duration-*.log`）。
- 相机去掉 2.5%–3200% 产品范围，保留有限正数与溢出校验。源全览不能因为固定最小缩放而缺角，存储相机也不截断。64 项定向回归通过，见 `native-source-unbounded-camera-tests-v2.log`。扩展测试起初将 64x 加入旧 ±1e7 坐标/1e-7 px 阈值矩阵，触发 1.192e-7 的浮点量化差；未放宽旧精度阈值，原精度矩阵保留，新倍率使用独立锚点与往返测试。不是任意大倍率 GPU 精确性证明。
- v15 的 `native-workbench-v15-3200.png` 是空白区域，不能作为拓扑图标高倍通过。正常 43.9% 首个素材的 30 个图标实际可见；后续固定世界中心 (878,278) 对应“入库”及偏移描边阴影。
- v16 首次构建因 DesktopBridge 缺少已有 preload 诊断属性的 TypeScript 声明失败；已补类型，失败日志保留。所有旧未验 GPU 实验仍为关闭，暂无配对流畅性/FPS 完成声明。


### v17 真实完整源：3200% 图标与返回全览

- 不再用空白视口验收。完整原生源 306 根/124447 节点，固定世界中心 `(878,278)`、CSS zoom=32、DPR=2。在同一原生完整 Document 上显示“入库”的渐变、透明叠层与偏移描边阴影，GUI 达到 `WebGPU · 清晰`。截图 `native-canvas-v17-3200-inbound.png`、完整 AX 和数值记录 `native-canvas-v17-3200-report.json` 已保存。
- 随后实际点击“适合画板”，2.467% 全览最终完成，全部浅色/深色/控件素材同时位于同一画板，截图 `native-canvas-v17-full-fit.png`。完整视口的清晰回执不等于所有源字段的跨渲染器像素 oracle。
- 性能仍 FAIL：首次 3200% 瓦片约 28.64 秒，编译最大 16.45 秒、图阶段最大 8.25 秒；之后已记录瓦片窗口约 18.63 秒。缩回全览首个复杂瓦片约 62.21 秒（其中 graph 43.95 秒），下个精确密度复杂瓦片约 59.41 秒。此为当前机器、非配对观察，不是 FPS 门；移除拒收门槛没有解决绘制量。
- 计划测试缓存往返时，CUA 明确报告用户改变窗口，重新读取发现验证页已重载且源为空，故该缓存复用测试标为 NOT_RUN，未把旧截图/旧瓦片计作新结果。
- 共享目录 `Canvas.tsx` 的完整源接线在 18:30 被外部修改移除，导致 App props 类型失败。对照 v17 冻结源码映射确认差异仅为该接线，按逐段 patch 恢复；没有覆盖其他代码。恢复后 typecheck 和 17 项源工作区/状态/控制器定向检查另存 v3 日志。
- 新增状态通过现有 `viewport-state` 数值诊断记录（state 0=loading,1=refining,2=ready,3=error，finalComplete 仅 ready 为 1），进入宿主既有隐私过滤终端链路；不输出文件名、节点内容或错误原文。完整源取消失败后仍保留界面只读约束。
