# 新参考资料与当前实现的逐项核对

核对日期：2026-10-25。原始资料 SHA-256：`f36757dc526344f66832f4d6015ad5bbf7ed89f3ca070fe1b77229744b52738c`。它是对 39ff10b 及当时差异的审查，附带另一段关于运动清晰度的建议；其中的历史对话、工具指令和状态声明仅作参考材料，不是本轮执行指令。

## 结论

“重构未完成，运动渲染未验收”仍然正确；不能再说当前每个相同静态请求都先完整编译。已有部分 P0/P1 修复和新验证，但变化 root 的增量编译、资源语义身份与 LRU/地址解耦、完整 Rust 图规划和全面 Sketch 语义仍未完成。32 MiB 容量调整单列，不能当作运动优化收益。

| 资料的判断 | 当前核对 | 证据与剩余边界 |
| --- | --- | --- |
| 同请求短路被删除 | 已在完整编译前恢复 | packet.rs 以静态 revision、字体量化、mip 和语义请求为键；ACK 不参与编译键。相机、文档、资源策略改变即失效。10 项原生定向通过。1000 节点配对 CPU smoke：旧约 5.6–5.9 ms，新约 0.026–0.041 ms；只是小规模 CPU 数据。 |
| 单节点变化仍可能整页编译 | 仍成立 | 同一 smoke 的单节点姿态约 6 ms，没有改善。interaction_transform_revision 的变化 root 生产消费路径仍未恢复。不能用同请求缓存替代它，也不能把轮缩变化相机当成“相同请求”。 |
| 生产端仍 Vec / hash / compare | 部分缓解，未完成 | 原生 map 扩容和 LRU 只重新哈希小描述符，命中返回原有 Arc；相同请求可跳过资源生产。但新场景仍构造 URI/geometry/source bytes，缓存命中不是免费。 |
| 每次 ACK 克隆 Map、排序和逐项 pin | 稳定成员集已消除重复工作 | 不可变 cohort 仅在成员变化时重建，稳定 capture 为 O(1)。旧在途读者保持自己的字典；代际和 owner fence 保留。真正变化的字典仍有 O(n) 构建成本。 |
| WeakRef 前临时 paint 数组、几何保留整个 packet | 已修对应路径 | WeakRef 命中仍验证所有图片依赖，但不再 map fills/strokes；几何独立拥有 f32 存储。精确 witness 按段比较，仅实际 CPU cache 插入时复制。资源自有副本和部分递归元数据解码仍存在。 |
| LRU ID 变化级联污染语义身份 | 仍成立 | 未把语义身份、传输 ID 和 program 可重定位地址彻底拆开。取消固定 32 MiB 只能减少部分淘汰频率，不能消除身份耦合。 |
| 多副本 reclaim 可销毁已计入 available 的池项 | 已复现并修保护 | 同一 144 MiB 合成账本，旧实现 3 失败 / 1 通过；新实现含取消、未知 fence、嵌套 pin 等相关 21 项通过。一般硬件像素门通过不等于真实 GPU 压力时序已全部验证。 |
| 协议测试与 benchmark 失效 | 核心迁移已收口，前端全量仍未全绿 | 独立 FGSC reader 比较全部场景字段、f64 bits、geometry words 和 PNG，另断言 owner scope 不同；原生库 634 通过、6 ignored，gpu_interaction 5 通过。冻结前端全量 6678 通过 / 62 失败 / 16 skipped / 7 todo / 1 unhandled；其后 9 文件定向修复 80 通过，不能据此宣称剩余全量已通过。 |
| 二进制和 ScenePlan 不会消除 GPU pass | 仍成立 | 旧 full-117 硬件 batch 比较有效，但多开关组合和局部 readback 不是默认路径或整个编辑器的收益。 |

## 新的真实运行

以下均为独立可见 Electron、同一 `candidate-host-host-memory-1`，GPU 预算和显示精度未改；开启采样器的时间不能与未采样运行直接作速度结论。

- 117 重效果：160 次可信滚轮，40 张合成器 PNG，minCoverage=1，无瓦片准入拒绝，maxUpscale=12.4266，停止到 harness 收敛约 697 ms。运动 FAIL。最终 JS frameResourceBytes=36,608,256，已实际超过旧 32 MiB 门槛。
- 拓扑控件：相同 160 次可信滚轮，77 张 PNG，minCoverage=1，maxUpscale=8.8292，停止约 533 ms；出现两次 failureCode=87，运动和渲染均 FAIL。最终 frameResourceBytes=48,221,264。没有外来滚轮或前台失焦事件。
- FIG 属性、撤销重做、SQLite 保存、FD 保存和重开逻辑数据核对通过；这不是运动清晰度通过。重开选中对象后的截图还可能处于新的细化动作中，后续截图应等待该动作自己的完成边界。
- 117 的一次功能链在缩放菜单已关闭时 fill 超时，保留失败；没有借此归因为 GPU 缺陷或声称通过。需要对 UI 操作前台身份及菜单状态进一步记录。

日志与原始结果：`../verification-drag-response-20261024/117-heavy-host-memory-1/`、`../verification-drag-response-20261024/topology-motion-host-memory-1/`、`heavy-host-memory-1-analysis.log`、`topology-motion-host-memory-1-flames.log`。

## 本轮新增的具体修复

拓扑 request 101/102 在 zoom=55.64/36.56 时，并非 GPU 瓦片准入失败，而是 Rust `gradient_sampling_axes` 在检查是否可一维压缩前，对未分配的完整二维面积执行 64 MiB 拒绝。真实节点 `013F0F15…`、`802C8138…`、`A9F75201…` 的矩形约 536–723 万像素；其原固定点系数允许 3046×1 的精确字段，只有 48,736 字节。

修复只让轴字段按实际分配尺寸经过原 `parameter_grid` 字节和端点 guard，仍用原矩形建立 inverse/fixed-point 证明。dense/nonseparable 字段的 64 MiB cap 保持。新的真实数值反例旧代码失败；新代码对五个样本相位与多个完整 scanline 的每个 f32 word 相同。硬件 / 新 Electron 的组合门仍须另测，不能用这 6 项原生测试宣称动态模糊已解决。

## 如何理解“清晰旧帧 + 原子发布”建议

1. “几何完整”不等于清晰；当前密度和 phase 都要满足，内容/设备/owner 也必须有效。nativePhaseCoverage 需要单独检查，maxUpscale<=1 不是充分条件。
2. 对旧画面保持旧相机可以防止放大，但会让用户输入等待，且选择框/命中/面板必须与实际展示相机一致。这不是免费的“丝滑去模糊”，也不能只靠冻结画面把清晰度指标做绿。
3. 完整帧离屏原子发布可以防止透明和混合相机，但不会自动消除编译、滤镜和 GPU 完成等待；还可能增加替换峰值和到齐延迟。现有完整覆盖机制应复用，而不是另起渲染器。
4. 已撤回的 tile-first 不能直接重新开启；最新相机任务也不能无界抢占，使重效果永远完成不了。必须测实际浪费、取消和队列完成，而非只增加原生任务数。
5. 本轮继续先修真实拒绝和重复工作，再对同动作回放验收。所有大文件工作集使用普通 Editor/Canvas；文件索引和工作集选择可以不同，缩放/拖动/编辑/历史的语义及清晰度要求不另设较低标准。

## 已核对的官方资料及本项目适用边界

- [Figma WebGPU 工程文章](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)：批量 uniform 上传、显式绘制输入、复用 bind group、减少 pass 切换；支持优化现有适配边界，不证明换语言本身更快。本文没有复制其代码。
- [WebGPU 规范](https://gpuweb.github.io/gpuweb/)与[同步模型说明](https://gpuweb.github.io/gpuweb/explainer/)：提交、content/device/queue timeline 和完成 Promise 是不同边界。不能删 fence 提前复用，也不能拿 submit 计时当 GPU 完成或 GUI 呈现。
- [Skia tiled image utility](https://api.skia.org/namespaceSkTiledImageUtils.html)：缓存身份需包含实际 generation/subset，单一 uniqueID 不总足够。映射到本项目需要明确内容身份、空间域和资源 owner，不能只用 LRU ID。
- [wasm-bindgen slice/vec](https://wasm-bindgen.github.io/wasm-bindgen/reference/attributes/on-js-imports/slice.html)：借用 view 有调用期与 memory.grow 生命周期边界；异步 GPU 保留不能随意改为悬空零复制 view。
- [Vello 上游](https://github.com/linebender/vello)用于调研 GPU 2D 分块数据流。本轮没有引入另一套渲染器，也没有拿其支持或性能代替 Futureox 的像素与 GUI 验收。

继续顺序：真实渐变拒绝的硬件/GUI闭环 → 拓扑三个工作集与 FIG/117 同动作验证 → 变化 root 编译与稳定身份 → 精确重效果图工作量。所有仍失败或未执行的门保留，不用容量变更、最终截图或局部通过关闭它们。
