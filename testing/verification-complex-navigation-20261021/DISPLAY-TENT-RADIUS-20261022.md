# 显示档半径候选（默认关闭）

这是一项明确的显示近似，不是精确路径中的等价变换。它同时要求 `VITE_DESIGN_DISPLAY_TENT_RADIUS=1` 和 `VITE_DESIGN_EXACT_CLAMP_PREFIX=1`。Worker 只接受可信 desktop SDR 显示意图，并覆盖调用者字段；Renderer 再拒绝 readback、非 present、HDR、software、非 WebGPU、displayMath，以及 displayFilters/material-source 实验策略混用。

仅已知普通 blur/backdrop 的轴可以选择最近 f32 半径，当前源码范围为 1..2048；最大半径变化不超过 0.000122071 个设备像素，并强制 `ceil(selected) <= ceil(original)`。原生文档、矩阵、依赖 bounds、四相采样和实际捕获相位不变。rational kernel、certified kernel、uniform 和 filter contract 使用同一个 selected 值。Glass、gradient、shadow、byte 与未知 caller 不启用此变换。

Frame/group/prefix/filter、Worker namespace/admission 与静态 backdrop 的缓存身份包含此显示策略。精确导出/readback 的 scene 会撤回该标记；`displayTentRadiusPasses/Pixels` 只在实际成功编码了不同半径后累计，不能用 eligible 节点数量代替执行见证。

117 原始背景半径的包为 149-bit denominator，不能进现有前缀管线；最近 f32 半径的包为 62 bits。独立显示候选保留原帐篷滤波算法，改变了其半径精度，不能声称原始 f32 分量逐位相等。

## 首版 512..2048 的实际区域 A/B

相同冻结源码、WASM、117 文档、字体、请求及 256 MiB 预算，两个路径都实际 GPU 呈现 ImageBitmap 后捕获 RGBA8：

| 单次冷诊断，含准备与呈现捕获 | 原精确半径 | 显示半径候选 |
| --- | ---: | ---: |
| 总耗时 | 2636.1 ms | 1742.2 ms |
| CPU 队列完成等待累计 | 1536.5 ms | 737.7 ms |
| finish 阶段 | 1006.5 ms | 205.3 ms |
| 实际改变的轴请求 | 0 | 22 |
| prefix accepted lines | 14712 | 19972 |

4096 像素、16384 个呈现字节零差异，输出 SHA-256 同为 `9a24cab1ac7ac90de6fc0c46b6740dac81b2fdf80965c2844cce6f947b777550`。这是一个区域的一次顺序 A/B，不能据此宣称一般速度提升、GPU 独占时间、整机低延迟或所有画面均一致。

随后扩大到 4 个真实 128×128 区域，显式使用 1 GiB 诊断预算，两路径同一检查源码/WASM/文档/字体/请求。每个区域实际执行了候选；共 262144 个呈现字节全部零差异。画质阈值事先固定为最大 1/255，未在观察结果后放宽。该预算只支持诊断参考，不代表产品内存门通过。匿名数值与身份见 [摘要](display-tent-radius-summary.json)。真实内容锚点整机测试仍在进行。

## 未覆盖的路径

Retained nested interaction 的大半径 fallback 仍调用原 whole-filter，保留其 512 guard。仅透传显示意图不会使这条旧路获得 2048 的支持；本候选没有扩大该 guard，也不能称嵌套拖动已经修好。编辑、撤销及原精确导出仍需匹配最终构建的完整联动验收。

## 连续缩放低半径：后续 CPU 候选，尚未执行 GPU 门

首版门通过后，显示候选下限由 512 收至 **1**，上限仍为 2048，最大 f32 舍入误差与 native integer halo 不增长的约束相同。连续缩放时正常背景的较低 binary64 半径也可能生成超过 prefix 支持宽度的有理包；仅优化最后的高 zoom 不覆盖这些请求。

`blurBackdropRegion` 在原早退分支和常量展开时，只为普通 normal/non-gradient 背景显式传递显示 eligibility。原 whole-filter `blur` 新参数默认 false，未知 caller、shadow/alpha-only、glass、gradient 和未授权路径均不选择显示半径。**原未舍入半径 >512 的 hard guard 仍先执行**；即使 `512+2^-43` 可舍入为 f32 的 512，也仍拒绝，不能借此支持更大 nested whole-filter。原 native/authored radius、依赖 bounds 和导出精度均未修改。

两轴 rational packet、certified packet、uniform 与 GPU filter contract 全部使用同一个 selected radius。改变轴计数在各次实际成功编码后增加；第二轴抛错时只记第一轴，不将节点 eligible 记作成功。displayFilters/material-source 实验策略整体不取得该近似权限。

使用当前 phase4 portable WASM 直接构造低 zoom 的 `18.39398384094238×2`：原 binary64 半径的 denominator 实测 **154 bits，prefix unsupported**；f32 选值的包通过同一个 prefix 准入。高 zoom 既有样本仍为 149→62 bits。第一次新增断言误按 149 bits 预计低 zoom，实测失败后改为 154；没有改 WASM 或 kernel 来满足预期。

本轮 focused 为 **45 项 display-radius +6 项 backdrop =51 项通过**，覆盖低半径 RN/tie、ceil 边界、真实 WASM 包、原 >512 guard、普通/非 normal/gradient/glass/unknown fallback、alpha-only 与实验策略拒绝、常量展开及成功轴计数。首次 typecheck 指出新 mock 把类型为 `true` 的 `uniformColor` 写成数组；改为 `true` 后 typecheck 通过，并仅重跑该一项通过（另外 44 项 skipped，不重复累加）。这是 CPU/WASM 与 mock encode 范围，不是新 1..512 实际 GPU 画质或延迟验收；前述首版实际 GPU 数值保留其原来源与范围。

此扩展冻结的 renderer SHA-256 为 `c7a8b779b0546938a9f17bdef5cffc0a72f61bb1cff82c4d11f0124104d9696e`，helper 为 `b2dede4cc896c0d8627005e0ce2aa171f7977408c8e841b1d5bfb3b6c35a2ec6`，测试为 `6a0d79ac935880ef457baad4119f7f70233c5de6d842baea5ceeb2cf458aced9`。候选继续默认关闭；新低半径的实际 matched GPU/整机门须另行记录。

## 后续实际 GPU 与独立大半径候选

1..2048 显示半径后来在同源码/文档/字体/请求的三个真实 117 区域完成实际 GPU 呈现对照，物理 zoom 2、8、16，共 **49152 字节零差异**；参考分别含 4002、4096、4096 个非白像素，三个候选均实际编码了改变半径的轴。使用显式 1024 MiB 诊断预算，不能冒充产品自动预算或整机连续缩放验收。原顺序冷总耗时为 1138.1/404.1/917.2 ms，候选为 1194.2/334.3/544.5 ms；不是重复统计或普遍加速结论。

另一项独立算子仅接普通 SDR/normal/non-gradient 背景的大半径显示 fallback。原 `blur` 的 >512 guard 保留；新算子只在 **原始半径 >512 且 <=2048**、真实 RGBA32F 私有捕获和完整索引计划成立时执行。输入借用不消费，输出仅占一张完整 H；横向分行，纵向先保存完整高度的列再滤波并写回该列，原始 capture 原点、范围与边界 clamp 语义不变。私有目标证书绑定 epoch/resource/shape/rect/axis/radius/clamp 并单次消费；取消或编码中途失败直接上抛，不能在部分编码后退回旧路。

四个实际 GPU 算子用例覆盖小数原点、透明/夹边、64 像素接缝和 2048 半径，与同一选值的独立 whole driver H/V prefix 对照，**170032 个原始 f32 分量零差异**。这不是原 scalar shader 或原始半径全图等价证明。

此前物理 zoom 32 会触发旧 512 guard 的 117 请求，新算子已实际命中一次并完成；但总耗时 **5685.6 ms**、finish 4541.8 ms、峰值约 1007 MiB，仍远未达到低延迟，不能称问题修好。原参考拒绝该请求，没有可冒用的旧全图真值。该轮 prefix counter 33908 行接受、0 行拒绝，等待集中在结尾完成，不是逐分带 fence；仍需定位全图/四相工作和产品预算压力。该请求不是实际按住鼠标的 nested interaction，后者须独立实机验收。所有身份与匿名数值保留在 [摘要](display-tent-radius-summary.json)。
