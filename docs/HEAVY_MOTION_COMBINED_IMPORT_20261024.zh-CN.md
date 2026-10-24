# 重效果、连续缩放与组合增量验证（2026-10-24）

本记录仍为开发候选。**快速连续缩放的运动清晰度仍有真实 FAIL，不能声称三份文件已经全程无模糊。** 完整 G2/G5 矩阵和物理输入到光子延迟未通过。过程日志与失败候选均保留在 [验证目录](../testing/verification-heavy-motion-20261024/WORKLOG.md)。

## 输入和隔离

- `01有料素材 (Copy).fig`：649,304 B，SHA-256 `701877664bf271305c8bc103c4036a228d7bd8816f1d98f18cdc332a75c36c46`。
- `拓扑素材.sketch`：118,272,240 B，SHA-256 `b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12`。
- `117.sketch`：5,013,257 B，SHA-256 `d494693eadf269e7fa29e4cc56e893f5890c02f4d96f4561065c851818a85d70`。
- `design-combined-f031-after-terminal-dev.zip`：1,462,704 B，SHA-256 `c61ad15d8396b172b0aa5e0885c765a66a0a0a159c23474d28228f61de1294b1`。

基线提交为 `f03197eddba5da8d6c53d4c9a655c0e007695b16`，工作区还有此前未提交修改，未重置这些修改。每次构建使用新的私有输出目录、独立 Electron 用户目录；只通过本任务持有的进程句柄关闭测试实例，没有控制其他任务进程。原始文件保持不变。

## 已完成的修复与验证

### 组合 ZIP

核对包内前后镜像摘要，保留当前修改进行三方合并。31 个应用路径中写入 30 个，`components.ts` 的对应修改已经存在。三个冲突分别保留了本地 compound 路径、源工作区排队/编辑保护以及双方测试。前端保存回执消费者和 native 新索引 key 返回方一起合并。

当前树缺少包所依赖的前置 terminal 增量。包内前镜像提供了 WebGPU 文件，已对照 f031 适配必要的设备终止、异步管线发布、park/revive 和 fresh initialize 保护；未虚构缺失的 settlement 统计模块。附带草稿测试经过类型和隔离修复后实际执行。ZIP 向量测试发现的“拖回原位仍增加空撤销”也已修复。

来源和冲突记录：[应用清单](../testing/verification-heavy-motion-20261024/zip-integration-applied.json)、[合并差异](../testing/verification-heavy-motion-20261024/zip-merged-review.patch)、[缺失前置代码对照](../testing/verification-heavy-motion-20261024/zip-terminal-prerequisite.patch)。

### 大源文件容量

源文件的固定 4 GiB 上限已移除。native 根据实际存储卷容量设置会话边界，复制和展开前检查实际可用空间；流式字节偏移保留跨进程可精确表示的范围。工作集、单片段、格式检查、GPU 预算和采样数学各自保持原约束。

实际执行了 **5,368,709,120 B** 的源 JSON：读取小属性、修改、完整导出、逐字节检查修改范围之外的内容，再流式重读索引。超过实际存储卷容量的稀疏长度请求在复制前被拒绝。测试正文耗时 70.62 秒，1 项通过；这是磁盘源文件能力，不能等同于将 5 GiB 内容同时放进一个可编辑画布。[实际日志](../testing/verification-heavy-motion-20261024/actual-5gib.log)

### 父级合成范围

Rust 计算后续真正读取的父级颜色范围，保留源几何、材质、滤镜和背景捕获范围。JS/GPU 用原有合成公式直接写入较小输出。真实 117 的重瓦片复现了原日志 **47,566,953** pass 像素；直接输出候选降至 **43,389,429**，约减少 8.8%。硬件目标像素逐位一致，但延迟收益有限，部分工作集统计增加。因此 `VITE_DESIGN_PARENT_SUFFIX` 保持显式启用，默认关闭。

先前“只缩小前景模糊输出”的尝试没有减少 WebGPU 实际工作，已撤掉。原生整视口对照在 117 出现约 14 秒输入积压，也未采用。[逐位对照](../testing/verification-heavy-motion-20261024/tile-unit-profile-3.json)、[整视口失败](../testing/verification-heavy-motion-20261024/117-viewport-compare-quality.json)

### FIG 主线程重复扫描

真实主线程火焰图发现全节点校验与交互状态比较重复枚举。现在单次校验复用节点枚举，保留所有校验；交互比较只在已有完整、私有的变更证明存在时检查变化节点，其余情况继续全量比较。FIG 首轮出现 283.4 ms 停顿，修改后两轮完整链路分别为 207.8/208.2 ms 最大属性阶段 UI 间隔，均无超过 250 ms 的停顿。这不是物理帧率或运动清晰度通过。

### 渲染 Worker 重复覆盖检查

实际 117 集成火焰图发现 `tilesCoverBounds` 和已经准备好的瓦片缺口检查被反复执行。现在覆盖扫描只排序一次；取消边界继续逐次检查，但同一 Worker 私有画面版本只计算一次缺口，相机、覆盖或交互状态替换后重新计算。不提供私有版本的调用者仍逐次检查可变对象。

同诊断配置、同 160 个输入的采样对照中，覆盖路径的自耗样本约从 172.3 ms 降至 10.7 ms。它是该路径的 CPU 采样结果，不是整个应用的加速百分比。新测试覆盖独立整数网格 oracle、分数相位、原有边界容差、取消和无版本的可变对象回退。[采样对照](../testing/verification-heavy-motion-20261024/coverage-profile-comparison.json)、[优化后集成火焰图](../testing/verification-heavy-motion-20261024/117-profile-coverage-5/flames.html)

### 区域图片重复上传

自然 260 事件轨迹的火焰图还显示，区域切换后被清掉的图片在重返区域时重新验证全部 f32 像素并上传。把既有私有图片所有权机制与滤镜候选解耦后，图片范围扫描自耗样本约从 146.3 ms 降至 2.5 ms；Worker 总活跃样本仅从约 2914 ms 变为 2870 ms，不能称为整体大幅提速。[相同轨迹采样对照](../testing/verification-heavy-motion-20261024/image-profile-comparison.json)

`VITE_DESIGN_IMAGE_ASSET_RESIDENCY=1` 仍是默认关闭的独立候选，保留文档/资源代次、设置、取消、真实队列完成、pin 和原工作预算的保护。当前 80 次硬件输出读回包括五块真实瓦片、WebGPU/WebGL2、原路径/组合候选、重复帧，以及 A→空区域→A。其中 20 帧建立各自后端/场景参考，60 帧与对应参考逐位比较，零差异；不将两种后端之间混作同一 oracle。117 的 WebGPU 路径从四次上传变为两次。[硬件结果](../testing/verification-heavy-motion-20261024/tile-image-residency-6.json)

这个候选没有消除快速反向缩放的放大旧帧，也没有证明稳定的端到端延迟收益，不能默认启用后宣称完成。

## 实际 GUI 与数据检查

独立 Electron 已实跑三份原件的缩放、属性、撤销重做、保存、关闭与重开。FIG/117 的完整已保存模型与预期修改比较；重新导入副本的新 document id 单列。拓扑三个工作集验证名称、透明度、历史、完整导出和重新打开。

拓扑导出 64 个 ZIP 成员中，63 个逐字节一致；修改页只有三个名称和三个透明度变化，其他事件和值保持一致。[全归档核对](../testing/verification-heavy-motion-20261024/sketch-combined-1-archive.log)

source6 前台、生产限流设置下的最终功能轮如下；这些 UI 间隔不是输入到像素延迟：

| 文件/工作集 | 编辑、历史、保存重开 | 最大 UI 间隔 | >250 ms 停顿 |
|---|---|---:|---:|
| FIG 的 01_Dashboard | PASS | 201.4 ms | 0 |
| 117 主画板 | PASS | 57.6 ms | 0 |
| 拓扑 30 图标 | PASS | 150.3 ms | 0 |
| 拓扑底座一 | PASS | 134.4 ms | 0 |
| 拓扑底座二 | PASS | 133.0 ms | 0 |

[最终前台运行清单](../testing/verification-heavy-motion-20261024/foreground-runs-6.json)。最终拓扑导出与完整流式核验过的版本逐字节相同，SHA-256 为 `4eeae3b850e2807fec1b3d13fc9ed5f4172c1d02ac726828035af8f336918af2`。原始三文件及 ZIP 再次核对摘要，未改变。[最终源码、构建和结果清单](../testing/verification-heavy-motion-20261024/final-evidence.json)

最新构建各次运行的状态、测试次数和剩余项见 [工作日志](../testing/verification-heavy-motion-20261024/WORKLOG.md)。`captured` 只表示采集完成，不能当作清晰度 PASS。既有 FIG 字体/实例等兼容提示仍单独保留。

再次审计发现，既有拓扑功能脚本主动关闭了后台限流，而窗口 visible 并不证明获得焦点。旧轮次的数据正确性结果仍成立，UI 间隔不能作为完全生产配置下的结论。最新 `*-foreground-6` 回归保持生产限流设置，主动激活本任务拥有的 Electron 窗口，并记录实际 `document.hasFocus()` 与焦点变化。另保留 source6 原 FIG 轮次的 258.3 ms/1 stall 失败，不把它删除或说成已定位的代码缺陷。

## 运动证据与测量边界

使用 160 个真实 native wheel 事件的确定性快速反向轨迹，并保留 Chromium 实际 PNG 帧。另有不截帧的同输入运行，避免把 PNG 开销归因于产品。质量追踪开关只改变统计频率，原日志每 250 ms 抽样一次不足以证明运动过程清晰。

当前仍记录到明显的旧纹理放大和细化等待。原生分块候选 `VITE_DESIGN_NATIVE_VISIBLE_TILES` 保持默认关闭。已经完成的宽视口可以在原活跃预算的四分之一以内保留一个兜底批次；该批次不增加绘制，也不冒充完整页面或当前原生精度。新内容、设备丢失、窗口变小和资源缺失仍撤销对应保护。

| 160 次输入的场景 | source5 停止发送→细化完成 | source6 前台同轨迹 | source6 最后输入接收积压 | source6 最大纹理放大 |
|---|---:|---:|---:|---:|
| FIG Dashboard | 1461 ms | 1625 ms | 12 ms | 9.70× |
| 117 主画板 | 942 ms | 742 ms | 216 ms | 26.91× |
| 拓扑控件“数据名称” | 600 ms | 506 ms | 5 ms | 20.40× |

以上为单次真实记录，source5 未强制证明焦点，不能将差值全归于代码或当作稳定性能提升。source6 分别有 406/425、242/250、212/271 次提交未达到原生清晰覆盖，**三项运动门均 FAIL**。最大放大系数是实际呈现纹理的缩放指标，不是每个像素的视觉误差倍数；平坦背景也可能被放大。

另从原日志重建的 117 自然轨迹收到全部 260 次输入，前台最大 UI 间隔 141.8 ms、无 >250 ms 停顿；末次输入到首次完整细化约 1098 ms，最大纹理放大 3.38×，运动门仍不通过。139 次空场景压力轨迹全部收到、最终细化完成；仍有 14 条零替换 reserve 的可选准入拒绝，有正 reserve 的前台拒绝为 0。分类读取真实线上的 `surfaceReserveBytes`，缺失字段列为未知，不能默认为成功；原日志正 reserve 拒绝也作为解析器正控保留。[分类核对](../testing/verification-heavy-motion-20261024/admission-classification-audit.json)

## 最终产物与剩余门槛

source6 的 trace0/trace1 两套均完整执行 Rust/WASM、TypeScript、Vite 和 native 构建，独立宿主和全部 2193 项构建输入再次校验一致。最终相关回归为前端 397、维护边界 14、桌面 27 项通过，共 438 项；这些是有范围的回归，并非全仓库或完整 G2/G5。5 GiB native 实际读写测试单列，不重复计入。[构建与回归清单](../testing/verification-heavy-motion-20261024/final-evidence.json)

默认代码包含 ZIP 集成、容量、UI 重复扫描和覆盖检查修复。父级合成缩域、原生运动瓦片、图片持有三个渲染候选仍默认关闭。下一层未解决瓶颈是当前相机的场景准备、重效果图形工作及其队列完成；既有自然轨迹仍有约一秒完整细化时间。CPU 局部扫描变快和硬件逐位一致，都不能替代这一条端到端验收。没有提高 GPU 预算或修改采样精度，也没有宣称硬件 VRAM 耗尽。

GPU timestamp 的各 pass 区间可能重叠；实测求和甚至大于整个帧的 wall 时间，不能将其相加或直接称为 shader 关键路径。`onSubmittedWorkDone` 只证明提交队列的完成，仍不证明像素正确或显示器扫描输出。[WebGPU 队列定义](https://gpuweb.github.io/types/interfaces/GPUQueue.html)

## 火焰图与外部参考

- [真实 FIG 属性编辑主线程（优化前）](../testing/verification-heavy-motion-20261024/flames/fig-before-ui-scan/flames.html)。`program` 是未归属样本，不能全部归入 idle。
- [真实瓦片单项 WebGPU 路径](../testing/verification-heavy-motion-20261024/flames/webgpu-unit/flames.html)。使用实际 Rust/WASM、生产图片加载器和 GPU；测试入口与完整编辑器入口分开报告。WASM 未解析索引不标成已确认的 Rust 函数。
- [包含 WebGL 冷管线初始化的单项对照](../testing/verification-heavy-motion-20261024/flames/real-tile-unit/flames.html)，不能外推为生产 WebGPU 热路径。

已查阅 Figma 关于显式图形状态、uniform 批处理、异步读回及渐进验证的工程记录；这些是优化方向参考，不能代替本项目实测。[Figma WebGPU 工程记录](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)

Skia 的反向滤镜边界要求覆盖全部真实输入，支持本轮先证明依赖范围再缩小临时表面的做法。Vello 的 Sparse Strips 架构提供减少空白工作和批处理的参考；其精度及效果契约仍需单独比较，当前没有替换本项目内核。[Skia 边界接口](https://github.com/google/skia/blob/main/include/core/SkImageFilter.h)、[Vello 架构](https://github.com/linebender/vello)

Memory64 已进入实现，不能拿历史 wasm32 的 4 GiB 地址空间说明当作所有 WebAssembly 的永久限制。本次用 native 流式源文件和局部工作集解决源文件准入，没有把修改内存常量当作 wasm64 迁移。[WebAssembly 功能状态](https://webassembly.org/features/)、[可移植性说明](https://webassembly.org/docs/portability/)
