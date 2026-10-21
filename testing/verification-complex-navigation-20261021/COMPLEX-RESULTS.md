# 六轮缩放与平移混合压力：实际结果及未通过项

**应用侧六轮操作完成，但整体验收仍未通过。** `verified-stress-117`、`verified-stress-fig` 的连续清晰度门均为 false；每份 16 次绑定实际 ACK 的画面捕获中，仅 14 份取得精细参考，另两份参考被原生面积门拒绝。因此两份原始结果的 `status` 均为 `failed`，不能将应用未报错改写成全部测试通过。随后完成的完整 CPU 回归已严格通过，独立结果见下，不使画质门自动通过。

| 最新实际工作量与结果，每文件分别计数 | 117 | FIG |
| --- | ---: | ---: |
| 连续轮次 / 滚轮输入 | 6 / 366 | 6 / 366 |
| 实际拖动手势 / 指针移动输入 | 60 / 960 | 60 / 960 |
| 操作阶段 / 阶段间停下等就绪 | 90 / 0 | 90 / 0 |
| 实际 ACK 数 / 其中缺失纹理非零 | 1697 / 0 | 2314 / 0 |
| 记录到的应用错误 / 结束状态 Canvas 错误 | 0 / 0 | 0 / 0 |
| 绑定画面 / 可用精细参考 | 16 / 14 | 16 / 14 |
| 可用样本的异常白块/透明缺口组件 | 0 | 0 |
| 参考失败 / 其中原生 surface 面积拒绝 | 2 / 2 | 2 / 2 |
| 文档与原始文件保留 | 是 | 是 |
| 连续清晰度门 / 抽样视觉完整性门 | false / false | false / false |

每轮保留两份压力捕获名额，共 12 份，再加 4 份边界/结束捕获，合计 16 份，名额均实际取得。两文件不可用的参考均位于第 2、5 轮高倍率平移向外样本。其余 14 份可用参考未检测到达到既定连通区域阈值的异常遗漏，**不等于这两份缺失参考可用，更不等于所有中间帧无白块或无模糊**。质量覆盖仍有 0，不能用相机 ACK 快或纹理缺失计数为 0 证明像素已经清晰。

## 原预算与实际缓存观测

应用没有接受独立参考的预算覆盖；额外 **1 GiB 只给跟踪结束后创建的独立精细参考 Worker**，未改变应用工作预算、分辨率、四相采样、回读精度或像素门限，也没有解除原生 `GPU surface budget exceeded`。117 的原生 halo 拒绝及上游兄弟滤镜依赖见 [FILTER-GAP-REVIEW.md](FILTER-GAP-REVIEW.md)。本轮没有抬高原生面积上限或缩减精度。

两份应用的显示缓存均保持以下同一额度：稳定活动预算 **134,217,728 B（128 MiB）**，有界替换暂存 **26,419,600 B**，活动准入上限 **160,637,328 B**；总显示驻留预算仍为 **234,881,024 B**。暂存允许在既定总额度内完成新旧覆盖替换，不代表全局预算增加，也不是全部应用显存上限。

| 应用缓存属性，来自 `after.tiles` | 117 | FIG |
| --- | ---: | ---: |
| 结束活动驻留字节 | 133,801,040 | 133,267,472 |
| 该实例报告的活动/总 high-water | 144,235,488 | 156,137,248 |
| 稳定活动预算 | 134,217,728 | 134,217,728 |
| 暂存期间活动准入上限 | 160,637,328 | 160,637,328 |
| 总显示驻留预算 | 234,881,024 | 234,881,024 |

两份结束活动值均回到稳定预算内，high-water 均低于有界准入上限。high-water 是该实例的累计计数，FIG 在压力前已达到相同 high-water，不能把它改称仅本段压力产生的峰值。驱动的 texture/display/retiring 账本与这份活动瓦片缓存不是同一口径，具体数值分别保存，没有合并成全应用 VRAM 数字。应用查询的工作预算分别为 268,435,456 / 536,870,912 B，来自默认自动策略的实际 `rendererPolicy`；两者都没有被参考的 1 GiB 覆盖。

内存诊断来自跟踪结束后的实际 Worker 查询与 `before/after` DOM 计数，存在观测时间边界；不是全程驱动分配跟踪。队列计时开关为 false，原始统计中的零毫秒不能解释为没有 GPU 等待，汇总将这类等待时长保留为 null。

## 历史失败保留及身份范围

| 运行记录 | 原始状态 | 记录到的应用错误 | 独立参考错误 |
| --- | --- | ---: | ---: |
| `baseline-stress-117` | failed | 2 | 0 |
| `fixed-stress-117` | completed | 0 | 0 |
| `fixed-stress-fig` | failed | 1（结束就绪时缓存预算拒绝） | 0 |
| `final-stress-117` | failed | 0 | 2 |
| `verified-stress-117` | failed | 0 | 2 |
| `verified-stress-fig` | failed | 0 | 2 |

早期 `fixed-stress-fig` 在 128 MiB 活动额度附近出现缓存预算终止；最新两份六轮记录在原稳定额度和有界暂存下均无记录到的应用预算错误，但这不使未完成的视觉和清晰度门通过。最早 baseline 的输入浮点校验与把透明白色页面误分类的失败仍保留原样；后续分类诊断不回写原始结果。不同源码/输入锚点的历史记录也不能拼成严格延迟 A/B。

最新两份构建源码清单汇总 SHA 均为 `adda46d185551edb752b2ac7085f6adc1a14ae38ee7247bb435fbfecb0dda29f`，已捕获运行资产清单一致，WASM 均为 `d2a6069e5da8abf3c1f7f86bc7bd1cd22de7396527c5f9e877f7138c65f97071`。manifest 和输入记录的 SHA、全部历史行与数值来源由只读 [summarize-complex.mjs](summarize-complex.mjs) 生成 [complex-summary.json](complex-summary.json)。两份 motion 目录没有独立的源码 before/after 全集哈希，故 `inputHashesStable` 保留 null；构建清单一致不冒充该缺失证明。

另行执行的完整 CPU 回归 `final-cpu-final-complex-v2` 已严格通过：client **4,776/4,776、623 suites**，desktop **319**，native preparation **3**，frontend contracts **324**，MCP unit/clipboard/socket 分别 **96/12/5**，syntax exit 0，各执行门均无 failed/skip/todo。实际 117/FIG 与 11 个可选 native/corpus 用例、页面重现场景均真正执行。源码 1,402 项 SHA 为 `bfbab905166edfa8540efdc1d345129369ccfbd234b9d7c1b9d0d72d3bdb36b4`，源码、运行时及选定独立 `final2` release 前后均稳定，改变路径为空；selected manifest SHA 为 `c9e87921d07fa2ef1c0823b354bb362c30d889d9857dccdeb813c914be7be0cf`，原生 release 程序与三处 WASM 严格匹配，见[最终 CPU 汇总](../verification-functional-merge-20261021/final-cpu-summary.json)。[新 Rust workspace](../verification-functional-merge-20261021/rust-regression-summary.json) 为实际接受执行通过 **1,403**、名义 1,404、0 failed、36 ignored、源码稳定；未执行私有 FD 样例不计接受覆盖。

`complex-summary.json` 现以顶层 `fullCpuVerification` 读取上述最终 CPU 汇总，仅保留通过状态、逐门计数、源码/运行时身份检查和摘要 SHA；历史 motion 行及两份原始 GPU `failed` 不重写。历史 4,747/4,749、2 failed 与运行时漂移仍保留。Material source cache 的实际高频 **51/255** 画质失败同样仍在，继续默认关闭；本次 CPU/Rust 通过不覆盖这些未通过的渲染门。

本次属于带实际 renderer/自动附加 Worker CPU profiler、画面回读和内存诊断的 `visual-audit`。没有 native sampler，额外回读串行执行但会干扰节奏；提交 ACK、rAF 和 profiler 区间均不代表硬件 FPS、GPU 完成或输入到光子的延迟。所有原始失败、不可用参考和 null 保留，用户设计、节点身份、相机坐标、原始图片及机器路径不进入公开汇总。
