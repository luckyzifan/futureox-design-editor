# 拓扑 Sketch 渲染日志分析（2026-10-23）

本轮是既有日志和源码诊断，没有修改产品源码、重启应用、导入/编辑用户文件或运行新的压力测试。时间均为北京时间。观察范围以已冻结日志字节前缀为准，不把后续追加内容并入统计。

## 结论

拓扑素材已经进入局部画布，但编辑后的文档同步、场景重编译、效果渲染图处理，以及新操作到来后旧任务的退出仍有明显长尾。单次属性修改从操作开始到后续预览结果返回 **5.648 秒**。这些阶段耗时有直接记录；进一步分解到 Rust 函数、JS 调用栈和 GPU shader 仍需要采样，不能把所有 wall 时间都叫 GPU 算力或主线程 CPU 时间。

本轮重点为 G0/G2 的编辑停顿、缩放响应；G4/G6 用于区分证据层级及运行版本。没有更改预算、精度或实验配置。

> 后续样本核对更正：4,022 节点属于后续投影缓存，不能代表该段成功显示的画布。正常“控件”页是 773 原始节点、953 派生节点。详见[火焰图与修复记录](../../docs/TOPOLOGY_RENDERING_REPAIR_20261023.zh-CN.md)。下文保留当时读取缓存的原始统计，相关工作集归因由此更正。

## 输入、会话与证据

- 原文件：`/Users/Apple/Downloads/拓扑素材.sketch`，118,272,240 字节（112.79 MiB）；SHA-256 `b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12`。
- ZIP 中央目录：64 个成员、3 个页面 JSON，总展开 831,806,447 字节（793.27 MiB），最大成员 699,402,701 字节（667.00 MiB）。本轮只读中央目录和原文件 hash，没有解压巨型页面。
- 当前应用进程 stdout/stderr 指向桌面的 `core-topology-refactor-gui-fixed-20261023.log`。其启动 profile 的 `recovery-v1/large-documents/.../journal.json` 记录相同文件名和源 hash，因此可以把这个应用实例与该素材关联起来。
- 主日志冻结范围：21:17:04.488–21:28:54.015，共 27,312 条诊断；包含一个前置画布会话。拓扑画布会话为 **925899771847**，21:20:11.883 开始，原生 preparation channel 为 **146077305183090**。
- 读取该 profile 的 `canvas-scene.json`：29,969,929 字节，4,022 节点、2 个页面记录，其中一个页面为空；3,591 vector、340 group、60 text、30 rectangle、1 frame；效果数组共 39 blur、27 background-blur、121 shadow。它是导入工作集快照，不是原始文件全量对象数，也不保证每个效果当前可见或启用。
- 工作集快照 SHA-256 `5aeb2a0e49548e0e9bf59053730a02fb558a83a4530bcc0a4223098b55024a27`。源文件和私有场景内容未复制进本报告目录。
- 日志 producer commit 为 `c65ed474141825968cb5e032d6add4cecd584a6d`，source digest 为 `b87f1ebbfcb5724bd71c575206a43ee03ba965ceb3a1b643397dc494c52b3927`，WASM 输入 digest 为 `e40e882a70e163b2fdba7345f9a55d59c780fb4822b684f763938812f386abee`。工作区有大量未提交改动且另有构建/测试活动；commit 和构建输入 digest 不是实际运行二进制一致性的完整证明。
- 运行配置记录：WebGPU 驱动、managed、四个相关样本、1 GiB 自动 working budget，softwareRaster=0、readback=0。记录没有硬件 adapter 名称；GPU timestamp 查询关闭，不能声称测得真实 shader 执行时间。

完整聚合与日志行号见 [主日志分析](core-topology-refactor-gui-fixed-20261023.json)、[拓扑会话统计](session-summary.json)、[关联事件](correlated-evidence.json)。各日志分析 JSON 保存读取前缀的字节数与 SHA-256，可排除实时追加对本轮数字的影响。

## 1. 属性修改经过多段昂贵同步，结果返回约 5.65 秒

同一 operation owner `61734539568` / operation `1` / authored revision `2`：

| 时间 | 事件 | 实测 |
| --- | --- | --- |
| 21:22:15.321 | property 操作开始，targetCount=1 | 原日志 3345 行 |
| 21:22:16.111 | 操作提交 | 操作 span 790 ms；对应 layer action 792 ms |
| 21:22:16.285 | UI frame-window | 记录一次 1,174.1 ms 回调间隔 |
| 21:22:16.448 | request 220，documentEnvelope=2 | 原生文档补丁同步 |
| 21:22:18.942 | methodCode=4 返回 | `apply_document_patch_with_damage` 2,485.4 ms |
| 21:22:18.952 | request 220 结果 | roundtrip 2,503 ms；drawCalls=0、previewTiles=0 |
| 21:22:18.953 | request 221 | 同一 operation/revision 的预览 |
| 21:22:20.143 | 场景编译完成 | compile 1,184.3 ms |
| 21:22:20.969 | request 221 结果 | roundtrip 2,015.5 ms，graph 801.9 ms，finish 9.7 ms |

操作开始至 request 221 返回为 5,648 ms；提交之后仍有 4,858 ms。request 220 与 221 是串接的不同工作，不是把同一请求重叠子阶段相加。日志中的 operation presentation ACK 在 21:22:19.030 已出现，早于 request 221 返回；它不能作为完整新画面已显示的证明。

原生边界进一步缩小范围：preparation 447 的 Node 入队至写入约 1.745 ms，至 Rust 首字节约 2,408.649 ms；主要时间落在发送给原生进程后、返回首字节前。这个区间包含传输/读取/原生解析与计算，不是精确 Rust CPU 采样。

源码对应：

- [Editor.change](../../frontend/design-client/src/engine.ts)：同步 draft、局部编辑证明、组件处理/布局、验证、history、publish。普通 change 没有和 preview/commit 同等细分的 CPU spans；现有日志不能把 790 ms 精确分配到每个函数。
- [render-worker 补丁处理](../../frontend/design-client/src/kernel/render-worker.ts)：等待 `apply_document_patch_with_damage`，随后清空 `compiledScene`。
- [Rust Engine patch/install](../../design-studio/crates/design-kernel/src/renderer.rs)：不满足 translation/paint retention 的补丁进入 `install_document`，重新验证、统计序列化大小、建索引、使 layout/camera 缓存失效。这是明确的潜在放大路径；本日志没有记录具体分支命中，不能直接宣称本次一定走了全量 install。

**优先级 P0：** 先在这条真实单对象修改链路补齐子阶段采样，确认为何没有落入更小的增量更新；保留权威验证、历史与依赖失效语义。

## 2. 编译长尾与精确图块缓存没有覆盖当前显示结果

仅拓扑会话：484 次 compile 完成，median 21.3 ms，P95 254.4 ms，最大 1,184.3 ms。221 个成功 request result 的 roundtrip median 31 ms、P95 811.4 ms、最大 2,503 ms，包含补丁同步等不同 request 类型，不能当作纯绘制 FPS。

391 个 tile 记录全部 `tileCacheDecision=5`（普通 miss），166 个携带缓存统计的 result 全部 `tileCacheHits=0`、`certifiedTileHits=0`、`tileCacheBytes=1024`。源码中 `OwnerTileCache.ownerMetadataBytes=1024`，说明这层 CPU 精确图块缓存没有驻留有效图块 payload。

[ownsExactTileBytes](../../frontend/design-client/src/kernel/owner-tile-cache.ts) 只接受独立 CPU buffer，明确排除 bitmap 和 gpuTile；[render-worker 插入条件](../../frontend/design-client/src/kernel/render-worker.ts) 还要求一次完整图块渲染及有效 witness。现有结果符合 GPU 显示路径没有进入这层缓存的情况。这是缓存适用范围问题，不能推出 resident compositor、GPU 材质或原生 geometry 所有缓存都无效，也不能把纹理直接塞入 CPU cache 绕过所有权限制。

**优先级 P1：** 针对实际 resident GPU 结果检查同文档/revision/采样相位的复用与失效，另统计编译/材质缓存命中；不要只凭新增 CPU cache 声称导航重算减少。

## 3. 效果图处理开销大，图块小也可能很慢

两条具体证据：

| 请求 / tile | compile | graph wall | finish | 工作量 |
| --- | ---: | ---: | ---: | --- |
| 227，514×514，日志 3725 行 | 59.1 ms | **747.9 ms** | 45.5 ms | 40 packet node visits，4 blur / 6 shadow visits，601 draws，34 submissions，84 material builds，7.55 MB upload |
| 24，第一个列图块，514×514，日志 961 行 | 71.8 ms | **379.5 ms** | 17.7 ms | 21 node visits，2 blur / 1 shadow，363 draws，30 submissions；material field build 162.5 ms、82.20 MB upload |

另一个缩小视图图块 request 261 有 551 node visits、7,304 draws、70 submissions、928 material builds；图块面积小并不代表效果/覆盖/材质工作量小。

`graphMs` 来自 [GPU renderer](../../frontend/design-client/src/kernel/gpu/renderer.ts) 的 wall 计时，包含图构建/编码、字段构建、yield 和可能的驱动等待；本会话 `deviceGpuTimingEnabled=0`，无法从中分出纯 GPU 时间。部分 tile compile 与前一 tile 图处理并行，不能用子阶段之和替代 `pipelineWallMs`。

日志峰值纹理计数约 **280.81 MiB**，配置预算 **1,024 MiB**，本拓扑会话没有记录 resource-budget 或 device-lost 分类。这只是应用纹理账本，不能等同实测总 VRAM，但现有证据不支持把当前主要瓶颈归咎于触顶。

**优先级 P1：** 对真实慢图块采样材质字段、效果 pass 数、编码/提交与 GPU 完成等待，优先减少重复字段和重复效果处理，保持当前显示精度与效果。

## 4. 取消正确分类，但长任务退出仍不及时

拓扑会话有 63 条 `error`，对应 41 个不同 requestId，全部为 category=1/code=1，即 `PREVIEW_CANCELLED`。13 条 failure-origin 是相同取消的来源记录，不能再算作独立崩溃。前置会话另有一条 main reasonCode=3，对应 client dispose/reset，不是 GPU 内存错误。

首次预览 request 3：21:20:16.257 开始执行，compile 794.4 ms 后进入 graph；21:20:24.982 收到取消，21:20:26.143 才报告 graph-stage cancellation，21:20:26.144 退出。该请求占执行区间 **9,886.6 ms**，取消至退出仍约 **1,162 ms**。它没有成功 result，不能冒充已完成首帧时间；也不能把整段都归为 shader 耗时。

[PreparationChannel](../../frontend/design-client/src/kernel/preparation-channel.ts) 明确规定已发出的同步原生工作无法中断，取消消费者后仍要等物理回复作为传输边界；本次首次预览取消发生在 graph，尚需单独定位 graph 内退出延迟，不能混同原生 preparation 取消。

**优先级 P1：** 定位 graph 和长原生工作各自可安全让位的位置；保留完成边界和资源存活规则，避免取消后仍占据执行权。

## 5. UI 停顿是真的，不能把全段最大值都归因于渲染

- 整个主日志 14 次 >250 ms UI 间隔；其中拓扑会话 **13 次**，最长 **2,008.8 ms**。
- 拓扑会话中，至少 4 个带已关联滚轮/缩放输入的窗口各发生一次 stall：283.4、450.2、341.0、274.9 ms（原日志 519、528、1348、1682 行）。这直接违反仓库活跃交互 uiStalls=0 的要求。
- 属性修改窗口还有前述 1,174.1 ms 停顿。最大 2,008.8 ms 所在窗口没有 inputPresent 或 submit，不具备把它单独归因于 GPU 渲染的证据。
- 输入到软件提交最大 **1,134.6 ms**；它不是输入到光子的物理延迟，也不保证新内容已经画完。
- 804 次 staleCameraSubmits，transformMismatch=0、outOfOrderSubmits=0。旧请求提交需要结合帧/身份判断；不能仅凭计数宣称 804 次可见抖动。
- Pointer move CPU spans 最大 25 ms，不能解释全部 0.3–2 s UI 间隔。常规属性修改、React 提交、全量派生/序列化、GC 以及系统调度仍需主线程采样。

## 与其他日志的区别

- 21:08 的 `core-topology-refactor-final-20261023.log` 虽然速度很好，但 152 个 tile 的 packetNodeVisits 都为 0、峰值纹理计数仅 16 字节；它没有实际复杂内容工作量证据，不能拿来证明此次拓扑渲染已经顺畅。
- 上午 `core-render-detail13.log` 另有 category=2/code=41，即“GPU 积分模糊半径超过 512 像素”，2 条 origin、4 条 error；这是已知效果支持边界，不是显存超限。该文件没有和本次拓扑工作集建立身份对应，不能算作此素材当前会话的失败。
- 下午其他会话、退出日志和不同构建的统计只作线索，不构成同输入同动作 A/B。

## 验证状态和后续顺序

1. G2：现有日志已观察到活跃交互 >250 ms 停顿，相关子项 **FAIL**。真实 GUI 连续帧、清晰度、选择框同帧及完整动作链 **NOT_RUN**，不作全应用验收。
2. G4：阶段 wall 归因有证据；函数级 CPU/GPU 根因与优化收益 **BLOCKED**，缺少匹配采样和受控 A/B。日志明细开启自身的开销未剥离。
3. G6：输入 hash、会话、producer 字段和日志前缀 hash 已记录；运行二进制与全部实验开关的一致性未完整证实，不声称构建复现门通过。
4. G3/G5/G7/G8：本轮没有实现改动，也没有重跑精度、导出、保存、固定规模矩阵、取消/晚回压力和协作门，均不新增通过声明。

建议实施顺序：**单对象编辑的补丁/重编译链路 → GPU resident 复用覆盖 → 慢效果图块 → 长任务取消响应 → 补齐 UI/像素关联测量**。每项都用同一拓扑工作集、相同动作和原质量配置做旧失败/新通过，不能靠提升预算或省略效果替代修复。

## 重算

从仓库根目录运行：

```sh
python3 testing/analysis-topology-render-20261023/analyze.py /absolute/path/to/captured.log
```

脚本只读指定日志，并向本目录写聚合结果；读取最后一个完整换行之前的字节并计算摘要。对实时日志重跑会产生新的窗口，不能覆盖旧结果后仍沿用旧统计范围。
