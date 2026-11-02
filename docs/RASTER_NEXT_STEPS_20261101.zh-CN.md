# 光栅重复计算与下一阶段结构优化

2026-11-01。承接已落地的普通 Gaussian 自动选择。此轮是开源代码阅读、当前生产渲染器的诊断插桩与一项隔离消除实验；没有修改生产运行路径、默认开关、HDR 或导出精度。

证据目录：[analysis-raster-20261101](../testing/analysis-raster-20261101/)。原件仍为下载目录拓扑素材，SHA-256 `b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12`。使用此前校验过的六个完整转换工作集、512×384 视口和 Apple Metal-3；原始 JSON/图片不附入源码。

## 结论

**存在真实重复计算。** 当前最具体的是重复描边覆盖合并、被提前退休的共享覆盖、重复材质参数准备，以及四相重复验证同一几何程序。更有结构性潜力的是让多个绘制在一个图块内完成，并以显式渲染任务依赖安排中间面的生成与回收。

不应把四个不同采样相位本身叫重复。当前普通前景 Gaussian/motion/zoom 已先 resolve，再只滤波一次并共享结果；Rust 扫描线区间也已有编译缓存与四相共享。不能把这些再当作未实现优化。

## 本轮测到了什么

观察一次相同请求的暖重绘，再把相机横移 0.25 个设备像素。**这不表示空闲画布每帧都重绘**：上游最终瓦片/交互缓存可直接避免调用 renderer。本探针描述的是 renderer 确实收到重绘请求时的工作。

计数器记录真实 GPU 调用与源纹理写入代次；相等候选比较完整 uniform 位、输入资源/版本/标志、目标格式/尺寸、通道与边界条件。几何程序跨帧单独隔离。插桩后的相同视口输出与未插桩参考逐位一致。

| 原件工作集，暖重绘 | draw 数 | 材质配置调用／不同配置 | 覆盖缓存逐字比较次数 | 重复完整 pass |
| --- | ---: | ---: | ---: | ---: |
| 旧式 Gaussian，400% | 122 | 40／10 | 576,624 | 0 |
| 新版 Gaussian，400% | 294 | 88／22 | 290,528 | 16 |
| 旧式 Gaussian，950% | 104 | 28／7 | 422,656 | 0 |
| 背景模糊，400% | 624 | 208／52 | 2,745,504 | 0 |
| 运动模糊素材 | 1,084 | 340／85 | 1,112,208 | 32 |
| 含阴影与 Gaussian，950% | 140 | 40／10 | 603,984 | 0 |

[有效完整计数](../testing/analysis-raster-20261101/instrumented-2/report.json)；[重复种类复核](../testing/analysis-raster-20261101/duplicate-confirmation/report.json)。计数不等于 CPU/GPU 耗时，未给本轮性能优化的百分比。

### 1. 相同描边蒙版反复合并：已做消除验证

[renderer.ts 的描边循环](../frontend/design-client/src/kernel/gpu/renderer.ts#L4063)对每条非居中描边调用 `combine(strokeMask, fillMask, rect, outside)`，绘制材质后释放临时组合蒙版。

真实素材中存在同一节点多条等宽、同对齐、同几何但不同渐变色的描边。路径蒙版已复用，但它与填充蒙版的合并结果没有相同粒度的复用。运动素材的暖重绘及 0.25 像素平移，各发现 28 次相同 mode-1 工作，其中 24 次的目标物理纹理内容甚至还保留着上一次结果。

隔离诊断只在以下条件同时成立时省略 mode 1：完整目标、全部通道、完整位模式相同的输入/参数、源写入版本未变、目标正是上次那个目标且未被覆盖/销毁。两个相机位置各省略 **24 次 draw，约 403 万目标像素工作**，分别与该相机的未修改参考比较，颜色/alpha/f32 位全部零差异。[消除实验](../testing/analysis-raster-20261101/mask-elision/report.json)

这是当前最值得先做的局部 A/B。生产实现宜采用按节点、相位、实际覆盖程序/填充源、对齐方式和矩形绑定的描边覆盖复用；不要把诊断中的大 JSON 签名和全局纹理映射直接搬入热路径。仍须核对 alias、取消、资源池重用及原内存预算。

### 2. 提前回收后，同一覆盖又被光栅化

新版 Gaussian 工作集重复了 **16 次 mode-31 覆盖 pass，804.6 万目标像素**；横移 0.25 像素后重复 28 次、1408.0 万目标像素。这些没有仍然有效的前一个输出可直接借用，不能仅删掉 draw。

相关源码是 [retireLeafMasks](../frontend/design-client/src/kernel/gpu/renderer.ts#L1421)：达到当前帧预算的 25% 后，满足条件的叶子蒙版会从 `coverage`、`masks`、`sharedMasks` 移除并回到有序池。`maskOwners` 是已经发生的使用历史，无法知道后面的兄弟节点还会用同一覆盖。该策略本来用于约束大效果场景内存，不能直接删除。

建议在既有私有程序身份上计算“后续是否还要使用、下次使用有多远、保留代价是多少”，据此选择保留或重算；在原预算内安排寿命。需要将实际退休事件与后续再生绑定，进一步确认每个重复的来源，而不是把所有重复都归因于一个阈值。

### 3. 同一份材质共同参数准备四遍

[configurePaint](../frontend/design-client/src/kernel/gpu/renderer.ts#L2771)每次都会处理填充变换求逆、复制并排序 stops、计算 sin/cos、读取颜色/alpha，并写入 uniform。运动素材为 340 次调用、85 组不同的节点/材质共同参数；背景素材为 208／52。

四相 offset 确实不同，不能把四次绘制合成一个平均覆盖。可复用的是不随相位改变的参数模板，四次只补各自 offset、矩形/位置等变化字段。颜色已经由 `scene.colors` 解析，不能声称现在每次都重新做完整 ICC 颜色转换。若沿用现有 GpuPaint 传输结果，先在适配层缓存准备结果；长期需要权威的新派生语义时才下沉到 Rust，避免复制文档模型。

### 4. 缓存命中了，几何数据仍重复比较

[CoverageCache.get](../frontend/design-client/src/kernel/gpu/coverage-cache.ts#L35)按 phase 区分缓存，每次仍完整比较程序字数组。例如同一个 35,356-word 程序，在四个相位重复比较，共 141,424 次；背景工作集暖重绘合计约 274.6 万次 word 比较。

这些比较具有正确性意义：fingerprint 仅用于查桶，不能以哈希相同代替精确相等。可优化为复用已认证的不可变程序身份，将“程序内容相同”的确认与“选择哪个 phase 的覆盖纹理”分离。采用 owner/generation 绑定的 handle 和实际字节认证；文档切换、来源替换、原地缓冲修改都必须失效。

### 5. 滤波系数存在跨请求重建，但不是第一优先级

六个工作集每次真实重绘产生 4–11 次系数构造；普通 `blurKernels` 是帧内表，[跨帧 GPU kernelCache](../frontend/design-client/src/kernel/gpu/renderer.ts#L830)已有实现，但仍需 `VITE_DESIGN_KERNEL_CACHE=1`。CPU 字节缓存目前只覆盖 `certified-tent`。

可先测扩大纯 CPU 系数缓存到有界的 box、tent、motion 数据，或准备同一 SDR 系数的 f32 权重表，减少 shader 中逐像素反复解码有理系数/相除。源颜色范围与精确回退仍须保留原系数包。已有默认关闭的 GPU residency 不能根据构造次数直接放开；必须计入上传、scratch、缓存和完成 fence 的实际代价。

## 更可能带来结构性改善的开源思路

### A. 稀疏覆盖与图块内合成

[Vello Sparse Strips](https://github.com/linebender/vello/blob/main/vello_common/src/strip.rs)区分需要 alpha 数据的边界与紧凑的内部 fill 区间。[Raph Levien 的 GPU 分块渲染文章](https://raphlinus.github.io/rust/graphics/gpu/2020/06/13/fast-2d-rendering.html)解释了按图块形成有序绘制命令，以及为何路径内线段与路径之间的绘制顺序需要不同处理。

本项目已有 Rust f64 区间程序；下一步原型可以直接消费它，为小图块生成有序绘制列表。在图块内部完成覆盖、填色、多个连续 source-over，最后写一次结果；blur/backdrop 等真正需要邻域或隔离的操作才产生中间面。四个相关样本分别保留，不提前平均，不照搬别人的 u8 coverage 或低精度世界坐标。

当前运动素材的 512×384 暖重绘有 1,084 次 draw，其中 **375 次合成、109 次复制**；累计有计数的目标像素工作约 **1.819 亿**，合成约 7602 万。这是目标面积求和，不是唯一像素数、实际显存流量或 GPU 时间。它说明仅改模糊公式不能消除大量中间工作。

优先原型：普通纯色/渐变、明确 clip、严格绘制次序的一段节点；复杂混合与效果走原路径。原有纯色/渐变融合已存在，这个方向要跨多个绘制减少中间面，而非重复实现单 paint 融合。四附件 packed coverage 过去暖态无稳定收益，也不能作为这条路线已验的证明。

### B. 明确任务依赖、寿命和重复结果

[Vello GPU scheduler](https://github.com/linebender/vello/blob/main/vello_gpu/src/schedule/mod.rs)在记录后按依赖安排图层，延迟分配目标，并利用共享纹理页和已释放区域；其代码明确优先控制分配量，再在已有资源内批处理。

[WebRender 的 render-task cache](https://github.com/mozilla/gecko-dev/blob/master/gfx/wr/webrender/src/render_task_cache.rs)同时记录缓存纹理与本帧生成结果的任务依赖；[Firefox 渲染说明](https://firefox-source-docs.mozilla.org/gfx/RenderingOverview.html)区分 picture、空间/clip 树、任务与局部失效。

本项目已有 `HorizontalFilterCache`、静态图片 blur、interaction roots、nested prefix、coherent subtree 等专用机制。建议在这些之上逐步统一派生结果身份与任务依赖，而非再新增一个无限大缓存：覆盖、描边裁剪、paint、blur、blend 分清输入版本、输出需求、采样/颜色策略和最后消费者。此方案直接对应上面的重复蒙版、提前退休和重复验证问题，并能延迟建立尚未消费的父层。

一开始不必重写整个渲染器。先用一个效果子树构建可对照的任务计划，比较像素、实际 draw、峰值与端到端耗时。区域需求已有 Rust support/suffix 方案和默认关闭候选，需审计其真实命中及失败边界，不能简单打开所有开关。

### C. 借鉴 Rive 的局部合成，保持后端能力边界

[Rive Metal 实现](https://github.com/rive-app/rive-runtime/blob/main/renderer/src/metal/render_context_metal_impl.mm)按设备能力选择 framebuffer read／raster ordering；[Rive WebGPU 实现](https://github.com/rive-app/rive-runtime/blob/main/renderer/src/webgpu/render_context_webgpu_impl.cpp)有 color、clip、coverage 的原子存储后备路径。

可借鉴的是将覆盖与颜色合成尽量留在局部存储，减少反复读取目标贴图。不能假设其 Metal 能力是标准 WebGPU 的通用能力，也不能直接替换本项目的 f32/HDR 与舍入合同。优先研究通用 WebGPU 的图块计算；只有测得平台收益后，再为 Metal 加专用能力路径。

## 建议顺序与验证边界

1. **局部小步**：描边组合蒙版复用；相位无关材质参数准备；认证几何身份只比较一次。已有明确重复与消除证据，容易限定回滚范围。
2. **一次结构原型**：Rust 现有区间 → 图块内有序绘制/合成；同时安排中间面的最后使用。比较原件重效果和纯矢量，验证实际计算/写入减少是否变成延迟收益。
3. **后续专门效果**：简单矩形/圆角阴影的解析或累计核表，以及之前已有收益但范围不足的缩小工作面。使用原核模型和明确误差门，不替换全部 blur。

本轮没有新的速度提升结论。GPU timestamp 探针虽然取得了数据，但每 pass query 下记录的总时长明显高于此前未插桩 A/B，且部分 prefix/clear/批绘路径不受同一计时覆盖；[原始诊断](../testing/analysis-raster-20261101/gpu-profile/report.json)只保留为定性线索，不据此把像素面积比例或计时总和外推为正常帧的瓶颈占比。

早期 `instrumented-1` 忘记恢复被池化的 driver 包装，导致跨案例可变计数引用被继续修改；该轮嵌套统计不作为证据。有效版本恢复全部包装并深拷贝快照；`instrumented-2`、`duplicate-confirmation`、`mask-elision` 均完成来源 hash 检查且 drift 为空。所有测试实例已关闭。外部源码阅读的 URL、内容 hash 与行数见 [external-sources.json](../testing/analysis-raster-20261101/external-sources.json)。

完整 G2/G5、其它平台、全源同时绘制和独立 Sketch/Figma 保真均未新增验收；本轮只确认重复工作、一个严格限定的可消除实例和下一阶段候选。
