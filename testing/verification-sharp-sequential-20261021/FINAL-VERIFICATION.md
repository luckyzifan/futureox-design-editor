# 2026-10-21 源码交付与渲染验收

**连续快速缩放仍未达到全程清晰、低延迟要求。** 当前源码的完整 CPU 回归已严格通过；117/FIG 六轮混合操作均无记录到的应用错误，但每文件两份精细参考被原生面积门拒绝，清晰度与完整视觉门仍为 false。下述旧 24 张静态 PNG 继续只属于历史旧导入器检查点，不能把 CPU 通过或旧画面一致当成当前全程无模糊验收。

## 默认保留的改动

- 图像表结束使用时逻辑退休，继续保留源图归属并计入工作账本；实际队列完成覆盖该退休快照后才销毁。普通预算内的可复用池不再仅为清空空闲对象而发起维护等待，真实压力、取消、设备丢失与回读边界仍保留。
- 导航预览按文档、修订、页面、会话、精度、相机、尺寸、DPR、客户端和实际 GPU 设备归属复用。缓存只使用真实呈现 ACK 确认的有效句柄；旧内容不能证明当前精度或采样相位已完成。
- Inspector 和属性面板复用已发布文档的拓扑；无实际修改的组件清理保持对象身份。平移快路保留布局、约束及引用检查，完整实际 FIG 与强制 WASM 全量求解的编辑、撤销、重做对照见 [CPU 记录](../verification-cpu-flames-20261021/README.md)。
- 累计功能 ZIP 的共享编辑操作、导入副本、MCP 及测试已合并，保留更新的渲染文件，见 [整合记录](../verification-functional-merge-20261021/README.md)。

## 新增修复的验证边界

重新导入原始 117 后，全部 575 条 shapePath 与原始 Sketch 对照，锚点、有效控制柄、拓扑错误均为 0；修复前保存快照有 170 个有效控制柄丢失，涉及 134 条路径。114 条圆形/圆弧子集的几何和 world affine 对照也通过。另以一条原始小圆执行真实 WebGPU 圆度检查，720 个方向的最大径向误差为 **0.875 物理像素**，低于固定 1.75 px 门限；旧缺柄 network 的真实 GPU 负对照误差为 **68.875 px**，被门限拒绝。该像素证明绑定新 WASM `d2a6069e…`，不代表全部 575 条路径都做过 GPU 像素对照。详见[控制柄证据](../verification-complex-navigation-20261021/README.md)及 [curves-summary.json](../verification-complex-navigation-20261021/curves-summary.json)。旧 FD/SQLite 中已经丢失的几何不会自动恢复，需要重新导入原始文件。

新增 composite 缓存保护仅触碰当前实际合成计划中可见、已就绪且归属一致的贡献瓦片，并更新其 LRU 使用顺序；被遮挡的历史瓦片仍可回收，预算没有扩大。受控的多密度、部分平移及缓存压力回归 **142/142 通过**，类型检查通过，见 [cache-visible-use-summary.json](../verification-functional-merge-20261021/cache-visible-use-summary.json)。这证明受控缓存行为，没有证明真实白块根因，也不能代替复杂连续缩放、平移及当前源码的完整回归。

后续又补上交付事务、实际移动后来源的 owner witness，以及前景替换的有界暂存：常规缓存仍为 128 MiB，当前视口最多临借 26,419,600 bytes，且仍受原 224 MiB 总驻留额度约束；真实 ACK 后回稳态。旧相机和预取不能借用，也不能因拒收取消新前景。最新定向 **171 项**、数字诊断 **23 项**及类型检查通过，见 [replacement-staging-summary.json](../verification-complex-navigation-20261021/replacement-staging-summary.json) 和 [CACHE-REVIEW.md](../verification-complex-navigation-20261021/CACHE-REVIEW.md)。这些修复已进入下述六轮实机与当前完整回归，但不使两份不可用精细参考或清晰度门通过。

包含新导入器与缓存改动的 `final2` 默认 release 已完成两文件真实 UI 编辑、完整文档撤销、1×/2×/3× 选区 PNG 导出及各四次含五秒空闲的 100%/3200% 重访，八次重访均同相机、零新渲染、零缺失纹理。117 三档导出与新正确导入器控制组哈希一致；FIG 没有拿旧导入器画布作零差异证明，见[最新实机回归](../verification-complex-navigation-20261021/REGRESSION-RESULTS.md)。六轮压力每文件实际执行 366 次 wheel、60 次拖动手势和 960 次指针移动，16 份绑定捕获中 14 份精细参考可用且无既定阈值异常遗漏，另两份原生 halo 面积失败保留；不能称全程无白块，见[复杂操作结果](../verification-complex-navigation-20261021/COMPLEX-RESULTS.md)。

## 历史旧导入器默认配置的实际 Electron 检查

使用 release Electron 44.7.0、实际 Metal 后端（报告 `metal-3`）、1440×960 窗口、855×888 CSS 画布、DPR 2、独立本地会话和真实键鼠输入。工作预算为 `auto`，跨帧 prefix scratch、顺序/原图整视口及清晰缩放候选关闭。所有重型构建、GPU 和最终回归顺序执行；已知的一次实验构建重叠单独排除，见 [失败记录](README.md)。

| 检查 | 117 | FIG |
| --- | --- | --- |
| 运行 | `final-safe-default-117` | `final-safe-default-fig` |
| 编辑 / 完整文档撤销 | 通过 | 通过 |
| 与原默认基线相同相机/DPR/视口的画布 | 12 张 PNG 字节一致 | 12 张 PNG 字节一致 |
| 实际 UI 选区 PNG 导出 1×/2×/3× | 三份均与基线字节一致 | 三份均与基线字节一致 |
| 两轮含五秒空闲的 100%/3200% 返回 | 四次均零新增瓦片 | 四次均零新增瓦片 |
| 返回时缺失纹理 | 四次均为 0 | 四次均为 0 |
| 首次 3200% 阶段完整就绪 | 1210.201 ms | 424.217 ms |
| 同阶段 CPU 端队列完成等待 | 26 次 / 761.9 ms | 6 次 / 22.2 ms |

这组 `final-safe-default-*` 使用旧 WASM `9cddc0c6…`，早于上述控制柄与 composite 缓存修复。24 张 PNG 字节一致只说明该旧检查点与其旧基线一致，不能证明圆形导入正确，也不验收当前新导入画面。这些是单次阶段观察，不是延迟分布或一般加速结论。117 同阶段仍有 20 次 prefix 等待，共 614.9 ms；剩余主要是准入等待。3200% 平移阶段总时长包含输入动作，动作返回到完整就绪分别为 15.990 / 14.142 ms，不能把整段约 1.22 / 0.89 秒都当成停手延迟。扩展编辑段开启了 profiler，不能作为无采样延迟基准。选区导出检查不等于每个页面所有效果的全量导出证明。

缓存返回数据见 [final-cache-summary.json](final-cache-summary.json)，对应画布、导出和队列统计见 [resident-filter-summary.json](resident-filter-summary.json)。同相机原生瓦片在旧基线也能命中；这部分不冒充本轮新增收益。缓存有预算和 LRU，不能承诺任意范围永久驻留。

## 运动画质和未通过的候选

`final-safe-motion-117` / `final-safe-motion-fig` 各使用真实连续 Control-wheel，100% → 700% → 3200% → 100%，阶段间不停下等待。两份严格清晰度门槛均失败，最低清晰覆盖率为 0。117 的运动图中文字边缘可见旧栅格放大，同相机独立原生参考图清晰。

每文档四份实际呈现内容均绑定同 Worker 的对应 ACK，再与独立原始渲染参考比较。八份抽样均未检测到达到既定连通区域阈值的异常白块/透明缺口，缺失纹理均为 0；**没有验证所有中间帧**，也没有由此宣称全程无白块。提交 ACK 和 rAF 都不是 GPU 完成或物理 FPS。完整指标和失败项见 [motion-final-summary.json](motion-final-summary.json)。

`VITE_DESIGN_RESIDENT_FILTER_SCRATCH` 现为严格 `1` 才开启。候选曾把 prefix 统计读取推迟到已有完成边界，原始浮点证明通过；但后续完整 117 首次 3200% 为 1993.338 ms，队列等待 1389.6 ms，虽然只有 10 次 fence，等待移至准入，因而没有作为默认发布。顺序整视口、原图整视口、源像素 blur、手势密度超前候选也保持关闭；整视口实验仍有显示缓存预算失败。

单独 material source cache 的部分实际 117 画面和队列观察有收益，但高频内容真实 GPU 画质对照出现 **51/255** 差异，继续默认关闭，不能由少量画面的较小差异推定泛化通过。原生 halo 门与上游兄弟滤镜依赖也尚未修改，见[只读滤镜审查](../verification-complex-navigation-20261021/FILTER-GAP-REVIEW.md)。

最新 `gpu-resident-filter-v5` 在实际 GPU 比较 16 帧、152,576 个原始 RGBA32F 分量，字差异和非有限结果均为 0，并覆盖压力、取消与恢复。它是小型实际 WASM/PNG 场景的数值和归属证明，不是完整 117/FIG 运动验收。

原有 `VITE_DESIGN_DYNAMIC_UNIFORMS` 和 `VITE_DESIGN_KERNEL_CACHE` 继续默认关闭。可选 `CORE_GPU_WORKING_BUDGET_MIB=4096` 是工作集准入上限，默认仍为 `auto`；它不扩大所有显示缓存，也没有使模糊或低延迟门槛通过。

## 源码回归与复现状态

最新 `final-cpu-final-complex-v2` 已完成串行全量 CPU 检查，见 [CPU 汇总](../verification-functional-merge-20261021/final-cpu-summary.json)：

| 门 | 实际结果 |
| --- | --- |
| 完整客户端 Vitest | 4,776/4,776，623 suites，0 failed/skip/todo |
| 完整 desktop Node | 319/319，0 failed/skip |
| 真实 native preparation 对照 | 3/3，0 failed/skip |
| frontend Node contracts | 324/324，0 failed/skip |
| MCP syntax | exit 0 |
| MCP unit / clipboard / 真实 socket fixture | 分别 96/96、12/12、5/5，0 failed/skip |

实际 117/FIG fixture、原生二进制、固定 Node 24.12.0 与临时 Python/Pillow/fonttools 环境均被记录；11 个可选 native/corpus 用例在原始 Vitest 结果中逐项为 passed，`CANVAS_REPRO_ADD_PAGE=1` 同时开启，未用 skip 补绿色。1,402 项 client/desktop/MCP 源码输入前后 SHA 均为 `bfbab905166edfa8540efdc1d345129369ccfbd234b9d7c1b9d0d72d3bdb36b4`，`sourceStable`、`runtimeStable`、`selectedDesktopDistStable` 均为 true，`changedSourcePaths=[]`。选定独立 `final2-desktop/dist` release 的 manifest SHA 为 `c9e87921d07fa2ef1c0823b354bb362c30d889d9857dccdeb813c914be7be0cf`，1,856 项构建源均吻合；三项原生程序与实际 release 执行文件、selected/public/generated WASM `d2a6069e…` 均严格匹配。

历史 `final-safe-v1` 的 **4,747/4,749、2 failed** 及其 `sourceStable=true`、`runtimeStable=false` 仍保留，不改写为通过；这是运行时产物漂移，不能写成当时源码也发生了漂移。更早 Rust **1,400 个实际执行通过**同样仍是旧导入器历史检查点。

包含控制柄修复的新 Rust workspace 已执行 `cargo test --workspace --locked --offline`，耗时 **685.776 s**，源码前后身份一致。Cargo 名义结果为 **1,404 passed / 0 failed / 36 ignored**；其中一个私有 FD 字体样例未执行其样例断言，因此实际接受执行通过为 **1,403**，该样例和 ignored 均不计入接受数。源码汇总 SHA 为 `aac5bd825d2de3d04b28e0d9d22e90dbf9a429b2e9ed239ff1f7530a0ac9815f`，见 [Rust 汇总](../verification-functional-merge-20261021/rust-regression-summary.json)；最新 CPU 回归再次复核 923 项 Rust 输入仍与该运行相同。CPU/Rust 通过不使当前连续清晰度、每文件两份不可用精细参考或 material 泛化画质失败变为通过。

`run-final-cpu-regression.py` 本次通过 `FINAL_CPU_DESKTOP_DIST` 绑定独立 release 构建，严格核对 manifest、构建源码、原生程序和 public/generated WASM，并单独记录共享默认 dist 的变化；未设置时保留原身份范围。运行时隔离与真实逐门执行一起满足本次 CPU 验收，不代替 GPU 运动画质验收。

复现实际画布和连续缩放分别使用 [run-electron-display.mjs](../verification-electron-display-tier-20261021/run-electron-display.mjs) 和 [run-sharp-zoom.mjs](../verification-electron-display-tier-20261021/run-sharp-zoom.mjs)。GPU 对照入口为 [check-resident-filter-lifetime.ts](../../frontend/design-client/scripts/check-resident-filter-lifetime.ts)，须显式设置候选为 `1`，结果不能代替默认整机验收。真实设计、原始 CPU profile、SQLite、PNG 和构建资产保留本地，不提交用户设计内容。
