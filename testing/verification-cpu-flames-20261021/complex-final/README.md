# 最终六轮连续缩放：实际 CPU 火焰图

[打开四线程图册](flamegraphs.html) · [原始权重与 source-map 证明](summary.json) · [缓存 helper 与策略](helpers/summary.json) · [独立日志等待统计](diagnostics/summary.json)

来源为 `verified-stress-117` / `verified-stress-fig`，使用 immutable `final2-desktop` 实际构建。四份 CDP profile 的 samples/timeDeltas 数量匹配，所有增量有限且非负；没有修正增量、排除线程或猜测 WASM 符号。16 份 JS/source map 均逐项通过实际 artifact manifest SHA-256 校验。

这两次 raw status 仍为 failed：各有两个独立精细参考遇到 native `GPU surface budget exceeded`，原始记录未改。实际 motion/settle 完成且没有 Canvas 错误；这不等于完整白块/清晰度验收通过。CPU sampler 在 motion 之前开启、trace 后停止，独立参考 Worker 在 sampler 停止之后才创建，因此失败参考不混入这些 CPU 权重。完整 profiler 窗仍包含其首尾准备、settling、诊断以及实际内容截图，不是无采样扰动的延迟基准。

实际应用沿 observed host policy 自动选择工作预算：117 为 268,435,456 字节，FIG 为 536,870,912 字节，host optional budget 字段均省略。只有 trace 后独立参考 Worker 收到显式 1024 MiB；observedExecutionPolicy 和 referenceExecutionPolicy 在 helper 摘要中分别保留。这不是应用 4 GiB 实验，也不能算产品预算通过。

| 文档 / 线程 | 加权样本 ms | active ms | idle ms | program 未归因 ms | GC ms（含于 active） | WASM self ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 117 / renderer | 45523.780 | 7128.359 | 36192.235 | 2203.186 | 118.626 | 9.039 |
| 117 / render-worker | 45523.469 | 4835.102 | 40600.424 | 87.943 | 162.334 | 198.764 |
| fig / renderer | 21649.896 | 7651.698 | 11571.833 | 2426.365 | 181.986 | 3.001 |
| fig / render-worker | 21649.732 | 3802.628 | 17773.632 | 73.472 | 156.178 | 20.686 |

## 每线程前五热点

单位均为实际 timeDeltas 加权毫秒。Inclusive 父子互相包含，不能加总；React 调度链尤其如此。这里保留匿名和未命名 frame，不把它们换成猜测的产品调用。

### 117 / renderer

| 排名 | self ms | inclusive ms |
| --- | --- | --- |
| 1 | `sanitizeFields` 1130.157（render-terminal-diagnostics.mjs:23） | `performWorkOnRoot` 4180.453（react-dom-client.production.js:12069） |
| 2 | `toDataURL` 785.303（未映射） | `flushSyncWorkAcrossRoots_impl` 3748.074（react-dom-client.production.js:13408） |
| 3 | `ProgressiveSurfaceImpl` 336.630（ProgressiveSurface.tsx:355） | `performSyncWorkOnRoot` 3746.571（react-dom-client.production.js:13574） |
| 4 | `state.capture` 312.806（未映射） | `(anonymous)` 2960.183（react-dom-client.production.js:13579） |
| 5 | `(anonymous)` 173.289（未映射） | `processRootScheduleInMicrotask` 2960.183（react-dom-client.production.js:13456） |

### 117 / render-worker

| 排名 | self ms | inclusive ms |
| --- | --- | --- |
| 1 | `sanitizeFields` 970.953（render-terminal-diagnostics.mjs:23） | `record` 1136.919（render-terminal-diagnostics.mjs:103） |
| 2 | `certifyExactImageRange` 605.602（exact-image-x-table.ts:15） | `iu.port1.onmessage` 1109.225（render-worker.ts:120） |
| 3 | `self.onmessage` 176.682（render-worker.ts:424） | `presentFrame` 1109.225（webgpu.ts:111） |
| 4 | `Ai` 176.100（composite-draw-plan.ts:39） | `draw` 1101.681（resident-presenter.ts:331） |
| 5 | `(garbage collector)` 162.334（未映射） | `drawList` 1012.437（renderer.ts:1703） |

### fig / renderer

| 排名 | self ms | inclusive ms |
| --- | --- | --- |
| 1 | `sanitizeFields` 1158.840（render-terminal-diagnostics.mjs:23） | `performWorkOnRoot` 5184.954（react-dom-client.production.js:12069） |
| 2 | `interactionOffsets` 498.737（interaction-layers.ts:96） | `flushSyncWorkAcrossRoots_impl` 4783.720（react-dom-client.production.js:13408） |
| 3 | `ProgressiveSurfaceImpl` 367.666（ProgressiveSurface.tsx:355） | `performSyncWorkOnRoot` 4783.720（react-dom-client.production.js:13574） |
| 4 | `state.capture` 320.691（未映射） | `(anonymous)` 3872.804（react-dom-client.production.js:13579） |
| 5 | `toDataURL` 232.320（未映射） | `processRootScheduleInMicrotask` 3872.804（react-dom-client.production.js:13456） |

### fig / render-worker

| 排名 | self ms | inclusive ms |
| --- | --- | --- |
| 1 | `sanitizeFields` 1081.016（render-terminal-diagnostics.mjs:23） | `iu.port1.onmessage` 1750.758（render-worker.ts:120） |
| 2 | `compositeDrawPlan` 344.613（composite-draw-plan.ts:61） | `draw` 1740.414（resident-presenter.ts:331） |
| 3 | `draw` 338.026（resident-presenter.ts:331） | `presentFrame` 1398.371（webgpu.ts:111） |
| 4 | `self.onmessage` 257.553（render-worker.ts:424） | `record` 1291.088（render-terminal-diagnostics.mjs:103） |
| 5 | `(garbage collector)` 156.178（未映射） | `sanitizeFields` 1081.016（render-terminal-diagnostics.mjs:23） |

## UI 缓存 helper 与采样开销

当前最窄的新缓存 helper 成本较小：117 `visibleCompositeContributors` self/inclusive 1.506/27.437 ms，`planTileAdmission` 3.010/6.454 ms；FIG 对应 0/43.530 与 5.976/13.552 ms。CompositeFrameWitness 整个模块 self 为 2.825 / 6.047 ms。0 个 self 样本不能解释为零运行成本。

累计遍历仍有成本：`estimatedTileResidencyBytes` self 为 117 107.729 ms、FIG 89.956 ms；`tilesCoverBounds` main self/inclusive 为 84.524/106.622 与 59.751/77.487 ms。FIG 的 `interactionOffsets` self 498.737 ms 更明显。这些是本轮累计采样成本，不能据此当单帧耗时或承诺某个缓存修复的因果收益。

早先热点 `allParents` 及 `propertyUnits`、`selectionMetric`、`definitionOwner`、`movePreviewPlan` 在本轮所选名称中没有活动采样；这只说明此采样窗未观察到它们，不能证明所有编辑入口成本为零。helper 摘要另外按整个源模块统计匿名子回调，函数 inclusive 与模块 inclusive 不应叠加。

诊断 `sanitizeFields` main self 为 117 1130.157 / FIG 1158.840 ms，worker 为 970.953 / 1081.016 ms；测试截图 `state.capture` main self 312.806 / 320.691 ms，`toDataURL` 785.303 / 232.320 ms。它们都真实出现在 visual-audit 的采样窗内，应与产品功能计算分开解释。该 correctness run 的时序不能用作干净生产基准。

## GPU 等待日志单列

以下来自同一实际 motion trace epoch 窗内的 host 诊断：先递归展开 batch，再按 session/source/seq 去重。它们是 CPU 观察的 GPU 队列 completion 等待，不是硬件 shader 时间，也不是从 idle 样本反推的时间。不可把这些累计值与 CPU 线程 idle 相加、相减或按一对一归因。

| 文档 | fence 数 / 累计 queueWait ms | admission reason 6 | periodic reason 5 | 最大单次 wait ms |
| --- | ---: | ---: | ---: | ---: |
| 117 | 304 / 31308.500 | 212 / 23865.000 ms | 16 / 126.600 ms | 1400.300 |
| FIG | 86 / 895.500 | 12 / 7.200 ms | 53 / 855.200 ms | 103.100 |

117 的主要已记录等待仍在 admission（23,865.0 ms），另有 reason 11 五次合计 6050.0 ms；不把减少某个 fence 名称当计算消失。FIG 的记录以 periodic 为主。完整 reason 数字、取消与请求范围保留在 diagnostics 摘要，不借 stripped WASM 名称表解释它们。

## 复现与证据范围

首次按仓库默认 assetsRoot 运行只遇 ENOENT：本轮 raw artifact manifest 使用 basename key，而当前 dist 已被后续构建覆盖。没有改 manifest、raw profile 或解析器；忽略目录 `baseline-runtime/frontend/design-desktop` 是指向 immutable `final2-desktop` 的只读相对路径 alias，提供解析器要求的目录布局，资源仍以逐项 SHA 而非路径建立身份。

```sh
node testing/verification-cpu-flames-20261021/analyze.mjs \
  --runs-root testing/verification-complex-navigation-20261021 \
  --assets-root testing/verification-cpu-flames-20261021/complex-final/baseline-runtime \
  --run-prefix verified-stress --stages continuous-wheel \
  --out-dir testing/verification-cpu-flames-20261021/complex-final
```

WASM 保留原索引；只采这两个 isolate，未覆盖其它 preparation/native 进程。SVG 活动宽度是累计调用栈权重，既不是时间线，也不是逐帧渲染证明。所有分析仅读取现有资料，未启动应用、GPU、构建或新 profile。
