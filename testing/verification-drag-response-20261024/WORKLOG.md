# 平移与对象拖动迭代（2026-10-24）

本轮沿用 futureox-design-development / futureox-rendering-first，基线 HEAD 为 `3fa2b0a487477d00fcb905afb11a924bd3d4f13a`。独立 host 复制自用户 dev 产物，其构建输入全部匹配；位置见 baseline.json。只关闭由回放脚本创建的 Electron 实例。用户 dev 及其他任务服务不属于清理范围。

## 已定位

- `117-before-1`：960ms、60 次原生 mouseMove 的平移中，请求相机有 60 个位置，呈现相机仅 1 个；最大位置差约 197 CSS px。46 次 coverageDeferred；结束后细化等待 1761ms。
- 同轮对象拖动：第一份 isolated retained capture 已因小数像素姿态不可复用，仍先完成它再启动 native pose；结束后等待 2092ms。不能把旧完整帧或选择框的 ACK 算成对象像素跟手。
- `117-profile-before` 的主线程与 Worker CPU profile、对应 HTML 火焰图分开保存。Worker 热点包括图执行/绑定、图像范围认证、二进制节点解码；采样运行不参与无采样延迟 A/B。

## 当前候选

1. 首个不能复用的姿态立即撤销本 owner 的 isolated warmup，直接准备最新 exact pose。页面平移交接时先接纳经过 transforms-only 校验的 authored owner，避免 React 回调将新 sample 错当成旧编辑。
2. Rust 输出完整、未按 viewport 裁剪的保守页面绘制区域。仅同一物理密度、整数像素平移、同一私有内容 owner、同一文档修订的空白缺口，可从仍存活纹理中的实际背景 texel 补齐。未知范围、未绘制内容、混合 owner、改变密度/相位、grid/checker/透明等不授权补底。未删除完整覆盖门，也未提高预算。
3. 原生 source identity 与程序数组绑定；替换 geometry storage 后必须重新比较程序位，不能仅凭节点 ID 复用。

## 已执行与限制

- native-page-support-tests-3：原生未裁剪范围、相机位移、修订和透明/grid 拒绝测试通过。前两次失败（测试语法和未指定画布采样）保留。
- drag-tests-3：对象交接和 render-dependency 96 项通过。前两次测试记录保留；完整定向集合要在最终 WASM 上重跑。
- drag-typecheck-3：通过。
- background-hardware-3：非 fallback Apple Metal-3。12 组背景扩展与完整原生重渲染 RGBA 逐字节相同（analytic / figmaSubpixel，managed / unmanaged），Alpha 最低 255；4 组未绘制内容进入视口时拒绝提交。前两次 harness 失败保留，均不算通过。
- ../verification-render-core-20261024/core-frame-hardware-1：5 个实际 FIG/117/拓扑区域，WebGPU + WebGL2，旧 renderer + JSON oracle 对当前 renderer + FGSC cold/warm；60 次浮点读回，0 个 word 不同。它只证明这些区域的 transport/renderer 像素，没有证明 GUI 性能。

## 仍须完成

独立完整桌面编译后的 117/FIG/拓扑平移、对象移动、快速缩放、属性/撤销/重做/保存重开，以及逐帧真实 Alpha。完整覆盖只能证明无缺口，不能证明运动清晰。运动验收仍要求当前物理密度、无旧纹理放大；settled sharp=1 不代替运动通过。页面背景候选仅处理有证明的空白缺口，未绘制内容进入仍需尽快生成当前原生像素。

大文件改用正常 App/Editor 画板、源文件完整保存和页面切换尚未实现。架构整体、完整 G2/G5 尚未验收；不得把上述局部通过写成全部完成。


## 后续排查（跨 2026-10-25）

- 修正测量归属：最初 probe 的 `shown` 读到的是 Surface 的最后 settled camera，不能视为运动实际像素。GPU camera-submit 才是提交像素对应的相机，新的 probeVersion=2 同时记录 visual 与 settled。旧原始记录未覆盖。117-before-1 运动提交的不同位置为 18 个；after-5 为 44 个，背景扩展实际采用 29 次，已提交片段 maxUpscale=1。仍有相位不匹配和约 1.4 秒最终细化等待，不能写成运动完整通过。
- background-hardware-4 加入近整数小数移动后，旧内容重投影与全新重栅格并不逐位相同，首次观察为 unmanaged figmaSubpixel 340 byte。整数相位限制曾恢复，真实运行显示该限制因约 1.14e-13 的相位差拒绝背景扩展。
- background-hardware-5 使用明确的双重 oracle：已覆盖内容必须与原来的清屏/重投影控制逐字节相同；新增空白必须与完整原生重绘逐字节相同。所有像素通过，且原有 12 组整数位移仍与全新帧逐字节一致。近整数场景的 full-fresh 差异仍单独记录（unmanaged 340、managed 303），**没有声称 full-fresh 相位完全通过**。产品只新增已证明空白像素，未改变旧内容采样/精度；运动相位仍待修。
- 原生节点/几何复用证明与生产者数组绑定已加入，替换程序数组必须重新验证位。
- FIG diagnostic-4/after-5 对象拖动均只收到 6 个指针事件，结束后约 4.3–4.9 秒等待，FAIL。fig-profile-4/object-profile 火焰图：主线程活跃 1379ms，native-preparation serialize inclusive 526ms；Worker 747ms，主要包括二进制解码、原始快照解码、绑定和图执行。零位移保留原文档身份尚不足够。
- 当前继续移除 interaction-layers 中仅为隐藏根图层而克隆完整节点表的旧路径：前端传原文档和 gpuRoots，Rust 使用现有受限 COW snapshot + DocumentPatch 处理渲染范围，原文档不变；没有另建渲染器。native-root-scope-tests-1：作用域场景包与旧 hidden-document oracle 逐字节相同，源场景不变，非法根拒绝。还须硬件、完整编译及 GUI。
- 117/FIG/拓扑最终功能链、普通画板大文件入口、完整重构/G2/G5 均未完成。期间没有重启或结束用户 dev 或其他任务服务。

- root-scope-hardware-1：真实 5 区域两后端 60 次读回零差异。root-scope-tests-1 的 123 项及 typecheck 通过，完整 candidate-6 编译完成，但 FIG 仍仅 6 个指针事件，单独根范围迁移不能修首姿态的全量同步。
- 新的 interaction-document-source 私有证明由 transforms-only producer 创建，保持源文档引用并冻结候选节点表、变换副本。首次姿态可用原始 canvas receipt 派生，Worker 先核对真实源 receipt，再执行现有 native transforms 或经校验的 DocumentPatch；没有传全图。原始 canvas lane 保持不变。
- pose-source-tests-1/2 保留：旧 Worker fixture 绕过正式 module 初始化、模块 reset 造成 test 私有映射分裂、以及旧测试把不同 FGSC 生产者的资源字节当作同一个 scope 比较，分别修复。pose-source-tests-3：26 项真实边界/CPU 像素/PNG 与客户端所有权测试通过；其他 interaction 单测之前通过。pose-source-hardware-1：5 实际区域 60 次浮点硬件读回零差异，4 区域用 native pose，1 区域用既有通用 patch 回退。
- candidate-7 完整编译后，fig-after-7：60 个原生 mouseMove 期间记录到 60 个指针事件（前版 6），首帧 request 9 的 documentEnvelope=0、derivationAdmitted=1、fullPayloadBytes=0。第一个 capture 约输入后 627ms 完成，结束后等待 1145ms（candidate-6 4045ms）。仍有明显延迟，尚不算顺滑/运动完整通过。

- candidate-7 全应用功能：117-operations-7、fig-operations-7、sketch-operations-7 均通过编辑/撤销重做/保存/新实例重开。FIG/117 用 SQLite 完整模型及外部 FD 核对（导入副本 ID 单列）；拓扑三组用完整 Sketch 导出后重开。`uiStalls=0` 仅其原有 >250ms 采样阈值，不当作物理 FPS 或运动清晰通过。
- candidate-7 平移/拖动：117-after-7 结束后等待 pan 1332ms / object 1054ms，实际 visual camera 峰值差约 13.4 CSS px；fig-after-7 pan 567ms / object 1145ms，平移 visual 60 个位置；sketch-after-7b pan 176ms / object 686ms，控件完整页。sketch-after-7 首次脚本在索引完成前就搜索，已保留失败，改为等待索引完成后重跑。拓扑 pan 有 88 条 pointer 事件，不能直接按固定60事件作严格时间A/B。
- source-page-capacity-1 是独立原生转换探针：文件 831806447 展开字节、124399 索引对象，存储卷准入约 994.7GB，并非4GiB。浅色整页转换在累计149584122 serialized bytes、深色在134822024时超过当前134217728 live-document额度；控件整页1582926 bytes /773 nodes通过。没有抬额度。大文件普通画板集成需保留源文件/工作集语义，不能直接把入口改成全量加载后漏存冷数据。
- 当前新加 compact pending pose：在已有 capture 运行时只保留最新矩阵，直到消费时才构造节点字典。新 ownKeys 计数反例验证60次被合并输入期间不枚举全节点表；coalesced-pose-tests-1 139项及typecheck通过。尚待candidate-8 GUI/profile。

- fig-profile-8：UI active 1016.1ms（4版1378.9），Worker333.5ms（4版746.9），为采样阶段，不是无采样速度比。主线程新第一热点 Immer shallowCopy265.8ms，261.3ms来自 engine.previewFreeMove：无自动布局的自由画板也读取draft.nodes，造成每次输入复制整表。现先从不可变base读取需要调整的ids；无需要时不创建草稿，原有布局调整逻辑保留。free-move-tests-1：canvas-drop+interaction-editor-recovery两个实际文件39项通过（命令中另一指定文件不存在，未计入）。candidate-9完整编译通过，正在重复profile。
- source-page-capacity-1 探针正常关闭和SIGTERM均未退出；核对自有父子PID和私有profile后仅对该Electron主PID32997发SIGKILL。主PID、helper、backend及node探针均已消失。记录 source-page-probe-owned-cleanup.json，未触碰用户dev/其他任务。

- 117-zoom-default-9：固定160 native wheel，真实提交171，163 non-sharp，maxUpscale29.7847，surfaceRejected0；最大pipeline550.2ms，末事件到完成1162ms。未过运动清晰度。
- 重新单独试验 nativeNavigation=1 + exactClampPrefix=1，nativeVisibleTiles仍0。navigation-hardware-1：现有 regional math/reference 对 native painter/prefix，5区域两后端60次float word读回0差异。两套配置workingSetBudget均保持原1GiB，其他预算未改。
- navigation候选完整编译后117-zoom-native-1：仍有maxUpscale26.8896，160 wheel但末次接收到达比派发结束晚6266ms，整体显著恶化（默认9版1035ms）。候选不改默认、不宣称修好；当前正在对默认9版快速缩放抓真实UI/Worker火焰图定位输入积压。

- Chromium trace 117-zoom-chrome-9：dataLossOccurred=false；CrGpuMain 的 IOSurfaceImageBacking::WaitForCommandsToBeScheduled::Dawn 单次1948.74ms，577次累计2670.86ms。UI V8 sample 约498ms/5.58s，idle4805ms，program280ms，不是JS主线程整段忙等。精确技术参考 Chromium iosurface_image_backing.mm 与 DevTools Tracing.pdl，未把源码解释当作已修复证明。
- submit-before-yield 候选尝试在CPU让出前提交已编码工作。11项顺序/取消/lifetime逻辑检查通过；yield-hardware-1有60次逐位读回零差异、最多28次yield提交，确实执行了候选。
- 117-zoom-yield-trace-1性能 FAIL：maxUpscale仍29.7847；Dawn最大等待1429.11ms但累计4544.237ms，末输入接收延迟3795ms，比默认更差。已从生产renderer撤回该无效分支，测试实现留作本目录参考，不增加默认开关。

- 现有 bitmap/WebGL 显示适配器与同一 WebGPU raster producer 的对照：bitmap-hardware-1 harness未清除复用driver上的captureDisplay，缺bitmap；2版修正后 identity/integer-pan逐字节相同，但1.3倍重投影有517 byte差异，不能当作像素等价替代。3版试验显式highp sampler仍失败，已撤回无效shader改动。接下来的bitmap独立GUI只用来诊断Dawn阻塞归属，不是质量已验收的方案。

- display-device-hardware-1：第一组3个姿态零差异，随后测试重复使用GPUAdapter被当前Chromium拒绝；修改为每设备获取新adapter。display-device-hardware-2：真实5区域×opaque/transparent×identity/integer-pan/1.3x，共30组，ImageBitmap进入另一个WebGPU设备后与原resident显示逐字节一致。它与bitmap/WebGL缩放不等价的失败分开记录。
- 当前VITE_DESIGN_SEPARATE_PRESENT_DEVICE=1仅测试候选：原GpuRenderer/WebGpuDriver仍生成全部精确像素，现有ResidentPresenter在第二GPU设备上管理显示。产出ImageBitmap前等生产队列实际完成，不把长依赖送进显示队列。传输前按现有224MiB presenter ledger同时预留destination和bitmap峰值；copy后保留bitmap计费直到显示队列完成，预算未扩大。显示设备丢失会真实终止其生产设备，避免把仍在执行的资源误标成可释放。默认尚关闭。
- display-device-tests-1：28项包含峰值准入、异步退休、取消/失败、现有初始化边界，通过；typecheck通过。split-driver-hardware-1实际使用完整新driver实现，对原shared-device driver做30组逐字节对照全部通过；显式destroy显示设备也确认终止同一个driver的生产设备。待独立Electron性能回放。

- split-display-1整机Chrome trace：117固定160wheel，Dawn/IOSurface最长等待0.85ms、669次累计30.906ms、dataLossOccurred=false；原shared-device trace单次1948.74ms、累计2670.86ms。WebGPU生产数学、GPU/显示预算均未提高。window4480ms，末输入接收较派发结束晚441ms，工作集峰值201033216B，无surfaceRejected。maxUpscale仍29.7847、144/153提交non-sharp，故**不是无模糊通过**。下一步是组合原生密度导航，不能仅凭队列改善切默认。

- 硬件 harness 审计：factory 的 renderer 替换先前只替换第一个 type import，未替换运行时 import，旧记录中的“旧 renderer”标签不成立；原始 JSON/FGSC transport 及显式 driver 控制对照仍是其实际范围。现全部相关 runner 改为 replaceAll，并在新 opaque-batch-check 中断言 reference 不存在新方法、candidate 存在且实际产生批量 draw。hardware-1 注册次序失败；2 同路径对照不算验收；3 private parked driver 被参考桩污染而未命中候选，不算验收；4 真正旧 renderer 对新批量，6 次完整 117 RGBA32F 读回零 word 差异，参考 0 batch、候选 4 batch。

- opaque-batch-hardware-4/5：原旧 renderer 运行时身份断言成立，117 完整 1710×1672 视口 6 次 RGBA32F word 对照为零差异。参考 9847 draw、158025728 passPixels；候选 5355 draw、150171664 passPixels，四相位仍全部执行。root-scope-hardware-2 已用修正后的真实旧 renderer 对照，FIG/117/拓扑 5 区域×2后端×2路径×3=60 次零 word 差异。opaque-batch-tests-1 28项、Rust叶节点资格反例通过。GPU timestamp 探针有 skipped pass、时间重叠，仅用于热点定位，不将 pass ms 求和当 GPU wall。
- candidate-opaque-native-1 完整编译并使用独立 Electron。117-zoom-opaque-native-1：160可信wheel，末输入延后1ms，停手到收敛610ms，最大pipeline408.5ms，无准入拒绝，Dawn最长0.593ms；前组合split-native-1分别698ms/2306ms/680.5ms。仍 maxUpscale32、115/148 non-sharp，因此运动质量FAIL，不改默认开关。FIG平移638ms/对象836ms；117平移917ms/对象1064ms；拓扑控件平移183ms/对象781ms（停手至settled；不是物理呈现延迟）。FIG/117功能链编辑/undo/redo/SQLite保存/FD保存/新实例重开均通过，完整模型比较保留。
- 大源文件 UI 改造进行中：LargeDocumentWorkspace 保留源持久化 owner/保存/重索引职责，删除独立 Canvas/Inspector 页面布局，转为普通 App 的 sourceWorkspace 适配器；进入时自动载入第一画板，侧栏页面/画板导航保留全部冷数据。普通 FD/DesktopSession、browser autosave、startup-preview 与外部局部文档隔离，关闭/保存仍经源 owner。新挂载 App 存储隔离及原操作检查25项通过；源并发修复后17项通过。尚不代表 Sketch 所有语义或结构编辑已支持。
- sketch-workbench-1真实首测FAIL：自动首画板载入与侧栏children列表同时占用源通道，宿主返回 Another file operation is in progress。未吞掉错误；已让列表effect等待busy=false，并加入原生通道互斥反例。candidate-source-workbench-2正在完整编译，尚待真实复测；第1版失败截图和记录保留。

- sketch-workbench-2：真实自动载入及编辑已进入普通App，测试在旧canvas内查询zoom控件超时；普通App将zoom放在Inspector，此为harness定位失败，保留记录。修正选择器后sketch-workbench-3全部三组改名/opacity/undo/redo/zoom/save/full export/新实例重开通过，直接入画板截图已人工查看；uiStalls=0只指>250ms采样口径。导出119392758B；streaming archive验证64成员中63逐字节不变，变化页仅预期3名称+3opacity，unexpected=[]，原始输入SHA不变。
- 移除无人调用的LargeDocumentDialog及其旧独立JSON/Canvas布局与对应旧UI测试，原生source/property/subtree API和源storage fence测试保留。普通App源存储隔离及late-reply/source-lane检查继续通过；27项workbench/phase/batch定向检查通过。新增首次保留像素相位撤销诊断，只测量，不放宽整数/精度准入。source-workbench-3完整编译正在运行。

- 117-phase-diagnostic-1仍有object约1s收敛；初版相位诊断错误地使用只在Worker设置的gpuSink，因此UI并未记录新字段，不能拿缺日志当相位未拒绝。已改为通过现有KernelClient的主线程viewport诊断通道传递，尚待新编译回放。

- 相位诊断：2版主线程字段已到达，但标量清洗误将浮点误差作为整数而剔除；3版修正并验证边界。117-phase-diagnostic-3第一对象移动 retainedPhaseError=0.3870967741935485，40个轴/居民检查；不是约1e-14误差，不能放宽相位精度门。后续undo/redo约0.32258。该对象回放仍约1125ms收敛。
- sketch-zoom-workbench-1：普通App控件页，独立前台160wheel、85张PNG运动帧；coverage最小1、无准入拒绝，但118/151non-sharp、maxUpscale7.5974、停手收敛775ms；运动清晰度FAIL。
- 小半径前缀诊断 small-prefix-hardware-1/2 未修改生产阈值：测试副本把启用成本阈值32改8，准备了原精确prefix，但所有实际kernel都被现有原始系数边界拒绝，0真正prefix工作。实际r=8.872759199349778、17.062998120031647、13.914602405530974、7.166459387346612均prefixRationalUnsupported=true。不能把阈值试验视为优化。
- 当前新候选 VITE_DESIGN_CERTIFIED_TENT_PREFIX=1 默认关闭：保留原始f64半径/原系数，Q64整数区间prefix，只有两端RNE到相同有限f32才返回，否则原完整rational滤镜。利用既有4MiB scratch，无新增预算。只在8..32、RGB(A)已有精确几何支持路径试验；Rust scene_plan标记可能的小滤镜，driver将实际上传的B/C系数与Rust重新生成的完整字节核对，私有资源身份绑定并在写入/销毁后撤销。32项上传/旧prefix边界检查通过；Rust对独立44-word完整rational oracle的signed/HDR/subnormal/边界/不确定拒绝检查通过（首轮Rust测试语法失败保留）。
- certified-prefix-hardware-1：真实117完整视口6次word零差异，候选实际14个interval pass、21150条GPU准入行和126拒绝行；但warm finish约489–499ms，控制约452–457ms，性能FAIL。2版将2^64分母的通用除法改为精确guard/sticky dyadic RNE，仍零word差异，warm finish约473–476ms对427–458ms，仍未胜出。行准入统计不是每像素区间接受统计。尚未编译此interval候选到完整Electron，尚未推广默认。
- 下一假设（尚未实现）：8..32交叉成本不利，测试实测重效果中>=32的大半径；将Q64线性系数/中间量的位宽证明收进Rust并与实际C上传绑定，避免每行重复检查，保留固定128位运算和旧精确回退。必须先CPU/general-rational oracle、硬件逐位，再完整Electron；若无收益撤回，不堆无效分支。

- interval prefix 已收窄为实测成本更合适的32..512，未改变既有滤镜半径guard。完整Q64字节和中间量界由Rust RationalKernel计算/校验，WASM返回小型位宽计划；TS仅将证明绑定实际上传的系数资源、维度和原始f64半径，在写入/销毁后撤销。GPU只接受同一私有B/C对，按原4MiB scratch编码，有限/跨度/整数128位/两端相同f32位检查保留。不确定仍回原精确滤镜。去掉不再需要的小半径scene_plan特性位，原native拓扑/依赖准备机制复用。
- certified-prefix-rust-tests-3通过：独立44-word通用精确卷积oracle覆盖8..512实半径、正负/HDR/subnormal/宽范围/NaN拒绝/零边缘及clamp；32项上传证书和原prefix资源边界测试、tsc通过。
- certified-prefix-heavy-hardware-1：两个真实117重效果区域12次RGBA32F读回零word差异，实际候选19/30个interval pass。暖控制finish为46.9/48.5ms及130.6/134.8ms，候选20.9/20.9ms及69.6/73.6ms；编码passPixels仍分别8623965和47566953，GPU求和工作减少，不伪造像素访问统计。峰值账本与同区域控制一致，预算未提高。
- certified-prefix-edges-hardware-1前16例通过，第17例NaN被既有材质参数上传边界拒绝，属于测试夹具错误，未放宽产品准入。2版用有效上传后写入并撤销证书的实际GPU表面表示非有限中间结果；120组×2=240次真实WebGPU读回全部零word差异，包括梯度、正负HDR、subnormal、宽动态范围、非有限中间值、H/V和clamp、32..512半径。
- candidate-certified-prefix-1完整桌面编译进行中；interval候选尚未经过全应用重测，默认仍关闭。此前source-workbench-3普通画板/完整归档通过不代替这次新GPU组合验收。

- 完整CF组合首轮117标准160wheel：117-zoom-certified-prefix-1仍maxUpscale32，收敛635ms，未解决运动清晰度。新同源control/candidate通过实际zoom输入及普通wheel平移，定位旧日志重效果tile的世界中心(-49.89876855195723,944.3417545022604)，并记录实际相机。注意旧117-revision-3与当前原始导入有52个constraints/transform和1个width/height差异，硬件oracle仍是同输入前后优化，不能把旧snapshot当当前导入完整身份。
- 117-heavy-zoom-control-1 / candidate-1均未通过：真实failure-origin记录mode28申请7718400B时账本1068139712B对1073741824B；约739546320B/99个free池资源仍属used/pending，busy仅约290521296B。候选恢复时发生50次compile/graph与1次fallback；恢复成功不代表无错误或优化已通过。候选per-pass日志证明确实执行757个interval pass（运动窗口595），但该轮aggregate maxPipeline=0属于回退结果统计覆盖不足，不是零成本。
- 当前composition admission修复：普通drawNode、masked-group合成和相关copy/luminance/fill/stroke边界检查即将分配的目标；同尺寸池仍直接队列复用，异尺寸压力等原checkpoint覆盖后才能回收。mask合成原来的reclaimScratch(0)未看到下一目标需求，现使用reclaimForSurface。未删used/pinned保护或抬预算。53项含真实取消/拒绝完成/输入保护的CPU边界测试和tsc通过；两真实重效果区12次硬件word对照仍通过。正在做旧256MiB拒绝→新256MiB成功并对旧默认1GiB像素oracle的合成压力硬件回归，随后完整Electron重跑原拒绝现场。

- composition-pressure-hardware-1/2夹具schema字段错误、3版未提供匹配色彩空间，均不算通过。4版48组1024×768在旧默认1GiB也失败；5版20组默认成功但新256MiB仍失败；6版48组512×512，候选失败时busy仅26952416B、free240286412B，mode0，暴露延迟创建pass-through layer的copy也缺少下一分配准入。已补齐lazy layer、coverage copy和sample resolve前的需求检查；组完成后的蒙版现在按单相位路径同样退休，保持共享/祖先/输出保护。
- composition-pressure-hardware-7：冻结48组512×512、144节点；旧256MiB拒绝（busy50323632B/free217727124B），旧原有默认1GiB成功作为oracle；新256MiB完成、5次实际checkpoint、working249051676B，对1048576个f32 word零差异。预算是更低的测试压力额度，产品仍为原1GiB。84项renderer/admission/passthrough/painter检查、tsc通过。
- 回放脚本新增render-failures.mjs，按真实motion窗口保留非取消failure-origin/summary，即使recovered=1、UI错误标签已清除，也把该轮标成failed-render-recovery。旧记录保留，不把恢复当作通过。

- 117-heavy-zoom-admission-1 / diagnostic-2仍拒绝。运行时source map已核对，当前renderer确有14个prospective检查，非旧bundle。Worker console.debug不走现有主线程日志转发，新增仅独立测试用CDP Runtime console监听后，diagnostic-3取得真实栈：drawBackdropLeaf → run(27)。重要更正：surfaceAllocationTag把mode编码成mode+1，原记录的failureAllocationPassMode=28实际是shader27（背景模糊结果扩展），不是interpolate mode28。此前合成压力修复自身有效，但不覆盖这个原现场。render-failures现在同时记录modeTag和解码mode。
- 已补两处backdropConsumptionRect扩展前的真实目标准入。backdrop-expansion-tests-1的43项通过，包含滤镜完成后才增加池压力，以及取消/不确定完成时不得编码扩展或释放活跃输入。backdrop-expansion-hardware-1/2用当前真实导入的117原始模型及现场camera(1150.4590877196504,-4758.453497795737,5.92418313898363)，旧renderer提前完成池维护作为同1GiB像素oracle；当前按需维护成功并逐word相同。2版启用实际captureDisplay缓存契约，仍零差异。旧oracle提前维护只用于取精确参考，不当性能对照。完整backdrop-admission-2编译进行中，待真实拒绝现场重跑。

- 117-heavy-zoom-admission-2：同一普通UI定位和160可信wheel，renderFailures=[]，没有非取消failure-origin/恢复回退，foreground tile拒绝0，working峰值985698664B；标准原1GiB预算未变。coverage最小1，但maxUpscale12.4266、83/112non-sharp，停手收敛770ms；运动质量仍FAIL。不能把预算修复宣称为无模糊或整机更快。开始用此完整构建重跑FIG/117/拓扑编辑/保存链路。
- 仍待实现/验收：快速缩放持续当前密度、对象fractional-device相位的重绘速度、全面Sketch专有语义和结构保存、完整Rust图规划/薄TS执行边界、G2/G5全矩阵。后续构思的保留交互内opaque batching/IEEE恒等快速算术尚未修改生产代码，不当作已有修复。SourceWorkspace.openFile的失败回滚/跨源切换还需要专项生命周期验证；不能只靠当前三个文件的新实例成功链路宣称所有打开操作完整。

- backdrop-admission-2完整功能复测：FIG、117编辑/undo/redo/SQLite保存/FD保存/新实例重开通过；拓扑三组在普通App中编辑/保存/完整导出/重开通过，三个最终画板截图SHA与之前已验版本一致。
- 117-native-profile-admission-2仅采样本次Electron PID19019的两个实际后代19022/19138，未附加其他任务。原生design-prepare对象阶段3188个线程样本中显式read等待2816，非等待372；compile_gpu_scene 207、帧资源encode 117（包含去重与序列化），geometry preparation/flatten和area-program仍大。原生HTML火焰图及V8图已生成；采样不作为物理延迟或无采样速度比。
- FrameSceneContext当前优化缓存每个不可变资源键的随机域hash，HashMap扩容/插入/删除只hash 9字节descriptor，Eq仍逐字节比较。保持32MiB额度和原ID/LRU语义。强制digest碰撞、不同kind、实际几何word变化、重置/驱逐边界5项Rust检查通过（首轮测试语法失败保留）；新WASM已构建，正在对旧WASM做三真实文档15轮完整FGSC字节对照。尚未编译此hash改动到整机。
- identity-math/identity-viewport均为testing目录里的源加载候选，未改生产WGSL：8192个边界/随机输入对加乘的GPU结果零word差异，真实117六次完整readback也一致；暖finish约409–428ms对450–467ms，但候选首次shader构建约13秒，未接受、未推广。

- Frame hash最终也跳过无scope/不可缓存大资源的无用hash。Rust packet 5项再通过；新旧WASM三文档15轮完整字节一致，2个真实重区12硬件readback一致。frame-hash-1完整构建的真实原生采样：资源encode非等待115→87，整个进程非等待372→354，整体拖动仍约1秒收敛，不宣称端到端已解决。
- 现有VITE_DESIGN_DYNAMIC_UNIFORMS=1独立验收：15项绑定边界测试、uniform-viewport-hardware-1六次完整117输出和uniform-region-hardware-1五区域两后端60次输出均零word差异。暖绑定组创建5190→29，graph88→59.4ms；完整117采样仍约1044ms停手收敛。未改默认开关。
- candidate-uniform-1是当前最新完整组合构建。117-heavy-zoom-uniform-1：无非取消渲染失败、无前台瓦片拒绝、原预算下峰值985698664B，160可信wheel；该次停手收敛576ms、但仍maxUpscale12.4266/83个non-sharp提交，运动清晰度FAIL。
- uniform-functional-chain.json：最新组合FIG、117、拓扑3组的真实编辑/undo/redo/save/新实例重开全部退出0。final-fixture-identities.json确认三原始文件SHA与任务开始完全一致。当前导出归档完整差异检查进行中。整体架构、全面Sketch结构/专有语义、无模糊与G2/G5仍未完成，不做全部完成声明。

- 最新sketch-operations-uniform-1-archive完整归档复核退出0：64成员、63逐字节不变、仅预期6项语义变化、unexpected=[]。current-build-identity.json确认当前工作区构建输入与最新完整独立构建严格相同（sourceInputsMatch=true）。其他任务dev进程21463/21591及用户已有51786仍在运行。
