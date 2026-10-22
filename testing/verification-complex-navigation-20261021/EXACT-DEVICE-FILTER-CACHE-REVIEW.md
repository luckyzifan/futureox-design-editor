# 精确设备网格滤镜复用只读复核（2026-10-22）

本次只读源代码与历史验证记录，没有开启开关、修改 renderer/Rust 或运行 GPU/重测试。结论针对已计算的设备网格 H/V 数据，不是此前有 51/255 画质失败的 source-space displayMaterial 预滤波。

## 当前究竟复用什么

| 路径 | 当前开关 | 可命中域 | 不能据此承诺的内容 |
| --- | --- | --- | --- |
| `horizontalFilters` | 默认开，显式 `VITE_DESIGN_HORIZONTAL_FILTER_REUSE=0` 关闭 | 同一私有 batch lease、同源纹理、完整精确 key、同 X/宽度；可复制相邻 Y 请求的 overlap，只补 missing rows | 跨 job、任意平移、跨缩放与长期保留 |
| `StaticImageBlurCache` | `VITE_DESIGN_STATIC_IMAGE_BLUR_CACHE=1` 才开 | 单个已完成的精确 RGBA32F H/V 结果；同实际上传私有证明、相同 camera/key、完全相同 input/output | 当前 117 3200% 热点与任意重叠窗口 |
| physical filter source window | `VITE_DESIGN_FILTER_SOURCE_WINDOW=1` 才开 | 驱动可从更大物理 RGBA32F 纹理的一个连续 subrect 按原逻辑维度读 | 产品目前没有 renderer 调用，打开开关本身没有复用收益；不支持 wrapping/ring |

水平缓存不是尚未接上的候选。[早期实际 Electron 结果](../verification-render-deep-20261020/README.md) 已记录 117 首次 3200% 的 20 tiles 中有 15 次命中、31,780 行复用，相关优化保留在默认路径。当前缓存仍只有一个最多 64 MiB 的 H plane，计入普通工作账本。

## 为什么同密度平移和新 job 仍然重算

[worker](../../frontend/design-client/src/kernel/render-worker.ts) 每次 tile 请求新建 `filterBatchLease = {}`，在该 job 的 `finally` 调用 `releaseFilterBatch`。中途切到另一个无相同 lease 的 job、失败或取消也会清理。缓存不能把前一 job 未完整发布的中间结果当成当前结果。

[horizontalFilterSource](../../frontend/design-client/src/kernel/gpu/renderer.ts) 的 key 含 node id、matrix、inverse、size、paint、原始 binary64 radius、input/output 的 X 与宽度、实际 image/atlas origin、完整 `scene.view` 和算术/颜色合同。Y 被有意留给 overlap 比较，因此同 camera 跨行可以命中；平移改变 camera/matrix 后不命中。不能仅删除 camera 或延长 lease 来制造命中，尤其 atlas/writer、设备重建、源替换和原生采样字段的精确相位还需证明。

当前 stage 热点还有明确容量界：117 已知内部 prefix 约 2428×2428、Image 输入高 3658；若 H plane 为 2428×3658×16，就是 **142,105,984 bytes（135.52 MiB）**，超过现有 64 MiB H-cache。这里加列调度也不能让该平面进入缓存，扩大 cache/budget 也不是本次建议。当前列计划还按 `scene.extent` 估计输出，stage 采用后它可能大于真实 target prefix；未来应使用同一份实际消费域，但仍须保留真实 H 字节门。

## Static blur v2 为什么覆盖不到当前热点

[identity admission](../../frontend/design-client/src/kernel/gpu/renderer.ts) 限定 `32 <= device radius < 64`，而当前 117 3200% Image 为约 612，background 为约 1177。它们无论是否打开开关，都不在该域。

[性能尺寸门](../../frontend/design-client/src/kernel/gpu/static-image-blur-cache.ts) 还要求 native `scene.output` 恰好 514×514，但待保留结果至少 1024×1024，最多 17 MiB、仅一项。这个策略原先面向约 1032² 的 SSAA tile；当前 `figmaSubpixel` 普通物理 tile/guard 通常约 514/518²，不满足最小尺寸。新背景 prefix 约 2428² 则超过 17 MiB。不能把它说成当前 Electron 3200% 已有可用的完整结果缓存。

缓存外层 context 虽只以 zoom 等合同清理，entry key 仍含完整 camera；每个合格 miss 会先退休原单 slot。它没有实现“平移后相同密度就命中”，也没有 partial overlap。private source 注册要求真实 managed 上传与 `imageTableRange` 证明，绑定纹理对象/resource/尺寸/完整 URI 和颜色调整合同；写入撤销、源移除、压力和真实完成 epoch 控制退休。`borrow` 还必须等 accepted producer 的完成 epoch，不会靠公开 finite flag 发布结果。

还有一个具体的命中路径差异：当前 static cache hit 固定执行四次 merge，而同函数正常 miss 在 `shareResolvedMerge` 条件和相同 destination surface 时已经可以一次 merge 后 retain。缓存命中未必比正常路径分配更少。若后续独立试验该缓存，首先应让 hit 复用完全相同的已证明共享条件与所有权处理；有 clip 或不同四相 destination 时仍保留各相操作。此处尚未修改，也不能据此追认旧 v1 回归的全部原因。

## 历史已否决什么

- [static blur v1→v2 记录](../verification-render-low-latency-20261021/static-image-blur-cache-v2.md)：v1 实际命中一次，13 PNG 与完整撤销无差异，但 held 输入 ACK 由 cache-off 的 517.15 ms 到 cache-on 的 623.42 ms，queue wait 约 897.6/898.4 ms，未改善。小边缘结果无命中却把保留数据增到约 32 MiB；保留平面也减少普通 pool 可用存储。不能把全部差值都归因于边缘平面，因为第一次 table wait 出现在它们之前。
- v2 收窄为单 17 MiB 完整 tile、URI 与 policy 分开比较。记录中的后续检查是 CPU/transport 与 typecheck，没有建立 v2 当前设备低延迟验收。
- [更早完整结果缓存](../verification-render-low-latency-20261021/complete-filter-cache-parked.md) 因少量有用 hit、工作内存挤压而移除。恢复补丁是历史快照，不应直接套回。
- 已通过的旧 `window-gpu-*` 是 rational bound/window 算子检查，不能当成 physical source-window 的产品缓存收益；该 API 当前没有产品调用点。

## 最小可落地顺序

1. 先完成当前 stage 的 GPU 正确性和 256 MiB 门。需要 H 的冷计算和目标分配仍可能失败时，保留更多缓存只会挤占工作集。增加有界 miss 分类能区分 lease/key、X/宽度、覆盖证明、容量、压力退休与完成 epoch；不要只报 hit 总数。
2. 独立复核一个默认关闭的 static-result v3，而不是恢复大缓存：先统一 hit/miss 的已证明 shared-merge 条件，再允许 native 完整 tile 的物理密度结果（例如 514 核心请求对应约 518² 结果，约 4.1 MiB），保留单项/17 MiB、私有源、完全相同 input/output/camera。不同 destination 与 clip 的四相操作仍保留。若扩大半径，只允许当前 exact streamer 本来已支持的域；不改变采样、滤镜、halo 或冷计算算法。当前 100% 物理密度约 radius19，还低于 streamer 的 radius32 入口，不能顺手更改冷路径来覆盖它。
3. v3 先测“同 camera、只编辑后方/其他节点”的静态 Image 重复请求。它可直接在 table/H 分配前命中。必须独立 raw GPU/设备画布、压力/取消/源写入撤销，以及至少相同构建的 cold/matched repeated workload；旧 v1 的失败意味着不能预设结果会更快。当前高背景 prefix 超过 17 MiB 的情况继续拒绝缓存。
4. 真正跨平移/跨 job 的 H 复用是下一项独立改造：使用真实上传私有 source token、完整算法合同和当前原生四相轴字段逐位 witness 验证重叠域，再建立可借用生命周期。不能仅凭相同 zoom、节点 id 或整数 delta 推断 exact field 一致。保留一个现有容量内的列/band；大于 64 MiB 的热点需要分 band 和完整边界支撑，不能放宽上限。

`passFilterWindow` 可以在未来已证明的连续物理窗口中避免某些临时 copy，但它只提供寻址。部分 overlap 缺行时仍要正确计算/装配完整 H 支撑；单窗口 API 本身不能把两张纹理拼成一个逻辑源，也不能把 ring wrap 当成连续源。
