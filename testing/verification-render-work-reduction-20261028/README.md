# 精确绘制减量：实现与验证（2026-10-28）

本轮已经实现连续纯色段批绘、独立常量覆盖、渐变填充/合成融合及分阶段工作量诊断。最终默认开启纯色段与渐变融合；常量覆盖保留为单独候选，因为热帧耗时没有达到运行前冻结的 5% 改善目标。

最终默认构建在 Apple Metal 3 硬件上，10 个合成场景、4 个真实文件视口和 7 个精度边界场景均逐位一致。真实 `117` 全览从 **7,136 → 4,056 draws（减少 43.2%）**，配对中位渲染/读回 wall time 从 **443.7 → 335.9 ms（减少 24.3%）**。这是指定视口的生产渲染路径验证，不是全编辑器 FPS 或全部复杂场景验收。

## 已实现的行为

1. **连续纯色段**：Rust 生成保持 painter order 的稀疏连续段；段之间的渐变、短段和透明度叶子仍按原顺序绘制。只有 Rust 证明为有界普通填充的组才允许混合替换。四个相关采样独立执行；目标必须私有且可写，实际 GPU 覆盖程序仍须通过证明。不跨效果、蒙版、未知背景依赖重排。
2. **渐变填充 + normal-over 融合**：复用原生渐变字段及 RNE 运算，省去中间 paint 纹理和合成 pass。保留原合成写入边缘、双线性读取邻域和 signed-zero 行为。证明绑定实际上传的 GPU 资源，复用写入时撤销。HDR、非有限字段、不支持的 clip、超界颜色、大字段和单个机会继续走原路径。
3. **常量覆盖候选**：只将已证明完全覆盖的逻辑区域映射到共享、不可变的 1×1 RGBA8 纹理，物理存储为 4 bytes。保留原逻辑范围、四采样和预算准入。测试发现普通 managed RGBA 上传会扩为 RGBA32F，已改成独立真实 RGBA8 分配并加入验证。
4. **诊断 v2**：独立统计 Coverage、Paint、Merge、Effect、Copy、PaintMerge、Resolve、Present；记录实际提交矩形面积、未测面积的 draw、缓存命中/失配、证明/资源/容量拒绝原因。全部为有界数值，不记录对象名或文档内容。瓦片聚合对诊断版本取最大值，不做累加。
5. **集成修复**：恢复 App 已经传入而 Canvas 未接收的原生源画布参数，接通全源范围滚动/适配与手形工具双击打开素材；排除滚动条等控件上的双击。另修复全透明 blur 的零值返回顺序。它们分别有回归，不计作渲染提速。

旧 painter/filter 实验开关、资源限额、采样精度、导出/HDR 语义均保留。Effect 的算法工作量本轮没有减少，诊断已明确显示其剩余成本。

## 默认策略与回退

| 构建时环境变量 | 默认 | 回退/启用 |
| --- | --- | --- |
| `VITE_DESIGN_MIXED_SOLID_RUNS` | 开启 | 显式 `0` 禁用 |
| `VITE_DESIGN_FUSED_GRADIENT` | 开启 | 显式 `0` 禁用 |
| `VITE_DESIGN_CONSTANT_COVERAGE` | 关闭 | 仅显式 `1` 启用候选 |

这些开关独立于旧 `VITE_DESIGN_OPAQUE_SOLID_BATCH`、`VITE_DESIGN_EXACT_CLAMP_PREFIX` 等实验。重新构建才会改变配置。场景级筛选避免为不能执行的批绘或唯一小渐变机会准备管线。

常量覆盖在最后一次全候选测试中，冷帧 draws 155 → 151，记录的峰值纹理字节 5,505,056 → 4,718,628；热帧 draws 都为 151，wall 中位数 27.3 → 34.5 ms，**性能目标 FAIL，因此不默认采用**。冷帧首次管线准备有顺序偏差，不用其 wall 值宣称收益。记录见 [synthetic-release.json](synthetic-release.json)。

## 最终默认配置的硬件结果

同一个构建、同一 Rust/WASM 编译结果、同一设备，控制侧关闭本轮新入口，候选侧采用最终默认策略。两次预热后做三次交替 A/B，包含 GPU 完成与 float 读回的 wall time；不是 GPU timestamp，也不包含 Rust 场景编译或输入到物理屏幕呈现。A/B 使用同一版本诊断和安全修复，不能称为运行旧版本二进制的对照。未与重编译/测试并行。

比较原始 RGBA32F 的 u32 位模式，包含 signed zero；合成每例 196,608 words，真实每例 1,048,576 words，边界合计 221,184 words。最终共 **6,381,568 words，0 差异**。每例比较一次预热输出；计时重复不是额外独立像素 oracle。

| 场景 | draws 前 → 后 | wall 中位 ms 前 → 后 | 判定 |
| --- | ---: | ---: | --- |
| linear | 243 → 163 | 26.6 → 20.1 | 工作量及 5% 目标 PASS |
| radial | 243 → 163 | 27.2 → 18.1 | PASS |
| angular | 243 → 163 | 24.7 → 17.6 | PASS |
| diamond | 243 → 163 | 22.9 → 15.9 | PASS |
| 64 stops | 243 → 163 | 38.0 → 31.2 | PASS |
| clipped | 243 → 163 | 31.9 → 18.2 | PASS |
| mixed solids | 527 → 27 | 50.7 → 9.9 | PASS |
| constant（候选关闭） | 151 → 151 | 24.5 → 21.3 | 无工作量变化，不归因提速 |
| wide color | 243 → 243 | 22.2 → 23.1 | 回退；5% 目标 FAIL |
| mixed effect | 538 → 538 | 43.9 → 43.3 | 回退；5% 目标 FAIL |
| FIG cards | 189 → 189 | 30.4 → 35.6 | 无工作量变化；5% 目标 FAIL |
| FIG charts | 116 → 116 | 25.2 → 23.8 | 无工作量变化，不归因提速 |
| 117 overview | 7,136 → 4,056 | 443.7 → 335.9 | 工作量及 5% 目标 PASS |
| 117 detail | 996 → 996 | 155.5 → 141.7 | 无工作量变化，不归因提速 |

原始结果：[synthetic-default.json](synthetic-default.json)、[real-default.json](real-default.json)、[edge-default.json](edge-default.json)。边界涵盖 1/2/3 倍导出配置、analytic、HDR 值，以及私有/共享目标的非有限邻域。该检查不证明所有格式导出、物理 HDR 显示或全滤镜组合。

真实 FIG 保持其 analytic 配置与原颜色语义，未为了命中新路径改成四采样配置。真实文件共 19,277 和 752 个源节点，测试只编译明确指定的视口，不能把源节点总数当成同时渲染数量。原文件最终 SHA-256 与最初一致，见 [source-originals-final.json](source-originals-final.json)。转换后的含内容 JSON 留在本机临时目录，不放进本记录。

## coverage / paint / merge / effect 的实际占比

下表使用 **117 全览控制侧已测提交矩形像素面积**，不是 GPU 时间占比。warm coverage 很低，是现有覆盖缓存已经命中，不代表冷帧几何免费。融合 pass 单列，避免把同一次工作同时算入 paint 和 merge。

| 阶段 | draws | 已测矩形像素 | 面积占比 |
| --- | ---: | ---: | ---: |
| Coverage | 68 | 4,852 | 0.03% |
| Paint | 437 | 1,099,001 | 6.53% |
| Merge | 1,630 | 8,497,551 | 50.53% |
| Effect | 126 | 3,689,372 | 21.94% |
| PaintMerge | 2,276 | 1,567,952 | 9.32% |
| Copy | 2,588 | 1,512,800 | 9.00% |
| Resolve / Other | 11 | 446,459 | 2.65% |

候选已测面积 16,817,987 → 15,978,071，另有 4 次批绘的面积未纳入诊断，明确计为 unmeasured。不能将这个差额宣称为完整 GPU 像素处理量下降。旧 `passPixels` 计数另为 13,814,329 → 13,064,113，口径不同，不与新统计混用。峰值字节是渲染器记账（包括保留缓存），不是物理显存。

117 detail 的 Merge 与 Effect 分别占已测面积 39.84% 和 33.72%，本轮两侧工作量相同，仍是后续主要优化方向。完整分解见 [real-default-summary.json](real-default-summary.json)。

## 回归、构建与 GUI

- Rust scene-plan：4 项通过；变更后已重建 portable release WASM，见 [native-plan-initial.log](native-plan-initial.log)、[wasm-build.log](wasm-build.log)。
- 最终 TypeScript typecheck 通过；最终受影响 GPU/Canvas/源工作区回归 118 项通过，见 [typecheck-default-final.log](typecheck-default-final.log)、[integration-default-final.log](integration-default-final.log)。
- 最终完整 GPU 回归 **1,759 项通过、7 TODO，157 个测试文件通过**，见 [gpu-default-final.log](gpu-default-final.log)。不同轮次和重叠范围测试不累加。
- Host 数值诊断 5 项通过；任务补丁 reverse-check 与 `git diff --check` 通过。
- 最新 macOS arm64 桌面默认构建通过，隔离产物位于 `/tmp/futureox-render-work-reduction-desktop-final-20261028`；[构建清单](desktop-build-manifest-final.json)、[产物哈希](desktop-artifacts-final.json)。没有覆盖现有运行实例或发布包。
- 前一桌面候选完成正式菜单导入真实 117、渲染、透明度 100 → 90 → 撤销回 100，截图/AX 留存：[画布](desktop-117-ready.png)、[撤销状态](desktop-117-undo.ax.txt)。其 [GUI 构建清单](desktop-build-manifest-gui.json) 单独绑定。该 GUI 检查早于最终场景筛选、常量物理格式修复和默认关闭，不伪称最新构建的 GUI 全回放；最终组合由上面的真实文件硬件、集成测试和桌面构建验证。

完整 G2/G5 固定规模矩阵、持续运动、全部高倍视口、跨平台、物理 scanout/FPS、最终桌面全量 GUI 回放：**NOT_RUN**。本轮不关闭此前的复杂运动/全源编辑问题。

## 保留失败与复现

运行前标准在 [RUN_SCOPE.md](RUN_SCOPE.md)。失败和中间测量没有被删：初始 harness 的缺失文件/色彩 schema、真实同名嵌套节点选取错误、edge 的非有限上传夹具错误，均保留对应 JSON/log。`synthetic-final.json` 的 mixed-effect 耗时 41.9 → 64.2 ms（含 144 ms 异常样本）促成场景级机会筛选；`synthetic-adopted.json`、`real-adopted.json` 和全候选 release 结果也保留。最终回退场景仍未获得稳定工作量收益，没有把波动算成功。

可复现硬件构建：

```sh
node testing/verification-render-work-reduction-20261028/build-hardware.mjs /tmp/NEW-EMPTY-OUTPUT
node testing/verification-render-work-reduction-20261028/serve-hardware.mjs /tmp/NEW-EMPTY-OUTPUT /tmp/report.json 60235 /tmp/futureox-work-reduction-real-inputs-20261028
```

浏览器打开服务打印的 `hardware.html`；`?real=1` 是真实文件，`edge.html` 是边界。真实临时输入可通过 `prepare-real-fixtures.ts` 重新生成（需原文件和当前 WASM）。`build-hardware.mjs` 额外参数 `all-candidates` 用于显式开启常量候选。原始构建身份见 [默认硬件 provenance](hardware-provenance-default.json)、[全候选 provenance](hardware-provenance-all-candidates.json)。最终代码与这两组配置差别已分别记录。

## 改动与回滚

[changes.json](changes.json) 和 [task.patch](task.patch) 只覆盖本轮 18 个源码/测试/规则文件；基线是已有脏工作区，不是 Git HEAD。`before/` 只保留对应原内容。Host 诊断测试的原始内容由已知改动重建并标明；tile 版本聚合原内容重建后与运行前冻结 hash 完全匹配。其他任务修改的 `NativeSourceSurface.tsx` 和 `canvas-fallback-submission.test.tsx` 保留，不归入本轮。

回滚先逐项核对 `afterSha256`，执行 `git apply --reverse --check testing/verification-render-work-reduction-20261028/task.patch`，确认没有后续修改后再 reverse apply，并重建 WASM/桌面。不要用全仓库 reset。记录内脚本/JSON/log 为新增验证证据，不属于运行时补丁；`desktop-gui.log` 仍可能随独立旧测试实例追加，最终证据摘要不对它作不可变文件承诺。
