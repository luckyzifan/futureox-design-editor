---
name: futureox-rendering-first
description: Plan, implement, benchmark, review, or package Futureox Design Core rendering, canvas interaction, Rust kernel, and game-art editor increments. Use to enforce rendering-first priority and evidence gates in this repository; not as a claim that an existing candidate has passed.
---

2026-11-02 [选区、框选与测距](../../../testing/verification-figma-canvas-chrome-marquee-20261102/README.md)只改选区描边、悬停、框选和 Option 间距。悬停轮廓和框选边跟选区一样，是整像素上的 1px `#4597F7` 实色填充。框选填充是 `#DCE9F5`，间距红是 `#E05634`。不改光栅、瓦片或预算。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [画布操作对照：编组与右键](../../../testing/verification-figma-canvas-ops-group-menu-20261102/README.md)只改编组命中已经具备的路径上的右键菜单：无描边矩形仍列出轮廓化描边，插件子菜单打开现有插件面板。空选区方向键不平移，空格拖动不移动对象。不改像素、瓦片或预算。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 打包的 FFmpeg 只服务动效预览编码，不改像素、瓦片或预算。33/100ms 与完整 G2/G5 仍未通过。见[记录](../../../testing/verification-ffmpeg-bundle-20261102/README.md)。
2026-11-02 [原型播放](../../../testing/verification-playback-plugins-import-20261102/README.md)只改原型预览合成：溶解不逐帧重采样，中间帧把玻璃和模糊封顶，落定帧仍是原稿。不改编辑器光栅、瓦片或预算。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [画布呈现续](../../../testing/verification-canvas-render-continuity-20261102/README.md)旋转之后的快速缩小不再用更紧的完成帧换掉宽画面，CPU 选区跟实时相机。缩小后的 CPU 帧若盖住更多画面就留下。合成预算和光晕不再换成整帧红字。旋转进行中的蓝框留在当前纹理上。文件锁期间的标签继续排队。不放宽预算。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [画布操作对照：粘贴与展平](../../../testing/verification-figma-canvas-ops-paste-20261102/README.md)只改粘贴父级、实例旋转和混选展平。Shift+E 在设计模式仍开原型。不改像素、瓦片或预算。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [画布操作对照续](../../../testing/verification-figma-canvas-ops-next-20261102/README.md)只改编组命中、Enter、空选区方向键和右键菜单。空选区方向键不平移。不改像素、瓦片或预算。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [画布操作对照](../../../testing/verification-figma-canvas-ops-parity-20261102/README.md)只改命中、Option 拖动复制和键盘微移。子级实形选子级，画板空白选画板。不改像素、瓦片或预算。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 Electron 主线程缩放、拖动、打开 `.fig` 和多页里的单页编辑见[记录](../../../testing/verification-electron-perf-flame-20261102/README.md)。当前页改动不再整份重布局或重序列化；需要重排时只解当前根岛屿。损伤索引只覆盖这一页，视口瓦片仍按脏区相交丢掉。不改像素、瓦片预算或实验开关。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 选区、悬停和已选画板标题共用 `#3459d4`。单选是 2px 包围盒加 8px 手柄；多选另给每个对象 1px 轮廓，手柄只留在并集上。不改光栅、瓦片或预算。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 右键菜单在所有窗口宽度都是 `#2c2c2c`。不改光栅、瓦片或预算。
2026-11-02 拿掉「设计 API」浮块，并把右键菜单改成深色。不改光栅、瓦片或预算。
2026-11-02 [批量回归整合](../../../testing/verification-integrate-batch-20261102/README.md)只把功能分支合在一起，不改光栅默认、瓦片预算或实验开关。预览事务不再为每次缩放和拖动刷新整份图层面板。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 Electron 主线程缩放/拖动/打开 `.fig` 见[记录](../../../testing/verification-electron-perf-flame-20261102/README.md)。只少做整份文档 `JSON.stringify` 和预览期间的图层面板刷新，不改像素、瓦片、预算或实验开关。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [Electron SQLite 工作线程](../../../testing/verification-electron-sqlite-worker-20261102/README.md)只改桌面存储调度和主进程文档 JSON。不改光栅、瓦片、预算或实验开关。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 Local plugin auto-load does not change raster, tile, sticky pose, or compositing paths. It is not a 33/100ms or G2/G5 result. See [the note](../../../testing/verification-local-plugin-autoload-20261102/README.md).
2026-11-02 [界面暖色外壳](../../../testing/verification-ui-chrome-grok-20261102/README.md)不改光栅、瓦片、预算或实验开关。选择描边颜色未改。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [界面抛光](../../../testing/verification-ui-chrome-grok-20261102/README.md)不改光栅、瓦片、预算或实验开关。加载动效和智能动画热区淡入只作用在界面状态；帧间形变仍走既有内核动画计划，不覆盖画布像素，也不把预览当成精确完成。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [钢笔与橡皮](../../../testing/verification-pen-eraser-figma-20261102/README.md)只改矢量交互和橡皮预览。开放笔画保留未碰到的三次曲线；填充形状的减去结果来自展平轮廓。不改光栅、瓦片、预算或实验开关。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [钢笔、橡皮与跳转](../../../testing/verification-figma-pen-eraser-nav-20261102/README.md)只改输入、矢量草稿和视图命令。不改光栅、瓦片、预算或实验开关。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [Mac 桌面 Figma 呈现](../../../testing/verification-figma-mac-presentation-20261102/README.md)不改光栅、瓦片、预算或实验开关。玻璃、圆角和页面/画板标题是界面与交互。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [Figma 版面与测距](../../../testing/verification-figma-layout-chrome-20261102/README.md)不改光栅、玻璃着色器、圆角曲线、瓦片、预算或实验开关。测距和布尔插入是交互与布局。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [玻璃与圆角](../../../testing/verification-figma-glass-corners-20261102/README.md)只把零平滑、无网络的矩形/画板/分区玻璃扩到拟合后的四角半径。均匀半径的字段和 JSON 不变。平滑与其它形状仍走距离场。画布手柄不改光栅预算。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [色域与透明度](../../../testing/verification-color-gamut-opacity-20261102/README.md)不改光栅预算、瓦片导航或实验开关。8 位画布仍是 sRGB。Display P3 只在导出时换算并标记。图层透明度乘进填充、描边和阴影，不是渲染故障修复。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [.fd 往返](../../../testing/verification-fd-roundtrip-20261102/README.md)只改原生容器的数值变体和被忽略字段的保留。不改光栅、瓦片、预算或实验开关，也不是 33/100ms 或完整 G2/G5。
2026-11-02 [图层、属性与右键菜单](../../../testing/verification-figma-layers-properties-menu-20261102/README.md)只改检查器、图层面板和画布装饰。选中的画板标题和单个形状名称用 `#0d99ff`。旋转读数跟手，正值为顺时针，不改选择框与纹理的时序。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [画布操作对照](../../../testing/verification-figma-canvas-ops-20261102/README.md)画布旋转读数与检查器共用局部顺时针角。⌘V 与 Ctrl/⌘D 把普通图层加上 10。单角圆角画进填充。不改缩放覆盖、粘性仿射或 GPU 预算。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [画布基础操作对照](../../../testing/verification-figma-basic-ops-20261102/README.md)只改选择命中、双击/Enter 和框选提交。不改相机、瓦片、粘性仿射、缩放铺满或合成预算。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [字体目录与缺失替换](../../../testing/verification-font-parity-20261102/README.md)只增加字体枚举、字重匹配和确认后的替换。不改绘制预算、瓦片或实验开关，也不把字体覆盖说成 33/100ms 或完整 G2/G5。
2026-11-02 [Figma 文档模型](../../../testing/verification-figma-document-model-20261102/README.md)只补文档/页面/样式/组件集语义和保存往返，不解决渲染故障。瓦片、预算和实验开关未改。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [FIG 导入对照](../../../testing/verification-fig-import-parity-20261102/README.md)不解决渲染故障。反向堆叠、对齐、文字样式、切片、连接线和白板只改变导入结果。瓦片、缩放、预算和实验开关未改。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 [Web 与桌面对齐](../../../testing/verification-web-desktop-parity-20261102/README.md)不改光栅、瓦片、预算或实验开关。网页画布操作仍走共享 Editor 与 WASM 命中/吸附，不另建网页文档模型。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 Figma 风格 MCP 门面见 [FIGMA_MCP_FACADE.md](../../../docs/FIGMA_MCP_FACADE.md)。它只调用现有 Design API，不改光栅、瓦片或导航。`get_screenshot` 仍是 CPU 设计内容导出，不是 GPU 截图。33/100ms 与完整 G2/G5 未通过。
2026-11-02 [画布操作对照](../../../testing/verification-figma-canvas-ops-20261102/README.md)不改缩放覆盖、粘性仿射或标签缓存。选择拖动、旋转手柄、取整尺寸标签和创建填充是交互层。33/100ms 与完整 G2/G5 仍未通过。
2026-11-02 Figma plugin host does not change raster, tile, sticky pose, or compositing paths. It is not a 33/100ms or G2/G5 result. See [the plugin host note](../../../testing/verification-figma-plugin-host-20261102/README.md).
2026-11-02 大拓扑 Sketch 的 CPU 首屏见[记录](../../../testing/verification-large-topology-sketch-20261102/README.md)。整帧放不进合成账本时改为分块并留下填充和页面底色，不再返回空的红字帧。CPU 完整画板按屏幕瓦片交付位图。精确入口仍先报错。这不是 33/100ms 或完整 G2/G5。约 113MB 原件不在仓库内。
2026-11-02 [sRGB 标记与片段字距](../../../testing/verification-color-fonts-srgb-20261102/README.md)只补导出色彩标记和 FIG 片段字距/行高。画布 8 位交换链仍是 sRGB；无覆盖的文字行盒不变。不是渲染故障修复，不关闭 33/100ms 或完整 G2/G5。
2026-11-02 画布操作界面对照见[记录](../../../testing/verification-ui-chrome-figma-ops-20261102/README.md)。只改选择名称、创建预览描边、工具栏提示和面板入场，不改像素路径。面板不再以透明度 0 入场。33/100ms 与完整 G2/G5 仍未通过。

2026-11-02 [导入与传输对照](../../../testing/verification-interop-transfer-20261102/README.md)不解决渲染故障。浏览器 FIG 描边端点与阴影背后标记、原生 `LAYER_BLUR` 别名是导入保真；瓦片交付缓冲、缩放导航、预算和实验开关未改。33/100ms 与完整 G2/G5 仍未通过。

2026-11-02 低倍缩放连续覆盖与合成降级见[本轮记录](../../../testing/verification-zoom-coverage-budget-20261102/README.md)。低密度驻留不再取消连续性预览；同修订像素留在预览之上。合成预算或滤镜光晕超限时显示路径分块并丢掉放不下的效果，填充仍在。旋转进行中的选择框跟当前纹理，不先转。这不是 33/100ms 或完整 G2/G5。

2026-11-02 [失败复核与定向修复](../../../testing/verification-rendering-audit-20261102/README.md)确认重效果、松手精修、全源首屏和模板二 3200% 仍未关闭；旧队列两例现已通过。当前原生交互只保留仍需使用且 owner 有效的图片，保留压力 fence 和未使用图片原策略。已解析 authored preview 不走 transport null 归一化；布局差量保留私有回执及全局字段身份。约束仿射逐次验证准确固定点，Rust 无效果叶节点只撤销自身及祖先支撑，描边重算、共享/效果/源上下文回退。最终三文件拖动/旋转 12 组 held/settled/fresh 零差异、完整 authored Undo 恢复；动作矩阵仍有 FIG 松手 511/825ms 和拓扑 1.55/2.07s。计量排除 ready 后 QA 快照，不把暖采样或回执代理当物理显示；33/100ms 和全 G5 未通过。字段存储候选仅留验证补丁，未增加生产开关。

2026-11-01 [连续操作续轮](../../../testing/verification-fluid-canvas-20261101/README.md)保留白底、独立400%网格及自适应面板的真实UI验证。图片驻留的交互默认策略按ABBA收紧；完整画面、位姿和像素来源约束不变。局部旋转可降低工作量，但重效果仍有秒级尾延迟。发生像素差异的区域/内阴影裁剪没有默认采用；渐变字段窗口仍为独立候选。不得将这些结果说成所有操作丝滑或完整G2/G5通过。

2026-11-01 相机连续呈现修复见[本轮记录](../../../testing/verification-camera-continuity-20261101/README.md)。缺口占位和图像投影必须显式为预览，保留文档/页/session/chrome 与精确 ACK 边界。投影只用于 GPU 完成后原子交接的不可变图像；live canvas 的 CSS 双移失败须保留，不能用 DOM 延迟代替逐帧像素。可见/待交接图像计入原预算，64 命令分段和高水位观察保留资源 fence。GUI、DOM、ACK、精修各自报告，不关闭全源首屏或完整 G2/G5。

2026-11-01 局部自身滤镜拖动与源视口回访见[本轮验证](../../../testing/verification-local-drag-revisit-20261101/README.md)。已证明的单个自身滤镜前景可缩小捕获，保留完整描边/滤镜支撑，剪切、叠加滤镜及后续背景读取继续保守。原生完整源的精确请求回访缓存共享原 64 MiB 额度，最多 32 项；重新发布有效帧序号并按当前 ACK 重发资源，不缓存第二份文档。`CORE_SOURCE_REPLAY=0` 回退。117 新鲜静态呈现对照、拓扑实际回放与 Metal 浮点对照分别记录；33 ms 可见 P95、100 ms 全场景精修与完整 G2/G5 仍未关闭。

2026-11-01 后续[三项复用 A/B](../../../testing/verification-raster-reuse-ab-20261101/README.md)的描边蒙版、材质模板、程序身份候选及组合均未过5%速度门，保持隔离、不得描述为已默认启用。四相与像素逐位检查、HDR/精确入口分别通过。池化 driver 的 QA 包装必须恢复，计时阶段断言无QA像素返回；修正夹具后既有Gaussian自动选择四个命中视口约14.4%，替代旧速度口径，不代表全应用或完整G2/G5。

2026-11-01 拓扑模糊先测后合入见[本轮证据](../../../testing/verification-blur-ab-20261101/README.md)。仅普通 SDR Gaussian 的直接/前缀和自动选择默认开启，`VITE_DESIGN_GAUSSIAN_AUTO=0` 回退；保留原核、六遍、RGBA32F、四相、输出密度及预算，HDR/精确输出禁入。RGBA16F 未达到预定提速门；缩小工作面仅有局部/隔离证据，旧 regions/reduction 开关保持显式启用。初轮16.8%速度记录由上述补测替代；两项可在基线复现的GPU suite队列测试失败保留，不关闭完整G2/G5。

2026-10-30 的稀疏画布、源准备与实时像素修复见[本轮验证](../../../testing/verification-sparse-canvas-20261030/README.md)。实时捕获必须高于实际页面质量层级，不能用固定 layer 4：原精确 layer 5 曾遮挡已生成的新像素，渲染回执变快并未消除蓝框先动。必须保留真实截图负/正对照。FXSCENE4 共享完整图片/几何并保留原始 f64 位；两 CPU 转换槽按源序合并，单 GPU owner 不变。空白复用需完整源、同 owner/颜色/密度的实际 GPU texel 证明，白色 authored paint 仍保留。四采样子树/静态前缀与高斯分条均使用原预算；新实验准入与开关不整体放开。有界捕获扩展只保留 owner-valid 输出边界，最多一原生百万像素，不授予像素复用或完整性。截图会阻塞 IPC 回执，像素回放与无截图计时分开；冷启动、100 ms 精修、可见 P95、任意嵌套/HDR 覆盖及完整 G5 尚未关闭。


2026-10-29/30 的响应修复与真实长测见[本轮记录](../../../testing/verification-responsive-editor-20261029/README.md)。保留 parsed Sketch 导入的计数额度、最多两个 CPU 转换任务、原绘制顺序与单 GPU raster owner。嵌套保留仅扩展空的独立 pass-through 祖先；图片专用解码器只在同源证明及相同颜色/mip 政策下共享，变化时分离，不共享 CPU 全文档引擎。根拖动停滞/跳框已有实际截图对照；6912 次长平移属于 v3，最终解码器增量及三文件编辑回归分别记录。冷启动、3200% 模板二错误、约一秒提交精修、33/100ms、全部嵌套效果与完整 G5 仍未关闭，不得称全部方案完成。


2026-10-29 FIG/Sketch 格式修复及全源横向预取见[格式验证](../../../testing/verification-fig-sketch-interop-20261029/README.md)与[平移验证](../../../testing/verification-source-pan-20261029/README.md)。保留两条 FIG 实现的真实 schema 契约、原生文件往返与 portable 像素边界；outline 蒙版只在派生渲染中使用几何材料，原始字段不被改写。预取最多八块、两块一批、一个 raster owner，屏内呈现优先；dither key 只消去完整周期，渲染相机/分数相位不取整。真实局部 A/B 收益不能替代冷启动、复杂 GPU pass、33/100ms 或完整 G2/G5；未知转换仍须明确报告或拒绝。


2026-10-29 四相四附件候选见[实现与对照](../../../testing/verification-gpu-packed-coverage-20261029/README.md)。`VITE_DESIGN_PACKED_COVERAGE` 默认关闭，仅显式 `1` 启用；只对四张全新、私有且通过实际上传证明的 RGBA8 目标合并光栅化，缓存命中和非显示路径回退。sample-only 默认开启并保留显式 `0` 回退。算子及生产像素一致不等于生产提速或完整 G2/G5 通过；暖帧未获益，不推广默认开启。

The 2026-10-29 CPU raster increment shares checked scan conversion with GPU interval compilation, packs the four binary phases into one byte per pixel, and reuses one painter scratch arena. See [its scoped verification](../../../testing/verification-cpu-raster-20261029/README.md). Keep the original f64 intersection operation order, sample positions, flattening tolerance and HDR/color/effect arithmetic. Local active-edge repair retains stable tie order and falls back on complex crossings. Cancellation must run on empty scanlines too. Native/WASM checks and isolated raster benchmarks do not establish hardware GPU, whole-editor latency or full G2/G5 acceptance.

2026-10-29 用户授权评估模糊无需逐位精确，并要求以下载目录拓扑素材覆盖各种模糊，见[本轮记录](../../../testing/verification-canvas-blur-20261029/README.md)。SDR WebGPU 的 tent/Gaussian/阴影单通道及运动/缩放显示计算默认使用限定浮点路径，0 开关回退。保持原核、半径、采样坐标/数量、分条、四相和预算；HDR、显式精确输出及异常范围保留精确结果，大半径阴影仍需私有上传证明。原件数字 0/1 模糊启用标记局部兼容并保留。以预定显示误差门验收，不将低工作量视口、空白视口或算子提速当成全源同时渲染、全 G2/G5、33/100ms 或跨渲染器保真。

2026-10-29 的世界支持索引、不可变图片共享、源视口/任务控制抽离及回归修复见[实施记录](../../../testing/verification-sharp-refactor-20261029/README.md)。在原 64 MiB 共享缓存内先预留再构建，额度不足按精确身份缓存拒绝；未知光学/蒙版/描边保留旧路径。三份真实文件编辑保存导出已回归；native 首块配对改善不等于运动始终清晰。字段退休索引经同源码开关/浮点/生命周期对照默认启用，0 回退；严格 33/100ms 目标仍未达到，秒级新视口精修、完整 G5、跨渲染器保真与完整执行计划重构尚未关闭。


2026-10-27 用户明确要求全源单画板、取消产品容量上限。以[新容量契约](../../../docs/SOURCE_CANVAS_CAPACITY_20261027.zh-CN.md)区分源总量与内部任务粒度：显式堆帧源索引、完整布局目录、PNG 分行解码是已落地基础；全源单画板呈现已在真实 GUI 验证入口通过并接入工作区；直接全场景编辑和流畅交互验收尚未完成。旧页面分段交互不再是最终目标；保留精度、源所有权和物理设备检查，不能把未加载对象当作已渲染。



2026-10-26 源页面载入修复见[本轮记录](../../../testing/verification-source-page-load-20261026/README.md)：macOS 原生内存探测、显式页面分段与有界转换并行分别验收。保留归档/文档/GPU 预算，逐段覆盖全部源对象不能代替整页同时渲染或 G2/G5。
2026-10-27 文本/布局/原型/本地库续轮见[验证记录](../../../testing/verification-sketch-text-layout-flow-20261027/README.md)。原生字典往返、Rust 字形/光标语义、真实库覆盖更新和 GUI 各自验收；本机 Sketch 重渲染零差异不能替代跨渲染器字形像素一致，G2/G5 全矩阵仍未关闭。

# Futureox Design：渲染优先

2026-10-28 的精确绘制减量见[验证记录](../../../testing/verification-render-work-reduction-20261028/README.md)。连续纯色段与渐变填充/合成融合有默认入口和 `0` 回退；独立常量覆盖逐位一致且降低冷帧工作量，但热帧未达冻结的 5% 目标，继续仅 `1` 启用。旧实验开关保持原样。场景筛选跳过单个渐变机会和不可执行的批绘，保留四采样、合成邻域、浮点舍入和实际上传资源证明。诊断 v2 区分覆盖/填充/合成/效果/复制/解析，像素面积未测的 draw 明确标记。真实 117 全览收益不推广到局部视口、FIG 或完整 G2/G5；未达性能目标的场景仍单列。

2026-10-26 拓扑高倍缩放续轮见[证据记录](../../../testing/verification-topology-navigation-20261026/README.md)：偏移/描边阴影按完整支持范围分条；私有上传证明绑定系数、半径和实际 GPU 资源，写入即撤销。默认受限入口仅用于非 HDR 画布，原有全局实验开关、普通滤镜上限和全部内存预算不变。硬件逐位比较、GPU 完成等待、当前密度覆盖和输入到呈现分别记录；已测 3200% 视口通过不代表所有视口或全 G2/G5 已通过。

2026-10-26 局部材质失效优化见[真实文件记录](../../../testing/verification-local-edit-cache-20261026/README.md)：只在既有 Rust 材质证明成立时使用已解析布局计算脏区，嵌套蒙版限制到消费容器，背景依赖按页面/隔离边界传播。页面根蒙版、结构变化与相关未知光学读取继续保守失效。FIG 小蒙版重绘从 20 块降为 1 块；117 大蒙版的减少绘制不等于端到端改善。性能受后台编译干扰的样本与截图叠层失配必须保留并分开报告，不以本轮关闭完整 G2/G5。

2026-10-26 大文件编辑续轮见[配对 GUI 记录](../../../testing/verification-large-edit-20261026/README.md)：取消已释放的首捕获、原生瓦片优先、完整工作集同步减少了重复绘制及交互中反复复制 52 MB 文档。完整源确认仍由既有 native full-load 提供，局部编辑仍增量，不放宽 receipt/CAS。保留真实 pointerup 与代理时间区别，约 16.6→6.7 秒仍不是即时编辑。维护检查与非零平移关联候选未采用；局部测试不能替代真实路径收益。

2026-10-26 的透明缺口、准入与取消修复见[本轮证据](../../../testing/verification-motion-continuity-20261025/README.md)。零透明、覆盖与原生密度不能证明对象及时跟随输入；保留旧帧也可能得到这些指标。宽整数精确滤波候选继续默认关闭，真实快速缩放与拓扑编辑收敛仍失败，不得把局部通过说成用户全部目标完成。

2026-10-25 的依赖范围、编译片段、准备取消、资源身份、调度、维护与批绘改动见[本轮记录](../../../testing/verification-render-pipeline-20261025/README.md)。局部精确像素和定向回归不自动关闭既有运动失败；保留默认关闭、无共享内存浏览器取消回退及未完成全 G5 的边界。

本 Skill 是项目工程规范，不授予额外操作权限，也不把设计目标当成已实现功能。

## 先读哪些规则

- 每次本项目实现、性能复核或增量交付，先读[渲染优先工程与验收规范](../../../docs/RENDERING_FIRST_ENGINEERING_CONTRACT.zh-CN.md)。它是以下门槛、矩阵与证据字段的唯一详细定义。
- 涉及架构、存储、文档或平台边界，再读[现有开发 Skill](../futureox-design-development/SKILL.md)和[v1 开发契约](../../../docs/DEVELOPMENT_CONTRACT_V1.md)。新规范确定优先级，不撤销既有精度、所有权、默认关闭或安全边界。

## 决策规则

1. 渲染体验是 No.1。模糊、白板、3200% 缩回、快速反向缩放、旋转、拖动、resize、紫色选择框同步和连续编辑不冻结优先于新增美术功能。按规范 G0/G2 的实际故障清单与真实应用回放验收，不能用“已加缓存”代替问题消失。
2. Rust 承担主要领域逻辑与权威语义；UI 负责输入、交互状态和展示。按 G1 给出 UI → Rust/WASM/native → 提交/渲染的实际调用与产物证据。现有 TS/GPU 适配层不是再建第二套业务核心的理由，也不应为形式上的迁移扩大本轮风险。
3. 保持现有精度、HDR/浮点、export、persistence、撤销重做和文档语义。G3 不通过时性能收益无效；不靠抬预算、删 guard、降效果/分辨率、跳过错误或复用过期画面“通过”。未验实验继续默认关闭。
4. 优化主 CPU 必须测真实生产热路径。G4 区分真实 117、十份真实导入、固定规模场景与小合成；分别标注 CPU、mock、software GPU、GUI、hardware GPU，以及 wall、提交 ACK、GPU 完成、真实像素。只报告测得的层级。
5. 使用 G5 固定矩阵：300/3000/20000 纯矢量与重效果六格；100 图标各自按 1/2/3 倍导出，修改后重复；真实 117 和十份副本另列。不可把缺失、拒绝、跳过或未执行的格子算通过。
6. 按 G6/G7 绑定来源、构建、配置、hash、真实 oracle、旧失败新通过及取消/晚回/压力证据。测试命中真实改动路径；输入 ACK 不证明像素呈现，CPU/mock 不替代硬件与 GUI 门。
7. 独立工作可并行，但构建/测试并发受明确资源上界约束，性能 A/B 不与重负载争用。协作接口保留 ID、操作、版本、幂等与快照/增量边界；按 G8 验证，不在渲染热路径等待网络、持久化或全量序列化。
8. 六项游戏美术能力及 VectorCraft 启发项属于 G9 后续范围：核心在 Rust，右侧面板直接编辑当前画布，必须闭合撤销/保存/导出链路。PSD/ABR 明确排除；参考源码不等于许可已核或产品能力已验证。
9. 增量交付遵循 G10：仅新增/变化文件及相关测试、精确前置 hash、文件清单、回滚和未验边界；不改已发布包、不发空包、不复制无关仓库。文档检查通过只能叫文档检查通过。

## 执行与报告

开始前写明本轮解决的渲染故障、受影响门槛、冻结基线、测试环境及停止/取消边界。运行前冻结场景、oracle、阈值和配置；阈值缺失时明确 BLOCKED，不事后放宽。

修改后优先给出：本轮改了什么；哪些 G 门已实测；哪些 FAIL/BLOCKED/NOT_RUN；证据与源码/产物 hash；下一步尚缺什么。全应用完成声明须满足规范的联合判定，单项候选只报告自身已证明范围。

- 4 GiB 大源文件与调度隔离的边界见[本机验证记录](../../../testing/verification-large-document-4gib-20261023/README.md)：完整源字节留在磁盘，局部画布仍使用现有 Editor/Rust/WASM；原生流式导入、导出、后台保存延迟和真实 GUI 像素必须分别报告，不能以展开容量替代全图渲染验收。

- 2026-10-23 的 0246 / 0741 / 1338 组合增量见[合并验证记录](../../../testing/verification-increment-0741-1338-20261023/README.md)。精确滤波、managed 背景入口和空场景 compose 候选保持默认关闭；源码和 mock 测试不替代真实硬件、全编辑器或导出/HDR 门。

- 2026-10-24 拓扑素材修复的真实 GUI、完整归档字节核对、硬件浮点对照及分段火焰图见[验证记录](../../../testing/verification-topology-repairs-20261023/README.md)。保留早期能显示但 winding 不一致的失败候选；最终 dense 工作容差收紧后真实几何 oracle 才通过。无采样重放 uiStalls=0 只证明该轮素材操作，不能替代完整 G2/G5、物理显示或退出协议验收。

- 2026-10-28 全源画布有限流水线最多两瓦片一批，复用既有单个提前准备任务与单 GPU raster owner。组合拓扑指定视口中位改善 7.68%，同层像素一致；117 收益较小。见[本轮证据](../../../testing/verification-bounded-source-pipeline-20261028/README.md)。速度绑定冻结构建，不覆盖后续并行 GPU 改动，也不关闭全 G2/G5。

2026-10-29 场景运行时第三模块见[模块记录](../../../testing/verification-scene-runtime-20261029/module-3/README.md)。原生源画布编译入口使用只读、已解析的需求视图，完整源仍作权威和回退。区分输出需求、舞台边界元数据、整页准备边距与实际编译读取范围；传输资源ID分配前闭合需求。保留原四采样、精度/预算、派生ID和取消边界。节点输入减少不等于首屏按需、冷数据驱逐或33/100ms达标；包字段/浮点位对照是CPU证据，Electron/GPU/G5仍在最终整合阶段。

第三模块真实 Electron 续测发现全览资源缓存阻塞局部需求、且完整回退重复清空几何缓存，见[回归与修复](../../../testing/verification-scene-runtime-20261029/electron-final/README.md)。交接仅回收可重建保留量，保持 scope/ID 与原预算。局部原生编译改善不能覆盖约 66 秒导入准备、全览绘制调用膨胀或秒级精修；33/100ms 仍未通过。
