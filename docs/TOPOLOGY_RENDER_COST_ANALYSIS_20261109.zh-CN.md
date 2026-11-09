# 复杂拓扑精修耗时与 Figma / Sketch 公开架构对照

日期：2026-11-09。已将两次修复提交快进合入远端和本地 main：`a8fc3698ad0874cc2a0a45e751ee7a685f43051a`，与此前验证的代码完全相同。本轮继续分析耗时，没有更改渲染运行时、数学、采样、预算或实验开关。

后续已落地的 GPU 批绘、约 100 秒的新基线及撤回的原生复用候选，见[优化实施与成熟度](TOPOLOGY_RENDER_OPTIMIZATION_20261109.zh-CN.md)。下文保留诊断时的来源与计量。

**110–115 秒的主要成本是大范围场景编译和大量细粒度 GPU 绘制/合成。此前修复减少了重复预览与清晰结果的等待，尚未消除这些底层工作。这个耗时仍是待解决的问题，不能当成复杂文件的合理目标。**

## 110–115 秒具体指什么

该数字来自[此前同文件、同静态相机的未采样对照](ELECTRON_GPU_REPAIRS_20261109.zh-CN.md)：点击“精修完整画板”，等待完整源绑定、当前视口全部原密度瓦片以及呈现回执完成。它不表示每次缩放都要等待这么久，也不是导出全部画板的计时；最初的源文件打开/缩略图阶段另计。

原始 Sketch 归档约 118.27 MB，展开条目约 831.81 MB，共 3 个源页面。应用完整源模式将目录中的 306 个顶层素材、124447 个派生节点纳入同一导航场景。306 是顶层素材口径，不等于 Sketch 原档中的 Artboard 数。与其他应用对比时，必须固定页面/对象范围，不能用另一应用的单页或首张缩略图代替相同完成条件。

这不意味着可以要求用户等待整份重绘。完整源作为权威保留，与只在当前画面投入必要的编译/光栅工作，应当分别处理。

## main 实际构建的分段采样

Apple M2 Pro / 16 GiB，macOS 26.3，Electron 44.7.0，Apple Metal，DPR 2，1440×960 窗口，原相机不变。使用隔离 profile 与 host 副本，读取生产 worker 回执和 native 边界，并采集一次约 3 秒的 V8 CPU profile。无并行重任务，用户原有应用不关闭、不重载。

本轮含日志和采样的运行约 **119.53 秒**，属于定位数据，不能与此前未插桩的 110–115 秒做性能 A/B。最终仍为 16/16、sharp=true、当前相机匹配；完整原生画布 2980736 个 RGBA 像素与此前结果逐位一致，原文件 SHA 未变。

| 实际边界 / 阶段 | 本轮观测 | 含义 |
| --- | ---: | --- |
| 最初 `large.open` | 9.628 秒 | 点击完整精修之前，单独列出，不放入精修耗时。 |
| `large.canvasSnapshot` | 11.739 秒 | 后端派生/绑定完整源快照的请求 wall。 |
| `load_source_snapshot` | 2.015 秒 | native preparation 接受源快照的请求 wall。 |
| 8 个可见批次流水线合计 | 105.477 秒 | 16 块当前视口瓦片，包括准备等待和 GPU 图执行。 |
| 其中：暴露在关键路径的准备等待 | 20.206 秒 | 使用 worker 的 `preparationWaitMs`，已考虑提前准备的重叠。 |
| 其中：图执行 `graphMs` | 84.767 秒 | 包括命令编码、合成、异步让出及 checkpoint，不是纯 GPU shader 时间。 |
| 图执行内部的 `checkpointMs` | 41.014 秒 | 已包含在 84.767 秒中，涉及资源/提交完成等待，不能再次相加。 |
| 最终 `finishMs` 合计 | 0.025 秒 | 只覆盖各次最终 finish 边界，不能用于代表整次 GPU 成本。 |

13 次 native `compile_gpu_packet` 请求的累计 wall 为 28.533 秒；worker 累计 `compileMs` 为 32.067 秒，还含接收、解析和验证等成本。这些工作与上一块的绘制有重叠，不能将它们再加到 105.477 秒上。不同进程时钟原点不互减。

### 已测到的主要成本

1. **每块瓦片仍携带很大的编译上下文。** 13 次编译都走 demand 路径，`resolvedCompileNodes` 范围为 83584–106475；累计投影重建 15 次，投影复用 2 次。这是编译文档/上下文节点数，不是每块实际画出十万个对象。源代码在可见需求扩展后重新构建投影，跨瓦片需求变化会影响复用；具体哪些上下文可进一步缩小仍需保持 mask/backdrop/效果依赖证明。[source_compile.rs](../design-studio/crates/design-kernel/src/source_compile.rs)
2. **绘制调用规模大。** 16 块瓦片合计 1097119 次 draw，3 块获得缓存结果。大量小绘制、覆盖/蒙版、离屏表面和合成造成命令处理成本。这个数不证明所有 draw 都冗余；可合并或消除的范围必须逐项验证采样、顺序和透明度。图执行占流水线约 80%，优先处理这部分。[GPU renderer](../frontend/design-client/src/kernel/gpu/renderer.ts)、[WebGPU driver](../frontend/design-client/src/kernel/gpu/webgpu.ts)
3. **完成等待已经被提前分散到图执行中。** 41 秒 checkpoint 不能通过删 fence、提前回收纹理来“优化”；应减少需要这些中间资源和提交的工作，同时保留完成边界。
4. **当前是开发 native profile。** `desktop-dev` 为 opt-level=1、无 LTO；正式 release profile 不同。release 可能改变 native 准备成本，本轮没有做该场景的 release A/B；JS/WebGPU 图执行工作不会因换 native profile 自动消失。[Cargo profile](../design-studio/Cargo.toml)

约 3 秒 CPU 采样中，renderer 主线程约 97% 为 idle；GPU worker 中可见 scene packet 解码、bind group、render pass、纹理创建、材质 key 等调用。这个窗口支持继续追踪 worker/driver 和准备通道，不代表整个过程的 CPU/GPU 利用率，也没有物理扫描输出或 GPU timestamp 归因。

## Figma 和 Sketch 的公开做法

以下为两家公开的一手技术说明，按文档日期理解；没有在本轮获取其私有渲染源码，也没有运行同文件的两家 GUI 性能对照。

| 一手资料 | 公开说明的做法 | 对本项目的启示（推断） |
| --- | --- | --- |
| [Figma WebGPU，2025-09-18](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/) | 批量上传 uniforms，复用 bindGroups，合并 renderPass；C++ 渲染代码用于 Wasm/native。 | WebGPU 后端需要足够大的有效批次，GPU API 名称本身不能保证快。应测未合批的真实原因。 |
| [Figma 性能工程，2023-08-29](https://www.figma.com/blog/keeping-figma-fast/) | 时间切片、本地操作优先，优化在多种真实硬件上回归。 | 交互及时反馈和最终完成分别设指标；不能只报落定速度。 |
| [Sketch Canvas，2023-02-23](https://www.sketch.com/blog/canvas-tech/) | 共享、缩放无关场景图，原位更新；Web 场景图可预先在服务端生成，再用 C++/Skia/Wasm 绘制。 | 增量维护稳定的渲染表示，避免反复从大范围原始层级重建；服务端预处理与本地首次导入成本分开比较。 |
| [Sketch 渲染优化，2021-12-23](https://www.sketch.com/blog/tech-talk-how-we-made-the-mac-app-faster-with-improved-rendering/) | 分析图层语义，减少不必需的离屏位图。 | 在有等价证明的普通路径中减少中间表面，复杂透明组、蒙版和模糊保留隔离语义。 |
| [Sketch 52，2018-10-02](https://www.sketch.com/blog/dark-mode-data-a-brand-new-look-and-more-in-sketch-52/) | Metal 与新的画布瓦片系统。 | 瓦片缓存是基础；还要控制瓦片背后的编译、绘制和资源成本。 |

这些资料没有给出本文件在 Figma/Sketch 中的完成耗时，不能据此承诺某个速度倍数或声称两者的全部私有实现已经明确。

本项目已经具备源需求索引、frame-scene 缓存、bind-group 缓存、uniform arena、批绘和单步提前准备。当前差距需要通过实际复用率与命令量定位；重复添加同名缓存或整体开启旧实验，不能代替减少本轮测到的工作。

## 优先处理顺序

| 顺序 | 针对的实测问题 | 下一增量应证明什么 |
| --- | --- | --- |
| 1 | 大范围需求投影在邻接瓦片间重建 | 保持完整源权威，在原缓存预算内复用稳定的材质/几何与依赖上下文；记录 scope 扩展原因，减少重建和接收端 packet 解码。不能裁掉实际影响像素的 backdrop/mask 邻域。 |
| 2 | 约 110 万次细粒度 draw 和离屏合成 | 按实际 pass 类型/面积及批绘拒绝原因统计，在证明成立的普通路径扩展现有合批和中间表面消除。保持四相、原密度、效果顺序、HDR/导出要求与资源 fence。 |
| 3 | 首屏与持续输入的工作争用 | 延续本次清晰区域优先策略，验证本地输入抢占、取消和反向缩放；分别报告首区域、整屏、旧帧持续时间与输入到画面。 |
| 4 | 开发 profile 与正式包差异 | 冻结 release 构建后，对同文件/相机/DPR做未采样的配对实测，另测实际安装包；没有实测前不把 profile 切换当作既得收益。 |

下一次运行时优化应以当前 main 为基线，先固定同文件/同视口的实际端到端门，至少改善 5%，同时保留像素、撤销/保存、取消和压力门。采样回放仅定位；真正性能对照与采样、截图、重构建分开。减少命令数本身不算通过。

本轮是诊断和公开资料调研，没有新增运行时提速。完整 G2/G5、33/100 ms、跨平台、同文件 Figma/Sketch 对照仍未执行，既有清晰度与开源/商业发布报告的范围保持。

## 本机证据

`testing/verification-topology-render-analysis-20261109/` 包含冻结 scope、隔离 host/生产 worker 观测脚本、完整回放、CPU profile/source-map 映射、native/worker 分段、像素比较、产物 hash 与 `analysis.json`。2675 个构建输入与已验证构建一致；WASM 仍为 `f34b99057da2ef35fe843d79eb54fdab0feabad414655a661b04d75f7d606c03`。私有设计输入与图片未纳入本次文档提交。
