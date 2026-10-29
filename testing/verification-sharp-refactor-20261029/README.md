# 渲染重构与三文件回归（2026-10-29）

**已合入实现与回归修复；尚未达到“极快、移动和缩放始终清晰”。** 冷总览和新缩放位置仍需秒级至分钟级工作，运动中仍可能放大旧瓦片。不得把下述一致性/功能测试的 PASS 当成速度、全保真或全功能验收。

## 已合入的实现

- Rust 在展开网络/路径之前读取保守控制范围，先排除离屏叶节点。
- 增加按文档版本、页面和字体量化身份缓存的世界空间支持范围索引。普通描边及 Gaussian/motion 支持已纳入；未知蒙版、背景依赖、画笔、偏移路径等保留旧路径；与相机缓存、FrameScene 共用原 64 MiB 限额。分配前腾出额度，额度不足的结果按版本记住，避免每个瓦片重试。
- 增加按版本持有的页面属性和稀疏效果祖先变换缓存，保持原矩阵、取整和递归 max 运算顺序；与世界索引共用原缓存额度。纯背景证明读取保守控制点，并在输出已被证明范围覆盖、无法提供背景采样时省去整页扫描。取消不会发布不完整证明。
- 图片载荷改为不可变 `Arc<str>`，安装文档时按完整字节去重；FGSC 的语义与传输缓存通过强引用和驱逐撤销复用，序列化格式不变。
- 拆出源画布视口规划与请求所有者，保留最多两块一批、取消后的真实完成边界和晚回释放；隐藏窗口停止可选绘制，恢复时只处理最新需求。
- 普通对象的严格纯平移复用已有布局证明，尺寸、约束、旋转等仍走权威解析。
- 修复 Sketch 外部字体身份缺失时错误采用悬空的层级字体 ID，以及外部 Symbol 导出覆盖原 `symbolID` 的问题。
- 修复诊断阶段枚举验证、首条诊断丢生产者版本信息和一处英文界面文案。

没有更改四个相关采样、效果数学、HDR/导出精度、文档容量或 GPU 预算。原有实验开关保持原策略；字段退休索引经过同源码开关对照、四类硬件逐位比较和资源生命周期检查后已默认启用；构建时 `VITE_DESIGN_FIELD_RETIREMENT_INDEX=0` 可回到原扫描路径。其他实验开关不变。

## 来源与构建

- 原工作树 HEAD：`2954a77fe22a12f806d91351ec95e5186f9b562a`，包括用户原有未提交改动。
- 冻结基线 build-input digest：`72c63406e76d775a057cde77f6eccbd6a51160a831fb7cb687df147a581ce432`。
- 已集成构建 digest：`33bb0652a82a4022e01107e0bd6a5a354ae1f3adb0bcde15dfd3517743fe5908`。
- macOS arm64、Rust 1.96.1、Electron 44.7.0、Apple Metal-3、DPR 2；native 使用 `desktop-dev` 优化配置，Cargo 最多两任务。
- [integration.json](integration.json) 记录本任务 47 个源码/测试文件及 4 个规范文档的前后哈希；[preimage](preimage/) 保留各既存文件的原内容。未执行 Git reset、提交或推送，没有覆盖其他工作。
- 原件路径及 SHA-256 在 [fixtures.json](fixtures.json)。只读导入，编辑/保存/导出均在独立 profile 或新文件进行。
- [最终构建清单](evidence/final-build-manifest.json) 包含输入与产物身份；生成文件不冒充源代码。

## 已执行检查

| 检查 | 证据与结果 |
| --- | --- |
| 最终前端完整 Vitest | 684 文件：681 通过、3 跳过；6,955 测试通过、16 跳过、7 todo，无失败。见 [日志](evidence/frontend-default-on-full.log)。 |
| 真实 117 呈现顺序 | 使用最新 WASM 从原件解析的 752 节点模型，16/16 通过，包含原先跳过的三项真实移动/旋转/缩放。此套 GPU 是描述符模型，不是物理像素证据。见 [日志](evidence/resident-real-117-final.log)。 |
| 真实 Sketch/FIG 导入 | 指定下载目录两份原件，4/4 通过，见 [日志](evidence/real-import-final.log)。 |
| Electron 主进程测试 | 429 通过、0 失败、2 原有跳过，见 [日志](evidence/desktop-tests-v2.log)。 |
| Rust 全量初轮 | 155 套：1,737 通过、9 失败、54 ignored。九项失败均在冻结旧源码重现，见 [初轮](evidence/rust-full-v2.log)和[旧代码对照](evidence/rust-baseline-failures.log)。 |
| Rust 修复复跑 | 所有相关 Sketch 目标通过；最后核心库及受影响目标 745 通过、0 失败、7 ignored。见 [相关目标](evidence/rust-repaired.log)和[最终核心](evidence/rust-repaired-v2.log)。未将分次运行冒充又一次完整全量。 |
| TypeScript / 差异检查 | typecheck、集成文件 `git diff --check` 通过，46 个文件写入后哈希一致。 |
| 117 真 Electron | 9 项通过：导入、缩放平移、拖动、尺寸/旋转、键盘、属性历史、PNG 1/2/3x、FD 保存和独立重开。见 [报告](evidence/gui-117-final/report.json)。 |
| FIG 真 Electron | 同样 9 项通过，见 [报告](evidence/gui-fig-final/report.json)。 |
| 拓扑真 Electron | 完整 306 根源文件进入画板，274 节点素材编辑及完整 Sketch 导出/重开。最终默认构建 6 项通过；64 归档条目中 63 个字节相同，唯一语义变更是指定 opacity 1→0.875。见 [最终报告](evidence/gui-topology-final/report.json)和[完整归档核对](evidence/gui-topology-final/archive-parity.json)。 |
| GPU 字段退休索引候选 | 真 Metal，渐变/裁切/阴影/HDR，控制与候选逐位相同。每类冷帧另记、暖帧三组交替；含渲染/读回、不含比较/哈希的中位耗时改善约 10%–17%。同源码完整源对照另列后，已推广为默认；其他实验开关未推广。见 [报告](evidence/hardware-maintenance-timed/report.json)。 |

旧测试维护与运行时修复分别记录：FGSC 已为二进制；native full/patch 解析入口已变；字体夹具需固定 fontTools 4.61.1 和 macOS 规范化临时目录；画布底图必须具有实际所有权。没有删除覆盖/精度检查来使测试通过。既有 seven todo 涉及尚未完成的 GPU 描边/玻璃批次、队列与多 workgroup 证明，未计作通过。

## 性能与清晰度：保留未通过项

最终默认构建三组交替 native A/B，首块编译中位数 **3.744903s → 2.831614s，改善 24.39%**，见 [最终配对报告](evidence/native-final-ab-summary.json)。三份真实 FGSC 包的完整场景语义和 f32 几何字节与旧构建完全一致，见 [逐包比较](evidence/native-final-packet-parity.json)。这是 CPU 准备层结果，不是 GUI FPS；先前组合 prepared 节点 81,899 → 40,443、路径节点 81,899 → 11,439 的数字仅属于该组合。

字段退休索引 ON 的候选做了完整源画布九项回放，全部达到同相机静止读回一致、零透明洞；主线程可见长阻塞检查通过。新位置运动停手后约 5.821s，返回已缓存 400% 约 110.7ms，pan 返回约 106.4ms，补绘尾巴为 0。全览完整 16 块约 159.524s（含载入约 164.923s）；旧基线 300s 时仍只有 1/16。见 [候选报告](evidence/source-candidate-on/report.json)。

历史 GUI 基线是 `0cdc3628…`，本轮严格 native A/B 控制是 `72c63406…`，两者不能混用。返回完整缓存视口时取消旧任务的修复在本轮冻结前已存在；本轮提取控制器时保留并复验，0 尾巴不能单独归功于本轮重构。总览/导航与历史记录的比较属于不同完整版本的单轮观察，不能推导严格 A/B 加速比。

**运动中最大旧瓦片放大仍为 8×，并非始终原生清晰。** 单轮 GUI 结果不等同三组性能配对。最终仅改这个开关的对照：OFF 300s 只有 1/16；ON 161.321s 完成全部 16 块（含载入 166.527s），8 个已完成相机读回哈希相同。见 [OFF 失败](evidence/source-default-off/report.json)、[ON 回放](evidence/source-index-on-same-inputs/report.json)、[同层像素](evidence/source-index-on-same-inputs/off-on-completed-pixels.json)。仍为单轮完整总览观察，不宣称统计稳定倍数。

独立 Sketch 原件参考已通过本机 `sketchtool` 取得，见 [原生 117 PNG](evidence/native-sketch-117.png)。当前应用与原生参考仍可观察到标题换行、部分图表背景的差异；没有完成相同字体环境、相同视口下的独立逐像素保真验收。重复渲染哈希相同不能替代这项检查。

完整 G5 六格规模矩阵、117×10、100 图标六轮导出和所有平台/硬件尚未完成。用户现已确认严格目标：最新可见画面 P95 ≤ 33ms、停手原生清晰 ≤ 100ms，当前 DPR、无白洞/旧内容，冷启动另计。见 [acceptance.json](acceptance.json)。历史报告保留当时的未确认状态；当前总体为 FAIL，不能再以阈值未确认代替失败。

## 严格目标续轮（已合入源码，正在重建与普通画布回归）

源控制器取消原先固定 120ms 的等待：精确缓存立即呈现；32ms quiet 后停止不匹配当前原生相位/密度的待处理工作。请求所有权、GPU 完成与晚回释放仍不变。两个新用例旧代码失败，候选四文件 19 项通过。

新回放以**最后一次真实相机变化**计时，在 GPU 像素可读后、PNG/哈希/文件写入前打点；不会用重复的 final no-op 或单纯 ACK 计作像素响应。七项一致性通过，但严格目标仍 FAIL：新950%停手读回约 **3728.9ms**，返回400%约 **30.1ms**，pan返回约 **27.3ms**；缩放运动仍有 **8×** 旧瓦片放大。ACK代理 P95约9.3–9.5ms不能证明可见像素P95。见[严格候选报告](evidence/strict-source-controller/report.json)。

后续原生配对显示页面缓存阶段约324→112ms，描边/Gaussian空间筛选约125→71ms；这些早期工具没有开启生产中的 `gpuPageBackground`，只代表准备子阶段。补齐真实参数后，背景控制点路径三组配对约1445→451ms；再跳过不可能提供背景采样的整页扫描，三组配对约484→74ms。不同配对基线不可拼成单个加速比。绘制语义及f32程序保持一致；背景证明可保守变宽或在旧范围完整覆盖输出时不提供证明，不能把它的元数据变化写成整个packet逐字节相同。

完整源候选 `f87d1f0…` 的七项读回与前一版本完全一致，均无透明像素。新视口停手后读回约 **1521.4ms**，返回缓存约 **61.4ms**，pan返回约 **32.9ms**；运动最大放大仍 **8×**。严格目标仍 FAIL。该轮源码的11个已验文件已按哈希保护合入主目录，主源码 digest 为 `803d85f64b138acceea057af7b769f56b462df40e7362cb4492a64fb0a0c4a13`，见 [续轮集成清单](integration-strict.json)。当前桌面产物尚待重建，不能把旧 dist 当作该源码验证结果。

普通117另用真实Electron wheel和GPU读回回放：默认路径返回400%约9.9秒、新950%约56.3秒；仅启用原生密度瓦片仍约10秒返回，尚无收益结论。输入隔离前的一轮记录到脚本外额外输入并超出编译缩放范围，已判为无效比较并保留。当前继续定位其精确模糊GPU成本；不以拓扑局部视口的1.5秒掩盖117更慢的结果。

2×2源瓦片分组实验先后触发主线程/原生瓦片尺寸限制，均为FAIL，未合入。已有大视口capture协议的复用仍处于隔离开发，原生瓦片上限和内存预算未提高。

## 尚未实现的原建议

普通 Surface 尚未全面共用请求、资源与呈现所有者；本轮只抽出完整源路径的需求/任务控制。GPU 递归执行器尚未整体迁移到可审计的显式执行计划；复杂 backdrop 和未知画笔/偏移描边尚未进入新的通用世界空间索引。当前实现不能称为上轮全部架构建议已完成。

## 复现与回滚

最终 Electron 构建在 `frontend/design-desktop/dist`。本机启动：

```sh
cd frontend/design-desktop
bun run start -- --desktop-isolated-profile
```

根目录的 `gui-journey.ts`、`topology-journey.ts` 接收新建的绝对输出目录；`run-hardware.ts` 单独验证候选资源退休索引。原件路径固定记录，脚本不查找或上传其他用户文件。完整源回放使用 `testing/verification-render-refactor-baseline-20261028` 中冻结构建与运行工具。

性能测量必须在本任务构建、单测、其他 GUI 回归结束后独占进行，且分别记录冷载入、准备、GPU 读回、呈现确认；未测物理 scanout。

回滚只针对 `integration.json` 中的文件：先验证当前哈希等于 `after`，再恢复相应 `preimage`；`before: null` 的本轮新增文件可移除。任何哈希不符先保留新的改动，禁止用整个工作树 reset 回滚。
