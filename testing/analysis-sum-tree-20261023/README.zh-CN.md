**Zed sum_tree 在 Futureox Design 中的适用性与实测 — 2026-10-23**

结论：最适合的落点是大文档的图层行序列增量索引。对当前 117 夹具，其绝对收益很小；对 2 万至 10 万节点的结构操作有优化空间，但先消除全表遍历通常比先换数据结构更划算。当前不建议替换 Rust NodeStore，不建议把 sum_tree 视为复杂画布编译的直接加速方案。

项目检查基线 `518d8ddad6bf7b3865035f1c89ad6548befd4a2d`；Zed 固定到 `cfb894a5dde8ccf3fba1659164f47fdd1c024e2e`。完整身份见 [manifest.json](manifest.json) 和 [upstream.json](upstream.json)。此次仅新增研究脚本和记录，没有修改产品源码、Cargo 依赖、协议或生成 WASM。

**1. 这个库实际提供什么**

Zed 的 [sum_tree 源码](https://github.com/zed-industries/zed/blob/cfb894a5dde8ccf3fba1659164f47fdd1c024e2e/crates/sum_tree/src/sum_tree.rs)实现带子树摘要、Arc 结构共享和写时复制的 B+ 树。使用方定义 Item、Summary 和 Dimension：例如摘要记录行数，按累计行数定位，分割和拼接片段时共享未变化节点。

它管理有序序列；设计文档的父子关系、图层折叠、节点 ID 到位置的映射、跨父级深度变化都需要应用层实现。它不是已经实现这些语义的设计场景树，也不自动提供惰性区间深度增减或整段可见性赋值。单纯换成树但继续每次遍历全部节点、输出完整数组，仍然是 O(N)。

**2. 具体落点，按当前投入价值排序**

| 落点与源码 | 可以采用的设计 | 预期价值与限制 |
| --- | --- | --- |
| [layer-tree.ts](../../frontend/design-client/src/layer-tree.ts) 的可见行序列 | 用带行数摘要的序列保存顺序，局部 splice；只向 React 提供视口行 | 最匹配。结构编辑、局部折叠/展开是目标；普通属性编辑已有凭证快路 |
| [Layers.tsx](../../frontend/design-client/src/Layers.tsx) 的定位、键盘导航、区间选择 | rankOf、rowAt、window、idsBetween 接口代替全量 map/findIndex | 先用更简单的缓存/选择分支即可改善。sum_tree 不自带任意 ID 的实时 rank |
| [layer-row-transition.ts](../../frontend/design-client/src/layer-row-transition.ts) 的变更凭证 | 从已完成的真实 diff 提供有限的结构变化信息，让索引更新局部区间 | 是增量索引的前置工作。现在只保存 topology/names 布尔值，不能定位哪个子树需要更新 |
| [scene-index.ts](../../frontend/design-client/src/kernel/gpu/scene-index.ts) 的场景能力摘要 | 对有限布尔值/计数做 OR/求和并沿变更路径更新；需要时用 FilterCursor 跳过已证明无关的分支 | 中期候选。当前已有 WeakMap 缓存和平移继承；集合去重、背景依赖、祖先变换不能靠一个计数摘要解决 |
| [scene.rs](../../design-studio/crates/design-kernel/src/scene.rs) / [ops.rs](../../design-studio/crates/design-kernel/src/ops.rs) 的 children 顺序 | 仅针对极宽父节点，研究持久化孩子序列，减少共享快照上的 Vec 复制/中间插入 | 技术上匹配，但涉及 Node、serde、操作回放和 TS 数组投影。当前 117 最大父节点仅 375 个孩子，优先级低 |
| [snapshot.rs](../../design-studio/crates/design-kernel/src/snapshot.rs) 的 NodeStore | TreeMap 替换 im::OrdMap | 不推荐。当前已经使用 OrdMap<String, Arc<Node>>；此次等价快照更新微测，TreeMap 明显更慢 |
| [text.ts](../../frontend/design-client/src/text.ts) / Rust text 字段 | 自建文本块序列，记录 UTF-8/UTF-16 长度等摘要 | 长文本方向可研究；还需字素边界、样式片段、段落重排和序列化适配。117 中最长文本仅 25 个字符，无当前收益证据；sum_tree 本身不附带完整文本编辑器 |
| [gpu.rs](../../design-studio/crates/design-kernel/src/gpu.rs) / [geometry_snapshot.rs](../../design-studio/crates/design-kernel/src/geometry_snapshot.rs) | 有条件地减少依赖扫描或重复命令片段准备 | 不能直接减少路径细分、文字 shaping、面积程序生成、滤镜像素计算。Prepared 已缓存子树 bounds/segments，ProgramCache 已按脏节点删除；应先证明剩余扫描占比 |

生产历史路径已核实：Editor → createEditingHistory/createGraphHistory → GraphApi → NodeStore。因此，“引入持久化树就能消除现有完整快照复制”不符合当前实现。另一个 DocumentEditor 的补丁历史实现不是判断当前前端历史路径的依据。

**3. 本机前端 CPU 测量**

Apple M2 Pro，Node v24.12.0 / V8。通过 Bun 仅转译/打包当前 TS 源码，执行使用 Node。每项预热 10 次；21 轮，正反交替操作顺序；每轮多个操作取平均，再统计这些批次均值的中位数。各脚本独立顺序运行，没有让 Rust 编译或另一组计时同时进行。机器不是隔离实验室，不作跨设备保证。

这里所有数值单位为毫秒，均为该函数片段的 CPU 时间，不包含文档修改、Editor 提交、React、Electron IPC、WASM 桥、GPU 和实际显示。文档及变更凭证在计时前构造。

| 操作 | 117 实际夹具，752 行 | 合成四叉树，20,001 行 | 合成四叉树，100,001 行 |
| --- | ---: | ---: | ---: |
| 完整重建图层行序列 | 0.0409 | 1.3069 | 9.3343 |
| 小子树折叠/展开交替，现有缓存路径 | 0.0424 | 1.4364 | 9.2180 |
| 已认证的普通属性更新后读取缓存 | <0.001 | <0.001 | <0.001 |
| 未认证、确实不改拓扑的更新后检查缓存 | 0.0936 | 3.4443 | 26.0245 |
| 搜索后重建 | 0.1692 | 2.3258 | 11.8979 |
| 当前单选前的 ID 数组生成与线性查找 | 0.0055 | 0.1681 | 0.9555 |
| 已知区间时，纯 JS 数组删除该子树后代 | 0.0008 | 0.0578 | 0.2829 |
| 重建 id → 行号 Map | 0.0324 | 1.4905 | 7.8547 |

117 使用仓库已有真实夹具 `testing/verification-render-low-latency-20261021/real117-repro/document.json`，752 个可达节点、最大深度 4、最大孩子数 375、106 个文字节点、最长文字 25 个字符。该文件不代表所有用户设计文件。两个大规模案例是合成结构，仅包含行计算需要的字段，不能据此宣称真实大型文档的整体响应。

折叠案例分别移除 25、84、84 行。数组删除的边界已在计时外计算，只与旧实现结果做了完整比较；没有计入寻找边界、维护排名、处理重挂深度和重新展开。这证明“减少工作量”有潜力，不是已完成的图层面板加速。特别是每次再建一个 10 万行 rank Map 会增加约 7.85 ms，抵消大部分节省。

未认证缓存检查的 26 ms 是人为覆盖该分支的测量，不证明真实交互会频繁进入该分支。应先按操作统计凭证命中、跳过版本及回退频率，不能为了跑分快就跳过必要的正确性检查。

原始样本与来源哈希：[ui-results.json](ui-results.json)。`p95_batch_ms` 是批次均值的 p95，不能当成单次用户操作尾延迟。

**4. 使用原版 sum_tree 的独立 Rust 对照**

固定版本的 sum_tree 三个生产源码文件及默认关闭 tracing 时需要的 ztracing/ztracing_macro 源码保持原字节。为隔离构建，仅重写了清单，去掉 Zed workspace 继承、开发测试依赖和未启用的可选 tracing 后端；未使用 Zed 应用或 GPUI。依赖解析结果保存在 [Cargo.lock](Cargo.lock)。Rust 1.96.1，release + thin LTO + codegen-units=1。

行序列使用 8 字节的紧凑 id/depth；映射使用 String 键 + Arc<Row>，模仿当前 NodeStore 的共享值形态。已知删除范围，保留旧快照，删除 128 项。每项预热 20 次，21 轮交替顺序，均包含新结果的创建和释放；用 black_box 消费结果，并检查序列与映射结果。不是完整设计节点、真实结构命令或渲染工作量。

| 原生操作，中位数毫秒 | 752 项 | 20,000 项 | 100,000 项 |
| --- | ---: | ---: | ---: |
| Vec 保留旧快照并删除 128 项 | 0.000087 | 0.003271 | 0.013160 |
| SumTree 保留旧快照并删除 128 项 | 0.001231 | 0.001892 | 0.002205 |
| im::OrdMap 快照 + 更新一个键 | 0.001653 | 0.002873 | 0.004096 |
| sum_tree::TreeMap 快照 + 更新一个键 | 0.011236 | 0.018215 | 0.018822 |

在该序列微测中，SumTree 在 752 项时反而慢，在 2 万项约快 1.7 倍，在 10 万项约快 6 倍；10 万项的绝对节省约 0.011 ms。其 TreeMap 在所测规模约慢 4.6–6.8 倍，因此没有支持替换现有 OrdMap 的证据。这个结论只针对测过的键、值、快照和单点更新模式。

树也有成本：10 万项初建约 0.371 ms，Vec 从已有元素复制约 0.013 ms；读取 40 项视口，树约 0.000189 ms，数组约 0.000027 ms。数组连续存储的常数更低，SumTree 的优势集中在保留旧版本并修改局部大序列。未测堆内存、峰值保留量和长时间 GC；不能宣称引入后一定节省内存。

**不得把本节 Rust 数字和上一节 JS 重建数字相除，作为“接入 WASM 后的加速倍数”。两者工作量、字段表示和运行时不同，Rust 实验没有构造或维护设计树索引。**

原始样本：[native-results.jsonl](native-results.jsonl)。原生构建和基准断言通过。对隔离的 sum_tree crate 执行 `cargo check --target wasm32-unknown-unknown -p sum_tree` 通过；这只证明该清单下的编译检查，不证明 JS 桥、浏览器运行或 Rayon 并行路径可用。本次未执行 upstream 全套测试、产品测试或 Electron/GPU 回放。

**5. 真正接入时需要解决的工作**

建议把索引做成可丢弃的派生状态，权威设计文档与 Editor.change 流程保持原有职责。初版可把页面、搜索和结构大改列为完整重建条件，从局部折叠/展开开始。

对 UI 提供类似以下接口，避免调用者又恢复全量遍历：

```ts
interface LayerOrderView {
  count(): number
  window(start: number, length: number): readonly LayerRow[]
  rowAt(index: number): LayerRow | undefined
  rankOf(id: string): number | undefined
  idsBetween(a: string, b: string): Iterable<string>
}
```

至少需要处理这些成本：

1. **位置和结构变更信息。** 当前 layerTransition 只有两个布尔值。要从已经完成的 diff 得到改变的父节点/孩子顺序，不能把用户选区或 draftIds 当作完整变化集合。旧版本被跳过、凭证失效时仍需安全回退。
2. **ID 到位置。** 序列树按累计行数查找很方便；随机 ID 的 rank 需要另一个可增量维护的机制。简单 id→数字行号 Map 在前方插入后会让后面所有行号过期。
3. **层级语义。** 隐藏一个子树不等于切掉任意数组区间；要保留折叠状态、搜索上下文、倒序兄弟显示、选择范围和 reveal。重挂子树还会改变后代绝对 depth，不能承诺无条件 O(log N)。
4. **查询模式。** 任意子串搜索每次更换查询通常仍需检查节点名称。Summary 不能凭空把文本匹配变成对数复杂度；搜索可继续全量重建或单独做索引。
5. **跨语言。** 若直接复用 Rust crate，应让索引驻留 WASM，传入有界增量并批量取约几十行。每次发完整文档或返回完整 rows 会重新引入 O(N) 转换成本。折叠和搜索是 UI 状态，也必须有明确所有者，不能只依赖渲染 Worker 内的文档副本。
6. **生命周期与验证。** 索引绑定文档、会话、页面和发布版本；撤销/重做、导入、组件物化、跨页移动、取消和过期回调均应与完整遍历 oracle 比较。需要预算和回收，不能无界保留旧索引。

已有数组视口 slice 为 O(V)；树窗口为 O(log N + V)，单纯滚动不会因换树自动更快。局部更新在已知边界、能维护索引且新增 K 个元素的条件下，才有望把全量 O(N) 改为与 O(log N + K) 相近的序列处理成本。区间选择实际返回 K 个 ID 至少需要 O(K)。

**6. 工作量估计与推荐顺序**

以下是一名熟悉项目的工程师、不包含等待跨平台设备的粗估工作日，不是排期承诺；各行是不同方案，不能相加作为已确认总工期。

| 方案 | 探索原型 | 含针对性回归的可交付版本 | 判断 |
| --- | ---: | ---: | --- |
| 修掉单选不必要的全量 IDs 工作，复用已计算索引，增加凭证命中统计 | 0.5–1 天 | 1–3 天 | 先做，成本低；不能每次重建 rank Map |
| 保留数组，局部折叠/展开维护连续区间 | 1–2 天 | 3–5 天 | 用来确定完整索引维护后还剩多少成本 |
| TypeScript 实现带计数摘要的分块/持久化序列 | 2–4 天 | 5–10 天 | 复用数据结构思想；不是直接复用 Zed Rust 代码 |
| 原版 sum_tree + 独立 WASM 派生索引 + React 接口适配 | 3–5 天 | 10–20 天 | 含会话、增量、排名、选择、生命周期；真正成本在这些接缝 |
| 渲染场景改成可增量聚合/拼接结构 | 3–5 天先做热点归因 | 15–30 天以上，视效果依赖而定 | 目前没有可归因的收益数字，不建议并入首次接入 |

许可证方面，[固定版本 Cargo.toml](https://github.com/zed-industries/zed/blob/cfb894a5dde8ccf3fba1659164f47fdd1c024e2e/crates/sum_tree/Cargo.toml)标为 Apache-2.0 且 publish=false，生产依赖含 heapless、rayon、tracing、ztracing。正式引入可固定 Git commit 或采用维护过的本地副本，并保留许可证及相关声明、核对依赖。本次独立清单只验证默认路径，不能宣称是可直接发布的完整 vendor 包。

推荐先用现有数组方案覆盖 117、2 万节点、10 万节点的完整交互。如果包含位置维护和 UI 发布后的数组更新已经足够快，则无需引入跨语言索引。只有大型结构操作仍是实测瓶颈时，再选择 SumTree；比较对象应是优化后的数组方案，而不是原来每次从根重建的实现。

对 117 当前约 0.041 ms 的行重建，即使完全消除，在这项局部 CPU 测量里也只节省该量级。它与此前场景编译数百毫秒属于不同路径。若某阶段只占总耗时 f，单独将其加速 s 倍，整体加速上限为 `1 / ((1-f) + f/s)`；本次没有测出完整交互中的 f，不能据此承诺 FPS 或整机倍数。

**7. 复现**

在仓库根目录运行；选择新的空临时目录，避免覆盖其他工作：

```sh
bun build testing/analysis-sum-tree-20261023/bench-ui.ts --target=node --outfile=/tmp/futureox-sum-tree-ui.mjs
node /tmp/futureox-sum-tree-ui.mjs /tmp/futureox-sum-tree-ui-rerun.json

python3 testing/analysis-sum-tree-20261023/prepare-upstream.py /tmp/futureox-sum-tree-rerun
cp testing/analysis-sum-tree-20261023/Cargo.lock /tmp/futureox-sum-tree-rerun/Cargo.lock
cargo build --locked --release --manifest-path /tmp/futureox-sum-tree-rerun/Cargo.toml
/tmp/futureox-sum-tree-rerun/target/release/sum-tree-probe
cargo check --locked --manifest-path /tmp/futureox-sum-tree-rerun/Cargo.toml --target wasm32-unknown-unknown -p sum_tree
```

不要在两个基准或编译同时运行时比较计时。首次下载需要公开网络。产品源码若与 manifest 哈希不同，应重新标注基线；脚本直接使用当时工作区的前端函数。
