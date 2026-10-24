# FIG / Sketch 导入与独立 Electron 验证（2026-10-24）

本轮完成了两个指定文件的导入、属性编辑、撤销重做、保存和重开验证，并继续处理实测失败。**这不是“运动中始终清晰”或完整 G2/G5 通过的结论。** 最终默认构建以 `VITE_DESIGN_NATIVE_VISIBLE_TILES=0` 完成指定操作链与日志复现回归。原生可见瓦片呈现仍为默认关闭的候选，其早期显式启用结果单独记录。

## 输入、构建与所有权

- 《01有料素材 (Copy).fig》：649,304 B，SHA-256 `701877664bf271305c8bc103c4036a228d7bd8816f1d98f18cdc332a75c36c46`。
- 《拓扑素材.sketch》：118,272,240 B，SHA-256 `b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12`。ZIP 展开约 831.8 MB，使用既有大型源文件工作区。
- 基线提交 `f03197e`，工作区已有其他任务改动，全部保留。构建使用独立输出目录、独立 Electron 用户目录和真实 Rust sidecar/WASM/WebGPU。未替换其他任务使用的共享 dist，也未操作其他任务进程。
- [最终清单](../testing/verification-fig-import-20261024/final-manifest.json) 记录 2,179 个构建输入的摘要，最终源码与测试构建一致；候选配置及本机运行目录见 [candidate-handoff-fix.json](../testing/verification-fig-import-20261024/candidate-handoff-fix.json)。CPU 采样与无采样回放分别记录。

## 修复内容

1. 完成既有 FIG 几何修复的真实文件验证：精确重合端点的闭合填充与开放描边分别保留；FIG 隐式填充轮廓显式闭合，不改变描边端帽和坐标。
2. 修复首次属性编辑后的保存停顿：复用已通过私有采用证书、版本和会话校验的 JSON 基线，首次增量保存只传变化节点，避免重新跨 Electron 桥复制约 2 万个节点对象。编码 Worker 的大小、结构、序号、原子失败和所有权检查保留；原地版本修改使缓存失效。
3. 修复 Sketch 工作区图层虚拟化失效：旧侧栏只有 814 px 高，列表却膨胀到 245,184 px，挂载 7,662 行。新增明确的 flex 高度约束后，只挂载 23–24 行，仍可滚动访问完整列表。
4. 密集曲线全量校验不再重复扫描默认共享的 fill/stroke，也不再为每条曲线构造 entries/opcode 对象；每个坐标、独立 stroke 和数量上限仍检查。
5. 修复默认路径的原生瓦片交接：当前计划中已达到最新请求相机 DPR 密度的瓦片，优先于旧相机的更高密度历史。未达到原生密度的新预览仍不能覆盖清晰旧帧，非当前计划不能提升。这样旧碎片在被真正替换后成为可回收资源；没有删除任何 used/pinned 或生命周期保护。
6. 原生可见瓦片候选从当前相机直接调度 DPR 密度瓦片，运动时按单瓦片让出执行机会，准备范围限制到当前批次，跳过低清整视口、LOD 和 overview 优先工作。它复用原编译、调度、准入和呈现路径；没有放宽 GPU/缓存/路径预算或改变采样数学。既有实验开关保持原状态。

## 独立 GUI 与数据结果

| 输入/用例 | 功能与数据 | 活跃 UI 回调 |
| --- | --- | --- |
| FIG：14 页、19,949 个编辑节点 | 导入、快速反向缩放、透明度编辑、撤销、重做、SQLite 保存、外部 FD 保存、正常关闭与新实例重开通过。导入副本的新文档 ID 单列，其余完整模型一致 | `uiStalls=0`；缩放最大 33.4 ms，属性/历史最大 233.3 ms |
| Sketch：30 图标工作集 `1:5`，4,022 节点 | 重命名、透明度、撤销重做、快速缩放、保存与重开通过 | `uiStalls=0`，最大 150.5 ms |
| Sketch：两组复杂底座 `1:32480`、`1:81474`，各 7,662 节点 | 同一操作链通过；完整文件导出后用新实例重开两组对象 | `uiStalls=0`，最大 167.0 / 181.9 ms |

证据：[FIG GUI](../testing/verification-fig-import-20261024/fig-final-default/report.json)、[Sketch GUI](../testing/verification-fig-import-20261024/sketch-final-default.json)、[归档核对](../testing/verification-fig-import-20261024/sketch-native-1-archive.json)。Sketch 保留全部 64 个 ZIP 成员，63 个逐字节一致；变更页流式 JSON 核对只有三个预期名称和三个透明度变化。最终默认构建导出的整个 Sketch 与已逐成员核对的导出逐字节一致，见 [默认构建归档复核](../testing/verification-fig-import-20261024/sketch-final-default-archive.json)。三个最终画布 PNG 与先前相同视图/编辑状态的截图摘要一致。两份下载原件均未修改。

FIG 仍显示已有的字体匹配、实例覆盖、独立区域样式等兼容提示；上述结果不等于与 Figma 原始像素完全一致。

## 日志定位与预算阻塞修复

不再要求用户补充位置：从日志、只读 SQLite 备份和原生编译计数完成关联。08:43:47 记录了删除唯一根图层的提交，随后“117”的持久化快照由 752 节点变为 0 节点。预算拒绝时的请求 337/343 均为 `packetNodeVisits=0`；约 180 倍 pass 的重效果样本发生在更早阶段。这两类问题不能归为同一次重效果渲染。

依据相机日志重建 139 个原生 Electron 滚轮事件，收到的事件均为 `isTrusted=true`，最终相机与原日志误差约 2.3e-7 CSS px。旧默认构建可复现预算错误；只改“可见瓦片优先”的早期候选也失败。加入原生密度交接修复后，**默认开关配置下两次重复回放均无 UI 错误，前台预算拒绝 4→0，最终细化完成**。两轮分别保留 3、4 次非必需历史缓存拒收，不把它们隐藏为零。活动缓存仍受原 128 MiB 及原替换 reserve 约束；没有提高预算。

证据：[关联时间线](../testing/verification-fig-import-20261024/reference-failure-timeline.json)、[快照元数据](../testing/verification-fig-import-20261024/reference-documents.json)、[相机轨迹](../testing/verification-fig-import-20261024/reference-camera-unique.json)、[回放对照](../testing/verification-fig-import-20261024/reference-replay-results.json)。原实例仅被读取日志和数据库备份，没有被发送输入或进程控制。

删除前的真实 752 节点保存快照也以 260 个原生事件重放，无渲染错误，最终细化完成。停手 1.2 秒时尚未完成，再过约 0.1 秒检查到完成；这不是物理输入到光子的测量，也不说明重效果已经足够快。最初只等 1.2 秒的失败观察保留，未把延长功能等待当作性能过关。

## 运动质量：仍未验收

用户提供的运行时分析已保留为 [参考故障证据](../testing/verification-fig-import-20261024/reference-runtime-failures.json)。原生位姿 SceneDelta、渐变字段缓存并不能证明滚轮缩放清晰，也不能替代重效果/背景捕获成本和瓦片替换峰值的处理。

以下是原生密度交接修复之前的历史候选对照，不当作最终默认构建的性能声明。同源构建仅切换新候选开关，对“控件”页的真实重效果对象进行 24 次缩放及 3 次平移，CPU 采样关闭，两个回放最终截图逐字节一致：

| 观测值 | 旧呈现链 | 原生可见瓦片候选 |
| --- | ---: | ---: |
| 最大纹理放大 | 8 倍 | 8 倍 |
| 非清晰提交数 / 总提交数 | 9 / 13 | 6 / 15 |
| 最长 pipeline | 511.8 ms | 509.1 ms |
| renderer 估算工作集峰值 | 342 MiB | 112 MiB |
| 最大 pass 像素放大 | 79.59 倍 | 79.67 倍 |
| 本轮 surfaceRejected | 0 | 0 |

见 [旧路径数据](../testing/verification-fig-import-20261024/pressure-focused-baseline-quality.json)、[候选数据](../testing/verification-fig-import-20261024/pressure-focused-native-quality.json)。这是限定回放的观测；工作集并非物理 VRAM，阶段时间有重叠，不能相加。该结果支持减少同时驻留/准备的资源，但**没有消除重效果成本或瞬时模糊**。这组控件回放本身没有复现预算拒绝；后来另用日志还原的空场景轨迹完成了上文的定位与修复验证。

后续顺序保持：当前相机的原生缺口优先 → 有实际贡献/所有权证明的旧资源回收与区域替换 → 重效果依赖/pass/表面范围缩减 → 对象手势 SceneDelta 的额外复制/回退浪费。不会用提高预算、删保护、降精度或仅展示静止清晰截图宣称通过。

G2 运动清晰度仍未通过；完整 G5 六格和十份副本未在本轮重跑；117 仅完成上文的特定日志轨迹，并未完成规定的完整动作矩阵。输入到像素/物理呈现目标未登记，提交 ACK、uiStalls 和最终清晰度分别报告。

## 回归与失败记录

- Rust FIG geometry：5 项通过；实际下载 FIG 的 Editor/WASM/history/FD 检查通过。
- 编辑、采用证书、编码、曲线校验组合：91 项通过；host codec 3 项通过。
- 最终原生交接、覆盖/缓存使用、准入与所有权：69 项通过，1 项原有跳过保留；早期候选的 67 项导航回归独立保留。
- TypeScript 检查、完整 WASM/native/renderer 构建和 `git diff --check` 通过。
- 初始 609 ms 自动保存停顿、旧侧栏大 DOM 停顿、源工作区路径预算失败、被用户消息中断的运行以及测试器标签遍历开销均保留在 [工作记录](../testing/verification-fig-import-20261024/WORKLOG.md)。不把失败版本的功能通过、或单个修复的通过，合并成全应用通过。

大体积完整模型快照已移到本任务私有运行目录，路径与摘要在 [large-evidence.json](../testing/verification-fig-import-20261024/large-evidence.json)。可重复入口为同目录 `check-fig-gui.mjs`、`check-sketch-gui.mjs` 和 `check-navigation-pressure.mjs`；以 `FIG_HOST` 指向清单中的独立构建，并为每次运行传入未使用的记录名。
