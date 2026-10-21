# 设备网格滤镜的只读审查

本次仅审查现有源码与已保留证据，没有修改 shader、扩大半径准入或执行 GPU/性能测试。**Material source cache 在高频内容的真实 GPU 画质对照出现 51/255 差异，不能默认开启。** 先前 16 对实际 117 静态画布最多 5/255 的结果只覆盖那些样本，不能覆盖这个失败，见 [MATERIAL-CANDIDATE.md](MATERIAL-CANDIDATE.md)。将源图先以 source radius 预模糊再放大，改变了原设备网格上的采样与滤波顺序；四相再采样本身不能证明这两个顺序等价。

## 32 是准入范围，不是着色器容量上限

- [render-worker.ts:648](../../frontend/design-client/src/kernel/render-worker.ts:648) 将桌面 bounded 候选限制为 32，并继续使用既有显示意图与导出排除策略。
- [webgpu.ts:52](../../frontend/design-client/src/kernel/gpu/webgpu.ts:52) 同时检查 `limit <= 32`、完整 RGBA、原始 binary64 半径和 f32 uniform 的支撑范围一致；[displayFilterPass:56](../../frontend/design-client/src/kernel/gpu/webgpu.ts:56) 还要求真实 tent 元数据、已准备 pipeline，以及半径与 uniform 对应。不能只改变一个数值而遗漏这些检查。
- [display-filter.ts:4](../../frontend/design-client/src/kernel/gpu/display-filter.ts:4) 的系数构造器本身支持至 16,384；[webgpu.ts:179](../../frontend/design-client/src/kernel/gpu/webgpu.ts:179) 已有独立的无 bounded-limit Web 显示合同。因此 32 不是纹理大小或 WGSL 的硬件限制，而是桌面可选分支当前限定的准入域；当前源码没有给出可把该域直接推广到大半径的数值证书。

以本次 117 的诊断参数为例，原图 736×414、节点 1920×1080、local radius 约 9.5648718：source radius 约 3.66653，而 3200%、DPR 2 的 device radius 约 612.1518。把 source-radius 结果放大并不等价于在 device-radius 网格上执行原算子。

## 直接提高上限会同时改变内存和计算路径

[renderer.ts:2722](../../frontend/design-client/src/kernel/gpu/renderer.ts:2722) 的 `streamIsolatedFilter` 在 `displayFilterActive(radius)` 时直接拒绝当前分块优化。这个优化原本保留原始四相字段、实际 X-table/逐相 resolve 与完整滤镜 halo，按有界 strips 处理 H/Y，相关实现见 [2684](../../frontend/design-client/src/kernel/gpu/renderer.ts:2684)、[2770](../../frontend/design-client/src/kernel/gpu/renderer.ts:2770)、[2834](../../frontend/design-client/src/kernel/gpu/renderer.ts:2834)、[2865](../../frontend/design-client/src/kernel/gpu/renderer.ts:2865)。

只提高 bounded 上限会让大半径走普通 `applySampleEffects` 与 `blur`：先 resolve 四平面，再在整块效果范围分配 H/Y 输出，见 [3177](../../frontend/design-client/src/kernel/gpu/renderer.ts:3177)、[3379](../../frontend/design-client/src/kernel/gpu/renderer.ts:3379)。它不能保留当前 strip 的峰值内存特征，可能增加准入等待或触发预算拒绝；不能拿较少 fence 推断整机加速。

两套系数纹理的布局也不同：[exactTentAxis:3352](../../frontend/design-client/src/kernel/gpu/renderer.ts:3352) 上传 rational 字节布局；[blur:3382](../../frontend/design-client/src/kernel/gpu/renderer.ts:3382) 上传 256 宽的 f32 权重布局。必须让每次 axis pass 的 pipeline、系数和元数据一致，不能只让 driver 接受更大半径。

## 当前 f32 reducer 仍为 O(radius)

[display-filter.ts:29](../../frontend/design-client/src/kernel/gpu/display-filter.ts:29) 按原设备坐标计算整数 texel 位置，没有降采样；[37–42 行](../../frontend/design-client/src/kernel/gpu/display-filter.ts:37) 对每个 tap 执行 source/weight 读取与补偿累加。半径 612.1518 在完整支撑处每轴最多读取 **1,227 个 source taps**，32 时为 65 个，tap 数约为 18.9 倍，另有系数读取。边界裁剪可能减少实际 taps，但不能把该路径视为 O(1) 滤镜。

已有 paired sampler 仅减少相邻 tap 的采样数量，仍为 O(radius)，并新增硬件线性插值误差；当前 bounded 分支明确不选择它，见 [webgpu.ts:851](../../frontend/design-client/src/kernel/gpu/webgpu.ts:851)、[1717](../../frontend/design-client/src/kernel/gpu/webgpu.ts:1717)。不能顺手把 pairing 与扩大 domain 绑定为一次“已验证”变更。现有 exact prefix 是另一种成本结构，大半径直接 f32 是否更快必须实际比较，不能事先估计收益。

补偿累加不恢复系数量化损失：[display-filter.ts:7](../../frontend/design-client/src/kernel/gpu/display-filter.ts:7) 先将各侧权重写入 f32，再按这些权重重建中心项。signed/HDR 的抵消、接近最大有限值的输入和累积溢出不能由“权重和接近 1”证明安全。[ExactImageRange](../../frontend/design-client/src/kernel/gpu/exact-image-x-table.ts:15) 可证明上传有限、非负与指数范围，但指数上限 127 只给出小于 2 的上界，不直接证明 RGB ≤ 1，更不证明近似结果逐位精确。应保留 [encodePass 的输出证书失效规则](../../frontend/design-client/src/kernel/gpu/webgpu.ts:1681)，不能把近似输出标成精确 finite/opaque 证书。

## 现有证据覆盖与缺口

- [check-bounded-display-filter.ts](../../frontend/design-client/scripts/check-bounded-display-filter.ts:15) 定义单轴 RGBA 的小半径近似比较，包含透明/钳位边界、signed 输入、最大有限值和精确抵消负例。其近似准入仅覆盖 ≤32；64 等被拒绝样本要求 exact fallback 原始 f32 一致，不能算作大半径 f32 通过。脚本在 [37–40 行](../../frontend/design-client/scripts/check-bounded-display-filter.ts:37) 明确排除了双轴合成与整幅场景验收。
- 本轮没有找到可核验的该 bounded-f32 实际 GPU 结果，**尚无该候选的真实 GPU 通过证据**。存在脚本、mock 选路测试或 CPU 权重守恒测试都不能代替它。
- 已通过的 resident-filter-v5 是原 exact 管线的像素/生命周期证明；[其源码明确排除 displayFilters](../../frontend/design-client/scripts/check-resident-filter-lifetime.ts:53)。它包含大半径测试也不能证明大半径近似 reducer 的误差或性能。

## 下一轮最小可信实验，尚未执行

先做独立 actual-GPU operator 对照，复用已有 Web 无 bounded-limit 的 f32 pipeline，仅在测试中比较，不扩大产品准入：同一真实上传、原始 device radius、整数 device-lattice 坐标和相同完整 halo，精确 scalar rational 作为独立 oracle；先关闭 pairing，覆盖半径 32 的邻界、64、512、本次约 612.1518 与更大真实值。输入覆盖高频棋盘/冲激/渐变、透明边缘、clamp、负坐标及实际 117 PNG，经真实 WASM 四相字段得到相同的待滤波输入，不能先在源分辨率预模糊。

单轴之后必须测真实 H→Y 双轴、同色彩管理及最终合成。报告原始 RGBA32F 误差、alpha、非有限值、未量化 SDR 编码误差和 PNG 差异；可以既有脚本的 `<1/255` 编码误差作为 operator 门起点，但它不替代实际场景画质门。任一域失败就缩小/拒绝准入，signed/HDR、alpha-only 与无有效私有来源证明继续走精确路径，不能吞掉负例。

只有数值门通过后，才考虑单独的默认关闭集成候选：**保留原四相、scene 的 source→device 采样网格、X-table/resolve 与 strip 内存边界，只替换每个 H/Y axis 的累加。** 该候选需要显式区分 float/rational 系数布局及每次 pass 的算术合同，不能通过全局提高 `displayFilterActive` 范围绕开 streamer。原图、编辑、撤销不改；PNG/readback、非呈现与 HDR 的精细导出排除仍按 [renderer.ts:4066](../../frontend/design-client/src/kernel/gpu/renderer.ts:4066) 保留。

最后才用相同构建、同文件、同相机与无 profiler 的实机重复对照，分别记录阶段耗时、CPU 队列完成等待、真实 adapter timestamp（若可用）、峰值账本和压力/取消恢复。此审查不给加速幅度预估，也不把任何候选改为默认。

## 新发现：117 的高倍率局部精细参考被原生 halo 面积拒绝

`verified-stress-117` 的第 2、5 轮高倍率平移向外样本均未取得独立 GPU 精细参考，记录为 `GPU surface budget exceeded`；不能把其余可用样本或实际显示 ACK 拼成这两份参考已经通过。来源文档 SHA 为 `a0d0df3b24ea187dfd5723c9d41ab17908ce22afebb0bf64592f749d6fac3677`。独立参考已经使用 1 GiB 工作预算，仍被 [gpu.rs:1502](../../design-studio/crates/design-kernel/src/gpu.rs:1502) 的原生面积门拒绝；该门发生在编译 extent 阶段，不由 GPU 显卡内存或 Electron 工作预算设置决定。

加载真实字体和文档后的 CPU 原生编译遍历定位到一个 64×64 终止块。同位置进一步缩到 32×32、16×16 仍失败；这些是编译准入结果，不是这些小块完成 GPU 像素对照的证据。实际直接重叠的是一个带普通 background-blur 的布尔路径节点，背景半径为 `18.39398384094238`，设备 scale 为 64；其祖先 frame 没有 clip 或可见效果。该布尔节点有原始子节点，但 [render_children](../../design-studio/crates/design-kernel/src/scene.rs:589) 返回空，不能把原始树中重复存在的效果直接算成已证实的重复 GPU 渲染。

具体拒绝链为：

1. [halo:474](../../design-studio/crates/design-kernel/src/gpu.rs:474) 对可见效果使用 `2 × blur_radius × max_scale`，该节点 own halo 为 **2355 px**。
2. [required_halo:1448](../../design-studio/crates/design-kernel/src/gpu.rs:1448) 无法把该半透明填充、带 network 的背景节点证明为不相关或不透明覆盖，保留这个 halo；[1496–1503](../../design-studio/crates/design-kernel/src/gpu.rs:1496) 在非 regional-foreground 情况将 viewport 四周统一扩边后检查面积。
3. 64×64 的 extent 因而至少为 `(64 + 2×2355)² = 22,791,076` 像素，超过 **16,777,216**。即使数学上缩成 1×1，仍需 `22,193,521` 像素；这条固定扩边路径不可能靠继续细分输出通过。1×1 是公式推导，不是声称额外跑过一次原生/GPU 测试。

这个案例确定了原生准入拒绝的原因，并显示当前单节点支撑存在保守余量；不能据此认为可以直接把 halo 除以 2。[drawBackdropLeaf:2511](../../frontend/design-client/src/kernel/gpu/renderer.ts:2511) 和 [drawBundle:2312](../../frontend/design-client/src/kernel/gpu/renderer.ts:2312) 的实际背景捕获由 `backdropBox` 裁剪并钳位，managed integrated tent 的滤波半径是约 **1177.215 px**；但背景输入已经包含同一父容器中更早绘制的全画面图像，其前景 blur 半径约 **612.152 px**。背景滤镜读取相邻像素时，这些相邻像素还要拥有上游图像 blur 的完整支撑。

因此该依赖跨越**前面的兄弟节点**，不能仅按当前节点及祖先的局部半径证明。只将全局 extent 改为约 1178 px 的扩边，可能在需要上游约 613 px 支撑的位置截断其输入。将两个真实 tent 支撑及邻居相加得到约 1795 px，只是说明存在比旧 2355 px 更小的候选范围，**不是已经成立的安全边界或实施许可**。现有 [single_backdrop_support_chain](../../design-studio/crates/design-kernel/src/gpu.rs:558) 也明确警告兄弟滤镜依赖不能按树中最大值盲目收紧；本文件含多个背景滤镜，当前全页证书并未准入它。

本轮不修改 Rust、WASM、面积门或精度，也不把 1 GiB/4 GiB 当作修复。下一步需独立建立 per-region、按实际绘制顺序追踪前序兄弟和祖先的依赖证书：核对原始四相、完整 halo、`backdropBox` 钳位边界，排除 legacy Gaussian、noise、glass、gradient blur、未证明变换及嵌套/后续背景链，再用真实 CPU 与 GPU 像素 oracle 比较局部输出、裁剪边缘及连续相邻块。证书和数值对照通过前，不能直接 halving，也不能宣称两份高倍率精细参考可用或长期缺锐化问题已修复。
