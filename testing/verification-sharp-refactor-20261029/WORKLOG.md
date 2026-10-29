# 实施中记录

- 用户要求实现全部上述优化、可重构、本地Electron回归117.sketch/拓扑素材.sketch/FIG，并以移动缩放清晰且极快为目标。速度P95<=50ms、停手<=150ms等已异步询问，尚未收到答复；不因此停实现。
- 基线=/tmp/futureox-render-sharp-20261029-base，候选=/tmp/futureox-render-sharp-20261029-work/source。主工作树运行时代码尚未由本任务修改，最终必须按baseline逐文件hash合入，不覆盖别人变化。
- 基线sourceDigest72c63406e76d775a057cde77f6eccbd6a51160a831fb7cb687df147a581ce432与已有candidate2一致，native/WASM已记录精确复用。
- 已实现候选：Rust geometry_support提前读取原曲线控制范围，避免离屏网络/path展开；source-render-work和source-viewport-plan从NativeSourceSurface拆出（保留两块、真实请求释放和ACK）；Paint.image改Arc<str>共享不可变payload，JSON/FD语义不变；PreviewLayout恢复已有严格translationOnlyChanges快速路径；诊断cpuStageCode固定字典修复。
- 早裁剪三组native A/B：4.453s→3.831s中位数，13.97%，paths81899→30598；像素尚需最终组合硬件/GUI核对。源快照用于native对照位于/private/var/folders/w8/x8s0mxjd1f38qc493f2g8rpr0000gn/T/forma-desktop-manual-ec27a87b-0a45-4720-9631-0ef19189a0dc-ZE0bTC/recovery-v1/large-documents/13a7bd5a-64ac-46f2-a943-97f4b3ef7fd2-1/canvas-native-0.json。
- 库geometry_support/early_support4项通过，source控制器和规划16项通过；图片共享旧String的指针负对照实际失败，保留image-old-failure.log。
- gpu_tile_culling旧基线也失败：旧测试要求新文档后cache entries=0，与现有精确失效后保留新谱系相机合同冲突；已改为重访多相机与fresh engine严格比较，不能将此叫产品修复。
- 全前端初轮684文件，6772通过/61失败/14skip/7todo；多数缺测试辅助文件或过期断言。已复制缺失生成器/历史oracle到隔离source；更新native full/patch入口监听、真实File夹具、锁定混选原子拒绝、字段title测试；PreviewLayout真问题修复后23相关测试通过。仍需重新构建后继续解决locale/keyboard/progressive等失败。
- 全Rust初轮到kernel lib：710通过/4失败/7ignored；失败是ruler单位重关联1ulp、SVG测试缺paint.color、d=误匹配id=。已修测试夹具/断言，需用--no-fail-fast继续完整套件。
- 简单nativeGapRepair取消低清整帧候选导致12条时序测试失败，已撤销，不合入；补丁存候选testing/verification-sharp-refactor-20261029/native-gap-rejected.patch。普通画布清晰度仍需继续实现验证，不能称完成。
- products-combined已从候选完整重建WASM/native/JS；任何后续客户端修改需单独重建前端且记录native复用。当前源码和它暂一致（新增测试工具不计production inputs）。
- 真Electron Metal-3资源退休索引硬件测试完成：4类gradient/clip/shadow/HDR逐位零差，实际index命中；暖frame含读回与比较计时改善约14.1%、1.5%、10.5%、4.5%。输出在work/hardware-maintenance，脚本在候选testing/verification-sharp-refactor-20261029/hardware.ts与run-hardware.ts。计时包含比较，应修正计时后再测性能；不据此全功能/速度通过。索引仍默认opt-in，未推广。
- 未完成：117/FIG/拓扑完整GUI动作、实际静止画质oracle、完整G2/G5、最终性能门、组合回归、合入与用户可启动构建。绝不能宣称全部目标已经实现。

- 117真实Electron v3与FIG v1各8项流程通过：导入、缩放平移、对象拖动与撤销、尺寸/旋转撤销重做、键盘移动、属性保存、FD保存与重开。原件hash均不变；测试构建为products-combined（早裁剪/Arc图片/任务控制/平移修复），尚不包含后来世界索引等变化。117前两轮分别因图层搜索不支持UUID、缩放输入仍有焦点导致Space未作为平移而失败，工具修正后强制导航不改变文档，旧失败保留。
- 世界支持索引已加入候选：按revision/page/font量化身份缓存有界前景支持，查询保守控制范围与浮点误差包络；未知mask/backdrop/stroke等继续原路径；普通blur/shadow支持扩展另有测试。共享原64MiB相机资源额度，不提高预算。toy生产packet前后相机/效果/蒙版/改动对照通过；需真实packet和最终GUI/像素回归。
- 世界索引组合native首块三组对照3.695s→2.816s，23.78%；prepared81899→40443、paths81899→11439、index18.6MB。数据在native-world-ab，统计结束先于下一cargo check，无并行构建。
- 进一步正在实现：Engine在安装时对相同图片Arc精确去重；FGSC按被强引用的私有分配身份复用image语义与传输缓存，驱逐/换scope撤销；已27项image_库测试通过。
- NativeSourceSurface新增隐藏窗口暂停/恢复最新视口；首次测试因Node Event与jsdom Event不兼容失败，已修测试事件构造，待复跑。
- 最终仍必须重建最新WASM/native/JS；完整回归、三文件最新版GUI、性能和静止独立oracle、hash守卫合入均未完成。

- 最新组合 products-current 全源 NativeSourceSurface 9/9 一致性用例通过，无透明洞，返回视口像素哈希相同，四项运动/静止认证保留。全览首个完整原生帧159.524秒（包含load165秒），旧基线300秒仍1/16；新视口运动停手5.821秒，回到400%缓存110.7ms、pan106.4ms，tail=0；运动最大旧瓦片放大8×仍失败。速度门未确认，视觉独立oracle未运行；不能宣称即时/始终清晰。该构建候选维护索引ON，最终已决定退回原opt-in，需最终配置重验。
- products-current 拓扑真GUI 6项通过：完整306根导入、274节点拼搭样式二编辑、zoom/pan、拖动尺寸旋转撤销、属性历史保存、完整Sketch导出和fresh重开。archive-parity:64条目63字节完全相同，唯一语义变更opacity1→.875。关闭时15秒watchdog需SIGKILL清理两个明确所属Electron；没有影响用户其他应用。关闭流程仍应独立关注。
- Rust完整155套1737通过/9失败/54ignored；9失败在冻结旧代码七个目标中完全复现。两项是真有功能问题（丢文档fontIdentities却保留layer textModel时错误使用悬空字体ID；旧foreign symbol导出以do_objectID覆盖symbolID），正在修复。其余是旧测试协议/模型（FGSC二进制、只当前页影响、Gaussian/motion/zoom现已支持、hotspot现已支持、images/_ref现为完整路径）。
- 前端第二轮684文件663通过/18失败/3skip（6883通过）；补完整测试辅助文件、用隔离pinned fontTools4.61.1和canonical TMPDIR后，18个失败目标复跑17通过/1个导出源delta断言未正确维护；该断言已修正待复跑。resident pose mock曾固定displayMath=true导致每次render销毁GPU，已模拟实际参数并补生产所需page backing，13/13通过、3个私有117输入尚skip。progressive旧假GPU驻留用例按实际无所有权→连续画面→原生补绘检查，并保留已有真实ACK覆盖复用测试，100+项已通过。

- 用户最新明确确认严格目标：最新可见像素P95<=33ms，停手原生清晰<=100ms，当前DPR、无白洞旧内容。acceptance.json已登记；不能再说阈值未确认，历史报告保持原状态，新验收仍NOT_MET。
- 维护索引同源码仅一个开关的最终对照：OFF digest d361710... 总览300秒1/16；ON digest33bb0652a82a4022e01107e0bd6a5a354ae1f3adb0bcde15dfd3517743fe5908 总览161.321s、含载入166.527s，9/9一致性。8个可比较视口RGBA8读回哈希完全相同；4类硬件浮点三组配对零差，10-17%暖帧改善。基于该维护入口联合证据已推广默认ON、构建时0回退，其他实验不变。README/新Skill段落之前OFF描述需更新到这一决定（尚未全改完）。
- 主工作树已合入47源码/测试文件+4规范文档=51项，integration.json精确前后hash，preimage保留原本脏文件；defaultOn主构建输入与上述ON回放严格相同。build-default-on.log完成；前端默认ON全量6955通过/16skip/7todo，无失败；gui-default-on套件117/FIG各9项、拓扑6项全部通过且输入不漂移（独立profile，包含PNG1/2/3x与FD，拓扑完整Sketch）。最终native三组3.744903→2.831614s=24.39%，真实3包语义/f32几何全等。维护开关只影响JS，native字节需核对可复用。
- 严格目标续轮在work/source，尚未合入主工作树：NativeSourceSurface原120ms等待已作为旧失败复现。新增2测试模拟实际运动超采样（1.125倍），旧代码2/2失败；候选完整缓存立即按精确原生计划呈现，不等头部密度；quiet32ms取消不匹配原生key的待处理任务，保持真实完成/晚回释放；SourceViewportPlanner分别缓存运动和原生两种需求。4文件19测试通过。日志strict-source-negative-v2.log和strict-source-tests.log。
- 严格源回放工具已写在本任务目录：entry.tsx/fixture.json/build-strict-lab.mjs/run-strict-lab.mjs/strict-report.mjs和4项通过的strict-report.test.mjs。读回增加pixelsAvailableAt（PNG/hash/IO前），最后实际相机变化计时，不用重复final no-op抹掉延迟；仅允许最新真实ACK且晚于最后相机变化的已显示画面复用。ACK P95只是proxy，绝不能据它通过可见像素P95。冻结严格源候选 /tmp/futureox-render-sharp-20261029-work/strict-source-lab/source digest a1f7fd89eaa24a2aeec97afa9d80f514e3c259022decb1cd6fa22f6cb6910b42；原生/WASM精确复用main；v1正运行（session85208，strict-source-run.log），共6例，不含冷3200/overview；仍预期运动8x/新像素生产超时目标会FAIL。
- 新profiling：profile-warm-native.mjs真实prepare，视口完整尺寸1600x1200，尺度8→19→64→32→8。warm-native-profile：冷3513ms，暖399.99/435.87/379.81/375.13ms；prepared约35k，path9540。8秒sample主要非idle栈memcmp291、zoom_support.scene_guard134、margin80、single_backdrop_support_chain76、metadata unwrap64；几何38、packet14。确定优先消除重复全页静态遍历，不臆测全部都是曲线。
- 下一正在设计但尚未写的Rust候选：PageProperties按world_cache相同revision/page缓存原本backdrop/foreground/noise-extra/hasZoom判定；zoom_support提取presence与active planner，false时不重复全树扫描。margin用受相同64MiB额度约束的压缩父子transform程序，只保留含可见效果的路径；保留每个祖先concat运算顺序、不可见分支0和原来的逐节点ceil/saturating/max顺序，未知/预算不足回原递归。没有native快照每请求深clone问题：preparation-worker仅发一个物理请求，design-prepare的last取消匹配当前active，已核查，不要误修。
- /tmp/.../user-preview/main.mjs只是准备，未启动；必须等性能测量结束后再开用户预览。主build/native产品不能在严格回放期间重建，避免污染source/native资源身份与测量。

- 严格源候选已完成6例一致性PASS，strict FAIL：新目标950%最后真实变化→GPU像素可读3728.9ms；缓存返回30.1ms、pan27.3ms，缩放仍8x。ACK代理P95 9.3/9.3/9.5ms不可冒充可见像素P95。数据strict-source-lab/v1/evidence/末尾report；主repo evidence/strict-source-controller已复制。源码尚未合入Main。
- 新Rust候选现已写在WORK：margin_index.rs（只保留有可见效果的祖先路径，保留逐级concat及每父节点ceil+saturating/max，空/不可见分支仍0；预先计入Vec增长与评估scratch，预算不足回退）；gpu.rs PageProperties缓存原有页级flags与hasZoom；zoom_support.rs拆出has_zoom和scene_guard_active；WorldSupport::Cache同64MiB额度带margin与固定属性，变量缓存超额时退为仅身份/谓词头，避免反复构造已拒绝索引。
- Margin2项（2000空分支仅3个计算节点）通过；WorldSupport5项通过；painter/pointwise/tile/zoom相关集成全部通过，其中zoom_blur 7项181秒；新增跨页面/效果启停/文档改动谓词测试1项通过，对照fresh完整规范化场景。
- 正在WORK构建desktop-dev design-prepare，session27599，日志page-cache-native-build.log，成功后复制到products-page-cache/bin/design-prepare。不要改WORK生产源直到构建结束。下一步用profile-warm-native.mjs timing做三组A/B（原Main33bb binary vs新candidate），尺度8/19/64/32/8，完整1600x1200需求；比较每尺度FGSC语义/f32几何，确认收益才合入。

- 页缓存+MarginIndex候选真实暖相机三组配对：323.731→112.308ms中位数，65.31%；cold/load另列，非GPU时间。page-cache-warm-ab/summary.json；五尺度8/19/64/32/8完整FGSC语义及f32几何全部相同(page-cache-packet-parity.json)。marginIndex 10,670变换步骤、2,260,240字节（含scratch预留）；prepared仍约35k。候选binary512bcd...在products-page-cache/bin，source-inputs.json保存精确输入hash，旧world_support.rs已反向重建并hash核对保存。
- 下一候选已在WORK扩展WorldSupport到普通描边和Gaussian/motion；使用原leaf guard的4*maximum_width上界，单独保留每个sigma算子的2个device pixel邻居，沿路径相加，防止小scale下把固定支持缩小。mask/backdrop/zoom/gradient/glass/brush/offset等未知仍回旧路径。新6高斯低scale与描边支撑测试通过；生产scene六种模式新旧准备严格相同；world_support共6通过。加了三背景链/非叶frame的独立准备对照通过，但不应把它称作实测原生像素oracle。
- World-stroke 7个集成目标正在跑，session266??（以工具返回为准），world-stroke-integration.log；未构建新native、未配对、更未合入Main。先测试，再构建fresh products-world-stroke，和products-page-cache做暖相机配对/5包一致性；不能覆盖已通过的中间版本。

- 严格目标组合30bb隔离构建完成；真实源七项一致性全部通过，与a1f7源码对应旧读回七项哈希相同。新950%读回4409.5ms、缓存返回32.5ms、pan返回103.2ms，缩放仍8×。先前文档“六项”是笔误，实际fixture含七项，保留原报告并修正后续fixture说明。
- 已完成World-stroke七集成目标及native三配对：暖阶段124.983→71.191ms，5包绘制语义/f32完全一致。不能外推完整生产延迟：真实render-worker还请求gpuPageBackground，原小工具没有这项，补充profile-native-page-support.mjs显式记录该政策。
- 加入真实政策后，page_paint_rects每次新zoom花约1.5秒且无逐节点取消；剖析确认不是native session重载或取消导致引擎克隆。WORK新增page-only保守控制点证明，原damage/zoom oracle不变、未知路径回退；cancel后不发布page_support缓存。控制范围转Rect前拒绝饱和/非有限值。44 dirty_region通过，新核心库728通过7ignored0失败。新WASM/native/JS组合正在构建。
- 另有默认关闭的源2×2完整瓦片分组实验：Rust原始地址不变，只合并齐全四格与外gutter，原GPU预算/细分回退不变；4项基础用例通过。必须真实像素与耗时验证后决定采用或撤销，尚未合入Main。

- page-dominance f87d完整源7项一致性PASS、与b873像素hash全同、零透明；严格FAIL：fresh1521.4ms，cached61.4ms，pan32.9ms，maxUpscale8。原生完整参数A/B484→74ms，84.7%。11个通过的源/测试文件按33bb主源码hash保护合入，主源码803d85f…；不包含分组实验，主dist尚未重建。
- 分组两轮分别Invalid tile request与Invalid GPU tile viewport。未放宽Rust 514瓦片上限；WORK正在使用既有8MP大视口capture入口承接规范四格组合，仍默认关闭，未构建验证。
- 普通App新增test-only探针/冻结构建/真实wheel脚本。第一轮host缺fixture参数，未启动；第二轮测试手势开始前已有529额外相机输入，标为受污染。第三轮测试窗口ignore外部鼠标、不可聚焦，直接webContents原生事件32/33条校验通过。117旧路径return9920.7ms、fresh56342ms、pan917.5ms，静止/quiet像素稳定；原生可见瓦片单独ON正在测，return10199.3ms。接下来测同源码native-wide，不能提前推广两个开关。

- 用户最新纠偏：拓扑素材为主验收，支持持续增长画布、小/大文件/多页，目标完整2D渲染运行体系；本轮先基于已有数据分析。已停止新增实验，进程检查无仍运行的本任务Electron/native准备。未开始Gaussian新算法实现。整体分析保存topology-system-analysis.zh-CN.md，最新拓扑7视口报告/产物身份/像素和native配对复制到evidence/topology-system-analysis/。
- 普通117 native-only、native-wide、native-exact组合均未带来zoom收益，未推广；所有实验仅存在冻结lab或WORK。最新main仍803d85f…，dist仍33bb检查点，须在后续实现/回归恢复时明确重建。后续主线转为按需场景存储、增量空间/效果依赖、统一渲染调度/执行计划、多页资源生命周期；117/FIG只作补充。

- 用户已授权按整体分析逐模块重构，单元/模块测试优先，最终才做真实电脑操作。模块1节点索引存储已在main落地，记录testing/verification-scene-runtime-20261029/README.md；5个源码/测试文件变更，源码digest1c37b500…（完整见module-1-manifest.json）。Native-only Rust场景包按ID读取，磁盘固定索引+Merkle证明、有界构建、元数据懒读；已接入源转换缓存。10单元+1真实完整拓扑模型+56后端模块通过，10既有专项ignored。真实124447节点，13次分散读取20,858字节节点载荷/136,320字节索引证明/0元数据，完整序列化语义一致。
- 本模块未接通视口需求加载：现有cache消费者仍into_document，canvas_snapshot仍全量合并。原GUI/CPU/GPU性能状态不因存储单测改变。下一模块是持久目录及需求集/依赖闭包装入，再增量索引/统一调度/多页；不应在模块中间启动GUI或重复全量构建。
