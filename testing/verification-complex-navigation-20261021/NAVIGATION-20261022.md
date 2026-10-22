# 2026-10-22 导航计算和工作交付修复

这份记录只说明已有采样依据、实现边界和 CPU 调度回归；实际 Electron 画质、GPU 等待和输入延迟须由本轮匹配构建的实机结果另行验收。

## 已有实际采样依据

上一轮 FIG 六轮复杂缩放平移的 renderer profile（`verified-stress-fig/continuous-wheel-0.cpuprofile`，SHA-256 `815682f0a7b3ca5149265c90b88ba9718dab5f46a7bcb29fa6c25923ac5a8ec2`）中，`interactionOffsets` 节点 419 的 self 样本累计为 **498.737 ms**。其父节点 143 的真实 sourcemap 指向 `interaction-renderer.ts` 的 `prepare`，与 [上一轮图表](../verification-cpu-flames-20261021/complex-final/README.md) 一致。这是整段采样累计，不能当作单帧停顿或本次已经获得的加速量。

`prepare` 创建计划时传入的文档与计划源文档是同一个对象。原验证仍枚举全量节点比较零位移；现在只读取选中 ID 并返回零位移。不同文档引用仍执行原有完整字段、节点和变换验证；没有新增一般文档身份缓存。缺失、继承和重复 ID 的原有结果保持一致。

## 导航工作交付

此前默认导航每个 160 ms 样本都会取消运行中的完整视口预览，并在完成后丢弃不再对应最新样本的结果。若一次实际渲染超过该间隔，就可能反复消耗已经提交的工作，迟迟没有可显示的新像素。这是控制流缺口；它不是独立 GPU 计时结论。

现在延续现有串行 mailbox：一个运行中的任务完成，等待区只保留最新目标。导航所有权在任务真正开工时创建，完成后在下一任务开工前解除。已完成的旧相机样本只能以自身真实相机、密度和缓存身份保留；不会覆盖最新计划，也不能将 `detail-ready` 或最终采样相位标记为已通过。

默认路径的采样间隔、预览密度、四个相关采样相位、精确计算、显示预算与已有有界替换 reserve 都保持原值。旧相机结果无权借用最新前景的替换 reserve。未通过的 sharp/sequential/headroom/filter scratch 实验没有因此启用。另行实现的严格 opt-in 原生密度/RAF 候选见下文，不能与默认路径混称已经通过画质或延迟验收。

内容、编辑/撤销产生的新文档引用、字体、页面、session epoch、DPR、尺寸、暂停、隐藏、手势结束及已确认的 GPU device incarnation 变化仍使运行中结果失效。迟到的 bitmap 和 GPU handle 交回原有释放路径。

## 验证边界

生产 `ProgressiveSurface` 的父 hook 图和真实 mailbox/预算准入代码用于下列对抗顺序测试；栅格传输、子 GPU 合成器和相机输入时序是受控替身，不据此声称真实 GPU 像素或帧率通过。

- WebGL2/WebGPU 各 200 个交替缩放、平移样本：保持一个运行任务及一个最新等待目标，旧结果保留真实相机，最新目标没有被旧回调重新命名。
- 编辑、撤销、字体、页面、epoch、DPR、尺寸、暂停、隐藏、挂起、手势结束及已确认 GPU owner 变化：迟到 bitmap/handle 各释放一次，不发布过期纹理。
- 现有 128 MiB 稳态预算几乎被完整显示帧占满：旧相机结果按历史预算丢弃，不逐出显示源或偷借前景 reserve；最新目标仍可按原有有界 reserve 准入。
- 同源快照重复 100 次准备不枚举节点；新引用的位移仍计算正确，子内容或页面变化仍拒绝复用。

`tsc --noEmit`、`git diff --check` 已通过。导航交付、预算准入、实际 React 失败转发、图层/整页移动和交互密度的 **9 套 212 项** targeted tests 通过。首轮 focused 测试因原测试只等待固定两次 microtask、缺少 RAF 替身及 `-0` 期望失败；修正了这些测试条件，没有降低所有权、预算或像素验收标准。

另行运行未重叠的 NavigationZoom/hook、可见合成源与原子帧见证 **4 套 52 项**，全部通过；没有更改这些缓存/采样模块。

本修复没有解决冷缩放时原预览密度不足，也没有建立模糊消除、无白块或低延迟的实际设备结论。必须继续分别比较新 Electron 的实际操作、画面、GPU 完成等待及严格同档和导出结果。

## 后续独立候选：原生密度导航与 RAF 最新目标

默认导航 `navigationPreviewDensity` 仍限制到 DPR 1/约 1 Mi 像素并按 160 ms 发预览；在实测 DPR 2 画布，这些像素本来就不能作为原生清晰证书。新候选要求两个开关都为精确字符串 `1`：`VITE_DESIGN_NATIVE_NAVIGATION` 和 `VITE_DESIGN_EXACT_CLAMP_PREFIX`。它同时要求 WebGPU resident、desktop display/full math、正常 SDR canvas；CPU/WebGL2、HDR、pixel preview、grid/checkerboard、figmaSoftware、对象编辑及其它实验式 sharp/headroom 路径均不启用它。

候选只更改活动导航分支：比率为实际 DPR，855×888 CSS、DPR 2 对应 1710×1776 像素。client、原生 viewport 与实际 GPU working-set 的原有准入仍执行，失败不会暗自降到 1x 重试。单次 startup coarse preview 保留旧值；编辑、撤销、导出与显式 readback 的质量路径没有接入该候选。filtered 旧低密度缓存覆盖不再使候选跳过原生请求；已确认的同设备、同内容物理密度覆盖仍可以复用。

`NavigationZoom` 的候选策略在第一条输入立即发出一个样本，随后原始输入只替换目标，RAF 发出这一帧最新相机。正常策略继续使用 160 ms。160 ms quiet、两次稳定帧、显式指针释放时使用已 flush 的最终相机都保持原边界。`useNavigationZoom` 将策略计入 owner；已取消但仍触发的旧 RAF 回调还要检查 live/状态对象、文档 owner、平移策略和采样策略，不能重新发布旧样本或复活计时器。

这个策略仍使用已有串行 mailbox 与真实缓存身份：一个运行任务、一个可替换的最新等待目标，旧完成样本只以其真实相机/密度保留，不能被命名为当前高清。它不增加并发 GPU capture，也不使用纹理 warp 作为去模糊验收。若 GPU 仍追不上输入，显示依旧可能使用旧样本；必须如实由连续帧质量/相机滞后门判失败。

调度、真实 hook dispatcher、parent surface、mailbox/intent 的 **5 套 200 项** focused tests 已通过（12.49 s），包含严格双开关、10 类质量排除、原生预算拒绝不降密、200 个原始目标到一个 RAF、旧 RAF 的 owner/策略/可见性失效。它们是受控调度/传输证据，尚未建立实际 GPU 清晰度、低延迟或无白块结论。源码在后续实 GPU proof 之前已冻结，候选保持默认关闭。

后续同一构建/文件/操作对照应至少包含连续大幅缩放与反转、快速 pan 出入已缓存边界、zoom/pan 交错、停下后的原生相位修复、DPR/resize/切文档/编辑与撤销并发、缓存接近既有预算后回访。分别统计真实输入→ACK 的相机/密度、可见有色内容漏画、每个完成 viewport 的实际像素数、队列等待、CPU 火焰图以及同档画面/精确导出；不能只凭请求数降低或纹理复用次数通过。


## 后续 CPU 小刀：借用 Canvas 已发布 scene

实际 Deep1 FIG renderer 火焰图中，`ResidentCompositeSurface` 的 layout effect → `InteractionRenderer.prepare` 累计采样为 **1,043.467 ms**；其中 `scene → visit` 为 **611.221 ms**，`buildInteractionDependencyScope` 为 **339.432 ms**，后者已包含 `interactionRootBounds` 的 158.724 ms。整段 profile 窗口为 19,915.842 ms、active CPU 为 6,004.958 ms；这些是累计采样工作，不能写成一次 611 ms 卡顿、某一输入的延迟，或新实现已获得的加速量。来源是 [Deep1 实际火焰图](../verification-cpu-flames-20261021/deep1-complex/README.md)，FIG renderer 原始 profile SHA-256 为 `8ab3e19243c432741ad8a8f1fe75c7a71db52352221dca1b6d18421fe8192aae`。

Canvas 已有 `CanvasSceneSnapshots` 为同一不可变 Editor publication 保存 scene；导航暂时清除 interaction props 后，原 `prepare` 又重新遍历同一场景。现在 Canvas 向 interaction 提供可选借用 token。token 只捕获原 store、快照 key 和 scope generation，不捕获 scene/entries；读取只查原有 current/displayed 两槽。旧 scene 离开这两槽后 token 立即拒绝，没有新增 history cache、WeakMap、第三个 scene 槽或 dependency-scope 缓存。原 displayed 槽仍持有的不可变 scene 可以继续被其原身份借用。

借用要求 document、nodes、pages、fonts、page、session 和当前 picking geometryEpoch 全部匹配。owner/session/page/readiness 任一变化都会替换 scope token，ABA 后旧借用也不能恢复；字体环境切换或恢复由原有 opaque geometryEpoch 拒绝。未 ready、未提供 token、旧 token 或资源不符时，保持原 `scene(document,pageId)` 回退。这个契约只用于 Canvas 已发布的不可变 Editor 文档；它不保证任意 mutable draft 的嵌套原地修改可检测，也没有给通用 `geometry.scene` 增加缓存。

`gpuInteraction` 的无条件 useMemo 移到已有 currentScene 之后，并由当前 scene/Editor/session/page/readiness 驱动借用 token。Canvas 在最终 JSX 之前没有组件级提前返回，变量也只在最终 JSX 使用；所有 hook 仍无条件按固定顺序执行。React 放弃一次 render 或 memo 时，最多重新发放 token/回退计算，不能借到错误快照。

仍逐次计算 `buildInteractionDependencyScope`。它的 fixed backdrop 两像素外扩依赖 zoom/DPR，低倍率/glass 分支也依赖质量策略，不能只按文档缓存整份 scope。GPU capture、采样、预算、代次取消、onReady/control、真实呈现 ACK 及 retained interaction 的 painter-certificate 安全排除均未改动。

两个 focused suite **74/74 通过**（5.53 s，其中新增 4 项）。覆盖 200 次借用无额外 scene/index 构建、current/displayed 逐出、编辑/撤销/重做、owner/session/page/readiness ABA、nodes/pages/fonts 替换、真实字体 geometryEpoch 变化、0.25/1/32 倍与 DPR 1/2 的反复导航恢复及 fresh scope 对照、无 token 的 mutable 输入和旧 token 回退。首轮默认 Python 缺少固定版本 fontTools，72 项通过、原有及新增字体测试两项前置失败；使用已有 Node 24.12.0/fontTools 4.61.1 环境重跑全两套通过，没有跳过断言或安装替代字体。`git diff --check` 通过；父任务将对合并状态再次 typecheck。

这四个生产文件及两个测试文件在上述 focused 结果后冻结，SHA-256：

| 文件（frontend/design-client/src/ 下） | SHA-256 |
| --- | --- |
| `canvas-scene-snapshots.ts` | `5185eedaaf08977d39f48cf29a3e20159cf06accb28ef5ef52de7b58f794e9a9` |
| `Canvas.tsx` | `2b84deca545e9e4c9c4e06a6d746072b653273ada84e123d00a0cb70ff4bcd8c` |
| `kernel/interaction-layers.ts` | `aa84442d01f16bd29415f0376cf6b48c7d5b56bfaea4e0aad64826a80d2ce0fe` |
| `kernel/interaction-renderer.ts` | `fb9d38a3e1be6e68d49c29ead301f655216b5daf5c880addb5445a1d2cba3843` |
| `canvas-scene-snapshots.test.ts` | `084f88c5e87600a476f27b141e0616d86dd2715652a3b45c427471c51aa1ffc7` |
| `kernel/interaction-renderer.test.ts` | `d0b4d5c060614a2b048bcca5ea645f8b44c2a8c16d3f253e8976b2d853d07ecd` |

本轮只验证主线程重复准备的控制流与一致性；还没有匹配新构建的实际 CPU 加速、GPU 等待、无模糊/无白块或输入延迟结论。精确导出与 authored/edit/undo 路径没有接入此 token。
