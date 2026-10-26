# 进度

- 基线 main-built 2232 个构建输入 + 四份技能/契约哈希，工作区逐项相同。
- baseline-large-1 启动失败：旧私有临时 host 缺 package.json，未进入应用，不算性能样本。恢复为主仓库相同 package.json 后 baseline-large-2 成功；原动作停止后 16289 ms，连续捕获每次 25 tiles、末尾预览再 20 精确 tiles。
- 两项 first-whole-capture release 测试在旧实现的 signal.aborted 断言失败；修复后 release/idle-warm/renderer 共 143 通过。只撤销可选捕获 owner，不取消文档修改；晚成功像素退役，下一手势独立 owner 可继续。
- commit 原生优先测试在旧实现确实先排 livePreview，修复后先原生瓦片；旧 backing 始终保留原文档身份，不赋予新内容完成权。新测试通过，类型检查通过。
- large-edit-1 组合候选保留原默认开关/数学/预算，只开与基线相同 Alpha/quality 观测。

- 默认候选一：1:5 停手收敛 16289→6809 ms；1:32480 4681→2491 ms；1:81474 9410→2724 ms。首轮配对，不称延迟全门通过。第一工作集的两批25瓦片交互和低清预览确实消失，原生20瓦片仍约6.4 s。
- 1:5 剩余35个非零 fence 中31个是 maintenance，合计约2094 ms；示例无压力、761MiB/1GiB、两项坐标资源仅2720字节，却因反复检查相同对象耗尽按调用次数计算的配额。
- 候选二将已知资源的延期配额绑定实际对象身份，最多8个不同待退役句柄；重复询问不新增退役责任。第9个对象、原75%水位、64MiB临时上限、allocation/image pressure仍立即走完成边界；无身份旧调用保留原8次逻辑。没有提前销毁、取消记账或扩大预算。
- maintenance-old-failure.log 用冻结旧 Renderer 穿过生产reclaimScratch，确实多等了一次fence；新17项Node通过，邻近4文件73项通过，类型检查通过。仍需实际GPU/GUI验证。

- 维护候选实际硬件没有端到端收益：7297 ms vs 对照复测6554 ms，等待总量2324 ms vs2270 ms。完整最终图候选/对照零通道差异，但减少同步次数没有减少GPU实际工作，三份维护源码和测试均恢复基线，候选差异保留为 rejected-maintenance.patch。
- 首次同运行 opacity-change/restore PNG 比较有3383个通道差异，全部位于底部 UI footer 操作名（移动图层→修改透明度），不是文档图形。保留原PNG与失配记录；后续对照在截图时只隐藏footer，画布尺寸和文档渲染不变，不把原失配计作逐位通过。

- 最终两修复主构建的117/FIG与拓扑A/B/C五组编辑/撤销重做/保存/完整导出/重开全部完成。final-main-pixels 在隐藏 DOM footer 后，原画布 vs opacity-change/restore 原生重绘的8,905,680个RGB通道零差异。
- 追加UI停顿检查发现基线首动作也有750ms停顿（跨采样窗口不能忽略）；两修复版本仍有约0.8s停顿。完整窗口 ui-stalls.json 仅为初始统计，不能把排除边界窗口后的基线0误当成完整运行0。
- main-cpu-profile-1 实际UI/Worker采样：UI native-preparation.serialize约1204ms累计活跃栈，validateDocument约220ms自身采样；native Rust进程与GPU执行不是这些V8栈。不是未采样性能结果。
- 发现非零 PageTranslation.displayedDocument 手工复制快照未保留私有 authored derivation source，交互预热会重传整个52MB工作集。改用既有 interactionPatchedDocument 来保存原文档+少量transform能力，仍由客户端/native核对真实源receipt，未直接授权派生。
- derivation-old-failure.log 旧实现缺source witness，derivation-fixed.log 四文件64项通过，类型检查通过。large-edit-3 普通配置用于匹配CPU采样，large-edit-3-traced 与早期Alpha/quality回放匹配。尚待实际路径确认。

- PageTranslation关联候选未降低序列化：真实UI serialize采样仍约1229ms，0.8s停顿仍在。因此两文件也已恢复基线，保留 unadopted-derivation.patch；未将局部64测试当成真实收益。
- serialization-metadata 确认动作中两次完整4022节点/3591几何节点文档序列化，每次52,340,611字符、约1.3–1.4s host wall。开始载入时两个空文档通过同ID的52MB bulk patch接收workset，fields含designSystem/colorManagement/pages，属于不能续期的结构性补丁。serialization-cause 显示首次交互 sourceIsCanvas=true，但canvasReceipt=false。
- 第四候选仅把 native canvas 的空nodes→首个非空workset改为既有完整同步。原本bulk patch也携带全部节点；完整同步可建立真正的原生源确认，后续非空文档仍走原增量路径。未放宽null/undefined、未知属性、source receipt、CAS或patch大小限制，没有新增authoring proof。
- workset-adoption-old-failure.log 旧代码选择patch而非完整同步；该负对照退出时还出现待处理mock promise的dispose拒绝，主失败断言正确命中。新4文件33项与类型检查通过。开始 large-edit-4 普通配置真实CPU/传输计数验证。

- 第四候选仅处理空→非空未命中真实重新选工作集：record中原生首轮已经full-load，但后续同ID的完整工作集重载通过4022节点bulk patch丢失了确认。其真实UI复制与停顿未改善，保留记录，不计收益。
- 第五候选扩展为：同ID native canvas，pages结构改变，patch明确覆盖每个旧node和每个新node（新集合非空）时选完整源同步；局部编辑、追加和不完整节点集合仍用补丁。完全依靠既有 full-load ACK 建立绑定，原授权与null/undefined等保护未放宽。
- 新35项定向通过与类型检查通过；冻结旧client非空完整替换用例在预期document缺失断言失败，源码已恢复候选后构建 large-edit-5。

- 第五候选实际命中：candidate-5-cpu-profile 动作期无整图序列化，仅4次4193字符节点补丁，实际派生请求1次。UI大serialize热点消失；profiler-on仍记录一次266.5ms停顿，未隐去。
- 无CPU profiler的C5 A/B/C GUI回放：pointerup→精修6729/2498/3153ms，A复测6801ms；三组Alpha零透明、maxUpscale=1、nativePhaseCoverage=1、无failure-origin。>250ms UI/rAF停顿均0，最大间隔约166/166/184ms，A复测175ms。
- workset-load-pixel-parity.json：旧bulk-patch vs新full-source标准姿态截图8,905,680通道零差异；候选内部opacity改回原生重绘也零差异。
- 源码最终8文件已hash保护集成主工作区；最终主构建完成，2232构建输入一致，Rust/WASM代码未更改。
- 最终主构建117/FIG和拓扑A已通过完整功能链；拓扑B在导出后重开时OS报No space left on device，C随后同环境失败，原截图/失败均保留。磁盘只剩约1.1GiB。根据两轮report列出的已退出PID与专属profile路径，清理75个自己创建的临时测试profile，保留原件/源码/host构建/备份/导出文件/图像与日志，释放约47.79GiB；cleanup.json记录所有路径。剩余约48.88GiB，重跑B/C。

## 本轮交付状态

- final-5-functional-sketch-b-retry / c-retry 清理空间后全部通过；与117/FIG/A共五组实际默认主构建功能链均闭合。所有导出文件大小和SHA-256见final-summary.json。
- 下载原始三文件SHA-256未变。最终8个源码/单测/技能文件hash匹配集成结果，主构建成功；用户既有应用窗口未自动重启。
- 最大工作集pointerup→精修6729ms、复测6801ms；其他两组2498/3153ms。无CPU采样的三组与A重复均0次>250ms UI停顿，仍不等于物理FPS或输入到光子；整体无延迟/无模糊目标未完成。
- 早期失败、未采用候选、CPU profiler结果、磁盘空间不足及清理后成功复测均保留。维护候选和非零平移关联候选未进入默认源码。
