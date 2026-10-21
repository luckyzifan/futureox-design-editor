# 顺序四样本显示候选 — 2026-10-21

**截至 v5，连续缩放清晰度验收仍失败。** v1 的整视口请求没有完成一帧；v5 已有完整产出，但默认预算和 4 GiB 预算都存在旧像素放大。不能把更多完整帧或 GPU 数值对照通过当成运动清晰度验收。最新预算对照见下文。

## 候选范围与保留边界

候选保留四个原始相关采样相位、绘制顺序和每层隔离/透明度，将视口分条带，逐样本绘制，再按原 `meanFourRN` 的“各乘 0.25、从左到右 RN 相加”顺序累计。条带完成后使用 GPU 区域复制写入驻留整帧。颜色临时表面可以限于 ROI；原始路径程序、矩阵和路径矩形不改动。实际分配继续受 renderer 的统一工作预算限制，纯计划的保守内存估算不是实际显存测量。

v1 的一般路径只接纳普通混色的纯色填充，无描边、遮罩、裁剪、pass-through 或效果；v5 增加了经过独立源证明的普通图像路径。缺失节点仅在明确的可信内核编译包选项下作为原有裁剪哨兵处理，显式损坏条目、循环和重复入边仍拒绝。一个单图单 blur 叶可以由调用方另外提供真实上传/范围及完整 halo 证明；**source-material 属于屏幕近似算法，不是精确滤镜缓存**，它未被以下 v1 纯色逐位证据覆盖。

这些候选继续严格默认关闭：`VITE_DESIGN_SEQUENTIAL_DISPLAY`、`VITE_DESIGN_SHARP_ZOOM`、`VITE_DESIGN_DISPLAY_MATERIAL_SOURCE`。原有 `VITE_DESIGN_DYNAMIC_UNIFORMS`、`VITE_DESIGN_KERNEL_CACHE` 也保持默认关闭。此次没有借失败的候选改变默认验收状态。

## v1 实际 GPU 数值对照

[GPU 结果](gpu-v1/results.json) 状态为 `passed`，设备为 Apple Metal-3，WASM SHA-256 为 `9cddc0c6b91a48474037a4f64f6ac844f8bbea696596a241b3d31b49cf9678c5`。

| 项目 | 结果 |
| --- | --- |
| 总用例 | 12：6 个实际顺序路径、6 个拒绝后恢复原路径 |
| 对比分量 | 4,908,840 个原始 RGBA32F 分量 |
| 原始 f32 字差异 / 非有限结果 | 0 / 0 |
| 实际顺序帧计数 | 6 |
| 测试专用目标回读 | 39,935,552 字节 |

输入由真实 WASM 编译，覆盖小数相机、缩放、负全局 ROI、跨三个条带、组透明度、重叠、多填充、孔洞、翻转、椭圆/圆角和合法 authored signed/HDR 极值及次正规数。6 个拒绝用例是裁剪、描边、渐变、前景 blur、背景 blur 和 multiply；要求先拒绝，再在同一个 renderer 上成功恢复原四平面路径，并与独立基线逐位一致。

参考与候选使用两个独立的生产 renderer，均以 `render(readback=false, present=true)` 请求执行。测试只在原 `driver.finish` 前观察实际目标并回读 raw f32，再正常呈现；额外回读属于证明工具，会增加同步，**不能用来推导产品回读次数、延迟或帧率**。源码、WASM 和输入哈希记录在运行目录的 `inputs-before.json` / `inputs-after.json`；不是 CPU mock 或改写着色器的结果。

复现入口（从 `frontend/design-client` 执行，输出必须是新的空目录）：

```sh
VITE_DESIGN_SEQUENTIAL_DISPLAY=1 DESIGN_TEST_OUTPUT=/absolute/new-directory \
  bun scripts/check-sequential-display.ts
```

加 `--prepare-only` 仅执行真实 WASM 编译、准入和证据准备，不启动 GPU。

## v1 真实 Electron 连续缩放

[117 结果](electron-v1-fresh-117/results.json) 状态为 `failed`。独立测试进程从新会话执行真实 Control-wheel，100% → 700% → 3200% → 100%，阶段间不等待静止；未打开 CPU profiler。源文件 SHA-256 为 `d494693eadf269e7fa29e4cc56e893f5890c02f4d96f4561065c851818a85d70`。

运动阶段主线程日志发出 70 个整视口请求，对应 worker 终态是 **56 个取消、14 个 unsupported、0 个完成结果**。这只统计三个 wheel 阶段内的请求，排除设置/导入阶段的其他失败；worker 与 main 对同一次错误的转发不重复计数。

| 观察 | v1 结果 |
| --- | --- |
| 呈现提交 ACK | 212，其中运动阶段 192、静止恢复阶段 20 |
| 每次 ACK 质量测量 | 212 |
| 最低清晰覆盖率 | 0 |
| 最大旧像素放大 | 32 倍 |
| 输入 → 提交 ACK p95 | 26.800 ms |
| 相机请求 → 提交 ACK p95 | 7.800 ms |
| 文档快照 / 源文件保留 | 均通过 |

提交 ACK 是呈现命令的确认，不是 GPU 完成或像素到屏时间。即使输入 ACK 较快，32 倍旧像素放大仍明确未达到“不模糊”要求。没有用 rAF、软件提交率或屏幕标称 120 Hz 声称实际 FPS。运行结束的 GPU 内存探针因缺少 execution policy 被拒绝，因此本次没有有效的末态 GPU 内存报告。

静态检查保存的原生 capture 包显示：100% 视口有 5 个可见效果节点，包括背景 blur 与阴影，超出当前候选范围；3200% 包只有 9 个实际节点、一个图像 blur，纯计划准入与首条带完整覆盖检查均可通过。旧日志的统一 unsupported 编号尚不足以确定连续缩放中每次具体拒绝门，不能把它们全部归因于 GPU 执行。现加入有界数值诊断，待下一轮记录补充具体原因。

## 数值诊断和后续验收

诊断仅在候选启用且 GPU diagnostics 开启时记录，每 renderer 最多 64 条 `skip / mode=48`；不记录图片 URI、节点名称或像素内容：

| reasonCode | 含义 |
| --- | --- |
| 601 / 602 | driver 能力缺失 / 纯计划拒绝（`count` 是效果候选数量） |
| 603 | material 启动策略拒绝，`state` 是策略缺口位集 |
| 604 / 605 / 606 | 完整采样覆盖 / source-plan / 源坐标边界拒绝 |
| 607 / 608 / 609 | material 预算 / 缺采样相位 / material 无结果 |
| 610 | 执行异常，`state=1` 为可恢复预算类，`0` 为其他 |
| 611 / 612 / 613 | 缺图像 / 缓存键无效 / blur 返回原图 |

603 的位 0–8 分别是 scene material 位关闭、编译期开关关闭、无范围接口、mips、atlas、display filters、非 WebGPU、HDR、display math。605 的位 0–3 分别表示实际范围存在、opaque alpha、非负 RGB、最大指数在既有安全域内；只用于定位，不能代替私有资源证明。

路由仍明确排除导出、精确 readback、HDR 和非呈现请求；候选不修改文档或编辑历史。v1 的运动检查通过了快照/源文件保留，但**没有执行新一轮完整编辑撤销和 1×/2×/3× 导出验收**，不能拿这次纯色 GPU 对照代替这些门。还需完成 source-material 场景画质、117 实际运动清晰度、最终原档导出与完整编辑/撤销回归，之后才能决定是否启用。

## v5 工作预算实验：auto 与 4 GiB 各两次

Electron 可通过可选环境变量 `CORE_GPU_WORKING_BUDGET_MIB=4096` 请求 renderer 的 4 GiB 工作预算。**默认仍为 auto**，策略字段省略时保留既有自适应规则；这不是启动时预分配 4 GiB，也不是整个应用、显示缓存、WASM 或系统 GPU 内存的统一上限。此选项不放宽纹理尺寸、图片、文档和设备能力等其他准入。

四次实际运行使用相同的 117 源文件、验证脚本和 195 个真实 Control-wheel 输入，顺序为 auto → 4 GiB → 4 GiB repeat → auto repeat。每次都是独立新会话，100% → 700% → 3200% → 100%，阶段间不等待静止，未启用 CPU profiler。末态实际策略分别报告 `268435456` 和 `4294967296` 字节，确认预算选项确实生效；四次文档快照与源文件保留均通过。

| 运行 | 匹配的运动期整视口成功 / 拒绝 | 最大旧像素放大 | 输入→ACK p95 | 实际输入间隔 p95 | 首末输入时长 |
| --- | --- | --- | --- | --- | --- |
| [auto 1](electron-v5-auto-117/results.json) | 21 / 31 | 17.989× | 95.900 ms | 93.200 ms | 4805.700 ms |
| [4 GiB 1](electron-v5-4g-117/results.json) | 36 / 30 | 22.326× | 126.100 ms | 122.500 ms | 6732.000 ms |
| [4 GiB 2](electron-v5-4g-117-repeat/results.json) | 39 / 30 | 22.326× | 128.500 ms | 126.300 ms | 6986.200 ms |
| [auto 2](electron-v5-auto-117-repeat/results.json) | 20 / 31 | 16.147× | 92.900 ms | 91.100 ms | 4675.500 ms |

四次最低清晰覆盖率均为 0，严格门全部失败。auto 的两次输入→ACK p95 为 **92.900–95.900 ms**，4 GiB 为 **126.100–128.500 ms**。4 GiB 完成更多整视口，但实际输入间隔和整段输入时长也变长，给了渲染更多时间；不能据此说吞吐、拖动体验或清晰速度更好。提交 ACK 仍不是 GPU 完成或像素到屏时间，两次重复不足以建立一般性能结论。

以下只累计四次测量窗口内、能与主线程 `livePreview` 请求匹配的**成功整视口请求**，不混入 setup、unsupported 或最终普通瓦片修复；各档均为两次之和：

| 同口径累计 | auto，两次 | 4 GiB，两次 |
| --- | --- | --- |
| 成功整视口 | 41 | 75 |
| compile | 1035.8 ms | 1951.9 ms |
| graph | 4454.8 ms | 1078.3 ms |
| finish | 773.1 ms | 7241.6 ms |
| CPU 队列完成等待 | 89 次 / 4358.6 ms | 20 次 / 4145.1 ms |
| 其中 admission 等待 | 79 次 / 3796.6 ms | 0 次 / 0 ms |
| material field 构建 / 命中 | 1376 / 0 | 2556 / 0 |
| material field 上传 | 78,962,880 B | 146,635,648 B |

4 GiB 下 admission 等待消失，但等待更多落到 finish / 周期完成边界，不能把 graph 数值下降解释为算术变快。上述阶段时间与队列等待可能重叠，不得相加成总耗时；队列完成等待也不是独占 shader 耗时。当前整视口日志没有字段构建耗时或 `imageAxisFields` 计数，[数值摘要](motion-summary.json) 将缺失计量保留为 null，不能据上传量推定 CPU 二维坐标场是热点，也没有这一轮火焰图支持该归因。

[auto GPU 对照](gpu-v5-pins/results.json) 与 [4 GiB GPU 对照](gpu-v5-pins-4g/results.json) 各通过 **15 个用例、7,216,716 个原始 RGBA32F 分量、0 字差异、0 非有限结果**。每档实际执行 8 个顺序帧；各自额外的 2 个真实 PNG 取消用例在首次 band copy 后取消，均没有完成或发布新帧，image pins 归零，并在同一 renderer 上恢复原路径逐位一致。证明工具的额外回读不用于产品延迟或 FPS 声明；这些用例也不证明 source-material 近似或整份 117 的连续运动已达标。

复核已有记录可运行 [summarize-motion.py](summarize-motion.py)，它只读取现有 JSON / 日志，递归展开 batch，并按 session/source/seq 去重，不启动应用。`motion-summary.json` 的 index 0–3 为 v1–v4，index 4–7 依次为本节四次运行。整视口成功计数与末态 driver-lifetime 顺序帧计数分别核对，四次窗口外成功整视口均为 0；普通 `previewTiles=1` 不作为顺序帧证明。

## 后续实际运动、原图捕获与资源生命周期证明

[motion-final-summary.json](motion-final-summary.json) 汇总十一条整机运行记录（其中一条因构建重叠排除）、一次原renderer整视口可行性与一次实际GPU生命周期证明；[只读汇总器](summarize-motion-final.mjs) 从已有JSON重建，保留输入SHA和缺失值，不运行应用或测试。原始profile、设计文档、相机坐标、截图和带相机JSON的原始错误仍被忽略；摘要只保留错误分类与其原始内容SHA。**有效整机运行均未通过清晰度门，当前不能宣称缩放不模糊或低延迟验收完成。**

| 实际整机运行 | harness / 清晰门 | 最大旧像素放大 | 输入→提交ACK p95 | 白块/透明缺失抽样边界 |
| --- | --- | ---: | ---: | --- |
| final-visual-117 | failed / failed | 原记录null，未获有效值 | 746.300ms | 仅3份有参考样本零异常；缺up-near-3200绑定capture，完整抽样门失败 |
| final-visual-fig | failed / 未完成 | 未测 | 未测 | 导入定位失败，0份样本；不能声称无白块 |
| candidate-motion-117 | completed / failed | 19.3315× | 110.200ms | 4份绑定样本有参考，零定义内异常；未检查所有中间帧 |
| candidate-motion-fig | completed / failed | 32× | 23.300ms | 同上4份抽样；相机ACK快不代表新清晰像素及时到达 |
| original-world-motion-117 | failed / failed | 43.0342× | 312.700ms | settling出现“显示瓦片缓存预算超限”，0份视觉样本，不能声称无白块 |
| original-world-motion-fig | failed / failed | 368.1465× | 382.000ms | 同样缓存预算失败，0份视觉样本，不能声称无白块 |
| original-world-fixed-117 | failed / failed | 38.6287× | 303.200ms | fairness/protected-key修正后仍settling缓存预算失败，0份视觉样本 |
| original-world-fixed-fig | 排除：构建重叠 | 不用于对照 | 不用于对照 | 运行未结束时启动了最终default构建；即使raw状态通过也不能作验收 |
| final-default-motion-117（历史scratch候选） | completed / failed | 原记录null | 404.700ms | 4份绑定样本有参考，零定义内异常；仅22/180次ACK有有效质量测量 |
| final-safe-motion-117（scratch关闭） | completed / failed | 原记录null | 196.400ms | 4份绑定样本有参考，零定义内异常；仅27/209次ACK有有效质量测量 |
| final-safe-motion-fig（scratch关闭） | completed / failed | 原记录null | 21.100ms | 4份绑定样本有参考，零定义内异常；仅16/487次ACK有有效质量测量 |

所有已测清晰覆盖率最小值均为0。final-visual-117有162次ACK，但只有19次有效质量测量，最高确认相机缩放约17.217而请求到32；缺失质量值不按通过处理。candidate-motion两份harness无错误、文档与源文件保留通过，但它们启用了CPU profiler和visual-audit；其它列出的整机运行也为visual-audit。因此表中ACK数值只是各自记录的提交确认观测，不能作干净生产延迟的A/B比较，也不是GPU完成、实际FPS或像素到屏时间。original-world两次在完整保留校验前失败，相关字段为null，不能补称编辑/撤销或源文件回归已经完成。

后续fairness/protection相关135项CPU检查及27项policy检查通过，并未使原图捕获的整机缓存预算问题解决：独立完成的fixed117仍出现相同缓存错误。fixedFIG在owned运行仍待结束时误与最终default构建重叠，资产/参考图身份及CPU/GPU负载不再受控；汇总器明确标为 `invalid-interrupted-runtimebuild-overlap`，保留raw结果SHA与状态，但有意不输出其ACK/清晰度对照指标。该次raw最终也记录了缓存错误与0份视觉样本，但不能把它算成有效候选复测。之前独立运行的original-world-motion-fig仍是有效的缓存失败记录。

[candidate-motion真实CPU火焰图](../verification-cpu-flames-20261021/candidate-motion/README.md) 将Worker计算和idle分开，并独立关联重复unsupported与原生瓦片回退。117全部27条skip602属于materialCount；FIG记录到62条scenePolicy，不能猜未记录的子条件。cancel清理fence不等于真正的PREVIEW_CANCELLED结果，不能用它夸大输入取消次数。

`original-viewport-100-4g` 的状态为passed，表示**固定实际117场景的原四平面渲染可行性**：4GiB admission下，1710×1776输出、1858×1924效果依赖范围、260个编译节点（2背景blur、2blur、1shadow）。候选sequential/material/image/filter/display-math标志全关。warm帧render wall1606.400ms，独立post-render completion probe676.400ms；随后唯一observation帧render wall99.600ms，独立完成probe369ms，工作峰值1,014,469,560字节。没有raw像素oracle或视觉/手势检查，不能把99.600ms当成GPU已完成或认为提高预算已解决流畅度。

`gpu-resident-filter-v4` 实际Metal-3证明通过：3类真实WASM/PNG合成场景、每组连续3/4/8帧，16份control/candidate原始目标比较，共152,576个RGBA32F分量，**0字差异、0非有限值**。额外proof readback为1,220,608字节；每帧正常产品路径的rasterReadbackBytes为0。candidate的prefix counter采样/延后帧数分别为0/3、1/3、2/6，验证既有第四帧周期边界；真实allocation pressure完成admission并收集3份退休table；两个对照组的取消都在真正prefix编码后发生，没有完成取消帧，scratch归零，再恢复1帧。记录中的实际纹理/scratch与renderer账本逐帧相等。

该GPU证明使用独立device及未改变的原始target COPY_SRC留证，直到组结束才统一排队回读；它是小型合成场景的像素及资源生命周期证明，含117式小数半径/3200%缩放，**不是完整117文档或整机画面/延迟验收**。证明工具的额外复制、最终读取、压力请求及取消会改变同步和内存行为；不从该记录声称产品帧率或耗时改善。`VITE_DESIGN_ORIGINAL_VIEWPORT_CAPTURE` 与上述顺序/清晰缩放候选一样仍严格默认关闭。

## 最终默认策略决定：scratch驻留未获默认验收

最后一次scratch候选warm检查中，117首次3200%清晰为1993.338ms；CPU队列完成等待为1389.6ms、10次fence（5次admission合计1111.2ms，5次periodic合计278.4ms），高于此前对照的878.9ms等待。减少fence次数没有证明延迟改善。因此 `VITE_DESIGN_RESIDENT_FILTER_SCRATCH` 已改为**仅严格字符串`1`启用、默认关闭**；逻辑table退休与预算内保留pool的改动仍在普通路径。没有把资源生命周期正确等同为整机性能通过。

`resident-filter-v1-*`、`resident-filter-v2-*` 和历史命名的 `final-default-*` 原始运行都属于scratch候选检查点，不能引用为当前已验收默认策略。随后真正关闭scratch的default构建/GUI应另存为独立检查点，不与这些候选混淆。[最新汇总](motion-final-summary.json)已优先绑定 `gpu-resident-filter-v5`：显式env=1、当前源码/WASM输入1118项前后SHA相同，仍为152,576原始分量零差异、零非有限结果、16份帧比较通过；这是最新源码的**opt-in**像素/资源证明，未授权默认开启或低延迟验收。若后续最新proof失败，汇总器也不会回退引用旧v4通过来掩盖失败。

关闭scratch的两份`final-safe-motion`运行已完整结束、harness无错误，文档及源文件保留检查通过；但严格sharp gate仍失败，最小清晰覆盖均为0，`maximumUpscale`原始JSON均为null。不能把null当成有限放大或把缺失质量测量补成通过。每份四个取样画面未发现定义内的大块白/透明缺失，报告均明确`allIntermediateFramesVerified=false`；这不等于运动模糊已消除或所有中间帧已检查。三份新运动报告均没有CPU profiler，但包含visual-audit额外capture，`latencyTimingComparable=false`，ACK数字仍不作干净生产A/B比较。

安全默认完整GUI的[真实CPU火焰图](../verification-cpu-flames-20261021/final-safe/README.md)另行保留匹配资产和SHA。FIG属性采样中`kernelLayout` inclusive17.519ms，未观察到旧`resolve_components`热点；这不替代真实调用计数的CPU/WASM测试，也不是把采样耗时当无profiler交互基准。
