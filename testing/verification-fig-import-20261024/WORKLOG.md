# FIG / Sketch 导入修复进行记录

用户范围：下载目录《01有料素材 (Copy).fig》与《拓扑素材.sketch》，独立 Electron 的快速缩放、属性编辑、撤销重做、保存与重开；不得操作其他任务进程。后续用户提供了低清运动预览、活跃瓦片预算拒绝、重效果 pass 放大和 SceneDelta 边界的分析，全部作为参考。不能以 uiStalls=0 或静止清晰宣称运动清晰。

## 已验证与修复

- FIG 原件 SHA-256：701877664bf271305c8bc103c4036a228d7bd8816f1d98f18cdc332a75c36c46，649304 B。
- FIG 既有 Rust 修复（精确重合端点的填充/描边分离、隐式填充轮廓显式闭合）已完整编译。真实导入得到 14 页、19949 个编辑节点。`real-fig-1.log` / `actual-fig-results.json` 为真实 Editor/WASM 历史及 FD 检查。
- 首次修改自动保存跨 contextBridge 全对象复制造成约 609 ms UI 停顿。`ResidentDocumentEncoder` 现可从经过会话/版本/私有采用证书确认的 JSON 初始化，再只传变化节点；host Worker 对 JSON 大小和结构照常校验，错误不推进常驻状态；原地版本修改重置编码器。`fig-gui-seeded/report.json` 功能链通过；缩放 max 25 ms、属性/history max 241.9 ms，均 uiStalls=0。导入副本的新 document id 单独记录，其余完整数据一致。仍有字体/实例/独立区域样式等兼容提示。
- Sketch 侧栏原先渲染 7662 行，listHeight=245184，实际 navigationHeight=814，见 `layout-before.json`。改为有高度约束的 flex 列和独立 source rows 滚动，修复虚拟列表失效。新候选只挂载 23–24 行。
- 密集 vectorGeometry 校验消除同一 fill 作为默认 stroke 的重复扫描及每条曲线的临时 entries/opcode 对象；每个坐标、命令数量、独立 stroke 仍全检查。新增非法坐标、opcode、别名容量回归。组合 91 项通过（`combined-regression.log`），真实 source scenes 全量校验通过。
- `sketch-gui-3.json` 三个真实工作集已编辑/撤销/重做/保存/完整导出/重开，但 UI 卡顿未过，不能作为交互通过。后续侧栏修复候选第一、二块 uiStalls=0；`sketch-gui-4` 被用户输入中断；`sketch-gui-5` 第三块快速缩放出现 Scene path budget exceeded（保留失败）。
- 早期 source GUI 的标签选择器遍历放大停顿（getElementLabels 自耗约 21s），已改直接 aria-label CSS 查询。CPU 采样中也确认实际 Layers 大量 DOM 提交，不能把全部停顿仅归咎测试器。

## 当前在验证的渲染候选

`VITE_DESIGN_NATIVE_VISIBLE_TILES=1` 为新增严格 opt-in（默认关闭）。既有所有实验 flags 维持默认设置。候选按当前 view 的 DPR 密度走原区域瓦片路径、运动批次一瓦片、准备范围限制到当前批次，跳过整视口低清/LOD/overview 优先工作。未修改任何缓存/GPU/路径预算、采样数学或 HDR/export 规则。需要实际 GUI/硬件质量与压力检查才能宣称改善；完整 G2/G5 仍未验。

`native-tiles-regression-2.log` 记录调度/ownership/admission 回归；其中原有字符串提取 receive 测试遗漏 coverageFlight 绑定，已补齐测试环境变量（未改准入实现）。`candidate-virtualized.json` 是上一修复构建，新的 `build-native-tiles.log` 正在构建 opt-in 候选。

## 未完成

1. 构建 native visible tiles 候选，独立重跑两文件；记录运动时 sharp/nativePhase/maxUpscale、队列/完成时间、surfaceRejected；不能把旧帧 ACK 当新像素。
2. 完成 Sketch 全归档核对。`verify-sketch-export.py` 使用私有目录 ijson 流式比较，63 个未改 ZIP 成员逐字节相同，变更页按 JSON 语义检查；首版比较误把对象 key 重排当差异，已修正为只将三个目标 style 对象局部规范化，仍须实际重跑。
3. 完成本轮 Rust FIG geometry、最终组合回归和源码/产物/证据摘要。最终报告须区分功能通过、UI 响应和运动清晰度/预算压力未过。

## 运行所有权

基线、私有 runtime、源/产物摘要见 `baseline.json` 和 `candidate*.json`。只关闭本轮 runner 创建的进程；唯一提前终止的是已确认失败的 owned PID 6529，完整命令核验记录在 `sketch-gui-2-cancelled.json`。旧 Electron PID 45064、96089 及其目录未操作。编译输出使用新 --out-dir，不替换其他实例正在使用的共享 dist。


## 日志闭环更新（原生瓦片交接修复）

用户要求继续自行读日志。已关联原实例日志及只读 SQLite 备份：重效果大 pass 样本在删除前；四次 surfaceRejected 在 08:43:47 删除唯一根节点、08:43:48 保存 0 节点的“117”之后。请求 337/343 的 packetNodeVisits=0，不能把之前的重效果统计直接解释成这次预算拒绝。源 profile 只读，备份放在本任务 reference-snapshot，未控制原进程。

从 camera-request 还原 139 条原生 Ctrl-wheel 输入；独立 Electron 收到139条 isTrusted=true事件，最后相机误差约2.3e-7 CSS px。旧默认链与只改 native-visible-tiles 的候选都失败（前台拒绝4/10次）。根因落到 progressiveTileLayer：旧高密度历史始终压住当前已达屏幕原生密度的新瓦片，阻止交接并将历史碎片持续算作 used。

已在默认路径修正：只有 fine 且 tile.zoom>=requestedView.zoom*dpr 才优先接替旧历史；不足原生密度的新预览仍不盖住清晰旧帧，非当前计划不能提升。所有资源准入、bitmap/GPU 生命周期与预算保持。69项导航/所有权/准入回归通过，1项跳过保留。

默认构建（新实验flag=0）第一次相同回放：前台拒绝4→0，detailReady=true，无UI错误，uiStalls=0；仍记录3次非必需历史缓存拒绝，不能称完全没有拒绝。已重新跑默认构建的 FIG 与3个Sketch工作集，编辑/撤销重做/保存/关闭/重开均通过。新的默认Sketch导出与先前完整核验的导出逐字节一致，hash=4eeae3b850e2807fec1b3d13fc9ed5f4172c1d02ac726828035af8f336918af2。

当前新构建/运行目录见 candidate-handoff-fix.json；empty-reference-fixed-repeat 是重复验证，随后需运行 REFERENCE_FULL=1 的删除前752节点轨迹。最终文档/manifest尚须更新到该默认修复，不能沿用早期 native-visible-tiles 候选的通过范围。重效果运动清晰度与完整G2/G5仍独立未验收。
