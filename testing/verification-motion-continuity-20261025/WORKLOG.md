# 工作记录

## 冻结与复现

- 从主工作区 39ff10b 加已有未提交改动复制到独立 worktree，保留 baseline.patch 和逐文件 hash。原工作区已有 dist/build-manifest.json 与冻结源码的 buildInputs 完全一致；该构建克隆到私有 baseline-host，所有 GUI 都使用独立用户目录。
- 原件：下载目录的 117.sketch、拓扑素材.sketch、01有料素材 (Copy).fig。仅导入到测试 profile，原件不覆盖。
- baseline-pan-117：停手后 1398 / 453 ms，出现 2x 历史纹理放大；普通平移没有发现透明。
- baseline-zoom-117：160 原生滚轮，最大历史纹理放大约 29.785x，停止后约 5210 ms 才被 harness 判定收敛。此构建只有周期性质量采样，不能把未测帧计为通过。
- baseline-fast-117 首轮因短窗口不足四张 screencast 帧失败。baseline-fast-117-2 发现 h 快捷键在缩放输入框焦点下没有切换工具，实际执行了对象移动；相机断言失败被保留，该轮不能当作平移验收。随后脚本先聚焦 canvas，再切换工具，并显式记录 MOTION_TOOL；短窗口稀疏截帧单列，不作为质量通过。
- baseline-fast-object-117 是纠正工具焦点后的独立重复：133 个 Alpha 探针中 19 个出现全透明像素，最大 790856 个。所有普通质量/显存诊断和实际 PNG 保留。

## 已实现、仍需组合 GUI 验证

1. 异步位图导入：完整交互图层组到齐前不提交空/部分帧，保留原图层所有者；Presenter 拒绝将缺失句柄解释为有意透明。continuity-old-failure.log 两项旧实现失败，定向修复后通过。
2. 页面移动：去掉对 viewport-only 页面移动的无条件 allowEmpty。编译器已有的 paint support 随全页平移变换，仅对确知没有内容的缺口采样原页面背景；缺少真实内容时保留完整 backing，通过同 owner/pose 的拒绝通知转现有原生交互路径。拒绝通知不会推进 input ACK。
3. candidate-fast-object-117：119 个 Alpha 探针零透明，uiStalls=0；仍出现预算拒绝，运动清晰度未通过。该结果不能叫总体修复。
4. screen-aligned density-cache 与 native 相机具有同样整像素采样证明时允许平移复用；仍拒绝分数相位、不同密度和依赖相机的数学，不加入容差。pan-phase-old-failure.log 为旧失败。
5. 嵌套四遮罩、描边对齐分配前按实际同时存活数量准入。clip-admission-old-failure-2.log 确认旧失败确为预算拒绝；同输入新实现、取消及相关准入 51 项通过。这是独立准入缺口，不等于解释每次真实预算失败。
6. 真实失败字典的 failureAllocationPassMode 是 shader mode + 1。candidate-2 的值 1 实际为 copy(mode 0)，不是 mask combine(mode 1)。根缓存保存之前重新检查完成绘制后的实际工作集，可选缓存不足时不破坏已完成贡献；最终合成先为真实输出准入。retained-copy-old-failure.log 穿过实际 drawInteractionRoots，旧实现复制缓存时预算拒绝；新实现通过。
7. candidate-3 继续暴露最终四样本 resolve(mode 23) 没有预留输出空间；补上该输出、HQ resolve 和 presentation crop 的原准入/完成 fence。没有扩大预算或更改像素算式。
8. 快速缩小到在途放大捕获两倍世界范围、且已有当前内容覆盖时，提前取消不再覆盖目标的可选捕获；小反转仍让任务完成，物理请求 fence 不提前释放。

## 回归边界

- 17 个相关文件第一轮 304 通过、2 失败；两项 overlay 测试在原始 Presenter/Surface 对照也失败，原因是完整捕获夹具误用了默认 gutter。补上明确 gutter=0 后相关四文件 57 通过。
- 新测试第一轮的 mock 函数类型推断错误保留于 typecheck-1.log，修正后类型检查通过。
- 最近 renderer 六文件 82 通过，见 renderer-affected-1.log；不是完整前端通过。
- candidate-3 快速对象链仍 maxUpscale=2、最终收敛约 594 ms、一次 resolve 准入失败；quality.json 明确 FAIL。后续候选必须重新验证，不能用零透明掩盖模糊和延迟。

## 2026-10-26 继续定位

- matrix-4 的全部对象移动有覆盖但仍出现透明像素。由实际 Alpha 帧、页面 authored 背景和调用路径定位到 `run(12)`：物理 1×1 页面背景被全局 interactionWindow scissor 排除，清零后仍被标记 uniformColor。`background-old-failure.log` 穿过实际 renderAttempt 复现；修复仅让该常量初始化覆盖其完整物理 texel，其他渲染区域与 authored 透明值不变。
- hardware.json：Apple Metal-3 非 fallback，白色、灰色、HDR/负值背景 × authored 透明与不透明，实际浮点 readback 对正常渲染共 24576 word 零差异。不透明窗口无透明像素，authored 透明仍保留。
- 整页平移缺口加入只限未提交、同文档、整设备像素位移的原始世界瓦片补齐。通过已有 canvas mailbox / KernelClient / tile admission 接收，不建立第二套缓存预算；忙时保留一个最新目标。不同内容、分数相位及失败回到原生交互。refill-parent.log 是实际 Surface 回调路径的定向控制流测试，不是 GPU。
- progressive-damage 的五个缩放/间隙调度失败经原始冻结 Surface 对照仍全部失败，见 progressive-baseline-control.log；没有将它们从测试中删除。此轮原生补齐定向测试单列，其他 183 跳过不计通过。
- matrix-5 三文件对象移动均零透明、maxUpscale=1、nativePhaseCoverage=1；但 117 最终收敛约 1925 ms，拓扑首组约 16836 ms。其旧 `motionGate=PASS` 字段只计算覆盖/Alpha/密度/错误，不包括延迟，**不能解释为完整 G2 或用户目标通过**。
- matrix-5 快速缩放仍 FAIL：117 最大约 21.76x，FIG 约 29.76x，拓扑约 72.93x 历史纹理放大。没有把当前候选称为全部完成。
- matrix-5 拓扑纯平移/缩放没有 authored 修改，测试却等候“修改已保存”提示，产生额外 180 秒 harness 失败；保留原结果。后续仅对真正发生对象编辑的源工作集等待该提示。计时在保存之前结束。
- 接下来单列 native-navigation 独立实验构建，只显式启用既有 native-navigation 与它要求的 exact-clamp-prefix；不改变源码默认。其结果不得混作默认配置收益或直接推广。

## 最终集成状态

- 默认源码 39 个变化文件经全量前置 hash 验证后同步主工作区；其他原有未提交内容保留。反向增量补丁只做 `--check` 并通过，未回滚。
- 主工作区 `bun run build --fast` 成功；2232 个输入与最终 manifest 一致，三个原生产物与已测基线相同。独立 profile 的实际主构建 117 启动/平移 smoke 完成，用户旧窗口不重启。
- 最终默认配置三文件的移动、撤销重做、保存、导出与重新导入全部完成。原件哈希未变。
- 组合回归 414 pass / 5 原有 fail / 1 skip，类型检查 pass，桌面诊断 27 pass。
- 宽整数精确滤波在实际硬件 10 组逐位对照通过；真实整页缩放仍未通过，因此保持默认关闭。可见瓦片候选亦仍关闭。最新拓扑快速编辑停手收敛仍约 16.7 s。
- 用户全部修复目标尚未完成，不以透明探针为零或覆盖指标通过替代姿态跟随、快速放大/缩小和延迟验收。详细范围见 README.md。
