# 运动清晰度实测记录 — 2026-10-21

截至本记录，**连续缩放始终清晰的验收未通过**。以下是同一 `117.sketch` 的独立单次运行观察，不能外推一般提速、Figma 流畅度或物理 90/120 FPS。机器可读原始指标和证据路径见 [motion-summary.json](motion-summary.json)。整理过程只读取已有记录，没有重新运行 CPU/GPU 测试。

| 运行 | 实测状态 | ACK 数 | 最大旧像素放大倍数 | 输入→ACK p95 | 结论 |
| --- | --- | ---: | ---: | ---: | --- |
| [sharp-v6-fresh-117](sharp-v6-fresh-117/results.json) | 运动门失败 | 256 | 15.894608 | 260.300ms | 最小清晰覆盖率为 0；不能以相机响应快代替清晰像素完成 |
| [material-v7-fresh-117](material-v7-fresh-117/results.json) | 运动门失败 | 286 | 11.586095 | 35.700ms | 输入延迟观测较小，仍存在严重旧像素放大，未达到不模糊要求 |
| [viewport-v8-fresh-117](viewport-v8-fresh-117/results.json) | 导入/设置阶段失败 | 未测 | 未测 | 未测 | 等待 120s 超时，未进入运动阶段 |

v6 向上缩放的 111 次 ACK 没有一次达到完整清晰覆盖；v7 的运动门同样失败。ACK 是 worker 对呈现提交的确认，不是 GPU 完成、更不是像素到屏延迟。v6 的相机请求→ACK p95 为 9.8ms，但输入→ACK p95 为 260.3ms，两者不能混用。输入间隔也存在长间隙；没有使用 rAF 数值宣称帧率。

v8 的 [原始诊断](viewport-v8-fresh-117/host-stdout.log) 包含预算 `failureCategory=3 / failureCode=20 / failureStage=13`。worker 与 main 转发记录可能重复，不能把日志条数当成独立失败次数。运行所有者观察到进程自然结束；**没有证据表明外部 kill 信号成功发出**。整视口生产分支已撤回，保留于 [parked-sharp-viewport.patch](parked-sharp-viewport.patch)，该版本没有运动清晰度结果。

## 标准交互与精确导出

| 运行 | 标准流程 | 首次 3200% 整阶段 | 按住拖动预览等待 | 1x/2x/3x 原始 PNG | 完整落盘撤销 |
| --- | --- | ---: | ---: | --- | --- |
| [material-v7-export-117](material-v7-export-117/results.json) | completed | 624.814ms | 222.722ms | 与 origin-v3 三份逐字节相同 | 通过 |
| [material-v9-export-117](material-v9-export-117/results.json) | completed，原始观察 | 710.709ms | 723.394ms | 与 origin-v3 三份逐字节相同 | 通过 |

以上时间是各自 harness 阶段/等待记录，不是单独 GPU 算子耗时，也不是配对多轮性能结论。v9 目前只纳入已存在的标准流程原始结果；不能拿它替代独立连续缩放门。两次导出前后持久化文档 hash 均未改变，源文件保留。导出文件由真实 UI 下载，经原 Electron 来源/类型/大小检查；测试进程自动指定保存位置，没有人工操作原生 Save 对话框。

v7、v9 的屏幕画面都**不是零差异**：相对 origin-v3，3200% 截图 RGB 最大差值 2/255、RGB 均值约 0.270963、p99 为 1；各自 held 与 settled 的最大 RGB 差值 5/255，17,705 个像素的 RGBA 不同，alpha 不同像素为 0。详见 [v7 视觉比较](material-v7-export-117/visual-comparison.json)、[v9 视觉比较](material-v9-export-117/visual-comparison.json)。这些是固定指标的报告，不是看完数值后选择的通过阈值；导出逐字节一致也不证明运动视觉已达标。

## 当前代码处置

- 已接受默认项仍为桌面屏幕密度档、pending pose 和 nested prefix。
- source-material 预滤波、sharp zoom、空闲交互预热保留严格 opt-in，未默认启用。
- source-material 是**屏幕近似算法**：源图空间滤波后重建，与原来的设备像素网格采样后滤波顺序不同。即使内部 H/V 使用精确算术，也不能把整条路径称为精确缓存或逐位等价。
- 文档、编辑/撤销和精确导出继续独立验收。当前证据不支持“缩放全程不模糊”“已达 Figma 流畅度”或一般性能倍率声明。
