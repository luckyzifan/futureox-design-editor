# 完整源画布横向平移供给修复（2026-10-29）

本轮在 FIG / Sketch 文件修复上继续，处理用户补充的“新视口瓦片供给跟不上”问题。基线为当前工作树，见 `baseline.json`，没有把先前 2026-10-28 的单瓦片旧实现作为本轮比较基线。

## 改动

- `SourceViewportPlanner` 接入一圈相邻瓦片。静止时先预热左右邻列，平移后复用既有 panPrefetch 排序选择前进方向，最多 8 块和 8×514×514×4 输出字节。
- required tiles 与 prefetch tiles 有独立集合。完整/ready 只依赖屏内精确采样和真实呈现 ACK，预取不扩大完成条件。
- 在当前屏内内容获得实际呈现回执后才启动可选工作。新必需瓦片优先，变向/变倍率/源切换/隐藏窗口取消过期预取，仍只有一个 raster owner、最多两块一批。可选预算不足不毒化已完成的视口；其它错误保留正常失败路径。
- 可选批次的准备范围只包围该批真实请求，保持原有 native support/halo 计算；不为预取扩张当前屏内的准备范围。没有删除 GPU admission fence、增大预算或降低采样。
- unmanaged dither 相机 key 仅减去完整 512 像素周期。渲染相机保持原值，分数相位不变；非周期、grid/checkerboard/pixelPreview 不等价时绝不合并。
- 普通整数平移的大部分路径原本已是世界原点 camera=0；用户提供的“每次平移整屏 key 失效”并非这些路径的事实。此次 key 修复针对确实携带相机平移的精确分数/远坐标分支。

## 已执行与正在收集的证据

- `controller-tests.log`：5 文件 31 测试通过，包含 visible-first、预取取消、单 owner、晚回/重复结果、DPR/倍率和相机身份。
- `period-pixel-oracle.log`：真实 WASM byte-gradient 测试，512 像素平移对齐后的 RGBA8 完全相同；1 像素平移存在实际 dither 差异。CPU/WASM 证据不替代 hardware GPU。
- `scope.json` 固定条件与预算；`fixture.json` 固定真实拓扑相机、A/B 顺序、8 秒预热窗口和左右平移序列。预热消耗单独记录，不能藏进“免费命中”。
- `frontend/design-client/verification/source-pan` 运行冻结的旧 surface/planner 和当前候选，使用同一 Rust/WASM/GPU 实现、真实源模型和呈现器；测量相机输入序列开始至目标相机实际呈现 ACK。

## 边界

预取不能消除尚未渲染区域本身的 GPU 成本。高 draw count、RGBA32F、复杂 blur/backdrop/mask 和真实资源压力下的 GPU 完成等待仍需独立 profiling 与数值验证。本轮不从历史 10 秒视口推算当前收益，不把已有其它增量的 pass/fence 优化归入本次改动，不用局部缓存命中宣称 33ms / 100ms 或全 G2/G5 达标。
