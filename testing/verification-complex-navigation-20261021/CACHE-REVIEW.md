# 可见缓存保护：交付事务与对象平移边界

本记录是当前源码审查与受控测试的范围说明，不是实际 GPU 清晰度、帧率或全部白块问题的验收结果。普通 Space 平移／缩放与对象／画板拖动是不同路径，不能互相代替通过。

## 交付事务修复

原 `receive` 在完整预算验收前会清除旧 key 的 ready、退回旧 bitmap、淘汰部分历史并裁剪非活动页面。若最后发现剩余来源都受保护而拒收，旧 live Map 未发布替换，但其部分资源和 ready 已改变。这是一条可受控注入的失效路径；尚未证明它解释用户实际看到的全部白块。

现在由 [tile-admission.ts](../../frontend/design-client/src/kernel/tile-admission.ts#L26) 先纯计算候选 Map、共享资源字节和淘汰集合；预算通过后，[ProgressiveSurface](../../frontend/design-client/src/kernel/ProgressiveSurface.tsx#L953) 才发布 Map／ready 并退回旧资源。拒收与 stale-document 交付保留 live、非活动页面和 held display 的资源别名。`HandledTileDeliveryError` 表示 surface 已接管交付资源处置，客户端仍拒绝请求、报告错误，但不会再次释放它。发布后的 trim／bitmap retirement 异常仍尝试 `setTiles`，原异常保留在 cause。

局部缓存预算错误进入现有的一次压力重试；没有提高预算或改变画质策略。先前八套测试 154 项通过、typecheck 退出 0；[计数记录](tile-admission-summary.json) 保留初始测试加载器失败与修正后的结果，原始日志留在忽略目录中。

## FIG 实机压力失败与有界替换暂存

随后 `fixed-stress-fig` 的真实 Electron 三轮混合操作完成了 183 次 wheel、480 次 pointer move／30 次 Space 平移，但最终细化以本地“显示瓦片缓存预算超限”失败。最后报告 missing texture 为 0；不能把这次失败描述为 GPU device lost，也不能据此宣称没有内容缺块。该运行保留为失败证据，修复后的实际重复验证是另一个记录。

源码给出的阻塞条件是：当前 required plan、上次完整 displayed frame、CoverageRetention、overview 和实际 used 来源的并集可能挤满常规缓存；helper 还必须计入 held display，不能通过简单删除 key 来释放它的字节。新来源在接纳／呈现前不能降低 used，而一次重试同样跳过这些保护集合，因而可能无法前进。原始日志没有保护集合分组快照，不能声称已经逐项还原了该次运行的全部内存所有者。

本轮新增一帧 foreground replacement 暂存，仅能借用**既有 total residency allowance 中的余量**。常规历史缓存仍为原 steady budget；当前 `current()`、非 prefetch 且属于当前 required plan／viewport capture 的新来源才可借用。cap 每次从当前物理视口重新计算，包含过滤 gutter 与部分平移多出的一行／列，并同时受 `steady/3` 和 `total-steady` 限制，不按请求累计。在 855×888、DPR 2、SDR GPU 驻留路径上，该 cap 为 26,419,600 bytes。非活动页面仍先为前景让位，accepted Map、held 来源与 inactive 页的名义 payload 并集保持在原 total allowance 内。最终 native ACK 后，原 `commitReady` 继续按 steady budget 回收已不贡献覆盖的历史。

旧相机／prefetch 的 delivery 不可借用暂存。当这种可选 delivery 无法按常规额度接纳时，只退回该 incoming，并保留数值拒收记录；它不再经旧 callback 的全局 `cancelPreview` 取消更新的 foreground fill。当前必需 delivery 的预算失败仍明确拒绝并走有界重试。

[replacement budget 测试](../../frontend/design-client/src/kernel/tile-replacement-budget.test.ts) 包括全热旧 used 集合阻挡新来源的负控、新 required 来源接纳、替换 ACK 后旧 used 下降并回到 steady budget、旧相机／prefetch 不借、不同 memory tier 余量与重复请求不可累计暂存。[实际 receive 闭包测试](../../frontend/design-client/src/kernel/tile-admission.test.ts) 同时覆盖 inactive 让位、可选拒收不取消前景以及既有 alias／清理异常边界。最新十一套定向 **171 项通过**，终端诊断与隐私白名单 **23 项通过**，typecheck 退出 **0**；[计数记录](replacement-staging-summary.json)。这些与前文测试重叠，不相加，也不替代修复后的 FIG／117 实机重复。

`data-cache-steady-budget`、`data-cache-staging-limit`、`data-cache-admission-budget`、`data-cache-active-bytes`、`data-cache-active-highwater` 和 `data-cache-total-highwater` 公开数值边界。终端 `viewport-state` 额外记录 proposed／budget／reserve／incoming bytes、held／used／pinned counts、total bytes、拒收标志和 high-water，不记录 IDs、文档内容、图像或异常文本。这些是名义 payload 账本，不是总进程内存、物理 VRAM 或已经释放的驱动分配证明。

## 审查发现的对象平移范围缺口

普通页面 [compositeItems](../../frontend/design-client/src/kernel/ProgressiveSurface.tsx#L1865) 并非所有对象拖动时实际提交的 items。[ResidentCompositeSurface](../../frontend/design-client/src/kernel/ResidentCompositeSurface.tsx#L119) 可用 `moved` 替换它；[PageTranslation](../../frontend/design-client/src/kernel/page-translation.ts#L195) 会对孤立画板裁剪、平移原来源，或[平移整页来源](../../frontend/design-client/src/kernel/page-translation.ts#L215)。原视口外的瓦片可能因此进入屏幕。

若只按未变换页面计算可见来源，这个瓦片仍可能属于可淘汰历史。下一次 [PageTranslation.prepare](../../frontend/design-client/src/kernel/page-translation.ts#L167) 又从当前 translationItems 重建来源，可能丢掉已经被平移到屏幕中的内容。overview 可能掩盖为细节下降；缺少覆盖时有出现缺口的可能。这是已有逻辑的范围缺口，不是本轮缓存事务新增的问题，尚无独立实机复现记录。

## 本轮的有限修复与证据

[实际 present 调用之后](../../frontend/design-client/src/kernel/ResidentCompositeSurface.tsx#L171)，子组件回传实际使用的 page／moved items，保留源对象与 placement／clip。父组件只接纳仍在 live Map 中的同一 page 源对象，[保存完整 owner、相机、DPR、设备与实际 items](../../frontend/design-client/src/kernel/ProgressiveSurface.tsx#L2022)。后续可见性计算仍使用同一个 `compositeDrawPlan` 和物理 quad 规则；没有保护全部历史、提高预算或修改 GPU 算法。

[CompositeFrameWitness](../../frontend/design-client/src/kernel/composite-frame-witness.ts#L5) 将子 layout 先提交的快照按 render owner 暂存，父 layout 再原子发布。已提交 owner 的 imperative 移动可直接更新；未提交／已过期 owner 的回调不会覆盖当前快照。暂存使用 WeakMap，不通过强引用保留废弃 render。

[真实 React 父子 layout 与 PageTranslation 测试](../../frontend/design-client/src/kernel/composite-frame-witness.test.tsx) 覆盖：

- 子 layout 先 stage、父 layout 后 commit，owner／相机不会分开更新；迟到旧回调与未提交 render 是负控。
- imperative 整页平移让原视口外来源进入屏幕，再用生产预算 planner 注入后续交付压力。新 witness 保留该可见来源、淘汰冷来源；原普通页面 witness 作为负控会淘汰移动来源。
- 更换设备 ownership 后，该来源不能继续取得可见缓存保护；原 authored document 没有被平移预览修改。

十套定向测试共 **163 项通过**，typecheck 退出 **0**；[本轮计数](translated-cache-summary.json)。测试使用受控 GPU transport，没有执行像素光栅，也不证明实际 GPU 延迟、质量、嵌套拖动或无白块。与此前 154 项存在重叠，不相加。

## 仍需实际验证的场景

1. 使用真实 117／FIG，在高倍率选中整页根节点或可隔离不透明画板，先把原视口外已缓存来源平移进屏幕，再让已排队的瓦片完成并触发预算压力；重复反向移动、缩放与返回，逐帧检查有色内容缺失、采样密度、设备归属和来源复用。
2. 同时记录真实输入、实际提交相机、GPU 队列等待及 CPU flamegraph；截图对照区分透明的白色页面背景与真实缺失内容，不能只根据透明面积判断白块。
3. 单独验证嵌套对象／背景依赖对象的 InteractionRenderer 路径、拖动结束后的原生瓦片接管、编辑、撤销／重做与精细导出。这里的 PageTranslation 测试不能代替这些路径。

仍存在一个明确边界：若来源已被缓存淘汰，而 React 尚未提交，第一次对象移动短暂引用该旧来源，新 witness 不会把它复活到 live Map。本次修复只保护**仍有 live ownership 且已经实际提交为变换后可见来源**的后续交付压力路径；不保证冷区域、已经过期的来源或首帧移动立即获得细节。保留覆盖与重新光栅的实际行为需要另外验证。
