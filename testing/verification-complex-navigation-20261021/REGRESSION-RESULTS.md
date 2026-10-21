# 最新默认构建的 117 / FIG 实机回归

`final2-regression-117`、`final2-regression-fig` 均在独立 `final2` release 构建完成实际 Electron 检查，主测试错误与各阶段最终错误均为 0。两次构建源码清单及已捕获的 42 项运行资产一致，实际 WASM 均为 `d2a6069e5da8abf3c1f7f86bc7bd1cd22de7396527c5f9e877f7138c65f97071`；源码清单汇总 SHA 为 `adda46d185551edb752b2ac7085f6adc1a14ae38ee7247bb435fbfecb0dda29f`。该版本包含新的控制柄导入器与 composite 缓存保护，material 候选关闭。

本摘要复核了每项已捕获资产的实际哈希，以及独立构建中的三项原生程序与 release 程序、installed/public/generated WASM 的哈希。**原生程序的这项核对发生在摘要生成时，并非运行时捕获的身份记录。** 构建 manifest、捕获资产 manifest、结果及日志 SHA 均保留在 [final-app-summary.json](final-app-summary.json)，不把生成时复核冒充整个运行期间的稳定性证明。源码清单与资产 basename 清单的汇总 SHA 均按键排序、使用紧凑逗号/冒号分隔的 JSON UTF-8 计算。

| 已完成检查 | 117 | FIG |
| --- | ---: | ---: |
| 真实 UI 编辑确实改变文档，节点数不变 | 是 | 是 |
| `extended.edit.undoRestoredCompleteDocument` 及完整文档 SHA 恢复 | 是 | 是 |
| 导航、连续 wheel 与导出保留文档 | 是 | 是 |
| 原始设计文件未被修改 | 是 | 是 |
| 实际 UI 选区 PNG 导出 1× / 2× / 3× | 三份下载完成并核对原始文件哈希 | 三份下载完成并核对原始文件哈希 |
| 每轮五秒空闲后，100% / 3200% 各两轮重访 | 四次均同相机 | 四次均同相机 |
| 四次重访新增渲染瓦片 / 缺失纹理 | 全部 0 / 0 | 全部 0 / 0 |

两份记录的编辑前、编辑后、撤销后、导出前后完整文档 SHA，以及六份实际导出 PNG 的 SHA、字节数和尺寸均在 JSON 中。117 三档导出另与新正确导入器的 `material-control-117` 实际 PNG 文件逐字节哈希核对，**3/3 完全一致**。FIG 没有拿历史旧导入器画布 PNG 作为零差异基准，也没有宣称所有页面或所有效果均完成导出像素对照。

| 单次阶段观察 | 117 | FIG |
| --- | ---: | ---: |
| 首次 3200%：阶段总时长 | 1169.472 ms | 445.181 ms |
| 同阶段：日志 CPU 队列完成等待 / fence 数 | 724.8 ms / 23 | 20.4 ms / 6 |
| 3200% 平移：阶段总时长 | 1067.739 ms | 872.969 ms |
| 平移输入动作本身 | 1049.785 ms | 860.042 ms |
| 平移动作返回后至本次最终就绪 | 17.954 ms | 12.927 ms |

这些是一次运行的阶段观察，**不是改善分布、硬件着色器时间、物理 FPS 或输入到光子的延迟**。平移总时长包含输入动作，不能全部当成停手等待。五秒空闲和最终相机等值来自实际 harness/重访记录；缓存命中存在既定预算与 LRU 边界，不能据此承诺任意区域永久驻留。扩展编辑/连续 wheel 阶段启用了 CPU profiler，其时长不能作为无采样性能基准。

这两份记录验收了所执行的编辑、完整文档撤销、选区导出和精确相机重访，**没有检查全部缩放中间帧**。随后两文件均完成六轮混合压力，应用无记录到的错误，但每文件两份精细参考被原生 halo 面积门拒绝，仅 14/16 可用，连续清晰度与完整视觉门仍为 false，见 [COMPLEX-RESULTS.md](COMPLEX-RESULTS.md)。Material 候选已有高频 **51/255** 画质失败，继续默认关闭。

最新完整 CPU 回归 `final-cpu-final-complex-v2` 已严格通过：client **4,776/4,776、623 suites**，desktop **319**，native preparation **3**，frontend contracts **324**，MCP unit/clipboard/socket 分别 **96/12/5**，syntax exit 0，各执行门均无 failed/skip/todo。实际 117/FIG、11 个可选 native/corpus 用例及页面重现场景均已真正执行。源码 1,402 项前后 SHA 为 `bfbab905166edfa8540efdc1d345129369ccfbd234b9d7c1b9d0d72d3bdb36b4`；`sourceStable`、`runtimeStable`、`selectedDesktopDistStable` 均为 true，改变路径为空，严格绑定本页相同的独立 `final2` release 与 WASM，见[最终 CPU 汇总](../verification-functional-merge-20261021/final-cpu-summary.json)。[新 Rust workspace](../verification-functional-merge-20261021/rust-regression-summary.json) 的实际执行通过为 **1,403**，名义 1,404、0 failed、36 ignored，源码稳定；一个未执行私有 FD 样例不计接受覆盖。

本页 `final-app-summary.json` 保留最初生成时的 CPU-pending 状态，另以顶层 `fullCpuVerification` 关联当前实际 CPU 汇总的 SHA、门结果和身份检查；现有实机运行快照未重写，也不暗示 CPU 检查重新执行了 GUI/GPU。历史 4,747/4,749、2 失败与运行时漂移没有被覆盖；CPU/Rust 严格通过不使缺失参考、连续清晰度或 material 画质门变为通过，也不替代独立的[控制柄几何与圆度证据](README.md)。
