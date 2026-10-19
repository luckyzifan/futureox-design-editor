# 启动与渲染剩余热点审计

日期：2026-10-19。对象：`__DESIGN_REPO__` 当前累计交付工作树。只读审计，未修改产品代码，未运行新构建、CPU 基准、浏览器、GPU、套接字或远程测试。文中的历史实测只适用于其原有冻结来源；当前源码证据与历史耗时分开列出。以下顺序是建议投入顺序，不是已测得的硬件瓶颈排名。

## 结论

仍有明确优化空间。当前“初次打开慢”“手势中图像跟随”“停手后恢复精细画面”是三个不同问题：已交付的局部 CPU 优化不能证明整机流畅。优先处理首屏无关 JS、静态资源/内核装载、首帧前全文件图片预热；快速缩放则重点测量并缩短不可抢占的准备段和精修等待。不要靠降低最终采样、删除精确表或盲目增大缓存来换速度。

Web 与 Electron 也不是相同工作量：`kernel/render-policy.ts:31–55,74–84` 让 Electron 保留 `desktopFullMath`；Web 的部分 canvas displayFilters/figmaSubpixel 策略在桌面不启用。`native` GPU 是显式选择（同文件 57–65），Electron 的原生 preparation 是 CPU 准备路径（`kernel/client.ts:390–404`），不等于默认已经使用全原生 GPU。

## 1. 优先拆真正留在首屏的导出链

证据：
- `src/export.tsx:1` 顶层引入 `react-dom/server`。
- `ExportPanel.tsx:3`、`NodeExportPanel.tsx:1`、`clipboard-export.ts:1` 静态引入导出助手；`automation/export.ts:2` 静态引入 `svgSource`，由 `App.tsx:7–8,104` 等进入入口。因此只保留 `App.tsx:197` 的动态 import 不足以拆包。
- 留存的 `testing/verification-startup-imports/build-graph.after.json` 首屏入口含 `react-dom-server.browser.production.js` 的 renderedLength 239,435、`server-legacy.browser.production.js` 的 216,321。它们是 bundler 模块体长度，不是最终压缩下载量，也不能直接相加当成可节省字节。
- 同次冻结构建首屏静态 JS 仍为 1,455,886 bytes；之前的 path-network 提取仅减少 12,171 bytes，gzip 分块和减少 4,629 bytes。这是实际产物差异，不是启动耗时/FPS。

安全做法：把 `pdfVectorIssues`、`sliceExportTarget`、导出类型等同步纯助手移到轻模块；使 SVG 服务端渲染代码仅在真正导出时加载。还要处理 automation 的静态依赖和既有同步 API 契约，不能只改一个 import。设置、历史、原型、自动化面板可再按展示入口拆分。必须以生产依赖图和冷启动计时验收，不承诺未测得的节省值；完整 SVG 字符串、导出尺寸、顺序和错误行为须保持。

## 2. 内核与字体装载仍重，Electron 静态资源明确禁用缓存

证据：
- 当前 WASM 39,289,919 bytes，SHA256 `e002c8fe2efc46b09fed04bbc21404c5b7bdfb773e12081c41cfc004c824ea1b`；字体 17,772,300 bytes。
- 12 个精确数据文件合计 30,867,734 bytes，经 `texture_noise.rs`、`texture_noise/clip_weight.rs` 的 `include_bytes!` 引入。这不是可随便丢弃的调试数据。构建脚本默认 `release`，默认去 name section（`design-studio/scripts/build-web.py:105–108,125–129`）；历史性能交付的具体 WASM 使用 desktop-dev，不能混为默认配置。
- 主线程 `kernel/module.ts:13–23` 先完整读取，再新建 Uint8Array 副本、compile、异步 instantiate。`initialization.ts:76–97` 先累积 chunks 再合并。因此当前主线程路径没有下载/编译流水重叠，且有整文件临时副本。
- `picking.ts:98–116` 已把 WASM 与字体读取并行，但随后 `load_font` 仍是同步调用。`App.tsx:386–415` 的 ready/本地恢复依赖这条初始化。
- render worker 也初始化 WASM（`render-worker.ts:133–143`）；Web preparation worker 再初始化 WASM/font（`preparation-worker.ts:12–22`）。Electron preparation 使用 Rust 子进程，但 UI 与 render worker 的 WASM 仍在。不同 realm 的独立实例有代码证据；不能仅凭这些调用就断言浏览器实际重新下载/重新编译了几遍，浏览器内部缓存行为尚未测。
- Electron `frontend/design-desktop/src/main.mjs:920–937` 对应用资源逐次 `readFile`，统一返回 `Cache-Control: no-store`，包括 WASM/font。

安全做法：先为不可变打包资源建立内容版本键与明确失效规则，保留 CSP/路径白名单；Web 部署的压缩/缓存头需要实查，目前未知。评估有实际流字节上限、超时和发布所有权保护的流式编译；研究复用已编译 Module，分别计量编译收益与实例内存，不能声称 Module 共享等于 heap 共享。若进一步拆轻量编辑/资源内核，保留全部精确算法/表，加载失败不得悄悄换字体或降精度。不要把默认字体删减成只适用于测试文字的子集。

## 3. 大量图片导入后，首帧前等待整份文档缓存预热

证据：`render-worker.ts:196–224` 的 `warmImageCache` 扫所有节点的图片填充/描边，不按当前页、可见区域或实际像素格式过滤；对每个 URI 串行尝试 byte 和 linear 两个持久缓存。`539–546` 在 load_document 之后、首个 tile/frame 之前 await 整个过程。`decoded-image-cache.ts:4,38–50` 的内存缓存只有 64 MiB，可能发生读取尚未使用的图片又淘汰前面记录。已有持久缓存本身是优化，问题是预热顺序和首帧阻塞。

安全做法：只优先准备首屏真正依赖的图片和所需格式；其他页面/离屏内容按需或空闲预热，并在预算已无收益时停止。现有 `managedImageLoader` miss 会走同一确定性内核解码（154–177），保留该回退即可避免画质变化。需要把缓存 key/hash、持久读取、解码、上传分开计时；当前未实测该阶段占比。

## 4. 最新请求淘汰有效，但不能消除正在执行的长准备段

证据：
- `RenderMailbox` 已立即移除过期排队请求，明确保留正在运行的工作（`render-mailbox.ts:8–12,17–24`）。不能再把“无限积压旧相机”当成既有事实。
- Web preparation 串行 Promise 队列，调用同步 WASM（`preparation-worker.ts:31–60`）；Electron Node worker/Rust 子进程同样一条活跃请求（`frontend/design-desktop/src/preparation-worker.mjs:8–18,23–30,42–45`）。已开始的编译没有中途 cancel 协议。
- `PrepareAhead` 只投机一个 CPU job，但 `drain()` 等待它完成（`prepare-ahead.ts:3–22`）；tile 批次结束/取消仍 await drain（`render-worker.ts:951`）。旧结果不发布并不代表旧 CPU 工作不再消耗时间。
- GPU JS 编码已在适当检查点按约 4 ms 让显示消息运行（`gpu/encode-yield.ts:7–19`、`gpu/renderer.ts:146–149`）；tile 完成后让控制与更高优先级交互通过（`render-worker.ts:935–946`）。不能说 GPU worker 完全不让步。
- `tile-scheduler.ts:315–324` 的可见 tile 整批提交且预算豁免；16 ms / 两 tile 是调度策略，不能当作真实 GPU 帧时限。

安全做法：先统计最新输入等待哪个活跃 job、取消后浪费的 prepare 毫秒、单 tile 最坏时长；在 preparation 协议加代际淘汰/优先级只对尚未开始的纯编译生效，文档变更仍保持严格顺序。较深改造是可恢复、分段的精确几何准备；每段保持原运算与顺序，提交只接受完整且当前的快照。单纯缩短定时器、增开多个大内核线程或频繁重启线程可能使工作放大、内存变差。

## 5. 缩放精修默认仍等 160 ms，不能把瞬时预览当最终细节

证据：`navigation-zoom.ts:6–7,55–68` 默认 sample/quiet 都是 160 ms；`use-navigation-zoom.ts:14,18` 未启用 adaptiveQuiet。`ProgressiveSurface.tsx:976–1021` 手势中复用覆盖或用有界预览；精确 native-density 工作在 settle 后继续。平移不进入该 quiet-window 策略。

历史 `verification-latest-navigation/README.md`：默认精修 admission P95 183.33 → 166.67 ms，约一帧提前，工作量不变。实验曾出现短突发 13 次预览+13 次精修，对照 9+1；修正实验也仍有额外精修取舍，默认未启用。因此感觉“停下还要清晰起来”有调度上的依据，但 160 ms 不是 pointer-to-photon 测量，也不证明相机显示只有 6 FPS。

安全做法：分别验收相机显示延迟、首次细节时间、全视口精修时间，再决定是否启用自适应 settle。必须加入快完成的重复短 burst、反向缩放、停顿恢复，检查已完成的真实工作总量；不能只用卡住一个 worker 的测试证明没有放大。

## 6. 导入已经在线程中解析，但主线程接纳/布局/序列化仍可能长阻塞

证据：
- `.fig/.sketch` 已走专用可取消 worker，原始 bytes transferable（`persistence.ts:25–32`、`import-file-worker.ts:13,40–64`）。Sketch worker 另初始化完整 WASM（`import-worker.ts:16–22`）；每次完成即销毁，有取消/回收价值，不能粗暴改成永驻而不设内存边界。
- 结果回主线程仍 validateDocument（`import-file-worker.ts:15`）。`document-admission.ts:4–12,23–26` 对全文件 stringify、UTF-8 计数、parse、校验；`picking.ts:124–135` 做布局后又进行 Rust 校验。复杂 components/layout 会同步 stringify→WASM→parse（336–359）。
- Web `App.tsx:486–500` 多次全文件 JSON 比较，prepared snapshot 会 structuredClone（`prepared-document.ts:10–15`）；Electron 已将 codec 移到原生 worker，但 `desktop-session.ts:473–478` 的 prepareDocumentForEditing 仍在 renderer。
- 编辑预览 `engine.ts:495–517` 仍有 nodes 拷贝、特性扫描和 layout；`Canvas.tsx:516–519,565,673–674` 在 document 身份变化后重建 scene/index 或 overview。纯相机变更有 useMemo，面板也已有 camera-independent snapshot（engine 274–287），Layers 已虚拟化（Layers 259–260），不应再次建议这些“尚未实现”。

安全做法：为接纳/布局/存储/首次 scene 建立阶段标记；把重复遍历与序列化改成同一不可变已验证快照/事务内复用，不能取消信任边界校验或可恢复存储保证。进一步异步化 layout 需保持主线程命中/几何、撤销、IME 和文档代际一致；这是较大架构项，不是一个 await 能解决。

## 次优先：精确缓存与内存

- 精确 camera/phase 是正确性条件。Rust `gpu.rs:114–119,1220–1247,1311–1363` 对新相机或缺失 guard 会重新准备，保留当前+最多四个 inactive camera，inactive 合计 64 MiB（134–155）。可优化文档级索引、相机无关几何/元数据、retained_bytes 全遍历（75–79），但不应去掉精确相机键或拿错误像素冒充命中。
- `composite-draw-plan.ts:89–94` 仍成对测试遮挡，最坏仍二次；已消除 flatMap 分配。历史 135 tile CPU planner 已从约 1.5 ms 降至约 0.046 ms，256 tile 约 0.15 ms；未有新证据前，不该把空间索引再优化排在首帧装载、长编译或图片预热前。
- 现有 display 128–512 MiB、renderer 工作集、32 MiB packet、64 MiB decoded-image、Rust inactive-camera 等是不同账本，不等于一个统一进程上限。预取已有最多八 tile/字节上限（pan-prefetch.ts:6–8,35–38），空闲 overview 已避开选区并可取消（ProgressiveSurface 1282–1286）。先看跨账本峰值、缓存命中/淘汰和 CPU payload 副本，再调整预算；无条件加缓存会恶化低内存设备。

## 已证实的进展及严格边界

- Inspector 3,000 选择：既有 ABBA 主线程 CPU 挂载约 24.7–26.0 秒 → 97–99 ms；父索引遍历 36,002 → 3。不是文件打开/FPS。来源：`verification-performance-editor/README.md`。
- 3,000 根节点的交互包围盒准备：访问量 18,000,000 → 9,000，独立 CPU 中位数 201.67 → 9.16 ms；不是完整预热/GPU。来源：`verification-performance-viewport/README.md`。
- Rust 3,000/10,000 节点 transform invalidation 清洁配对显著下降；编译、快速 camera cycle 并无稳定一致提升，报告保留回退值。来源：`verification-performance-rust/report.md`、`comparison-clean.json`。不能只挑快的一段声称整个渲染器已提升。
- compositor CPU planner、minimap 移除、SVG 首屏闭包瘦身均已有专项证明；硬件 FPS 和 Web/Electron 输入到显示延迟仍未验收。

## 下一轮必要验收

1. 固定交付源码/二进制/字体哈希、构建 profile、实际 backend、DPR、屏幕刷新率与电源模式。Web/Electron 分开，冷缓存/热缓存分开，已有缓存与首次导入分开。
2. 启动：JS 网络/解析/执行，WASM 读取/compile/instantiate，font load，native boot，文件解析，主线程接纳/layout，存储，图片预热，首包准备，shader/pipeline，上传，首次真实显示与首个完整精细视口。阶段并行必须呈现时间线，不能相加冒充总延迟。
3. 3,000 与 10,000 节点，并包含真实复杂导入图、图像、文字、clip/mask；平移、连续缩放、反向缩放、重复短 burst，10%/100%/400%/3200%。记录 P50/P95/P99 输入到显示、长任务、空白覆盖、精修等待、实际完成/废弃工作数与峰值内存。
4. 每项优化同时保存完整包/CPU 精确输出、顺序、float bit、phase/gutter 和取消所有权回归；有硬件权限后再做 GPU 像素/截图差分。现有 CPU/driver double 不能代替 GPU。背景模糊与 .fig/.sketch 保真另有专项审计，本报告不越界得出其视觉正确性结论。

当前限制是缺少授权的真实显示链路验证，不是已经证明 GPU 快或慢。本轮没有尝试绕开该限制。
