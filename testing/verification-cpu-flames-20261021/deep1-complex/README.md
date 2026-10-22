# Deep1：真实六轮输入火焰图

本组使用独立冻结的 release Electron，117 和 FIG 各执行 366 次真实滚轮、960 次 Space 平移输入；没有在 90 个操作阶段之间等待静止。采样图来自实际 CDP renderer/Worker profile，40 份保存的 JS/source-map 资产逐项匹配。SVG 已离线栅格化查看；没有用阶段日志伪造火焰图，也没有绕过浏览器文件 URL 限制。

**两份整体验收均失败。** 117 与 FIG 各有 16 个实际捕获，14 个精细参考可用、这 14 个没有检测到超过预定阈值的异常缺口组件。117 另两个参考分别超时 120 秒，FIG 另两个被现有 512 像素整数积分模糊 guard 拒绝。缺失参考保留为失败。两者最低清晰覆盖均为 0，最大放大上界缺失或非有限；不能把它们写成无模糊/无白块通过。数值、来源与严格边界见 [公开整机摘要](../../verification-complex-navigation-20261021/deep1-app-summary.json)。

| 实际采样，ms | 117 renderer | 117 Worker | FIG renderer | FIG Worker |
| --- | ---: | ---: | ---: | ---: |
| active CPU | 6446.414 | 4334.383 | 6004.958 | 2754.376 |
| idle | 38261.627 | 42623.958 | 11493.520 | 17110.957 |
| sanitizeFields self | 266.710 | 308.810 | 233.810 | 258.403 |

117 Worker 的 `certifyExactImageRange` self 为 653.227 ms，其中 634.584 ms 位于 `imageFor → uploadImage → uploadLinear`。这是同步 CPU 扫描的实际调用栈，不是 GPU 时间；不同层级的 inclusive 值不能相加。主线程 `toDataURL` 等捕获工具占用单列，不能当产品绘制热点。

[实际日志的队列观察](diagnostics/summary.json) 与 CPU 采样分开：117 admission 268 次、累计 30338.1 ms；FIG admission 12 次、11.4 ms。累计 CPU 队列完成等待不是独占 shader 时间，也不能把 idle 全部归给 GPU。不同 Worker 的等待可能重叠，主/Worker 窗口不能相加为整机延迟。这些启用 profiler、诊断和捕获的 ACK 数据也不是无扰动生产基准或硬件 FPS。

该构建开启区域 painter 与有限图像显示候选，native-navigation 关闭；它早于后续的四相等价遮罩、image-over-zero、回收顺序和 capture-read 迭代。后续源码不能借用这组旧资产图证明已经通过。文档和原文件的导航保留检查通过，但本轮没有执行编辑、完整撤销或导出；这些门仍须在最终构建上单独完成。


## 主线程重复场景准备与后续借用修复

FIG renderer 的 source-map 聚合与原始调用树一致：React layout → `ResidentCompositeSurface`（304 行）→ `InteractionRenderer.prepare`（298 行）→ `scene/visit`，以及同一 prepare 下的 `buildInteractionDependencyScope → interactionRootBounds`。相关累计采样如下；行号是该冻结构建的 source map，不是当前源码位置。

| 调用 | self，ms | inclusive，ms |
| --- | ---: | ---: |
| scene | 152.461 | 611.221 |
| buildInteractionDependencyScope | 104.957 | 339.432 |
| interactionRootBounds（包含于上一行） | 154.210 | 158.724 |

FIG 整段窗口为 19,915.842 ms。611.221 ms 不是一次卡顿或单个操作的 CPU 延迟；rootBounds 与其父级不能重复相加。CDP 样本也不记录 JS 参数身份，不能单凭 profile 证明所有调用都传入同一对象。实际 navigation workload 保留文档，源码又显示 Canvas 已有 published scene、interaction 恢复仍独立重建，二者共同支持复用这一已有 immutable snapshot 的最小修复。

后续实现通过 Canvas token 严格借用原 current/displayed 两槽，缺失/旧 token 回退 fresh scene；没有额外 history cache，也未缓存依赖 zoom/DPR 的整份 dependency scope。两套 CPU focused tests 74/74 通过；边界、源码 hash 和首轮环境失败记录见 [导航说明](../../verification-complex-navigation-20261021/NAVIGATION-20261022.md)。这些新源码不能反向套用本组旧 profile 宣称获得 611.221 ms 延迟改善或渲染体验已经达标；仍须新构建复杂操作验收。
