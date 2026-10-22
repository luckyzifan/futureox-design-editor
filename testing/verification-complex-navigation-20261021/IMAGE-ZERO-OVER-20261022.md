# 图片向透明目标合成的精确恒等式验证

此候选仅省去已证明等于 source 的一次 normal 合成。它保留原 mode2 图片绘制、四个相关采样相位、原生坐标字段、图片数据和精度，不改变导出、编辑或撤销语义。必须处于严格 `VITE_DESIGN_EXACT_CLAMP_PREFIX === '1'` 的 painter-stage lane；不满足证明条件时继续原 mode3 合成。

证明来自 driver 对实际上传字节建立的私有 range，且每次 GPU 写入都会撤销；不凭 URI、文档元数据或可变 TypedArray identity 授权。当前保守域要求 managed exact math、明确的采样相位、完整无 atlas 偏移的源纹理、alpha 全部精确为 1、RGB 非负有限且最大指数不超过 127（每通道小于 2）、binary mask 和整数格点。原生有效图片地址 clamp 到 texel centres，invalid 地址输出全 +0；加上 binary coverage 后，输出 alpha 仅为 0/1，alpha 为 0 时四通道均为 +0。仅同范围的已知透明零 dst、normal 合成、无 clip 才跳过 merge。半透明/负值/更高 HDR、未知写后上传、非单位 opacity、float mask、clip、分数 dst、范围不等及无 stage 均保留原路径。

独立脚本 [check-image-zero-over.ts](../../frontend/design-client/scripts/check-image-zero-over.ts) 将实际 `GpuRenderer.paintOver` 与独立编码的旧 mode2→完整 clear→mode3 对照。参考不调用 `paintOver`。每个 fixture 都跑四个采样相位，并记录是否真正跳过 mode3，不能仅凭结果相同假定优化已执行。

| 本次 v2 实际 GPU 检查 | 结果 |
| --- | --- |
| fixture / 相位执行 | 15 / 60 |
| 原始 RGBA32F 分量 | 754,432 |
| 逐位差异 | 0 |
| 实际跳过 mode3 | 20 |
| 拒绝域实际保留 mode3 | 40 |
| 绑定真实 117 图片与 native window | 四个相位均通过 |
| binary holes / invalid contain 的零 alpha 控制 | 1,755 / 12,164 个像素 |

Apple `metal-3` 上的 v2 通过。正域包含完整覆盖、binary holes、signed-zero/subnormal、invalid contain 和绑定的真实 117 原生窗口；负域按上述限制保留 mode3。参考与候选均读取实际 GPU 结果的原始 f32 words，所有分量与逐场景 SHA-256 一致。实际 peak texture 为 33,464,352 字节。

这是显式 **512 MiB 的 bounded operator 对照预算**，不证明应用默认 256 MiB 下整文档可运行，也不代表真实 117 全部区域通过。此门未测整机延迟或 GPU queue wait，不能根据跳过 pass 或峰值推断快速缩放和平移已达标。

最初 v1 使用了不符合生产 data-image URI 校验的合成资源 key，在像素对照前失败，未计为通过。v2 仅将显式测试 loader 的资源 key 改为合法 data URI；没有放宽生产校验或像素门。该失败记录保留为独立历史。

v2 的 1146 项输入清单前后相同，SHA-256 为 `ed68e610d79e05685b7ac238583fa557031fdda7ddede7765a43bbb962920bcd`。原始结果 SHA-256 为 `8fb857e126de709c30eebb81aa19eb05939c3df272e0ec831c20bcef913edb28`。公开[计数与来源摘要](image-zero-over-summary.json) 只保留合成名称、数值和哈希；私人图层标识、路径和像素不入库。整机连续操作、其他区域及合并后编辑、撤销、导出仍需独立验收。
