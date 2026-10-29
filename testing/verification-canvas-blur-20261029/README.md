# 拓扑素材：画布模糊计算量迭代（2026-10-29）

本轮主文件是用户下载目录的 `拓扑素材.sketch`，原件 SHA-256 为 `b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12`。117 只保留为前期辅助记录。本文不把指定视口、算子或静止读回的结果当作整应用 FPS、运动始终清晰或全 G5 验收。

## 来源与事实

- 流式遍历原件全部三页、306 个顶层素材，原始层级共 124,354 层；原件未改写。转换后完整源快照为 124,447 节点（含转换生成节点），不是同时绘制数量。
- 可见层级上的启用效果条目：旧式 type0 2,188，新式 type0 42，背景模糊 301，运动模糊 12，外阴影 3,015，内阴影 925。计数包括启用但半径为零的条目，不能当作实际 GPU 工作量。原件未发现启用的缩放模糊；缩放、渐变、tent 和玻璃模糊的补充用例在原件素材的测试副本中添加，单独标为 derived。
- 已核对父目录 Figma 的实际 `shader_78.glsl`：浮点三角权重、成对线性采样、有界循环。已核对 Sketch `MSBitmapEffectsContext` 反汇编：降采样选择、8 位预乘缓冲、vImage 盒式卷积调用。逆向摘要的部分阈值与原始反汇编并不完全一致，本轮没有照搬该表，也没有猜测 Figma 的半径映射。参考文件及哈希见 [reference-sources.json](reference-sources.json)。
- 原有逐位有理计算保证的是本项目的确定性数值合同，不能据此证明比原生 Sketch/Figma 更保真。本轮获用户明确授权，改为限定画布的误差验收；原核、支撑范围、半径、采样坐标和分辨率保持原样。

## 实现

1. SDR WebGPU 画布的 tent、Gaussian 三轮 box 及阴影单通道，读取原有理系数包，以 f32 补偿求和替代多字整数乘加和除法。原有精确 prefix 保持优先；透明边界只跳过可证明为零的 tap，分数原点保留原寻址。常量输入可直接返回其精确结果。
2. R32F 阴影保持单通道存储。>2048 的已支持阴影仍要求原私有上传证明；不提高原生半径、纹理、包或显存预算。
3. 运动/缩放使用 Rust 原有坐标表、原采样数量和范围，只将双线性归约及累加改为原生浮点。源邻居含负值、>1 或非有限值时使用原精确 shader。
4. 画布与精确输出的滤镜缓存身份分离。显式 readback、非呈现输出、HDR、软件剖面和不支持的物理源窗口维持原路径；可选管线失败退回原程序。`VITE_DESIGN_CANVAS_BLUR_FLOAT=0` 在构建时恢复旧算术。
5. 修复真实原件中 `blur.isEnabled: 1` 被当作关闭的问题，局部支持整数 0/1 和布尔值，保留原字典；不改变其它属性的布尔校验。旧代码的新用例失败，修复后五项导入/导出测试通过；真实“模板二”工作集恢复九项 Gaussian，对应全文件 42 条新式模糊。见 [旧失败](topology-numeric-old.log)、[修复复验](topology-numeric-restored.log)。

## 冻结的验收和方法

[RUN_SCOPE.md](RUN_SCOPE.md) 保留初始范围与后续扩展。数值门从运行前固定为：最终黑/白底合成后未量化 SDR 编码最大误差 <1/255，alpha 最大误差 <1/255，无新增非有限结果；拒绝域、HDR 和精确输出按原始 f32 位比较。没有在失败后放宽阈值。

硬件为 Apple Metal-3，Electron 44.7.0。相同源码、同一输入对照开关，首次冷编译另列、两次预热后进行三组交替 A/B。时间为生产图渲染加 GPU 完成/最终 QA 读回的 wall time，不含源文件导入及 Rust 场景编译，不是 GPU timestamp 或物理显示延迟。没有与本任务构建/测试并发测性能。

- [209 项 tent/box/阴影/边界检查](operator-shadow-large/report.json)通过；覆盖 R32F/RGBA alpha、分数相位、2240/2240.125/4096 私有阴影包、signed/HDR/nonfinite 回退。最大编码误差约 4.88e-6。
- [62 项运动/缩放检查](spatial-run-v1/report.json)通过；最大编码误差约 5.48e-7。单独的运动算子耗时下降约 77%–84%，缩放约 85%；不能推广为整图收益。
- [拓扑工作集初轮](topology-run-final/report.json)与[玻璃补充](topology-run-glass/report.json)像素门通过，之后的精确输出逐位一致。初轮部分相机对准大对象内部；最终报告以轮廓边缘复测为主。
- 完整源三视口初轮中的“拼搭样式二”实际为空白，`nonuniformChannels=0`，其 22% 观察值已作废，不作为提速验收。保留 [原始报告](full-topology-run-v2/report.json)和[截图](full-topology-run-v2/comparison.png)。后续增加非均匀像素断言并对准真实轮廓。
- [GPU 全套回归](topology-gpu-tests.log)：160 文件，1,773 通过，7 原有 todo。TypeScript 检查通过。mock/CPU 逻辑测试与上述硬件证据分开。

## 保留的问题与失败

内阴影和运动所在的完整素材视口初轮没有稳定的大幅收益：内阴影约 12.5→12.7ms，运动约 808.7→790.9ms。算子已减量，整幅图还包含其它大面积效果、合成和等待，不能宣称所有场景都显著加速。

早期 harness 的导入路径、读回裁剪、数值参数和 schema 失败保留在对应日志；空读回的 operator-v2/v3 不作为数值证据。box 半径 1024 被原上限拒绝，未抬高上限。首次桌面构建在发现导入修复被源码写回覆盖后停止；修复已恢复并复验。随后一次构建出现增量链接缓存错误，改用非增量构建；另一轮只因并发修改 `source_compile/tests.rs` 未通过源码冻结检查，不计为完整构建通过。

33ms 最新像素 P95、100ms 停手清晰、完整 G2/G5、各平台、独立原生 Sketch/Figma 全像素保真及完整源冷启动目标仍未完成。完整源准备的导入/快照/加载时间单列于 native manifest，不能隐藏到预热里。

## 复现与回滚

本地工具：`topology-inventory.py`（只读流式盘点）、`prepare-topology.mjs`（隔离 native 工作集）、`prepare-full-topology.mjs` / `focus-full-topology.mjs`（完整源与相机）、`run-hardware.ts`（独占硬件）。临时输入留在本机 `/tmp`，不发布设计内容或浏览器 profile。

回滚优先构建时设置 `VITE_DESIGN_CANVAS_BLUR_FLOAT=0`；导入修复应独立保留。源码回滚只针对本轮清单并校验 after hash，禁止 reset 全工作树。最终变更、产物及边缘复测记录在本文件后续结果节和 `changes.json`。

## 最终边缘视口结果

以下均为 256×192 输出像素的固定视口，三组配对中位数，原始冷/热样本保留。每例新增非均匀像素检查，避免空白或对象纯色内部冒充轮廓质量验证。

| 类型 | 原算术 ms | 新算术 ms | 耗时减少 |
| --- | ---: | ---: | ---: |
| 原件旧式 Gaussian | 29.5 | 19.5 | 33.9% |
| 原件新版 Gaussian | 105.4 | 76.0 | 27.9% |
| 原件背景模糊 400% | 120.3 | 118.2 | 1.7% |
| 原件外阴影 400% | 33.1 | 24.2 | 26.9% |
| 原件内阴影 | 9.6 | 10.0 | -4.2% |
| 原件运动模糊 | 775.9 | 766.9 | 1.2% |
| 原件背景模糊 950% | 295.8 | 282.2 | 4.6% |
| 原件外阴影 950% | 93.3 | 56.2 | 39.8% |
| 素材副本：tent | 39.4 | 27.3 | 30.7% |
| 素材副本：渐变模糊 | 122.9 | 67.9 | 44.8% |
| 素材副本：缩放模糊 | 39.8 | 24.4 | 38.7% |
| 素材副本：玻璃模糊 | 50.2 | 38.9 | 22.5% |

[边缘视口原始报告](topology-run-edges/report.json) · [画面对照](topology-run-edges/comparison.png)。十二例的颜色/alpha 误差门通过，随后各自精确输出逐位一致。内阴影视口约 4% 的反向波动及运动/背景的小幅收益均保留，不能把算子收益宣称为这些整图场景已提速明显。

完整源快照实际包含全部 306 个素材；指定视口并不同时绘制所有节点。关闭本任务 GUI 测试实例后重新配对：

| 完整源视口 | 原算术 ms | 新算术 ms | 状态 |
| --- | ---: | ---: | --- |
| 主框架03 | 110.9 | 107.7 | 有内容；像素门通过，耗时减少 2.9% |
| 模板二 | 98.1 | 70.2 | 有内容；像素门通过，耗时减少 28.4% |
| 拼搭样式二 | — | — | FAIL：基线与候选均为空白，不计提速 |

[最终完整源记录](full-topology-run-quiet/report.json)。本轮完整源总评仍是 FAIL，而不是用其它视口覆盖失败。

## 独立确认的蒙版问题（尚未修复）

“拼搭样式二”原件的 `360EEE93-E4D1-422C-9897-BA0A8CBB4FF7` 为无填充矩形裁剪蒙版，`clippingMaskMode=0`。当前导入只设置 `mask=true`，没有区分该模式；GPU 默认按绘制结果的 alpha 消费它，空填充得到零 alpha，因而把整组遮空。这发生在旧、新算术两边，并非本轮浮点误差。

已用本机 Sketch 对原件同一素材导出，确有非空内容：[原生参考](native-mask-reference/B4F79D9D-73A9-4CFA-A0C2-BA3610CC6105@0.2x.png)、[命令结果](native-mask-reference.log)、[实际 GPU 父链与空填充](full-composition-chain.json)。源蒙版语义应单独修复，不能通过删蒙版、补白填充或跳过该素材让性能验收变绿。

## 最终构建与功能检查

- [最终 GPU 回归](final-gpu-tests.log)：160 文件、1,773 通过、7 原有 todo；[TypeScript](final-typecheck.log) 通过。
- [导入修复复验](topology-numeric-restored.log)：5 项通过（含数字 0/1 和错误类型负例、四种 blur 的源值保留）。
- [独立桌面构建](desktop-build-ready.log)通过，产物 `/tmp/futureox-topology-blur-ready-20261029`，使用非增量 native 构建规避之前的缓存链接错误；构建末尾全部输入一致性检查通过。
- [真实桌面检查](gui-topology-built/report.json)从原件加载完整 306 素材目录，打开“模板二”，WebGPU 就绪，无页面异常或新管线回退警告，原件 SHA-256 不变；[截图](gui-topology-built/topology-ready.png)。关闭测试实例超时，随后仅清理了它自己的进程树，记录在 [cleanup](gui-topology-built/owned-process-cleanup.json)。因此不声称退出生命周期通过。

本轮没有改动用户已有正在运行的桌面安装。源码默认开启此显示算术；普通启动需使用新构建。回退只需构建时显式 `VITE_DESIGN_CANVAS_BLUR_FLOAT=0`，不需要撤销数字模糊启用标记修复。


### 构建后身份核对

[final-provenance.json](final-provenance.json) 记录本轮变更涉及的构建输入及全部共享 WGSL 与成功桌面构建一致、native/WASM 产物哈希及原件最终哈希。精确回滚补丁 reverse-check 与本轮文件 diff-check 通过。


### 增量应用演练

[apply-delta.py](apply-delta.py) 在任何写入前核对全部前置哈希；支持 `--root`、`--check`、`--reverse`。已在独立临时目录实测应用、回滚及错误前置原子拒绝，见 [delta-verification.json](delta-verification.json)。只提供本轮源码差异，不覆盖其它未提交工作。
