**VS Code 代码与架构在 Futureox Design 中的复用评估 — 2026-10-23**

当前最值得采用的是：列表的增量派生与局部发布、统一的资源清理、适用于可合并只读工作的任务工具，以及按需加载的 Monaco 代码视图。最先能获得的性能收益来自本项目自己的重复父索引和整树重建问题。直接换库并不能代替减少这些工作。

项目基线为 `518d8ddad6bf7b3865035f1c89ad6548befd4a2d`；VS Code 源码固定到 `8c643aa26a949a1ed2c00a7830357e4a580954e0`。另测公开包 `monaco-editor@0.57.0`，其包声明的 VS Code 来源为 `6a598d4a13031703d483d103c1d934a36ad27971`，两者不是同一快照。完整身份见 [manifest.json](manifest.json)、[upstream.json](upstream.json)。本次只新增研究文件，未修改产品源码、依赖、生成 WASM 或桌面配置。

交付核验时工作区已有后续并行修改。在本研究记录的文件中，sidecar.mjs 与 preparation-worker.mjs 的传输迭代器由 documentFrames 改为 documentWrites；已阅读该差异，它不改变本文对请求/字节预算与业务取消的要求。这两份文件不参与 CPU 基准。其余已记录源码哈希仍匹配，尤其是所有列表与资源过滤测量输入。原始 manifest 保留测量时身份；不把本文当成后续整个工作区的测试结果。

**1. 优先级、复用方式与接入成本**

以下是熟悉本仓库的一名工程师对局部接入和针对性回归的粗估工作日。不是已承诺排期；大范围迁移、跨平台验收和新产品能力另计。

| 优先级 | VS Code 资产 | 本项目落点 | 复用方式 | 局部接入估计 | 收益性质 |
| --- | --- | --- | --- | --- | --- |
| P0 | 列表/树的增量派生、可见区发布方式 | AssetsPanel、WorkspaceLibrary、Layers、layer-tree | 优先借鉴架构；按需要抽取 IndexTreeModel | 共享资源索引 1–2 天；窗口化 2–4 天；图层局部折叠 3–5 天 | 有源码与局部测量支持，整机收益待验证 |
| P1 | DisposableStore、MutableDisposable、toDisposable | 导入 Worker、历史/文档库面板、会话订阅、可取消预览 | 固定版本抽取小范围公共工具，封装项目接口 | 首个模块 1–3 天；数个入口 4–7 天 | 减少清理遗漏和生命周期分支；没有已证实的 FPS/内存降幅 |
| P1（有代码视图需求时） | Monaco editor / diff editor 公共 API | HTML/CSS 导出查看、代码差异、节点关联定位 | 使用正式 npm 包，按需加载 | 只读视图 3–5 天；语言 Worker、差异与节点关联 5–10 天 | 节省功能研发；会增加下载/解析/内存成本 |
| P1–P2 | Delayer、Throttler 等任务合并工具 | 重复文档库刷新、未来资源检索/只读预览 | 仅接语义允许合并的同一资源读取 | 2–4 天 | 可减少重复任务；已有防抖、排队路径不能重复计算收益 |
| P2 | IndexTreeModel 的具体实现 | 大型图层结构操作 | 抽取无 DOM 的模型，保留 React 视图 | 5–10 天；搬整套 DOM Tree/List 通常需更多周级工作 | 减少自写折叠/过滤/列表事件逻辑，不明显快于正确的数组局部更新 |
| P2 | filters.ts 的 fuzzyScore/createMatches | 可选组件搜索或新增命令搜索 | 固定版本抽取算法，保留原搜索模式 | 1–3 天 | 缩写匹配、排序、高亮；本次测量比子串匹配更贵 |
| P2 | 文本差异算法 / Monaco 差异视图 | 导出代码前后对比，历史中单个 text 字段的细节 | 限定文本显示用途 | 算法 2–4 天；完整交互随 Monaco 接入 | 改善差异可读性；不能代替文档语义差异和撤销 |
| P3 | ContextKey/命令服务、FileService、Extension Host、Workbench | 全局命令、文件后端、插件平台 | 当前主要作架构参考 | 完整引入是周级至月级 | 当前需求不足以覆盖迁移和维护成本 |

如果只解决现有性能问题，先做 P0。若目标是补上设计到代码的产品能力，Monaco 是最直接的现成组件。生命周期工具适合随新模块或局部重构接入，不建议为统一形式一次性改写所有已有逻辑。

**2. 最值得先改的资源面板：避免重复父索引**

源码链路：

- [AssetsPanel.tsx](../../frontend/design-client/src/AssetsPanel.tsx) 用 Object.values(doc.nodes) 过滤组件，在名称匹配时调用 family(doc, id)，渲染每个匹配项时又调用 family。
- [components.ts](../../frontend/design-client/src/components.ts) 的 family 每次调用 allParents(d)。
- [geometry.ts](../../frontend/design-client/src/geometry.ts) 的 allParents 每次遍历页面和全部节点，创建新的 Map。

若文档有 N 个节点、C 个组件，仅过滤阶段就可能做 C 次全量父索引构建，工作量接近 O(N×C)。资源列表还直接渲染所有匹配项。把父索引放在同一不可变快照/操作内共享，并把组件条目派生与可见区渲染分开，比引入模糊搜索更值得优先做。

这里可借鉴 VS Code 的数据模型与视图分离，但无需先引入 VS Code 代码；本项目已有 Editor.parentMap。可变草稿仍必须重新计算，不得把已发布快照的缓存拿去服务草稿。

只提取原版 family/allParents 函数体、擦除 TypeScript 类型后测过滤阶段，结果如下；优化对照只在本次操作构建一次父 Map，输出完全一致：

| 合成案例 | 当前过滤，中位数 ms | 共享父 Map，中位数 ms |
| --- | ---: | ---: |
| 2,000 个普通节点 + 根节点，100 个组件 | 27.784 | 0.545 |
| 20,000 个普通节点 + 根节点，200 个组件 | 957.802 | 8.560 |

这是合成数据、单一查询的 CPU 片段，未包含组件实例化、React/DOM 或实际资源面板。它验证重复工作确实昂贵，不能宣称所有真实项目都会快相同比例，也不意味着该修复已接入。

**3. 树模型：VS Code 比 Rust sum_tree 更贴近当前 UI，但数组对照同样重要**

上游 [indexTreeModel.ts](https://github.com/microsoft/vscode/blob/8c643aa26a949a1ed2c00a7830357e4a580954e0/src/vs/base/browser/ui/tree/indexTreeModel.ts)已有折叠状态、可见后代计数、过滤和 onDidSpliceRenderedNodes。与 sum_tree 相比，它多提供了实际树 UI 的语义，且可以留在 TypeScript 层。

本项目 [Layers.tsx](../../frontend/design-client/src/Layers.tsx) 已采用固定 32 px 行高和可见窗口；[layer-tree.ts](../../frontend/design-client/src/layer-tree.ts) 也能复用普通属性编辑后的行顺序。剩余机会主要是折叠、展开与拓扑变更后的全量重建。

原型使用真实 VS Code 模型；把 doc 的兄弟顺序转换为与当前面板一致的倒序，接收 splice 事件更新展示数组，并以当前完整遍历结果验证展开、折叠后的每个 ID、depth 和 context。随后加入更简单的数组局部 splice 对照。最终树对照结果为：

| 案例 | 当前完整重建路径 ms | VS Code 局部更新 ms | 普通数组局部更新 ms |
| --- | ---: | ---: | ---: |
| 117 实际夹具，752 行 | 0.0517 | 0.0020 | 0.0002 |
| 合成四叉树，20,001 行 | 1.4449 | 0.0177 | 0.0152 |
| 合成四叉树，100,001 行 | 19.1521 | 0.0787 | 0.0764 |

关键限制：

- 两种局部方案都预先知道子树位置。数组方案保留了待展开的后代片段；VS Code 模型也预先构造完成。未计入初建、任意 ID 的定位和结构重挂后的索引维护。
- 展示数组是原型私有的可变数组。正式接 React 时还需窗口快照/版本发布，不能把原地变异的同一数组当作不可变快照发布。
- 未覆盖搜索上下文、跨页移动、组件物化、撤销/重做、跳过发布版本、可访问性和实际焦点。不能把约 240 倍的函数对比说成编辑器加速倍数。
- 原版 IndexTreeModel 的位置计算会累加前面的兄弟节点；不保证任意宽树查找为 O(log N)。它也不能自动处理本项目的文档/会话/版本所有权。
- 本次进程同时保留原型树、位置表和展示数组，分配与 GC 环境不同于上一轮 sum_tree 研究；不要把两个研究中原始完整重建的毫秒数直接当成产品回归。

建议先实现窄范围的数组局部折叠/展开。若随后需要更完整的树过滤、身份保持和细粒度事件，再评估采用 IndexTreeModel。其价值主要是节省实现和维护工作，而非超越正确的数组局部更新。

RangeMap 虽小，也不必先接。它按连续同高分组线性查找；当前固定行高直接除以 32 即可定位。它更适合新增可变行高需求时评估。

**4. 生命周期与异步工具：可复用，但不能改变业务协约**

上游入口：

- [lifecycle.ts](https://github.com/microsoft/vscode/blob/8c643aa26a949a1ed2c00a7830357e4a580954e0/src/vs/base/common/lifecycle.ts)：DisposableStore、MutableDisposable、toDisposable。
- [async.ts](https://github.com/microsoft/vscode/blob/8c643aa26a949a1ed2c00a7830357e4a580954e0/src/vs/base/common/async.ts)：Delayer、Throttler、Limiter。
- [cancellation.ts](https://github.com/microsoft/vscode/blob/8c643aa26a949a1ed2c00a7830357e4a580954e0/src/vs/base/common/cancellation.ts)：CancellationTokenSource 及与 AbortSignal 相关的辅助函数。

本项目的 importFileInWorker 已有 AbortSignal、超时、监听解除和 worker.terminate；历史/文档库面板有 alive 标志；浏览器保存已有 350 ms 防抖。因此接入的价值主要是统一所有权、减少重复代码和避免遗漏，不是“从没有取消机制变成有取消机制”。

对真实上游实现执行的行为探针结果：

| 探针 | 结果 | 对本项目的意义 |
| --- | --- | --- |
| 第一个任务阻塞期间向 Throttler 提交 100 个任务 | 执行第 0 和第 99 个 | 适合允许只保留最新待处理请求的同资源只读工作；会跳过中间任务，不能用于逐条必须完成的编辑/保存操作 |
| 同一同步批次向 Delayer 提交 100 次 | 执行 1 次 | 验证合并机制，不是当前真实负载收益；也会引入等待 |
| Limiter(1) 有运行中和排队任务时调用 clear | 排队任务的 Promise 没有被 resolve/reject | 不能直接替换要求每个请求有终态的 sidecar/导入请求契约；需要明确的包装层 |
| DisposableStore 连续 dispose 两次 | 已注册回调执行一次 | 证明局部清理幂等性，不能据此证明全应用无泄漏 |

另需注意：上游 DisposableStore 在 dispose 后再 add，并不自动替你处置新增对象；异步返回的资源需要显式的“已失效则释放”处理。原生 AbortSignal 接口可以保留，不需要为了风格统一迁移所有 API。

不可替换的现有边界：

- [render-work-queue.ts](../../frontend/design-client/src/kernel/render-work-queue.ts) 有单 encoder 所有者、交互优先级和完成 tile 后才可让步的规则。通用 Limiter 不具有这些语义。
- [render-mailbox.ts](../../frontend/design-client/src/kernel/render-mailbox.ts) 已有目标合并，并刻意允许部分运行中工作完成后复用其像素。不能用“相机变化就取消一切”代替。
- [frame-debounced-value.ts](../../frontend/design-client/src/kernel/frame-debounced-value.ts) 按帧计数且重复相同值不延后发布，与时间防抖不同。
- [sidecar.mjs](../../frontend/design-desktop/src/sidecar.mjs) 的请求数、聚合字节、响应预留、背压、写入结果和不确定提交语义必须保留。
- DisposableStore 只能组织何时调用释放函数，不能把 GPU 提交确认当作完成确认，也不能提前销毁仍在队列使用的纹理。

**5. Monaco 是直接可用的功能资产，优先做按需加载的只读视图**

本项目已通过 [automation/export.ts](../../frontend/design-client/src/automation/export.ts) 提供 code.export，输出 HTML、CSS、资源、保真警告及 nodeIdMap。Monaco 可以承接：

1. 选中节点的导出代码查看、复制和定位。
2. 两份明确的导出快照之间的文本差异。
3. 后续受控的代码草稿与检查结果展示。

现有 nodeIdMap 只有 elementId/selector，不包含源代码行列或 AST 映射。源码定位需补充映射；把代码改动反向应用到设计文档还需新的受限转换与校验，不能把接入 Monaco 当成已经完成双向同步。

需要处理焦点与 Ctrl/Cmd+Z 路由、中文输入法、主题、worker URL/CSP、模型 URI、编辑器/model 的释放、文档切换和大文件预算。Monaco 的文本历史与当前设计文档的历史应各有明确所有者；所有设计修改仍进入已有 Editor.change 和内核校验。

推荐按需动态加载，把语言服务限定到真正需要的 HTML/CSS/JSON 等范围。当前导出是明确标注 approximate 的 HTML/CSS，不能让代码视图暗示与原生渲染像素等价。Monaco 不执行 HTML，也不会自动运行 VS Code 插件。[官方 FAQ](https://github.com/microsoft/monaco-editor#faq)

**6. 代码体积也属于接入成本**

对固定的 VS Code 源码做 TypeScript 5.9.3 isolated transpile，再用 Bun 1.4.0 压缩打包指定导出；Monaco 使用正式 ESM 包。以下是该构建方式的独立结果，KB/MB 使用十进制。未采用 VS Code 自己的完整构建流程；实际项目的 const enum 处理、共享依赖消除和优化策略可能改变数字。

| 独立入口 | 压缩后的未 gzip 文件合计 | 各文件 gzip 合计 |
| --- | ---: | ---: |
| DisposableStore / MutableDisposable / toDisposable | 14.6 KB | 4.0 KB |
| Delayer / Throttler / Limiter | 112.0 KB | 34.5 KB |
| fuzzyScore / createMatches | 81.2 KB | 25.3 KB |
| IndexTreeModel | 139.1 KB | 42.8 KB |
| RangeMap | 2.2 KB | 0.9 KB |
| stringDiff | 89.3 KB | 27.2 KB |
| Monaco editor API，含输出 CSS | 2.86 MB | 0.728 MB |
| Monaco 通用 editor worker，另计 | 0.312 MB | 0.097 MB |

Monaco 的 HTML/CSS/JSON/TS 等语言 worker 不在该数字里。各入口有共享依赖，不能把表格简单相加当作接入后净增长。文件大小也不是解析时延或运行时内存；本次未测 Electron 启动或 RSS。

src/vs 下的实现适合固定 commit 后有选择地抽取和维护，不应被当作稳定的第三方公共组件 API。优先保留项目自己的薄接口，避免内部 import 链扩散。Monaco 则使用其公开 API。

**7. 搜索与差异：提升功能，不能默认获得性能收益**

在预先小写化的 20,000 个合成英文名称中，查询 button：子串过滤约 0.389 ms，fuzzyScore 计分约 12.911 ms。未包括排序和匹配高亮，因此不是完整模糊搜索的总成本。

这不是相同语义算法的胜负比较：fuzzyScore 可以匹配 btn → Button，做缩写评分；当前 includes 是连续子串。上游实现还把 pattern 和 word 的计算长度限制为 128，不能不加处理地替换当前任意长度名称搜索；中文拼音缩写也需要另外的规则或别名，不能从英文驼峰匹配能力推定。

建议作为可选搜索模式或有限候选的排序阶段，预先缓存名称，限制候选数量。暂不改变图层搜索的既有可见性与祖先上下文规则。

本项目 [document-diff.ts](../../frontend/design-client/src/document-diff.ts) 按稳定节点 ID 分类位置、样式、文本和父关系。VS Code 的文本 diff 可以细化单个文本字段或代码导出，但不能替代这种结构化差异，也不能替换 FD 的资源省略、历史恢复 CAS 或撤销事务。大型差异仍需要输入预算和可取消工作边界。

**8. 暂不值得整体引入的架构**

- 整个 Workbench：大量服务、配置、菜单、主题、布局和生命周期耦合，且与现有 React UI 重叠。
- ContextKey/完整命令服务：可借鉴声明式 enablement，但当前 editable/modal/property preview/session/revision 的执行时校验仍必须存在；UI 可用状态不是操作授权。
- FileService/WorkingCopy：本项目已有浏览器 IndexedDB、桌面 SQLite、FD/资源、恢复和存储修订号，普通文本文件 dirty/save 语义不能直接覆盖。
- Extension Host：有可参考的进程边界，但尚无需求证明值得增加完整插件平台。本项目已经有导入 Worker、准备 Worker、Rust 子进程；已有隔离应继续验证，而非因为 VS Code 有一套就重建。
- 全部语言服务、调试、终端和 Git 工作台：只有明确要扩展为代码 IDE 时才值得另做产品范围评估。

[官方架构说明](https://github.com/microsoft/vscode/wiki/Source-Code-Organization)明确区分 base、platform、editor、workbench 和宿主入口，适合用来约束复用边界。[Extension Host 文档](https://code.visualstudio.com/api/advanced-topics/extension-host)说明了本地、网页与远程扩展运行环境。

**9. 推荐接入顺序与验证**

先修资源面板重复父索引，再按组件/文档库规模增加窗口化；然后完成图层局部折叠/展开和真实交互对照。在这个过程中只对新拥有的订阅/任务接入小范围生命周期工具。若需要代码工作区，再单独增加懒加载 Monaco 只读视图。

正式提交前应分别验证：完整遍历 oracle 对照、搜索和重挂、撤销/重做、会话切换与旧回调、键盘/IME/焦点、窗口化拖拽和可访问性；任务工具验证每个 Promise 的终态、错误与取消；Monaco 验证 worker 加载和模型释放。实际 GPU/FPS、长期内存和启动时间属于另外的设备验收。

本次已经完成：固定源码读取、独立打包、CPU 原型与行为断言、原始结果保存。未做产品 typecheck/测试、React 挂载、浏览器/Electron/GPU、堆快照或跨平台验收。所有工程工期与建议都是据此作出的判断。

Code-OSS 相关源码采用 [MIT 许可](https://github.com/microsoft/vscode/blob/8c643aa26a949a1ed2c00a7830357e4a580954e0/LICENSE.txt)。正式复制时保留版权、许可和涉及的第三方声明，固定上游版本并记录修改。本研究不是微软发行版、品牌、市场服务或所有扩展的授权判断。

**10. 复现与证据**

原始结果：[probe-results.json](probe-results.json)、[tree-comparison.json](tree-comparison.json)、[bundle-sizes.json](bundle-sizes.json)。第二轮树比较加入优化后的数组方案，替代第一轮树计时；资源和模糊搜索分支没有改动，保留第一轮结果。最终脚本包含全部方案。

在仓库根目录运行，使用一个新的临时目录：

```sh
python3 testing/analysis-vscode-reuse-20261023/prepare-upstream.py /tmp/futureox-vscode-rerun
npm ci --prefix /tmp/futureox-vscode-rerun/tooling --ignore-scripts --no-audit --no-fund
bun testing/analysis-vscode-reuse-20261023/build-probes.ts /tmp/futureox-vscode-rerun /tmp/futureox-vscode-results
bun build testing/analysis-vscode-reuse-20261023/bench-reuse.ts --target=node --outfile=/tmp/futureox-vscode-rerun/bench-reuse.mjs
node /tmp/futureox-vscode-rerun/bench-reuse.mjs /tmp/futureox-vscode-rerun /tmp/futureox-vscode-results
node /tmp/futureox-vscode-rerun/bench-reuse.mjs /tmp/futureox-vscode-rerun /tmp/futureox-vscode-results --tree-only
```

下载脚本核对 Git blob SHA；依赖由保存的 tooling package-lock 固定。原始转译时为适配已提供的工具内容，源文件末尾空白曾被规范化，算法没有更改。复现下载恢复上游原字节。计时不要与其他基准或编译并行。源码哈希、CPU、编译方式和范围记录在 manifest 中。
