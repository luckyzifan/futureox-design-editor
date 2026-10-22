# 独立 phase4 候选：背景捕获的真实前缀读取域

本记录是新 Rust 源的数学边界、定向 native CPU 测试和实际 117 packet 预检。它没有覆盖或改写既有 phase3/WASM/GPU 历史记录，也没有将 CPU 裁剪量当作 GPU 内存、颜色或延迟验收。

## 不改变 capture 的原点、尺寸、相位或 clamp

正常 mode26 背景捕获的某一轴，capture 原点为 `o`、尺寸为整数 `N`、prefix 纹理整数原点为 `S`。每个 capture texel 中心为 `p = o + i + 0.5`，原双线性采样使用 `q = (p − S) − 0.5`。在原有充分相位门通过时，这些 binary32 操作精确；全部 texel 的实际整数 textureLoad 域是 `floor(o)..floor(o)+N`，含最后的 base+1 邻居，即长度 **N+1**。即使权重为零，该邻居仍不能丢弃，非有限值乘零可产生不同结果。实现再外扩 2 像素作保守保护。

新候选先完整求得并验证 phase3，冻结其每个背景节点的 `backdrop_inputs` 和 `post_composites`。原 `backdrop_inputs` 继续供 `Compiler::backdrop_box` 与充分相位门计算，不能按新较小需求重新生成它，否则多背景场景中较早节点的 capture 可能移动或变小。

实际允许读取的旧物理 prefix 是 **phase3 `post_composites[id].union(backdrop_inputs[id])` 的矩形 hull**。新的前向读取需求仅为该旧物理 prefix 与上述完整 bilinear load footprint 的交集，再与当前 phase4 demand 作矩形 union。不能只与 logical backdrop box 取交，也不能把矩形 hull 当集合并：更晚背景缩小当前 demand 后，logical box 外的旧 plane 边缘/角落仍可能被捕获。单元测试用一维和二维计划模型验证这一边界；它们不是声称已经在实际 117 复现了错误。

capture texture 本身的原点/尺寸、blur 系数、两个轴的算术、mode27 clamp、颜色/图像计算及 authored transforms 均没有在此改造中改变。前景 blur 的独立 source halo、父子 clip 与多个背景的反向依赖继续完整传播。

## 严格独立准入与回退

新的可信 request-envelope 字段为 `gpuPainterCaptureReads: Boolean`，缺省关闭；字符串、数值和 null 均拒绝。`true` 必须同时 `gpuPainterSupport: true`。它不是文档元数据，不能由 FD 可选内容启用。

只有已通过相位门且具有完整 `stages` 的 phase3 计划才尝试 phase4。phase4 缺少任何 frozen map、stage/geometry 不完整、prepare guard 不覆盖或相位证明失败，整份退回已通过的 phase3；没有已证 phase3 时仍走原 conservative compiler。原 1/512 网格、32K 相位域、外层 taps/bilinear 邻居、8192 源尺寸、16M surface cap 和准备窗口要求都未放宽。whole/default/export/pixel-preview 不取得此候选的额外权限。

## 验证与 117 数值

定向无重叠 **39 项 native CPU 测试通过**：新增 6 个 footprint/边界单元与 7 个 policy/packet 集成、既有 6 个相位负例，以及 20 个 painter/backdrop 回归。覆盖零权重非有限邻居、原始二维 hull 角落、多 BG 原 box 冻结、前景支持、合成 PNG image/clip、无 stage 的父效果 fallback、严格 bool/default/export、同 engine 3→4→3 cache 及细旋转相位整证书拒绝。

初次新测试编译因 `unwrap_err` 要求成功类型 `GpuScene` 实现 Debug 而失败；改用 `err().unwrap()` 后通过，没有因此修改生产算法或降低断言。模型边界复审后又补充 frozen old-prefix 角落与非有限邻居测试，并以最终源重新运行上述 39 项。

`profile_painter_capture_reads` 对同一个实际 117 请求作 native phase3→phase4→phase3 预检，输出只有数值，结果如下：

| 元数据域 | phase3 | phase4 |
| --- | --- | --- |
| 两个主要 child prefix | 2428×2428 | 2428×1248 |
| 另一 child prefix | 2402×2428 | 2402×1248 |
| 独立前景 blur source | 3658×3658 | 3658×2478 |
| 全部 source extent 像素数 | 13,380,964 | 9,064,524 |
| 根输出需求 | 68×68 | 68×68 |
| 节点数 | 9 | 9 |

一个背景 capture box 的 binary64 bits 变化 **0**；所有矩阵 bits 变化 **0**、effect 字段变化 **0**；回切 phase3 后完整 packet 精确恢复。上述尺寸是 native 依赖/分配元数据，不能直接认作实际 GPU live-byte 峰值或速度。

[公开摘要](painter-capture-reads-summary.json) 仅保留计数、矩形、源 SHA-256 与输入摘要，不含真实节点 ID、图像/程序 words 或私人路径。测试示例用 `DOCUMENT FONT REQUEST_ARRAY_JSON` 三个显式本地参数，不扫描下载目录。

## Portable WASM 与独立小场景实际 GPU 门

public/generated portable WASM 已重建，SHA-256 一致为 `40748786a93f9bdf2775b210904d787fa9b069fa46e565035cd980bcab36fe1f`。独立 `deep-painter-phase4-oracle-v2` 的 38 组实际 GPU 比较已通过各自的严格门，共检查 **554,496 个输出分量**：

- **30 组通过证书的场景**：437,760 分量与未改的更宽 full-frame GPU crop 逐位/逐 byte 一致，差异 0。
- **8 组拒绝证书的场景**：116,736 分量保留与旧同 crop GPU 的一致性，旧 packet 也完全相同，差异 0。
- 两个被拒绝的旋转场景与更宽参考仍有 **888 个历史差异**（2 与 886）；它们被明确保留，不能把 same-crop fallback 通过说成新获得的 wider-crop 等价。
- 14 组实际生成不同的 capture-read 计划；compact witness 记录 16 次真实写入。integer outer-shadow 实际走 byte-alpha 两轴，原生 RGBA8 输出与更宽参考差异 0。覆盖新增的真实 PNG 生成 opaque/partial image 场景。

全部输出分量有限，输入文件运行前后 SHA 稳定，浏览器错误 0。首轮 v1 在完成的前 32 组满足相应门后，进入 integer-shadow 路径时因 unmanaged mask 的 pipeline31 未准备而失败；该失败记录保留。修正的是该传输/目标格式路由，没有放宽 shader 数学、相位门或 fallback 标准，随后 v2 的全部 38 组通过。

[公开摘要](painter-capture-reads-summary.json) 分别保存 admitted wider-crop、rejected same-crop 与历史 wider 差异、WASM/源/结果哈希；不含输入/输出原始分量。

**上述为 v2 历史门：39 项 native CPU、portable WASM 身份与独立小场景 GPU 通过。** 当时真实 117/FIG 新 GPU 配对尚未完成；后续门如下单列，不将历史状态改写为当前体验已达标。

## 后续 v3 祖先 clip 场景与实际文档局部门

v3 保留 v2 的全部比较边界，并加入两个祖先 partial/rotated clip 的 integer-shadow 场景，共 **40 组、583,680 个输出分量，分域 gate 差异 0**。32 个证书准入场景的 466,944 分量对 unchanged wider full-frame crop 零差异；8 个拒绝场景的 116,736 分量对 unchanged same-crop legacy 零差异，packet 保持旧值。拒绝域 wider-reference 的 **888 个历史差异仍明确未通过**，没有使用近似容差。

14 个 capture-read scene 改变、16 次 compact 写入，真实 byte-alpha 轴为 6（v2 为 2）。本次源/输入清单为 **1149 项**，前后相同；浏览器错误 0，输出非有限分量 0。实际 GPU 结果 SHA-256 为 `55ae3458fc0f1bfe6fa8e9b5b4455a70807009074ae813878b53b7715dc07db1`，结果包装 SHA 为 `0046b0cf1a8814409685ffffc7d6e46ba2f1b7b53a2026143fe4e9f6ccb20f80`，WASM 仍为 `40748786…fe1f`。完整数值与绑定源码身份在[公开摘要](painter-capture-reads-summary.json) 中按 v2/v3 分开保存。

实际 117 随后的 band 内存门与局部完成记录见 [IMAGE-BAND](IMAGE-BAND-20261022.md)；实际 FIG 在 256 MiB、r1920 下完成的局部 byte-alpha 请求及其祖先 clip 边界见 [BYTE-TENT](BYTE-TENT-20261022.md)。这些是局部执行，不能替代复杂 Electron 缩放/平移、画质/白块、缓存、编辑/撤销或导出验收。实际 FIG 同 window 的 unchanged CPU 对照已尝试，但被原 combined-halo 2048 guard 拒绝、未产生参考像素，因此整 scene CPU parity 未建立；不能将独立小算子 oracle 当作该完整 scene 的 CPU 对照。
