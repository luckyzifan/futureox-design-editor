# 启动与源转换清单核对

基线为 baseline.json 中的 commit 与逐文件 hash。优先消除实际热路径重复工作，保持完整源、按需编译、编辑回退和文件认证边界。

| 项目 | 核对结论 |
| --- | --- |
| 1. source_snapshot 全节点读取 | 存在，但当前不是无用副本。`Preparation::load_source_snapshot` 将其装入完整 Engine；`source_compile::Runtime::compile` 从完整 Engine 创建 Catalog，布局、全源语义、未支持请求回退、修改、CPU/导出均使用它。Reader.metadata 明确不是可渲染模型。只保留 metadata+stage 会使 stage.children 悬空并破坏这些路径。原 3.8789s 是完整 native-load，含读取、认证、校验与装载，不是单独 into_document 的 profile。完整惰性源需要另立带权威回退的生命周期方案，不能直接删调用。 |
| 2. refs/policy 重复扫描 | 成立。依赖引用遍历所有 JSON 字段；private compatibility 和 symbolMaster 准入只沿 layers 链，合并时必须保留两者不同范围，包括非 layer 元数据中的嵌套值。 |
| 3. root.clone | 克隆存在，原函数也返回 root，不能只改一行而继续返回被移动的值。但所有当前调用方都丢弃该返回值；删除私有 API 的无用返回值后可以转移 root 所有权。 |
| 4. Symbol 索引超过 4 MiB | 成立：OnceLock(None) 会回退重复扫描。需要有界分片或磁盘索引，并覆盖 revision、失败、重复 symbolID 首个命中和并发构建。不能只取消 4 MiB 阈值，也不能假定本次拓扑样本已经触发此路径。 |
| 5. scene_store 几何节点副本 | 成立。Cow::to_mut 会复制 Node 字段容器；几何载荷本身为 Arc，不是每次深拷贝完整几何。只读序列化视图可省去 geometry-only 节点的复制，保留原 Node 序列化规则、packed 几何、镜像引用和 Merkle 字节顺序。 |
| 6. 序列化只为计数 | 成立，build_range 的窗口总量和共享节点/字体扣除都可以计数写出，不需要临时 Vec。此路径与 canvasSnapshot 不同；仍会遍历序列化内容，不能把避免分配写成完全取消编码。 |
| 7. index-data 再编码 | 部分成立：Entry 包含轻量身份、层级、字段 span，原始内容已由 span 指向 spool；没有再次编码整个 699 MB JSON 子树。可先消除每个 Entry 的临时 Vec。改二进制格式属于更大的持久索引/历史编辑兼容变更。 |
| 7b. canvas_layout 字段重复打开 | 成立：frame 与 rotation 各读取完整 Entry，并各打开源文件。一次布局可按 part 持有索引/源句柄，每个根只读一次 Entry，仍由 Changes reader 应用当前修订和取消检查。 |
| 8. merge_entries/children.contains | children 的重复查找可用有序 Vec 加成员 Set；不要改变已有顺序。design_system 的大块 Sketch 元数据已经直接合并；泛型冲突往返 JSON 并非所有字段都可用简单覆盖替代，需要保持嵌套合并与冲突原子性。 |
| 9. 密度规划/裁切 | 值得后续 profile。密度相同不代表采样相位、周期 dithering、原生已呈现 lattice 或可见 tile key 相同；已有双槽 key 复用不能被密度-only 缓存替代。 |
| 10. 合成覆盖/retire | 覆盖最坏复杂度和退役反查存在。完整当前网格回执需要核对所有权、core/gutter、相位、原生密度和晚回；不能从节点/瓦片数量直接推导无洞覆盖。独立的 GPU tile ID 反向索引可以另做生命周期回归。 |

`canvas_snapshot::build_inner` 已按源顺序分批转换，并保持最多两个 CPU 转换槽。尚未消除的是转换结果合并成完整 Document，以及写完快照后再由 native 完整装载；不能把“有序分批转换”本身当作尚未实现的新能力。

`area.wgsl` 的小区间、二分、边界、四采样和解析分支描述正确；本轮不改光栅算法。上述未落地项与实际修改、运行结果在最终 README 中分别列出，不能把审核方向当成性能验收。

最终选择：Entry 流式写入候选虽然保持字节一致，第一轮和追加对照的 source-open 均值分别回退约 6.87% 和 3.47%，没有证明收益；该部分已撤回，保留原 Vec 编码。布局的 Records/源文件句柄复用仍保留。另一任务曾试验 metadata-only 并在真实装载中得到 Missing node 后撤销；本任务未加入该实验。
