# 真实下载文件的渲染优化 A/B（2026-10-31）

## 测试方法

- 原始文件：`/Users/Apple/Downloads/拓扑素材.sketch`（118,272,240 字节，124,447 个转换后节点）和 `/Users/Apple/Downloads/117.sketch`（5,013,257 字节）。原始 hash 均未改变。
- 对照使用同一 release 后端 `c1df1f443dfa319c6622acb54a40ce3c85363c029f9fe64dd06db7b3cdb78f57` 和同一 `design-prepare` `fdcd36b2ea761d52b63b138b25ad7c806e9ab3035992ccdd2dccf4d3a451f36f`。
- ABBA 顺序分别运行默认 `RootFacts` 与 `CORE_SOURCE_LEGACY_REFS=1` 的旧版重复扫描。旧分支只用于对照，不是默认路径。
- 每个用例都执行源打开、完整快照和原生加载，不用单个函数估算代替生产路径。独立阶段波动不直接归因于算法。

## 结果

### metadata-only 候选：失败，已撤销

首次实现只读 metadata 和 stage，单元测试通过，但真实 `loadSourceSnapshot` 失败为 `Missing node`。后续 `load_source_document` 必须执行完整文档校验，不能只传 metadata。该候选源码和二进制已撤销，没有把它计为加速。

### RootFacts：大拓扑文件未证明加速

两次基线与两次旧实现对比如下，所有运行均通过且原件未变：

| 阶段 | RootFacts 基线中位（ms） | 旧实现中位（ms） | 相对变化 | 判断 |
| --- | ---: | ---: | --- | --- |
| source-open | 9212.71 | 8965.54 | -2.68% | 新实现较快，但规模/顺序效应需另测 |
| whole-source-snapshot | 9210.17 | 9292.08 | +0.89% | 新实现反而较慢，未证明加速 |
| native-source-load | 2888.54 | 2306.41 | -20.15% | 独立阶段，不归因于 RootFacts |

详见 `root-facts-ab/ab-summary.json`。

### RootFacts：117 的小幅局部收益

首轮快照阶段约快 1.93%，追加独立第二轮约快 4.11%。source-open 第二轮只差 0.04%，原生加载波动较大，均不据此扩大结论。可以把 RootFacts 视为“117 快照阶段的小幅收益候选”，不能据此宣称整个启动或所有文件加速。

详见 `root-facts-117-ab/ab-summary.json` 和 `root-facts-117-ab-2/ab-summary.json`。

## 正确性检查

- `cargo test -p futureox-design-kernel --lib preparation::source_snapshot::tests --offline -j 2`：候选单元测试通过，但后续真实流程证明不足，已撤销。
- `cargo test -p futureox-design-desktop-backend --lib large_document --offline -j 2`：默认 RootFacts 68 通过、11 ignored。
- `CORE_SOURCE_LEGACY_REFS=1 cargo test -p futureox-design-desktop-backend --lib large_document --offline -j 2`：旧实现同样 68 通过、11 ignored，保证对照语义一致。
- release 后端首次后台构建超过 300 秒，随后增量构建完成并固定产物；没有把构建超时算作性能结果。

## 边界

## GPU/渲染候选的真实 Electron ABBA

使用当前安装版 `frontend/design-desktop/dist`，build-manifest SHA-256 `6179e88e45206b5691cd49158970353254bbba9d0cd398822cfacfe82f70b867`，并用其自带 sources 清单校验运行产物。每组四次交替运行，基线关闭、候选开启；下表负百分比表示更快，正百分比表示更慢。完整逐次数据见各目录的 `ab-summary.json`。

| 候选 | 导入 | 平移停止 | 缩放停止 | 根拖动停止 | 嵌套停止 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Gaussian prefix+regions | -1.33% | -8.80% | +79.69% | +9.18% | +17.94% |
| Coherent subtrees | -2.20% | +1.07% | +1.79% | -1.46% | +44.87% |
| Image asset residency | +15.41% | -10.45% | +5.35% | -0.66% | -19.38% |

高斯组在 125% 缩放约快 5.28%，950% 约快 0.68%，40.4% 约快 1.91%，但拖动和嵌套回退，不能称为整体收益。3200% 在基线和候选中均因 `GPU surface budget exceeded` 失败，属于共同限制，未形成通过对照。

静态子树的嵌套回退包含一个 129 ms 离群样本，仍需单独复核；它没有证明整体收益。图片驻留的嵌套中位时间较低，但两组配对一快一慢，导入还出现一次明显回退，因此不能推广为稳定加速。

测试脚本为 `ab-render-candidate.mjs`。全部使用原始 `拓扑素材.sketch`，`VERIFY_TIMING_ONLY=1` 避免截屏 IPC 干扰，后两组跳过共同的 3200% 预算失败点。所有运行均保持源文件不变。

## 论文方向与追加实测

查阅了以下公开论文资料并映射到已有候选，未把论文架构相似当作实现或性能证明：

- [Nehab & Hoppe, Random-access rendering of general vector graphics](https://www.microsoft.com/en-us/research/wp-content/uploads/2008/08/NehHop08.pdf)：单元格局部描述与自适应采样，对应当前瓦片/区间程序，而非另建一套采样语义。
- [Ganacim et al., Massively-parallel vector graphics](https://dl.acm.org/doi/10.1145/2661229.2661274)：加速结构和细粒度工作消减，对应常量覆盖与分桶思路。
- [Dokter et al., Hierarchical Rasterization of Curved Primitives](https://onlinelibrary.wiley.com/doi/abs/10.1111/cgf.13622)：局部层次化光栅，对应范围索引与局部工作，而不是直接替换现有 f64 区间。
- [Crow, Summed-Area Tables for Texture Mapping](https://dl.acm.org/doi/pdf/10.1145/800031.808600)：积分/前缀滤波，已由前面的 Gaussian prefix/regions 对照覆盖，没有重复宣称新算法。

| 候选 | 导入 | 平移停止 | 缩放停止 | 根拖动停止 | 嵌套停止 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Constant coverage | -2.61% | -3.79% | +0.41% | -1.20% | +10.44% |
| Packed coverage（四相合并） | -3.92% | -4.25% | +15.04% | +3.30% | -23.03% |

常量覆盖仍只有局部收益。四相合并覆盖在导入、平移和嵌套上有较明确的局部收益，但反向缩放和根拖动回退，不能整体推广；后续若要保留，只应针对这些场景继续做同像素、同设备、更多重复次数的验证。详见 `constant-coverage-ab/` 与 `packed-coverage-ab/`。

## 边界

源转换部分只覆盖源打开、快照和原生加载；GPU 部分使用真实 Electron 回放的 UI/composer 回执，不是物理输入到光子或完整 G2/G5。RootFacts 的小幅局部收益不等于完整启动达标；GPU 候选也没有证明整体提速。启动的主要屏障仍是完整源物化、快照写入及后续 GPU 工作。`native-source-startup.mjs` 的 `SOURCE_FILE` 仅用于选择同机已存在的测试原件，不上传文件。
