# 渲染架构对比：design-studio × Apple Maps(VectorKit) × Affinity × Figma

日期：2026-10-18。
你的架构现状依据：design-kernel/design-gpu 源码 + design-client/src/kernel 当前状态（含 2026-10-18 增量批次后的 overview-coverage/prepared-tile-fallback/translation-patch/retained-commit）。
逆向依据：maps-analysis/（7 份）、affinity-analysis/（4 份）、figma-wasm-analysis/（自有挖掘，Figma 列只引用已确证部分）。

---

## 一、总形态

| | 你的 design-studio | Maps VectorKit | Affinity 2 | Figma |
|---|---|---|---|---|
| 内核 | Rust→wasm(web)+原生(桌面侧车)，CPU 几何/coverage + GPU 合成 | C++，CPU 场景 + Metal 渲染 | C++，CPU AGG 光栅 + Metal compute + GL 合成 | C++→wasm + WebGL/WebGPU |
| 场景组织 | 文档树 + 影响矩形 + 脏区证书 | **ECS + 帧图任务 DAG** | 文档树 + per-tile 渲染树 | wasm 内场景图 + 增量 ops |
| 帧驱动 | 宿主/React 事件驱动，无常驻 rAF | CVDisplayLink 两段式 + 空闲停表 | 视图失效驱动 + 线程池 | 事件驱动（你们对齐的 mP 两帧规则） |
| 呈现 | web：worker 内 WebGPU 驻留合成（无回读）；**桌面：侧车回读+IPC（短板）** | drawable 直呈，零回读 | GL 纹理直呈，零回读 | 浏览器合成 |

**判定**：形态上你=Figma 同构（wasm 内核+GPU 合成），你的 web 呈现路径（ResidentPresenter 驻留纹理+UV 四边形+scissor）已经和 Affinity 的 GL 合成器同构。唯一结构性落后在**桌面侧车回读**（Maps/Affinity/Figma 都零回读）。

## 二、帧调度

| 机制 | 你 | Maps | Affinity | 判定 |
|---|---|---|---|---|
| 至多一帧在途/丢帧 | DisplayCommandOrder 单调序列丢乱序 + Mailbox 取消 | stamp==1 两段式，旧帧未完新 vsync 整帧丢弃 | 渲染原子闩 + AbortDraw 协作中止 | **对齐**（实现不同，语义同） |
| 限频/空闲 | 无常驻 rAF，pending 清空即停 | CVDisplayLinkSetPaused + RunawayDisplayLink 看门狗 | 失效驱动（天然无循环） | 对齐；你缺看门狗断言（CI 可加） |
| 优先级抢占 | pose 优先级 1 插队 + yieldToHigherPriority 瓦片边界让位 | 网络 1/5/8 + 在途升优先级 | 三级队列（普通>HQ>离屏）+ 视点距离 | **基本对齐**；你缺"离屏任务回灌"（Affinity MoveOffScreenTasksToNormalQueue 等价物）和"在途升优先级" |
| 变频率重逻辑 | 无（全部每事件跑） | VLR n%freq 空闲指数抬频（65 个 Logic） | 225ms HQ 定时器 + 1000ms 均值自适应 | **差距**：你的文字整形/模糊 bake 无降频机制 |

## 三、瓦片体系

| | 你 | Maps | Affinity |
|---|---|---|---|
| 锚定 | **世界锚定 512²（+1px gutter）**，平移免重建 | 四叉树数据瓦片（几何驻留） | **视口锚定**（缩放全量 retile+HardAbort） |
| 档位 | 0.1/0.25/0.5/1/2 + 动态降密 | 连续 z（公式 clamp[1,25]） | 256²(软)/512²(GPU)，HQ 恒 2× |
| 缓存 | 三层：主线程显示 LRU(128-512MiB) + CoverageRetention(最宽帧≤⅓预算) + worker ExactTileCache(128MiB, damage 证书) | 内存 NSCache 512 项 + 磁盘 SQLite 500MiB LRU | MemoryManager 记账（无配额）+ 可见性回收 |
| 逐出策略 | 插入序 LRU + 保护 plan/retention/overview | 在途引用 + stamp 制 | 可见性 + zoom 层复用 |

**判定**：你的世界锚定是**三家最强网格设计**（Maps 数据瓦片不同类；Affinity 视口锚定缩放必 retile 是它的弱点）。缓存层数你最厚，damage 证书复用是独有优势。缺：磁盘层（Maps 有 500MiB 瓦片库，你全内存——跨会话复用是之前 SPEC 里的 KV 项）。

## 四、缩放/平移路径（最大分化点）

| | 你 | Maps | Affinity |
|---|---|---|---|
| 平移 | PageTranslation 纯偏移 + panPrefetch 8 瓦 + rim 1 环 | 纯相机投影，零光栅 | ε=1e-7 短路，纹理零重绘 |
| 缩放（手势中） | **重采样放大上一档（nearest mag）+ 密度升半倍频程** | 几何连续重投影（零光栅） | **纹理 warp（只改矩阵）+ 新纹理排队老纹理续显（zoom 队列+像素差混合）** |
| 缩放（静止后） | 两帧 debounce → native 采样 → 全 plan 补齐 | 不需要（一直连续） | Rationalise+Retile 一次 + 225ms HQ |

**判定**：**这是你剩余差距最集中的一格**。三家缩放策略三档：Maps（几何级，最优）> Affinity（纹理 warp+队列，次优）> 你（重采样，可用但"糊窗期"长）。你的世界锚定网格其实比 Affinity 更适合做 warp（旧档瓦片天然可矩阵缩放），Maps 逆出的重投影层方案（SMOOTH-RENDERING-SPEC §1）在这上面落是最顺的。另外你缩放换新档时的"旧瓦片保持"语义已部分存在（LodSnapshotCache underlay + progressiveTileLayer 不遮旧），离 Affinity 的"像素差混合过渡"差最后一步。

## 五、未就绪回退链

| | 你 | Maps | Affinity |
|---|---|---|---|
| 链条 | overview 背书瓦片 → coarse LOD 桶 → exact 粗底 underlay → motion 降采样 → native 带 → exact + preparedTileCanFill 补洞 | 祖先 2 级 + 后代 BFS 3 级（Morton 序先粗后细）+ 拉伸 alpha | 视口网格 + zoom 纹理队列 |
| 过渡 | progressiveTileLayer 新低密度不遮旧高密度 | stretch-weight smoothstep 几何驱动 alpha + 标签 0.4s 线性淡入 | 像素差着色器混合 |

**判定**：你的回退链层数和 preparedTileCanFill（取消批次中已完成单瓦片入场补洞）已是 Maps 回退梯子的功能等价物，且 zoom∈[1/2,2] 的准入阈值合理。**缺的是过渡的"连续性"**：交换瞬间无 alpha 混合（Maps stretch-alpha / Affinity 像素差着色器都是干这个的）。

## 六、质量阶梯

| | 你 | Affinity | Maps |
|---|---|---|---|
| 档位 | motion 半倍频程降密 → settled native；presentationQuality 仅诊断 | T0 交互(1×+mipmap+单pass) / T1 静止(2×HQ) / T2 导出 | half/精确分层 + Glyph3d 低精度变体 |
| 触发 | 两帧 debounce（80ms 强制） | 失效即降级（preview 标志）+ **per-tile 225ms idle 定时器** | 相机运动 + 动态帧率 |
| 恢复 | 事件驱动补齐 + 250ms/idle 维护 | 独立 HQ 队列 + 幂等短路 + 视点距离渐进 | VLR 抬频 |

**判定**：功能对齐，**恢复语义你略弱**：你的 debounce 是全局的，Affinity 是 per-tile 定时器（可见区先恢复、外围后恢复，天然渐进）+ WasDegraded 指针（降级原因与恢复解耦）。你的 retainedCommit（松手把已显示 native 帧直接提交）已经实现了 Affinity "幂等短路"的一半。

## 七、GPU 管线与 shader 管理

| | 你 | Maps | Affinity |
|---|---|---|---|
| 管线数 | 6 条共享 WGSL + override 常量起步 | 预编译 130 家族 + Alloy 运行时模板 + **64bit function-constant 掩码特化** | **7 阶段正交模板**（fragment 存在性决定 GPU/CPU）+ Pending/Broken 三态 |
| 缓存 | ProgramCache LRU 32MiB + CompiledPacketCache 32MiB | PSO 全量描述×掩码惰性缓存 | 描述符字典序内存缓存 + 失败永久拉黑 |

**判定**：你的 WGSL override 铺开计划（SPEC §5）正好是 Maps 掩码模式的等价物；Affinity 的"按访问模式分算子（per-pixel/scanline/strip）+ Pending/Broken 三态"对你 compute 化效果 pass 时最值得抄。

## 八、文字 / 颜色 / 内存

- **文字**：你是轮廓→解析 coverage（导出精确最优），**交互档无图集缓存**——Maps（RG8 SDF 图集+运行时 repack）和 Affinity 都是图集派。差距项，方案已在 SPEC §4。
- **颜色**：你 f32 线性 + 托管精确/降级自适应；Affinity 的显示 3D CLUT（profile/屏幕变化不失效瓦片）值得吸收；Maps half 交互层你不采纳（合理，确定性优先）。
- **内存**：你的三层显示预算 + 四桶 GPU 台账（复刻 Figma CorePerfInfo）+ needs_free 压力钩子 = 三家里**可观测性最强**；Affinity 记账制、Maps zone 制都不如你透明。

## 九、总判定

**已对齐（近三批优化后）**：帧纪律（至多一帧在途/丢帧/事件驱动）、调度优先级（距离排序+抢占让位）、回退链层数、三层缓存+damage 证书、GPU 驻留呈现（web 侧）、retainedCommit 幂等提交、平移纯偏移。你的 web 渲染栈现在是一个"机制完备度接近成品"的架构。

**剩余差距（按杠杆排序）**：
1. **缩放路径**：重采样 → warp/重投影（SMOOTH-RENDERING-SPEC §1 + Affinity zoom 队列语义）——体感最大项；
2. **桌面呈现**：侧车回读+IPC → 零拷贝（SPEC §7）——桌面端体感最大项；
3. **交换瞬间 alpha 过渡**（Maps stretch-alpha / Affinity 像素差混合）；
4. **交互档字形图集**（SPEC §4）；
5. **变频率重逻辑 + per-tale 恢复定时器**（Affinity 225ms 语义）；
6. **预取半径**（你 rim 1 环 vs Maps 3 屏）与在途升优先级；
7. **磁盘瓦片层**（Maps SQLite 500MiB 跨会话复用）。

**你独有/领先**：世界锚定网格（缩放复用潜力 > Affinity 视口锚定）、damage 证书跨补丁复用、binary64 解析 coverage 精度、四桶台账可观测性、跨后端逐位一致（三家都做不到）。

**一句话定位**：你是"Figma 形态 + 比 Figma 更严格的确定性契约"，机制完备度已达 Maps/Affinity 的工程水位；剩余差距全部集中在**缩放的过渡质感**和**桌面呈现链路**两个格子里，且方案都已在手（两份 SPEC）。
