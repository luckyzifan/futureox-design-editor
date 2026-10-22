# 区域裁剪的 binary32 采样相位门

该问题来自主任务的实际 GPU 小场景对照。它不是噪声或可忽略的视觉误差：phase2 的 `rotated / 1.375` 有 864 个 RGBA32F 分量不同，多为 1–2 ULP；关闭新 clamp-prefix 后仍存在。前面多个普通、双背景、嵌套和 clipped 场景通过，不能替代这个失败。phase3 的原生门仍为默认关闭的 `gpuPainterSupport:true` 候选保护，不改变 shader 算术。

## 为什么整数裁剪仍会改变 bilinear 权重

完整 capture 的 X 原点为 `-9.189306259155273`，stage capture 为 `26.810693740844727`，整数差为 36；两原点本身均可由 f32 精确表示，fraction 相同。但 mode27 在同一全局点 `47.5` 上计算 `q = f32(f32(p - origin) - 0.5)`：

- 旧 q 为 `56.189308166503906`，fraction 为 `0.18930816650390625`。
- 新 q 为 `20.189306259155273`，fraction 为 `0.18930625915527344`。

减法的局部数值跨过 f32 指数边界，先后丢失不同低位。mode26 从四个整数逻辑 target 读取 fractional capture 点，也存在相同类型的问题。因此，只检查“新 capture → 小输出”的相位，不能证明“旧逻辑源域 → 新 source/prefix/capture”的相位。

`1/512` 格点与 `global <= 2^20` 单独也不足。`65535.00390625` 是精确 f32、在该格点上；加整数 5 后的 `65540.00390625` 上传为 f32 会变成 `65540`，两次值仍各自在格点上，但相位丢失。不能只看 origin 的 fraction 或 rotation Boolean。

## phase3 使用的保守充分域

对实际依赖 walk 认定的普通 background-blur，用 authoritative `Prepared.fill_bounds` 生成 legacy capture 与计划 capture。整个 painter certificate 必须同时满足：

1. 两 capture 原点差为整数，原点在 `1/512` 格点，原点/端点及 ±0.5 clamp 位置都能无损往返 f32。
2. 两 capture 每轴大小均为正整数且不大于 8192；把 global capture 区间再扩到完整 authored-f64/uploaded-f32 tent reach，加两个 bilinear 邻居后，仍严格位于 `(-32768,32768)`。
3. legacy 与 candidate source extent 每轴不大于 8192、全局整数坐标在既有范围内；联合源跨度再含完整 reach 与邻居小于 32768。还显式检查每轴扩展后 capture 的两端减联合 source 的两端所得四个差（再留局部邻居）均小于 32768，不隐含容器自身的 fill/capture 必须落在子 source union 内。所有计划 target/source 区域由原有依赖 walk 约束在对应 extent 中。

这个域使 capture 点、整数 tent tap、clamp 端点都在精确 f32 的 `1/512` 网格内。整数 source origin 可以沿用既有 ±2^20 域，其整数本身仍是精确 f32；不能笼统说所有操作数乘 512 都小于 2^24。mode26 的 `p - integerSourceOrigin - 0.5` 与 mode27 的 `p - fractionalCaptureOrigin - 0.5` 的差值另由局部界约束，仍在能精确表示该格点的范围，`fract`、`base + 1` 及 textureLoad 邻居不会因裁剪重新舍入。完整支撑证书负责排除人工 crop 边缘被观察到的情形；真实形状边缘继续保留原 clamp。

这是充分门，不是扩大坐标/质量准入。过细 fraction、跨指数失真、端点/邻居或尺寸不受证明时，**整份 certificate 被拒绝**，包括只改变 extent 的第一阶段；不能只删除 stage 元数据。回退 packet 与同 crop 的 legacy packet 完整相同。legacy 与另一 full-frame capture 本来可能存在 crop-dependent 差异，回退不应被写成新 exact/full-frame 证明。

117 热点的相位 `.1171875` 和 `.162109375` 在该格点上，旧/新 capture 及完整 reach 也在窄域内。单整偏移 outer-shadow 没有 fractional backdrop sampler，因此不受新增 BG 的 32K 限制；其原有 source/偏移证明继续有效。

## 已执行的 CPU 检查

```sh
cd design-studio
cargo test -p futureox-design-kernel --locked --offline --lib painter_backdrop_phase_tests
cargo test -p futureox-design-kernel --locked --offline \
  --test gpu_painter_support_regions --test gpu_regional_backdrop \
  --test gpu_analytic_blur_regions --test gpu_tile_culling
```

纯相位模块 6/6、四个集成文件 39/39（15/5/7/12）通过，互不重叠。覆盖真实 117 数字、65535 反例、512 格点边界、完整 outer tap/邻居、source/capture 尺寸与联合跨度、旋转细相位，以及保守域中 capture/expand 寻址的数值枚举。集成测试在有/无 parent foreground blur 两种情况下断言 unsafe phase 拒绝整份 certificate，完整 scene JSON 与同 crop legacy 相同；另验证无 BG 的 shadow 在 50000 坐标仍可准入。

最初新增测试的 JSON macro 使用了没有前导零的小数，编译错误已修正，再顺序运行上述检查。没有通过改变 shader、ULP 容差或丢弃效果使测试通过。

上述 45 项检查没有执行 GPU。随后使用 phase3 portable WASM `4efb26d67f71bf031fed9efbdfe3ea15385c57017de46aa5fd465a13136679a9`，同 phase2 的 117/FIG 各 10 请求 CPU 复核成功，完整 native scene 哈希均保持相同。它们仍只是编译准入。

## phase3 实际 GPU 的两种验收门

独立小场景设备运行 `deep-painter-phase3-oracle-v2` 共 32 场景、466,944 个分量，输入清单运行前后相同。24 个采用证书的正域场景与未修改 whole-frame 的更宽 GPU crop 逐位零差异；8 个拒绝域的 native JSON 与同 crop legacy 相同，GPU 原始输出也零差异。所有分量有限，实际发生 16 次透明层 compact 写入，包含有限 HDR 场景。

旋转测试必须拒绝证书，并通过**同 crop legacy**门；其对更宽参考在倍率 1 和 1.375 下仍分别有 2、886 个不同分量，共 888。该既有现象完整保留，没有被算入正域 full-frame 通过，也没有用视觉容差抵消。记录的零差异是各自明示验收门的结果，不是宣称全部 wider-reference 零差异。

v2 原始 GPU 结果 SHA-256 为 `369974b9dd8678d20d88a9c9e8e6d7da92dacc7807a8cd1578c3c26b72246cff`，输入清单 SHA-256 为 `b1fcff76fdeac4c69232edb794a054fe1d6ae67cc810bfe8b6891cb841b91b30`。各场景、native 输出格式和来源哈希见[分阶段摘要](native-painter-support-summary.json)。v1 因合成夹具不可达节点在完成 20 场景后中断，不是通过；v2 修正夹具，没有更改 shader 或放宽门。

这完成的是小场景相位/支撑/compact 像素检查。真实 117/FIG 的 GPU 大区域预算、复杂连续缩放平移、最终完整 Rust/编辑/撤销/导出与延迟仍需独立验收；不能用此结果宣布用户问题全部解决。
