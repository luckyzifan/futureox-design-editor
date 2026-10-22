# Deep2：复杂实机 CPU 火焰图（整体验收仍失败）

117 与 FIG 各有六轮真实输入：366 次滚轮、960 次 Space 平移。图严格绑定 `deep2-desktop` 及对应 run 的 runtime manifest；40 份 JS/source-map 资产分别与两份 manifest 核对后复制到 ignored runtime 目录，未使用后续 checkout 源码替代。独立 host 的 WASM 为 `40748786a93f9bdf2775b210904d787fa9b069fa46e565035cd980bcab36fe1f`；build-manifest SHA-256 为 `32d04a4cddfeb45df34b2b3867ee0d609d1d8d8d64d9029ade012fa28329f030`。

## 三个有效目标与一个完整排除

严格 `analyze.mjs` 首次分析全部四目标时失败：FIG Worker 原始 profile 在 sample 357 有一个 **−1 µs timeDelta**。原文件 SHA-256 为 `18c2837cbd6a68fcb6d7b0824b0257770f28938c33ef9fd6048be0f41db32ff2`，保留原字节，没有取绝对值、置零或只删除该样本。随后使用原生成器分别选择 117 两个目标、FIG renderer，合并三个有效图；FIG Worker 完整排除，原因和原始负值在 summary 中保留，不计任何 CPU 总量。缺失 Worker 图不是零 CPU。

| 有效目标 | profile 窗口 ms | active CPU ms | idle ms | profile SHA-256 |
| --- | ---: | ---: | ---: | --- |
| 117 renderer | 40049.561 | 8104.102 | 28355.509 | `3c4cf79b995be679b0eedd21f6da13a4d29ad29c6aff382c7460902b57ec3e0e` |
| 117 render-worker | 40049.582 | 6575.857 | 33341.177 | `9b036ae3a954e5a754c7e0339e31166a1eceec3f455350d14fdb20dbfe577574` |
| fig renderer | 24769.47 | 8825.015 | 11773.337 | `3635946c21f0e85247d7c79507af0418148c82da1fd075e13ad79b08c66c7973` |

主/Worker 窗口不能相加成整机延迟；idle 不等于 GPU 独占时间。这些启用 profile、诊断和实际 readback 的操作不是干净延迟基准。SVG 宽度是累计活动样本，不是时间轴或单次 long task。

## scene 借用的实际采样变化

| renderer 调用，inclusive ms | 117 Deep1 | 117 Deep2 | FIG Deep1 | FIG Deep2 |
| --- | ---: | ---: | ---: | ---: |
| scene | 102.952 | 未采到 | 611.221 | 未采到 |
| buildInteractionDependencyScope | 72.880 | 90.537 | 339.432 | 756.821 |
| interactionRootBounds（含于上一行） | 30.723 | 58.623 | 158.724 | 363.587 |
| InteractionRenderer.prepare | 308.655 | 312.930 | 1043.467 | 1000.153 |

Deep2 两个主线程 profile 都未采到 `scene/visit` 工作；117 实际采到 `entriesFor` 1.522 ms。该冻结 host 的 Canvas/snapshot/interaction source hashes 与借用实现匹配，支持重复几何遍历已减少这一局部结论；采样为零不证明绝无调用。完整 dependency scope 没有缓存，FIG 仍主要在 React layout → prepare → dependency scope/rootBounds；其累计值反而增加。Deep1/Deep2 窗口、调度与捕获开销不同，不能把 611.221 ms 写成一次停顿或宣称同等输入延迟改善，也不能据此说主线程或渲染整体通过。

117 Worker `certifyExactImageRange` self 609.914 ms（Deep1 653.227 ms），仍是可见同步 CPU 热点。主线程 `state.capture`/`toDataURL` 和 diagnostics sanitizer 必须与产品绘制计算分开。这一 host 尚未启用后续显示半径候选；radius1177 的拒绝/回退观察不得套用后来修改的实现。

## 画面门与内容覆盖限制

- 117：sharpGate=false，5249 个 violations / 1763 个 ACK；16/16 个实际 GPU 参考可用，异常遗漏组件 0，allIntermediateFramesVerified=false。
- fig：sharpGate=false，5734 个 violations / 1846 个 ACK；16/16 个实际 GPU 参考可用，异常遗漏组件 0，allIntermediateFramesVerified=false。

`completed` 仅表示诊断跑完。尤其 root 实际查看发现117第一次3200% capture/reference 与第1/4轮高倍参考均为空白；部分其它轮次才有颜色内容。因此16个参考的遗漏组件为0不能证明高倍有内容的场景均正确，更不能证明缩放无模糊或所有中间帧无白块。后续测试将通过 trace 前实际100%像素选择内容 anchor，并独立报告参考内容覆盖；不改本轮旧输入或放宽遗漏/清晰门。真实文档图像、原始 pixels/scene/用户路径仍不入库。
