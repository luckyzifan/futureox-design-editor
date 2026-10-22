# 四相离散覆盖的独立原始 GPU oracle

`frontend/design-client/scripts/check-sample-coverage.ts` 为 `identicalSampleCoverage` 准备独立算子门，直接调用生产 `WebGpuDriver.mask`/`maskRegion`，使用真实 scalar `r32float` render attachment，并以 texture-to-buffer copy、MAP_READ、Uint32Array 原始词读取 `.r`。它不通过 renderer、不调用其 canonicalize、不把 R32 的默认 `.a = 1` 当覆盖值，也不比较已共享的单张掩码。

每个 accepted fixture 的四个独立 sampleIndex 原始 full mask 必须逐词相等，三个 regional mask 必须各自等于其原始 phase 的对应 crop。声明为不同的 negative control 必须不获证书，且实际 GPU 至少一词相位不同；unknown 必须拒绝证书，数值允许恰好相同。coverage 输出还需都是原始 +0 或 1 的 f32 bits。

合成 header3 程序包含相同 raw spans 但 sample offset 分离、不同程序的相同整数 runs、端点调整后区间起点倒退、signed zero、负 upper、单像素双端点、17-span 二分与末端边界、非零存储 offset，以及 sampleCount/重复 row 总工作预算未知路径。

实际 117 fixture 从约定的原始场景自动选择 helper 命中路径，按覆盖面积取最大三个，没有硬编码文档节点 ID。准备结果为 3658×3658、1283×416、68×68。原始 document/request/scene、path、程序 words 和输出像素均留在私有输入或运行时；公开结果只应保留数值与 SHA-256。

绑定的旧失败场景 SHA-256 为 `91b7d963a027bf556c7eddad3ee593260431ab15114a89c5cf313913612bb7d1`。对应 document `a0d0df3b24ea187dfd5723c9d41ab17908ce22afebb0bf64592f749d6fac3677`、request file `f38710da2551f6a338b009e77a6edb6ce18b050537f56137de7f40460976ca6a`、显式 painter-support 执行请求 `e3fc7bdc92eaf921c387843b8d4448e603c2813c656f8fd3433b1cc84448cba7`、WASM `4efb26d67f71bf031fed9efbdfe3ea15385c57017de46aa5fd465a13136679a9`、字体 `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da` 分别校验；prepare 和实际浏览器路径都重新 native compile，并要求完整 scene SHA 严格相同。

在 `frontend/design-client` 运行 `bun scripts/check-sample-coverage.ts --prepare-only`。输入位置可用 `DESIGN_COVERAGE_SCENE`、`DESIGN_COVERAGE_DOCUMENT`、`DESIGN_COVERAGE_REQUESTS` 显式提供；不扫描其它私人文件。实际 GPU 运行去掉 `--prepare-only`，由 root 在其它 GPU 工作结束后串行执行，必须选择新的空 evidence 目录。

prepare-only **16 组**通过；helper focused **18/18** 通过。后续 `deep-sample-coverage-gpu-v1` 已在真实 Apple `metal-3`、明确非 fallback GPU 通过相应的独立算子门：

- **9 组 accepted**：完整四相原始 R32 覆盖逐词相等，phase0 对照其余相位的差异为 0。
- **5 组 declared-different**：全部不获证书，GPU 实际四相确实不同。其差异是必要的负控制，不能记作回归失败或从总数中抹除。
- **2 组 unknown**：全部拒绝证书；此次 GPU 数值恰好相同，也不能放宽其结构/工作预算准入。
- 全部 case 的 regional mask 与各自原始 phase 的 full-mask crop 比较均为 0 差异；三个实际 117 路径 3658×3658、1283×416、68×68 的 full/region 门均通过。

原始 full-mask 共读取 **57,775,392 个 u32 词**，其中包含故意不同的负控制，**不能表述为这些词全部四相零差异**。公开 [数值与 SHA-256 摘要](sample-coverage-summary.json) 分别给出各分类的读取量、预期差异和 region 比较结果，不包含原始词、像素、实际节点 ID 或私人路径。

该实际 GPU 运行前后输入 SHA 全部稳定，浏览器错误 0，实际浏览器重新加载绑定 WASM/font/document/request 再次 native compile 的完整 scene SHA 匹配。此结果只证明被接受掩码的四相离散覆盖及区域裁剪，不建立整份文档颜色合成、延迟、编辑/撤销或导出验收，也不改变未知路径的保守 fallback。
