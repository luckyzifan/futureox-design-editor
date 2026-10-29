# 当前渲染与 core 中 Figma 逆向资料对照

日期：2026-10-28（Asia/Shanghai）。范围：当前未提交工作树的静态调用链、已有真实测试记录、定向质量测试，以及正在运行的 V43 窗口的一次只读观察。本轮没有修改渲染实现、实验开关或用户设计内容，也没有重新运行全应用性能基准。

## 判断

有明确优化空间，当前优先级是：减少实际绘制与合成工作、缩短原生密度像素的等待、提前排除不可见子树。已有瓦片、缓存和局部失效，继续增加同类机制不一定有收益。

用户确认两种症状都存在：运动中模糊，以及停手很久仍模糊。前者找到了明确的默认预览策略；后者尚未定位到唯一缺陷，需要同一运行构建的采样与实际像素对照，不能用“清晰”标签代替。

## 1. 实际路径和证据层级

普通编辑画布：

```mermaid
flowchart LR
  A[Canvas 输入与编辑状态] --> B[KernelSurface / ProgressiveSurface]
  B --> C[Worker 任务与瓦片缓存]
  C --> D[Rust WASM 或 native 准备与编译]
  D --> E[GPU 覆盖 填色 效果 合成]
  E --> F[驻留瓦片 Presenter]
  F --> G[Chromium 画布与编辑叠层]
  B --> F
```

相机移动可先重投影驻留像素；新采样密度和相位需要准备、编译、绘制及呈现。Rust native 准备并不意味着最终走原生 Metal 窗口：通常仍由 Worker 的 WebGPU 路径执行绘制。

源码还有全源 `NativeSourceSurface`：源快照由 native 持有，前端发送 token/owner 和视口，避免将完整文档送入 JS 字符串。它与普通 `ProgressiveSurface` 的任务组织不同，不能把两条路径的能力混写。

**当前接线不一致已复现：** `App.tsx:1246` 向 `Canvas` 传 `nativeSource`、状态和打开素材回调，但 `Canvas.tsx:224` 没有对应 props，也没有挂载 `NativeSourceSurface`。实际 `bun run typecheck` 因 TS2322 失败。该 surface 在独立 `native-source-check.tsx` 中有挂载。因此，历史验证页成功不能证明当前工作台接线完整；也不能把这个源码问题当作正在运行的 V43 的已证故障。

## 2. 运动模糊：默认导航预览主动降低密度

当前 [navigation-zoom.ts](../../frontend/design-client/src/kernel/navigation-zoom.ts) 的普通导航预览为：

```text
ratio = min(DPR, 1, sqrt(1048576 / (CSS_width * CSS_height)), 2048 / max(CSS_width, CSS_height))
```

`ProgressiveSurface` 的活动导航捕获实际使用这个 ratio。例：1000×800 CSS 像素、DPR 2，原生目标为 2000×1600，而普通导航捕获为 1000×800。每轴需要放大 2 倍，总像素量只有原生的四分之一；视口更大还会继续降低。

同一模块默认 `NAVIGATION_ZOOM_SAMPLE_MS=160`、`NAVIGATION_ZOOM_QUIET_MS=160`。普通 hook 没有启用 `adaptiveQuiet`；手势释放的已知边界、原生像素覆盖复用等另有快速路径。这里的 160ms 是新预览采样与停手判定策略，**不是合成器只能运行 6.25 FPS**。旧纹理仍可随每帧相机移动，但纹理内的新细节不会随之产生。

现有复杂内容公平精修分支还要求 `view.zoom >= 1`。因此低于 100% 的活动导航不能依赖这条原生精修分支；仍可能复用已有高密度纹理或走其它路径，不能理解成低于 100% 永远不清晰。

优化方向：在已具备短任务的场景，让原生密度可见瓦片及时完成，低清捕获只承担确有需要的缺口；按实测绘制成本决定调度，避免小文件也无条件等待相同窗口。需要一起测取消浪费和首像素时间；只把 160 改为 16 或直接抬预览上限，可能增加过期工作和显存压力。

## 3. 停手后模糊：必须独立做像素验收

已有的正确机制：

- [canvas-raster-plan.ts](../../frontend/design-client/src/kernel/canvas-raster-plan.ts) 按 `zoom × DPR` 要求最终密度，并检查设备像素采样相位。
- [ProgressiveSurface.tsx](../../frontend/design-client/src/kernel/ProgressiveSurface.tsx) 的完成条件检查 preview、相位、frame key、文档同步、相机和稳定密度。
- [resident-presenter.ts](../../frontend/design-client/src/kernel/gpu/resident-presenter.ts) 已使用 `minFilter: linear, magFilter: nearest`，不能把“将放大过滤改为 nearest”当作尚未实施的修复。
- [presented-fragment-quality.ts](../../frontend/design-client/src/kernel/gpu/presented-fragment-quality.ts) 明确说明：其覆盖与密度指标不检查纹理内部像素、alpha 内容或效果保真。

所以“WebGPU · 清晰”主要是内部完成协议；它不自动证明字形轮廓、图片原始分辨率、同字体外观或 Chromium 最终合成完全符合用户预期。

下一轮应该对同一个固定画面同时核对：当前 revision/pose、最终纹理尺寸、实际采样比例、UV 相位、Canvas backing/CSS 尺寸与变换、最终 GUI 像素。以 1px 线、12/14/16px 文字、重复图标、原始分辨率已知的图片为小夹具，覆盖 100%/125%/200% 和整数/分数平移。

若纹理本身已软，继续查字体/路径覆盖、图片采样和 resolve；若纹理清晰而 GUI 软，继续查最后的缩放与像素对齐；若仍在显示旧纹理，回到任务完成与替换链路。不能提前把这三类都归因于 DPR。

本轮只读观察到运行中的 `FutureoxTopologyRefinementV43` 在 100% 显示 `WebGPU · 清晰`。该画面的文字可辨，没有用该单张截图证明或否定其它位置的持续模糊；未核验 V43 与当前工作树的构建对应关系。

## 4. 大小文件都慢：绘制工作量比文件字节数更关键

[已有真实瓦片准备 A/B](../verification-tile-preparation-20261026/README.md) 特别有价值：

| 指标 | 历史记录 |
| --- | --- |
| 准备调用 | 32 → 28；清缓存 4 → 0 |
| 鼠标释放至精修，中位数 | 7529.5 → 7315.6ms |
| 改善 | 2.84%，未达到保留门，候选未采纳 |
| 剩余绘制 | 约 8.2 万次 |
| graph 阶段 | 候选约 5.5 秒；包含 checkpoint，不能全算 GPU 纯执行时间 |

这组结果说明，在那个真实场景中，准备复用并不是剩余约 7 秒收敛的主要解法。[拓扑记录](../verification-topology-navigation-20261026/README.md) 还记录过首屏 20 瓦片 66,429 draws，以及全源复杂瓦片数十秒的失败；这些均为旧构建的限定场景证据，不是当前 V43 的重新测量。

当前 [GpuRenderer](../../frontend/design-client/src/kernel/gpu/renderer.ts) 为保持四个相关样本、裁剪、隔离、混合顺序及浮点语义，会产生 coverage、paint、merge、copy、effect 等多段工作。一张很小的文件也可能有昂贵的多层阴影、背景读取和大量细小路径；文件小不等于每帧工作少。

最值得继续做的是：

1. 在原顺序内扩大安全批绘与 paint/merge 融合命中，消除可证明多余的中间表面与复制。
2. 只处理有贡献的像素区域，避免每个轻量节点反复合成整个大目标。
3. 对同采样、同源、同依赖的相邻瓦片复用效果中间结果，保留完整 halo 与背景读取依赖。
4. 用实际 draws、passPixels、RT 切换、队列等待和端到端精修共同评估；不能只优化某个 finish 数字。

当前已有 `VITE_DESIGN_MIXED_SOLID_RUNS` 等候选和区域合成实现，且 [10月28日工作范围](../verification-render-work-reduction-20261028/RUN_SCOPE.md) 正在处理这些方向。应核验这些增量的实际命中和验收，不另起一套重复批绘器，也不将 opt-in 代码存在当成默认已获益。

本轮没有实测真实小文件的完整性能分布，因此“小文件主要卡在哪一个 pass”仍需单列 profile；以上区分了已证策略成本与待测运行瓶颈。

## 5. 大文件的结构优化：在几何展开前裁剪

[geometry_snapshot.rs](../../design-studio/crates/design-kernel/src/geometry_snapshot.rs) 已有 prepared 缓存、叶子裁剪和中性裁切 frame 的早退。但普通未缓存分组仍递归；文本路径获取发生在通常的叶子离屏检查之前。`RenderIndex` 主要承担拓扑/连接关系，不能等同于保守光学边界的空间索引。

[gpu.rs](../../design-studio/crates/design-kernel/src/gpu.rs) 的 `CameraPrepareKey` 包含精确相机；`covers()` 要求相机相同及准备范围包含。已有 LocalPaths、字体轮廓、描边和相机缓存；新密度仍可能重建设备空间几何和覆盖程序。

应继续分离：

- 世界空间：稳定路径、字形轮廓、子树边界、效果依赖。
- 设备空间：当前缩放、采样相位、覆盖程序和目标区域。

新相机先用保守空间索引筛出可能贡献像素的子树，再展开设备几何；对未变化的世界数据继续驻留。不能简单从 cache key 删除 zoom/phase，否则会错误复用采样。

全源快照的所有素材包在一个 `clip=false`、`pass-through` stage 下。因此只索引 page 根会命中一个巨大的 stage，收益有限；需要在其内部建立安全的素材/子树边界。阴影、描边、模糊、蒙版和背景依赖必须计入，布局目录矩形不能直接当光学裁剪框。

该方向对大文件放大查看少量内容最有潜力；全览全部内容可见时，仍需第4节减少实际绘制。

## 6. 全源路径没有使用所有已有调度能力

[NativeSourceSurface.tsx](../../frontend/design-client/src/kernel/NativeSourceSurface.tsx) 每次取中心排序后的 `missing[0]`，以 `tileViewport:[tile]` 请求并 await 完成。停手 120ms 后转最终相位。它不是随机取块，也没有使用 256px 瓦片：`planTilesAligned` 的第三参数 256 是计划数量上界，实际 `TILE_SIDE` 为 512。

[render-worker.ts](../../frontend/design-client/src/kernel/render-worker.ts) 已有 `PrepareAhead`，但只有同一批次存在下一块且 native 支持并行准备时，才能把下一块 CPU 编译与当前 GPU 工作重叠。单块请求不能利用这一跨瓦片流水线。

可以试两块相邻可见瓦片的小批次，保留逐块回调、最新相机取消和资源所有权；再复用普通路径已有的 `NavigationCost` 与空闲预取。第一块冷编译不会因此消失，GPU 主导时也不能期待大幅缩短总耗时。

现有 `EncodeYield` 已约每4ms让出 CPU 编码；这与一个昂贵瓦片何时交付新像素不同。下一步需要可完成的小工作单元，而不是只让事件循环有机会处理消息。

## 7. Figma 资料中真正值得借鉴的内容

资料对应其采集版本，以下不宣称是所有当前 Figma 版本的统一实现。

| 参考机制 | 资料证据 | 当前项目对应与建议 |
| --- | --- | --- |
| 按需物化、不可见子树推迟 | `BIG-FILE-PIPELINE` §8 为函数/字符串锚点级证据，部分完整算法仍未恢复 | 前置保守子树空间索引，让视口外对象尽早退出准备 |
| 512px 瓦片、按需 populate、LRU、独立 blit | `GLUE-JS-MINING` §2 的 viewer 实现级证据；编辑器实际调度在 WASM | 当前已有同类结构，应改善成本、抢占和生产路径覆盖 |
| 相机密度两帧稳定后更新 | viewer JS 实现级 | 当前另叠了160ms导航窗口；应按实际成本评估轻场景的原生密度更新 |
| effect pass fusion、direct composite、分析 mask、回退原因 | `TILE-VRAM-TELEMETRY-FINAL` C4 指令级策略解析 | 扩大已实现的严格融合能力，追踪命中/拒绝原因和实际像素工作量 |
| Loop-Blinn、textAlpha、smoothPathInstanced | `RUNTIME-TRACE` 与 `RENDER-DETAILS` 的实际 pipeline 捕获 | 长期探索稳定几何/字形 GPU 实例复用；不是立即替换精确主路径 |
| worker render section 缓存与 snapshotHash | `BIG-FILE-PIPELINE` §5 合同与锚点 | 延续现有增量传输、资源身份和片段缓存，减少重复编译与上传 |

不要照抄的结论：

- viewer 的16ms/2瓦片预算对屏内工作存在豁免，不能宣称 Figma 保证每帧只画两块或每块16ms内完成。
- viewer 的384MiB瓦片缓存目标、平台显存启发式和本项目工作表面预算是不同口径，扩大预算不等于修复延迟。
- Figma 的有界采样和降采样策略不能直接替换本项目严格效果数学，并宣称完全等价。
- 文本/描边优化文件存在不代表命中。当前 `RendererOptimizations` 未发现生产引用；`StrokeGpuPipeline` 只经该模块引用，实际几何准备仍调用 Rust 描边缓存与变换。这不证明全部 GPU 几何优化缺失，但不能据注释写“描边已经全部GPU化”。

参考文件：

- [GLUE-JS-MINING](../../../core/figma-wasm-analysis/GLUE-JS-MINING.md)
- [BIG-FILE-PIPELINE](../../../core/figma-wasm-analysis/BIG-FILE-PIPELINE.md)
- [TILE-VRAM-TELEMETRY-FINAL](../../../core/figma-wasm-analysis/TILE-VRAM-TELEMETRY-FINAL.md)
- [RENDER-DETAILS](../../../core/figma-wasm-analysis/RENDER-DETAILS-2026-10-26.md)

## 8. 建议实施顺序

1. **先使基线可信：** 修复当前全源接线/类型错误，绑定运行构建、源码、WASM/native 与默认配置；小文件、117、全源文件分别记录。
2. **先处理用户可见故障：** 分开测运动中旧纹理放大与停手后的最终字形/线条；让状态完成和实际像素一致，补齐无法精修的明确错误。
3. **减少实际渲染工作：** 完成现有批绘、区域合成、常量覆盖和融合候选的硬件及真实应用验证，重点看重效果与轻矢量是否都获益。
4. **大源前置裁剪与稳定准备：** 建立保守子树支持索引、保留世界几何；全源两块小批次作为独立、较小的接线候选验证。
5. **再做长期几何与文本管线：** 按实际CPU热点决定字形实例、路径实例或GPU描边，不依据未接入文件的注释预测收益。

每次 A/B 同时保留：首次可用像素、最后输入至清晰、旧帧最长持续、最大纹理放大倍率、compile/graph/checkpoint/finish、draws/passPixels、资源峰值和同层像素对照。输入ACK、无UI停顿和“清晰”标签都不是实际画质或物理FPS的替代指标。

## 本轮实际检查

- 只读审阅上述当前源码与父目录逆向资料；历史数据单独标注。
- `bun run typecheck`：失败，`App.tsx:1246` TS2322，`Canvas` 缺少 `nativeSource` prop。
- 四个定向 Vitest 文件：`canvas-raster-plan`、`navigation-zoom`、`progressive-quality`、`presented-fragment-quality`，85项通过。它们只证明所测CPU/状态逻辑，不证明实际GPU/GUI清晰度。
- V43 GUI只读观察一次，100%与“WebGPU · 清晰”；没有移动、编辑或保存文档，没有对其测FPS。
- 未执行：同构建小/大文件性能A/B、完整G2/G5、硬件像素新对照、导出/HDR回归。源码中的既有未提交改动保留；本报告不构成运行时修复验收。
