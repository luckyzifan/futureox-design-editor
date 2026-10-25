# 当前状态（2026-10-25）

**尚未全部通过。运动中旧帧放大仍可复现，不能宣称无模糊、完全顺滑或架构重构完成。**

## 已实现并取得对应证据

- 拖动：原始画布 receipt 派生姿态、Rust 根范围快照、待处理矩阵合并、删除无必要的 Immer 全节点表复制。FIG 原回放仅收到 6 个指针事件，后续约 60 个；这不等同于每次输入都立即得到新像素。
- 完整覆盖：保留完整覆盖准入，在同一内容/密度的已证明空白缺口补背景。已有内容的重投影与全新栅格相位仍分开验证，未放宽精度。
- 大文件：直接进入普通 App 工具栏、图层、Canvas、Inspector，自动加载第一画板；原独立源文件页面及 JSON/Canvas 对话框已删除。完整源文件仍由独立存储 owner 保留，局部画板不会进入整文档 FD/SQLite/IndexedDB 自动保存。
- GPU 准入：补齐合成、临时层、蒙版和背景扩展分配前的实际需求检查；完整组的已消耗蒙版按所有权退休。保留 used/pinned 保护及实际完成 fence，不提高预算。
- Rust 帧资源：缓存资源键的哈希，扩容和 LRU 操作不重复扫描大字节串；内容相等仍逐字节确认，32 MiB 原额度不变。

## 已测试但保持默认关闭的渲染候选

- 独立显示 GPUDevice：仍使用同一个渲染器和现有 Presenter。目标纹理与转移位图同时计入原 224 MiB ledger。真实 macOS Dawn/IOSurface 长等待由约 1.95 秒降至不到 1 ms；不能据此宣称运动清晰。
- Rust 纯色组计划及现有四相位程序批绘：117 完整视口 draw 从约 9,847 降至 5,355，硬件浮点输出不变。
- 32–512 半径的整数区间前缀：Rust 校验实际 Q64 系数并给出中间量界；仅两端舍入成相同有限 f32 位时使用结果，不确定像素仍走原精确滤镜。原 f64 半径、四相位和 4 MiB scratch 均保留。
- 现有动态 uniform 绑定：原路径与候选的真实 117 完整视口和 FIG/117/拓扑区域像素一致；全应用组合的三文件编辑/保存重开通过；运动质量仍未通过。

## 关键证据

| 记录 | 实际范围与结果 |
| --- | --- |
| `composition-parity-hardware-1.json` | 5 个真实区域、WebGPU/WebGL2、60 次浮点读回，零 word 差异 |
| `certified-prefix-heavy-hardware-1.json` | 两个真实 117 重效果区域，12 次读回零差异；暖完成等待约 47–49→21 ms、131–135→70–74 ms。不是整机速度声明 |
| `certified-prefix-edges-hardware-2.json` | 120 个数值/边缘场景、240 次硬件读回零差异，包括负值、HDR、次正规数与非有限中间结果的原路径回退 |
| `composition-pressure-hardware-7.json` | 旧 256 MiB 拒绝，新同额度成功；5 次 checkpoint、峰值 249,051,676 B；与旧原有默认额度的 1,048,576 个 f32 word 一致 |
| `backdrop-expansion-hardware-2.json` | 当前 117 导入模型和真实失败相机，同 1 GiB、实际 captureDisplay 契约，扩展修复前后逐位一致 |
| `117-heavy-zoom-admission-2/report.json` | 160 可信滚轮，非取消渲染失败/恢复回退为空；仍 maxUpscale≈12.43、停手收敛约 770 ms，运动清晰度 FAIL |
| `fig-operations-uniform-1/report.json`、`117-operations-uniform-1/report.json` | 编辑/撤销重做/SQLite 保存/外部 FD 保存/新实例重开通过，完整模型核对 |
| `sketch-operations-uniform-1.json` | 三组真实拓扑素材编辑、撤销重做、完整导出、新实例重开通过；普通工作台自动入画板 |
| `sketch-operations-uniform-1-archive.json` | 64 成员中 63 逐字节不变；变化页仅预期 3 名称和 3 透明度，原始输入 SHA 不变 |
| `frame-hash-packet-bytes-1.json` | 三个真实文档、15 轮旧/新 WASM 完整 FGSC 字节相同 |
| `117-native-profile-admission-2/`、`117-native-profile-frame-hash-1/` | 仅附加本任务独立 Electron 后代。原生资源编码非等待样本 115→87，整体 372→354；采样不当作 wall/物理帧延迟 |

`render-failures.mjs` 会把运动窗口中的非取消失败及 recovered=1 计为失败，不再仅看最后 UI 错误标签或 settled 清晰状态。失败、夹具错误、未命中候选及性能退化记录均保留在 WORKLOG 中。

## 仍未完成

- 快速缩放始终保持当前物理密度，以及对象非整数设备相位重绘的延迟。
- 全面 Sketch 专有语义、结构编辑保存、跨源打开失败的生命周期专项验证。
- 全部渲染图规划/复用职责收进 Rust，完整 FrameSceneHandle 数据流及旧执行路径清理。
- 完整 G2/G5 矩阵、逐帧 GUI Alpha 与选择框/内容同步的联合验收。

实验不能因局部收益自动改默认。独立构建、运行参数、日志、火焰图及未通过原因见 [WORKLOG](WORKLOG.md)。没有更改其他任务进程，也没有提交或推送这些工作区修改。

当前最新独立组合为 `candidate-uniform-1.json`；其控制参数只作用于该私有构建。`117-heavy-zoom-uniform-1` 的这一轮停手收敛576ms、无渲染恢复失败，但旧纹理仍放大约12.43倍，不能验收为运动清晰。
