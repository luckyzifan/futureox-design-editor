# 2026-10-20 Electron 实测 CPU 火焰图

本文是合并前的历史实测，不能用于验收后续源码。仓库保留分析工具、源码身份、
紧凑结果与 SVG/HTML 火焰图；下文引用的原始 profile、画面截图、原生日志和
运行构建清单保留在本机，未随本次源码提交。用户要求停止测试后没有重新运行。

本轮结论：最新 `00383f4` 的首次高倍清晰化仍未达到快速交互验收。117 的主要问题是大模糊图片的坐标场重复计算、上传和 GPU 完成等待叠加；FIG 导入还存在秒级主线程计算。没有将局部缓存命中或 rAF 频率当成 Figma 流畅度验收。

## 可直接查看的证据

- [117 首次 3200% 的 CPU 火焰图图片](117-zoom-3200-flame.png) / [可悬停查看的全部火焰图](117-run1/flamegraphs.html)
- [FIG 导入主线程火焰图图片](fig-import-flame.png) / [文字区域补测全部火焰图](fig-text-run2/flamegraphs.html)
- [五次运行的紧凑结果](run-summary.json)、[117 请求/瓦片/fence 关联统计](117-run1/diag-summary.json)
- 原始 CPU profile：[117 render Worker](117-run1/zoom-3200-1.cpuprofile)、[117 主线程](117-run1/zoom-3200-0.cpuprofile)、[FIG 导入主线程](fig-text-run2/import-0.cpuprofile)。可在 Chromium DevTools 中加载。
- [117 原生准备进程的独立系统采样](117-run1/native-zoom-3200-62828.sample.txt)
- 实际画面：[117 3200%](117-control/zoom-3200.png)、[FIG 文字 3200%](fig-text-run2/zoom-3200.png)

火焰图来自真实 CDP 采样栈，横向宽度为累计采样耗时，纵向是调用关系。图中排除了 idle 和 program；它不是事件时间线，更不是 GPU timestamp。各级 inclusive 时间不能相加。

## 构建、环境和方法

使用当前源码重新执行 `node scripts/build.mjs --release`：WASM、React renderer、Rust sidecar、design-prepare 和 design-render 都已重建；typecheck 随构建完成。构建记录时间 `2026-10-20T10:40:21.352Z`，即北京时间 18:40。每次运行保留同一份 1670 文件的 [构建清单](117-run1/build-manifest.json)，另有 [最终身份核验](identity-check.json)。只新增本目录的测试/分析工具与证据，没有修改产品实现。

真实可见 Electron，1440×960 CSS 像素、DPR 2、Apple Metal WebGPU。系统显示器报告约 120 Hz；这不等于应用提供 120 个不同内容帧。保留 sandbox、contextIsolation、webSecurity；原始输入通过产品文件输入控件导入，使用新建临时用户目录与实际 Rust/SQLite。鼠标和键盘由 Playwright 发送，未用 mock renderer、替换文档模型或合成渲染结果。没有测物理触控板到屏幕光子的延迟。

CDP 目标采样间隔 1000 微秒，覆盖主线程和长期存活的 render Worker。Native `design-prepare` 在首次 3200% 同时进行了 5 秒、2 ms 间隔的 macOS sample。短生命周期导入 Worker 在结束后退出，未成功取回其 profile；不据此归因其内部 CPU 成本。117 第一轮记录的重复 `Session with given id not found` 是采样工具继续引用已退出 Worker 的问题，后续工具已在 detach 时移除；主线程和 render Worker profile 已成功保存。应用 pageerror 均未发现。

WASM 符号不是猜测：从同一个 release 构建重新运行 wasm-bindgen 得到带 name section 的模块，验证去掉 name section 后与实际加载的两个 WASM 文件逐字节相等，再按函数索引映射 6143 个名字；见 [符号身份](wasm-symbol-identity.json)。JS 使用该构建随包生成的 source map。`VITE_DESIGN_DYNAMIC_UNIFORMS`、`VITE_DESIGN_KERNEL_CACHE` 均未开启。

每次先完成正常启动与初始画布，然后导入，选定真实图层并适合选择，进入 100%，做四次往返平移，再进入 3200%，平移，返回 100% 并重复 3200%。所谓“首次”仅指本轮首次进入该目标相机；之前的启动、导入和适合选择已经预热了一些资源，不能称系统级完全冷启动。阶段时间包括菜单输入和等待最终 ready；平移总时长还包括输入发送，不能直接倒数当 FPS。

运行顺序为 117 采样 → FIG 首轮 → 117 无采样对照 → FIG 文字补测 → FIG 无采样对照。性能运行没有并行构建/重型测试；并行子代理只做源码和日志读取。这是定位和开销控制，不是基线/候选随机化 A/B，也不支持整体加速比声明。

## 实测结果

下表对照关闭 CPU 采样和详细诊断，仍保留轻量 rAF/longtask 观察与自动输入。

| 场景 | 117 采样开启 | 117 采样/详细诊断关闭 | FIG 文字补测采样开启 | FIG 采样/详细诊断关闭 |
|---|---:|---:|---:|---:|
| 导入至呈现 ready | 4.045 s | 3.717 s | 11.439 s | 10.946 s |
| 首次目标 3200% 至 ready | 9.870 s | **9.452 s** | 0.916 s | 0.748 s |
| 重复返回同一 3200% | 0.220 s | 0.208 s | 0.256 s | 0.276 s |
| 3200% 平移期间最大 rAF 间隔 | 108.3 ms | **141.8 ms** | 74.2 ms | 57.6 ms |
| 导入最大主线程 longtask | 311 ms | 292 ms | 3529 ms | **3312 ms** |

117 的图层锚点是“组合 51”，包含模糊图片背景。FIG 文件有 19,959 个节点、15 页；文字补测锚点为 `Whooops, that page is gone.`，截图确认 3200% 下实际显示文字轮廓。第一轮 FIG 锚点是 `21_404_Error` 画板，3200% 中心落在空白区域：其 838 ms 结果保留但**排除内容清晰度验收**，不能用它证明复杂区域快速清晰。

五次运行中，每次导入后与相机操作后的持久化文档完整 JSON 哈希均一致。752 节点的 117 与 19,959 节点的 FIG 原文件 SHA-256 运行前后保持一致。这证明本轮导航没有持久化改写文档；不证明外部格式像素完全等价，也不覆盖对象编辑/撤销验收。

## 117：计算热点与 GPU 等待已关联

首次 3200% 的 request 103 从 18:41:12.563 到 18:41:22.196 执行 9632.6 ms，排队等待为 0。20 个新瓦片均未命中，每片约 465–495 ms 依次到达。

- render Worker 累计约 3.331 s 活动采样、6.587 s idle；主线程约 9.582 s idle。主线程此时没有长任务，不能把整个 9.9 秒都归为主线程布局计算。
- CPU 调用链为 `streamIsolatedFilter → filterSource / paintOver → paint → imageGrid → materialField → image_sampling_axes_placed`。
- `materialField` inclusive 2.191 s；`linear_point` self 967.4 ms、`linear_axis` self 751.0 ms、`image_sampling_axes_placed` self 266.3 ms。`writeTexture` self 209.3 ms。父子 inclusive 时间重叠。
- 实际记录 **4420 次参数场构建、0 次命中、491,212,800 字节上传**。字段构建壁钟约 2102.1 ms，与 CPU 采样吻合。
- **189 次 admission fence 等待合计 6105.1 ms**，另 20 次 prefix scratch 等待 135.4 ms。它们是等待 GPU 队列完成的壁钟，不是精确 GPU 执行时间。不能把这些值再与包含它们的 graph 时间相加。
- 20 个超过 100 ms 的 admission 等待贡献 5089.9 ms，均为 `pressure=0`、`requiredBytes=0`。19 次记录 156 个 coordinate map 候选。这里的 156 是回收前候选数，不能写成当次销毁了 156 个资源。
- 总计 831 次命令提交、37,180 draw calls、约 37.97 亿 pass pixel visits。操作的计算/编码规模和资源等待同时偏大。
- prepare 暴露等待仅 35.6 ms；native sample 的 2221 个样本中 2184 个停在读输入。本场景没有证据支持“旧 native compile 占住队列是主要原因”。首次 preview request 102 因 compiler extent-area guard 快速失败，随后 tiled 103 完成；该 guard 也不能写成物理 OOM。

对应实现：[条带滤波](../../frontend/design-client/src/kernel/gpu/renderer.ts#L2267)、[图像坐标场](../../frontend/design-client/src/kernel/gpu/renderer.ts#L1268)、[缓存和上传](../../frontend/design-client/src/kernel/gpu/renderer.ts#L439)、[回收与等待](../../frontend/design-client/src/kernel/gpu/renderer.ts#L1712)、[Rust 轴字段](../../design-studio/crates/design-kernel/src/paint.rs#L593)。

## 为什么会有这么多重复计算

原 Sketch 背景 Image 为 1920×1080、blur radius=9.564871788024902、rotation=360。此次 32 倍缩放、DPR 2、精确模式内部再次 2 倍采样，使设备模糊半径变成 1224.3035888671875。514 像素输出瓦片的内部尺寸为 1028，支持区扩张到 3480×3480。

`streamIsolatedFilter` 将其分为 55 条、每条 64 行；每条 4 个 sample，就是 **220 个图像坐标字段/瓦片**。20 瓦片为 4400 个，每个字段 3480×2×RGBA32F=111360 字节，共 **489,984,000 字节**，与现场约 491.21 MB 很接近。剩余 1,228,800 字节恰等于另外 20 个各 61440 字节的字段；剩余字段的具体类型未单独确认。

缓存最多 64 项，因此 220−64=156，与现场 coordinate map 候选数吻合。这是本文件和本视图的数据闭合，不是所有设计都固定如此。

Rust 每次只生成一个 sample 的轴字段，却先对 4 个 sample 加中心共 5 个相位逐坐标验证首尾端点，之后再次计算当前 sample 输出。同一条带四个 sample 会重复四次这个证明。按成功分支尺寸推导，每字段约 11×(w+h) 次 `linear_axis`，每瓦片约 857 万次、20 瓦片约 1.71 亿次；这是源码推导，未插桩统计实际调用次数。`linear_axis` 还调用完整的 `linear_point`，同时计算 X/Y 后取一轴，解释了火焰图中该函数的宽度。

安全候选应优先评估：在同区域四个 sample 间复用完整证明；预计算不变量并做单轴计算；对整个滤波支持区证明可分离后复用完整轴字段，让条带读取子范围。保留现有 f64 运算顺序、端点位比较、contain 三态和失败后的 dense fallback，不能把 360° 的微小三角残差直接归零来换速度。

GPU 回收当前要求整个 coordinateMaps 集合为空才能走部分免等待证明，即便本轮最终仅回收已完成的 pool 项也可能被其他候选挡住。候选方向是先选出本轮真实回收集合，再按其 last-use epoch 判断是否需要等待。仍被 GPU 使用的纹理必须继续遵守完成边界，不能删除 fence 或提前覆盖上传。减少 CPU 证明工作本身不会消除所有 draw/pass 与等待。

以上只是有证据的优化切口，本轮没有实现或验收这些候选，也没有宣称预计调用量降低等于体验加速。

## FIG：导入主线程还有另一条计算链

FIG 两次采样导入分别约 11.41 s / 11.44 s，最大长任务约 3.51 s / 3.53 s。关闭采样与详细诊断后仍约 10.95 s，最大长任务 3.312 s，说明长停顿仍存在。

第一轮主线程约 5.02 s 活动样本，`prepareDocumentForEditing` inclusive 1.830 s，`kernelLayout` 856 ms，其中 `resolve_components` 约 721 ms；`native-preparation.serialize` inclusive 1.078 s。还包括 `captureDocument`、`validateDocument`、`augmentedDocumentJson`、JS→WASM 编码、Electron IPC 和 GC。第二次原始 profile 与火焰图另存，可对照重现。不要把父子时间相加，或把这里的导入结果冒称文档标签切换对照。

应分别检查 admission/layout/components 与跨边界整文档序列化的必要次数和主线程归属。此前 Worker 方案的总耗时回退问题仍需独立 A/B；本轮没有开启该候选。

## 验收边界与并行审查

下载目录原来的 `render-profile.json` 是 10 月 18 日阶段壁钟记录，没有 CPU 栈或构建身份，不能当作本次火焰图。它记录的 94 个渲染请求 P95 约 2.892 s，11 个拖动中间帧中位数约 406 ms，仅作历史背景。

本轮可确认最新构建真实打开两种文件、导航后文档未变、GPU 最终 ready、特定区域有截图和 CPU/原生采样；117 首次清晰化仍约 9.45 s，平移 rAF 间隔仍有尖峰。rAF 间隔不是 GPU 呈现或物理显示 FPS，且 117 平移尖峰期间未记录到 >50 ms 主线程 longtask，不能把所有间隔都强行归因于同步 JS 计算。没有 Figma 同机同操作对照、90/120 个真实内容帧验收、完整对象拖动/编辑/撤销回归、像素 oracle 或全部 15 页切换验收。

只读并行审查确认设置入口、页面保留/切换、属性/图层逐字段事务、全应用国际化、MCP 实际 socket/外部客户端仍各有未闭环范围；没有因为本轮渲染结果把这些标为完成。应继续按 [开发合同](../../docs/DEVELOPMENT_CONTRACT_V1.md) 和 [仓库技能](../../.agents/skills/futureox-design-development/SKILL.md) 分别验收。

## 复现

从仓库根目录先完成 release 构建，再串行运行；输出目录必须不存在。

```sh
(cd frontend/design-desktop && node scripts/build.mjs --release)
node testing/verification-real-electron-flames-20261020/run.mjs "$HOME/Downloads/117.sketch" /absolute/new-output
DESIGN_CPU_PROFILE=0 node testing/verification-real-electron-flames-20261020/run.mjs "$HOME/Downloads/117.sketch" /absolute/new-control-output
DESIGN_ANCHOR_TEXT='Whooops, that page is gone.' node testing/verification-real-electron-flames-20261020/run.mjs "$HOME/Downloads/01有料素材 (Copy) (1).fig" /absolute/new-fig-output
node testing/verification-real-electron-flames-20261020/analyze.mjs /absolute/new-output
```

本轮带名字模块与实际 WASM 的字节一致性校验已记录。重新构建成不同 WASM 时，应重新生成并核验名称表；分析脚本会校验当前运行身份，禁止套用旧名字或新 source map 到旧 profile。临时用户目录含导入文档和应用缓存，由本目录 `.gitignore` 排除，不应纳入源码增量。
