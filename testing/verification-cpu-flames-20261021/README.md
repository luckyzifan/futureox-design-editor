# 117 / FIG：真实 CPU 采样火焰图

[最终六轮缩放与拖动图册](complex-final/flamegraphs.html) 使用实际 `verified-stress-117/fig` 与 immutable final2 资源；[范围与缓存 helper 分析](complex-final/README.md) 分开记录 CPU、截图/诊断开销和日志队列等待。原始两份 run 的精细参考预算失败仍保留，不能由 CPU 图改判完整视觉通过。

[打开火焰图 HTML](flamegraphs.html)，或查看八份独立 SVG；[summary.json](summary.json) 保留数值、完整热点父栈和输入 SHA-256。来源是 `verification-sharp-sequential-20261021/default-current-117`、`default-current-fig` 的实际 CDP `.cpuprofile`，不是用阶段日志绘制的示意图。

| 样本段 / 线程 | 加权样本 ms | 活动 CPU ms | idle ms | program 未归因 ms |
| --- | ---: | ---: | ---: | ---: |
| 117 wheel / renderer | 865.768 | 171.646 | 603.784 | 90.338 |
| 117 wheel / render-worker | 836.005 | 27.664 | 807.090 | 1.251 |
| FIG wheel / renderer | 1296.219 | 472.643 | 476.645 | 346.931 |
| FIG wheel / render-worker | 1026.922 | 56.892 | 967.515 | 2.515 |
| FIG property X / renderer | 3692.077 | 2555.647 | 892.042 | 244.388 |
| FIG property X / render-worker | 3512.587 | 46.557 | 3464.770 | 1.260 |
| FIG undo / renderer | 2574.062 | 1013.167 | 880.124 | 680.771 |
| FIG undo / render-worker | 1936.480 | 56.281 | 1878.949 | 1.250 |

## 直接定位到的计算路径

- **FIG 属性 X**：`fields.onKeyDown → finish → Inspector.update → Editor.updateProperties/update → change` 累计 1494.474 ms；其中 `kernelLayout` 累计 941.747 ms，真实导出包装 `resolve_components` 累计 789.357 ms。WASM self 合计 815.748 ms，最大项为原始 `wasm-function[3510]` self 175.453 ms。这里只知道导出包装和实际 WASM 索引，没有推断 Rust 函数名。
- **FIG 编码/IPC**：属性段 `reconcileBaseline → captureSnapshot → encode` 累计 572.384 ms；撤销段相同链 590.785 ms。`desktop-session.ts:214:44` 的回调 self 分别 271.432 / 260.880 ms，Electron `invoke` self 分别 124.899 / 118.330 ms。它们位于文档编码桥调用栈；将未命名原生帧进一步认定为具体 clone 算法需要另外证据，不能凭名称猜测。
- **FIG 连续缩放**：`Canvas` self 71.367 ms；`allParents` self 70.261 ms，其节点遍历回调 self 45.352 ms；`Canvas.tsx:2246` 的 slice filter self 32.489 ms。`allParents` 来自 Inspector→selectionMetric→propertyUnits、ComponentPanel→definitionOwner、TextStylePanel→propertyUnits 和 CanvasEditPreview→movePreviewPlan；不是 Canvas 直接 worldMatrix。完整父栈在 `focusedStacks`。
- **Worker 连续缩放**：117 活动样本仅 27.664 ms，FIG 56.892 ms，主要在驻留呈现、`compositeDrawPlan` 和诊断代码。这些短窗口不能支持“Worker CPU 光栅一直忙”的判断；更不能把 idle 直接记成 GPU 耗时。

## 怎么复查与解释

运行 `node testing/verification-cpu-flames-20261021/analyze.mjs` 可从保留的原始采样重建图。解析器逐一验证实际 JS bundle 与对应 source map 的 SHA-256，再使用内置源码映射；不会导入旧 WASM 名称表。`compiledLine/compiledColumn` 为显示用 1-based 坐标；source-map 的 line 是 1-based、column 是 0-based。映射描述采样时的构建，之后修改的 checkout 行号可能不同。

实际使用的16份 JS/.map 已逐项校验并保留在被忽略的 `baseline-runtime/`，目录内保持原仓库相对路径。构建覆盖当前 dist 后，传 `--assets-root testing/verification-cpu-flames-20261021/baseline-runtime` 仍可复查基线。`--runs-root` 指定包含两份采样的父目录，默认子目录为 `default-current-117` / `default-current-fig`；`--run-prefix` 可改前缀，`--out-dir` 把另一轮图表与数值写到独立位置。新一轮必须使用该轮匹配的资产，不得混用基线 source map。

连续缩放新采样使用 `--stages continuous-wheel`，读取两文档目录中的 `continuous-wheel-targets.json` 及各真实profile；默认不传此参数时仍读取原先四类operation jobs。可用逗号传多个明确的stage文件前缀。新manifest若以资产basename为key，解析器在 `--assets-root/frontend/design-desktop/dist/renderer/assets/` 解析并逐项校验JS和source map SHA；旧仓库相对key继续支持。

新targets行可携带 `target`、实际 `TargetInfo`、profile文件名及采样起止元数据；旧的renderer字符串和raw TargetInfo数组同样可读。主线程必须有实际renderer/page标识；只有实际worker类型且记录URL指向 `render-worker` 模块时才标成render-worker，其它worker保留类型/序号，缺失render-worker覆盖会明确写入每份摘要，不按数组序号猜测。

新 `run-sharp-zoom.mjs --profile` 来源要求报告 `profile=true` 且存在有效 `cpuProfileTraceBoundary`。采样开始早于native输入trace、结束晚于trace；解析器呈现完整CDP采样窗口，并保留epoch trace边界及实际TargetInfo元数据，不虚构与CDP单调采样时钟的映射或精确裁剪。这样的图用于定位计算热点，不是无profiler延迟基准。

展示与摘要中的仓库 `file://` 帧 URL 使用 `repo:` 相对路径；其它本机文件只保留文件名，避免提交机器目录。compiled 行/列未改变，原始 profile SHA 与未修改的原始文件仍可复查。

每个 `samples[i]` 使用 `timeDeltas[i] / 1000` 毫秒作为权重。Self 按相同实际帧聚合；inclusive 排名对每个样本内同一帧去重，避免递归重复累计。SVG 保留真实父子调用栈，横向宽度按累计**活动**样本归一化，图底部为 root；它不是时间线。父子 inclusive 相互包含，不可加总。小于 0.5 px 的窄块仅在 SVG 中省略，完整权重仍在原始样本和数值计算里。

本轮 `results.sampling=false` **不代表这些段没开 profiler**：两份报告均为 `extended.cpuProfiling=true`。诊断记录与自动化查询也真实出现在样本里。这些带采样扰动的窗口不能当无 profiler 的交互延迟基准。GC 单列且包含在活动 CPU；idle 与 program 未归因单列，均不被改名为 GPU 等待。主 renderer 与 Worker 起止时间不同，不能相加当整机延迟；其它 preparation/native 进程和 GPU 并未由这两份 isolate 采样覆盖。

此分析只读取已有文件并生成静态证据，没有启动应用、测试、GPU 或浏览器。画面清晰度、白块和 GPU 队列仍需独立的实际呈现证据。

## FIG 布局调用的具体原因及独立 CPU 候选

随后只读检查了同一次 owned Electron profile 的 SQLite revision 1/2。目标仍为 `sha256:9fc30e381907f7d8b7fe635c7e36999c4ec1949cfb90c2d40506cb2fe0d6e448`：19,959 个节点中只改了它的 transform，其它节点和文档顶层值相同。该文字约束是 horizontal=scale、vertical=center、referenceWidth=584、referenceHeight=166，直接父框尺寸也是584×166；更外层 page-root frame 有 scale/scale 约束但没有 reference。

原 `translationOnlyChanges` 对 affected ancestry 中任何 constraints 一律拒绝，因而进入 `!!designSystem` 的全量 `resolve_components(JSON.stringify(document))`。实际内联 font 数为0；SQLite仅有2份图片资产，共99,860字节，引用到7处。大头是约25.2MB的完整节点/元数据图，而非每次传入巨型字体包。`components::changes` 确实执行完整 JSON 解析、验证、before clone、设计系统/组件/布局/布尔解析、再验证及结果差分；不能把这789ms全叫成某个未知 Rust 函数。

已单独实现窄 CPU 候选：对稳定引用尺寸逐轴复现 Rust anchor 运算顺序，并要求候选位置/尺寸 Object.is 固定点；End 消减舍入、Stretch/Scale minimum、负零、缺失/不符 reference 继续回退。只有明确位于 page.children 的根节点才允许不执行的 root constraint；Rust constrain 仅遍历 node.children，不会对 page-root 应用锚定。引用、flow、sizing、资源和其它变更护栏保留。

[constraints-summary.json](constraints-summary.json) 记录55项 CPU 测试全部通过、零跳过（21.715秒）及源文件 SHA。包含实际完整FIG：从该次SQLite恢复全部图片资源后，其 JSON.stringify SHA精确等于原采样报告 `21d6625e5b9936e0aa896f695dcc9c184512ca28cd2d42d7d92e865c52f18693`。5组实际X/Y及重复绝对姿态、反向返回、完整字段与JSON hash、真正 Editor undo/redo 均与强制 `kernelLayout(candidate)`（不传 previous）的真实 Rust/WASM 全量 oracle 完全一致；fast 路径验证没有调用 resolve_components。另覆盖5类anchor、像素、静止缩放父矩阵、parent resize/reference不符/end大数舍入/负零/引用拒绝。原始大文档和测试日志被忽略，未提交私人设计内容。

这些测试验证语义，不是应用延迟或GPU画面结论；新的源码尚需统一构建后的真实交互验收。火焰图仍对应更早的匹配 baseline build，不会因候选源码修改而换成候选测量。

当前没有可直接套到这个函数的现成 resource handle ABI：`load_document_fonts` 已按字体身份复用；`resolve_components` 仍接受整份字符串。已有 preparation receipt/derive 是 canvas→interaction 的受控空delta派生，引用驻留渲染Engine，既不属于主线程layoutEngine，也不返回这里需要的组件/layout差分。Graph编辑op传输已避免相同资源再次同步，但发生在这个预解析之后。直接删资源/约束字段、借用其它session receipt或跳过recovery都不能解决此契约。优先验证本次窄translation admission；更一般的增量布局需要单独的原生ABI及权限/资源/失败原子性证明，不能伪称现有contract已支持。

## 实际 Electron 后续采样：Editor 入口仍曾回退

[resident-filter-v1 火焰图](resident-filter-v1/flamegraphs.html) 与其 [数值/SHA](resident-filter-v1/summary.json) 来自随后实际 Electron 的同类采样，使用独立保存的 `resident-filter-v1-runtime/` 匹配 bundle/source map。FIG property X 中 `Editor.updateProperties → change` inclusive 为1599.468 / 1593.926 ms；`kernelLayout` 1003.279 ms、`resolve_components` 855.259 ms、WASM self 880.494 ms。`reconcileBaseline → captureSnapshot → encode` 另有619.631 ms。这仍是带 profiler 的 CPU 样本，不能解释成干净交互基准或 GPU 等待。

这证明前一版 constraints helper 的直接调用虽然通过，实际 Editor 入口尚未受益。只读核对本次 SQLite rev1→2，19,959节点仍只有选中文字的 transform 发生语义变化；但 `Components.detachMissing` 在每次编辑中对全部22个主组件无条件 clone/replace，即使没有非法属性。严格的 translation admission 正确地拒绝了这些非 transform 引用变化，随后执行全量解析。

修复只让该清理在首次真正删除非法 component property 时复制和替换。translation 引用/布局/约束护栏保持原样。[后续 CPU 证明](resident-filter-v1/editor-translation/summary.json) 为77/77通过、零跳过，21.602秒，相关10个源码/WASM输入前后SHA相同。完整实际 v1 FIG 重建后的 JSON.stringify SHA 为 `4b78f93ca62a45703d91edca1dc411b5955609f79093b5414a57f1d00d9141f4`，精确等于实际 GUI beforeSha256。新增断言真实 `Editor.updateProperties → setNodePosition`（Inspector 使用的回调）及 `Editor.change` 均零次 `resolve_components`，结果与不传 previous 的完整 WASM oracle 逐字段及JSON hash一致；完整编辑撤销/重做一致。另验证无变化组件身份保持、三种真正非法 property 仍被删除、原生组件删除与一次撤销。

第一次新增测试按名称选目标，实际文档有两个同名同位置文字，因此在执行oracle前失败（76/77）；原记录保留。随后通过 `FIG_LAYOUT_TARGET` 固定该次GUI已记录的真实选中ID，完整77项重跑通过，没有删断言或跳过。可复现命令需传 `FIG_LAYOUT_BEFORE` 为对应的完整已复原文档及 `FIG_LAYOUT_TARGET`；独立config已包含组件测试。早先55项中的零解析断言仅覆盖直接kernelLayout调用，不能替代这里新增的真实Editor入口断言。后续实际Electron画面和延迟由另一次统一构建验证，不由此CPU结果代替。
