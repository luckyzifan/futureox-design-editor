# 源转换重复工作优化与实际验证

2026-10-31。源码已在工作区修改，未部署到运行中的 Electron 应用。本轮基线为 `baseline.json` 的 commit、文件 hash 和冻结 release 二进制；最终保留组合为 `selected.json`。逐项核对见 [AUDIT.md](AUDIT.md)。

## 结论

清单中存在可优化的重复扫描、复制、分配和文件打开，但不能直接删除 `source_snapshot::read` 的完整文档读取。当前 Engine 的校验、布局、完整渲染回退和修改需要完整文档；metadata 不是可渲染模型。原先约 3.88 秒记录的是完整 native-load，不能全部算作读取成本。有序分批转换和两个 CPU 转换槽也已经存在，剩余大头是完整结果物化、快照写入及重新装载。

最终实测**没有证明整个启动明显提速**。最明确的局部收益是布局读取：最终两组均值约 **37.0 → 6.75 ms**。完整快照始终 **300,408,797 字节、124,447 节点、306 个根**，所有新旧快照逐字节一致。原件 SHA-256 始终为 `b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12`。

## 保留的修改

- `large_document/projection.rs`：用一次 `RootFacts` 遍历收集引用和准入信息，保留“所有 JSON 字段的引用”与“仅 layers 链上的组件/私有兼容标记”两种范围；批次和依赖解析消费同一结果。删除默认窗口路径无人使用的原始 root 返回值，直接转移所有权，避免整棵 `root.clone()`。调用方及测试同步更新。
- `scene_store/record_node.rs` 与 `scene_store.rs`：通过只读序列化视图省略顶层 `vectorGeometry`，几何单独采用原 packed 编码。几何节点不再仅为清空这个字段而复制整个 Node；共享图片需要的原有副本仍保留。Node 的其余序列化规则、字段顺序、原始浮点和 Merkle 回执不变。
- `large_document/scene.rs`：窗口及共享节点/字体的字节计数不再分配立即丢弃的 JSON Vec，仍使用同一 serde 编码和原有准入额度；依赖根列表用有序 Vec 加成员 Set 去重，保持原顺序，空输入不建 Set。未声称完全取消序列化或按 revision 缓存所有长度。
- `large_document/index.rs`、`canvas_layout.rs`：布局过程按 part 复用索引和源文件句柄，每根只读取一次 Entry，再读取 frame 与 rotation。Changes 修订映射、有限读取、取消和几何验证保留。
- 两个原有往返测试仍期待 FXSCENE1，而冻结基线与实际文件早已是 FXSCENE4；仅把断言更新到实际格式。`preexisting-format-fixture.json` 保留证据，没有修改文件格式。

另一任务在共享的 `projection.rs` 中增加了 `CORE_SOURCE_LEGACY_REFS=1` 对照分支，保留了旧扫描和 root 克隆。本轮保留该分支，最终测量显式设置 `CORE_SOURCE_LEGACY_REFS=0`；不把该对照开关算作本轮实现。其 metadata-only 实验曾并行出现、真实装载失败后撤销，本轮未采用；冻结的准备器二进制也不含该实验入口。

## 未采用与剩余项

Entry 直接流式写入候选保持字节一致，但初测和追加组的 source-open 均值分别回退约 6.87% 和 3.47%，未证明收益，**已撤回该部分**，恢复原 Vec 编码。保留失败候选 `index-streaming-candidate.rs`、全部日志和结果，没有用最终较快样本覆盖早期回退。

尚未实施：大 Symbol 索引的磁盘/分片回退、完整源惰性物化、紧凑二进制索引、泛型冲突合并的全部类型化、密度/相位与裁切分离、完整网格覆盖回执、GPU ID 反向索引、光栅分桶。未知字段合并、历史补洞、采样和覆盖 guard 均未削弱。

## 测量

使用真实 `/Users/Apple/Downloads/拓扑素材.sketch`，同一固定 owner/session、完整快照及 native 生产入口。macOS，Rust 1.96.1 release，最多两个构建作业，Node 24.12.0。进程新建，但未清空 OS 文件缓存；以下是 wall 时间，不能当成 CPU 栈 profile、GPU 完成、真实 GUI 呈现或物理延迟。

三组记录分别保留：

1. `startup-results.json`：最初全部候选的 ABAB 两对，阶段有回退及较大装载波动。
2. `confirmation-summary.json`：追加 ABBA，相关后台活跃检测为 0；流式索引仍没有收益，因此撤回。
3. `selected-confirmation-summary.json`：最终组合 ABBA。一次基线采样检测到既有 Electron Renderer 55.6% CPU 活跃，原样保留在 `selected-confirmation-runs.json`，不能当成完全无干扰性能门。

最终组均值（每种两个样本，毫秒）：

| 阶段 | 基线 | 最终组合 | 观测变化 |
| --- | ---: | ---: | ---: |
| source-open | 7,428.06 | 7,223.11 | -2.76% |
| source-layout | 37.03 | 6.75 | -81.77% |
| whole-source-snapshot | 9,969.61 | 9,902.19 | -0.68% |
| native-source-load | 2,353.80 | 2,611.12 | +10.93% |
| 四阶段合计 | 19,788.50 | 19,743.17 | -0.23% |

装载路径及磁盘字节没有相应算法变化，该阶段的上下波动不能归因于本轮写入优化。合计差异不足以支持整个启动提速结论；布局阶段减少打开和解析的结果在多轮中一致，但只占启动很小部分。

## 正确性与失败边界

- 最终源文档 suite：**67 通过、11 ignored**，日志 `selected-backend-tests.log`。
- 存储 suite：**16 通过、1 ignored**，`store-tests-final.log`。
- 准备 suite：**19 通过**，`preparation-tests.log`。
- 源编译 suite：**14 通过、1 ignored**，`source-compile-tests.log`。
- 合计 **116 项已执行通过**，13 个显式大样本/专项用例未运行，未计入通过。早期 FXSCENE1 断言失败、测试类型标注修正和已撤回候选的日志均保留。
- 每组真实启动都核对完整快照字节、Descriptor/Merkle 回执和布局目录。完整快照 SHA-256 为 `30d4106011c5fe4ccbe4b895005dd3ebc3158814e3315f53fe7b5e3576f06f4e`。
- `same-snapshot-pixels-overview.json`：同一冻结快照经新旧准备器绘制“主框架03”的 384×217 整板，真实内容 PNG 字节完全一致，SHA-256 为 `b7b33ac9a511844bb7f0207e6ee36ab348731dc903943b64924061f3319a941a`。最初 96×64 裁切主要是背景，未把它当作内容覆盖证明。
- “拼搭样式二”在两版均因 5162×2784 图片解码预算拒绝；保留为该像素用例的 FAIL/共同限制，未提高额度、降低分辨率或把拒绝当像素通过。

![相同快照整板 CPU 对照](candidate-cpu-overview-0.png)

本轮 kernel 改动只在 `cfg(not(target_arch="wasm32"))` 的原生 scene_store 中，实际 native 产品已经重建。没有浏览器/WASM 改动，不把这些原生测试称为 WASM 验收。G2/G5 全编辑器连续交互、完整 HDR/导出/持久化矩阵、REAL117×10、600 张图标和 GPU/设备压力均未在本轮执行；本轮只证明所列 CPU、存储、原生转换及像素范围。G4 全生产性能门没有通过声明。

## 复现与回滚

实际命令和退出码见 `commands.json`。基本入口：

```sh
python3 testing/verification-source-work-reuse-20261031/run-regressions.py
/Users/Apple/.nvm/versions/node/v24.12.0/bin/node testing/verification-source-work-reuse-20261031/compare-snapshot.mjs --overview
/Users/Apple/.nvm/versions/node/v24.12.0/bin/node testing/verification-source-work-reuse-20261031/startup-ab.mjs /absolute/products /absolute/fresh-output
```

启动脚本拒绝覆盖既有输出目录。完整归档副本和索引 spool 是测试生成的中间物；通过字节核对后已清理部分 `recovery/`，日志、布局、Descriptor、hash 和基线 1 的快照保留。源原件从未修改。计时与 CPU 像素回放分开执行。

前置 hash、最终 hash、新增文件和证据清单见 `manifest.json`。未打包/发布，无需重复应用源码。回滚只恢复内容仍等于相应候选 hash 的文件；`projection.rs` 还包含并行加入的比较开关，必须按本轮 hunk 合并回滚，不能用整个旧文件覆盖。`before/` 是原前置，`measured-source/` 保存了经 hash 验证的原始测量版本；不使用整库 reset。
