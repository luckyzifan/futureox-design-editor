# 官方 Sketch 样本适配验证（2026-10-31）

## 范围与来源

- `sketch-hq/sketch-reference-files` 固定提交 `d78b6f36e755770aaae57145c4ca3c0d9339f925`（MIT）：299 份 JSON，组成 74 个按版本/特性分类的测试组。该仓库已归档，主要是 JSON 参考，不是包含全部二进制资源的完整原生归档。
- `sketch-hq/file-format-series-json-to-sketch` 固定提交 `5e6361e39771a1095b0268999dacb48ed0da8efd`：完整 `color-library.sketch`，SHA-256 `78fb63a1e435ec4f1c042ef5e01ec6256a9023f1b3503a9fe82b72fc8b54b93a`。
- 来源及许可元数据见 `../fixtures/sketch-official/SOURCE.json`。当前工作树 HEAD 为 `928a1ea`，同时含有其他任务的修改，不把它描述为干净基线。

## 基线与修复

初次生产导入→导出→再导入：完整样例通过，74 组中 69 组通过，5 个 `export-formats` 组因 `jpg/tiff/eps` 和零倍率被拒绝。

实现将官方导出设置接入共享模型，按索引保留 `absoluteSize`、`namingScheme`、`visibleScaleType` 等来源字段。`tiff/eps` 和零倍率只声明 Sketch 往返保真，不声明本编辑器可生成对应输出；JPG 在面板中复用 JPEG 执行器。前端与 Rust 校验保持一致。

## 已通过

- `cargo test -p futureox-design-kernel --test sketch_official_reference --offline -j 2`：2 项通过，覆盖全部 74 组和完整样例。五个导出设置组逐字段比较，完整样例的共享色板逐值比较。
- `cargo test -p futureox-design-kernel --test sketch_format_contract --test sketch_import_admission --test sketch_official_reference --offline -j 2`：17 项通过。
- `bun run build:kernel`：实际 WASM 重建成功。
- `bun run test -- src/sketch-import-contract.test.ts src/layer-export.test.ts src/automation/node-input-descriptors.test.ts src/cpu-incremental.test.ts`：38 项通过；随后 `bun run typecheck` 通过。
- 当前 codec 导出的 `color-library-roundtrip.sketch` 已由 Sketch 2025.1.3 (203472) 原生 `sketchtool metadata` 成功打开。输出 SHA-256 `574ae4d09304a6e48d29981d2d3e8b881125498b7e7f9c7e5fc626c36028ca3e`。

## 保留失败与未验边界

核心库完整 `--lib` 回归为 793 通过、10 忽略、1 失败；失败是 `fig::tests::conversion_tests::gradient_transform_maps_onto_paint_transform` 的 FIG 渐变矩阵断言，与本增量修改的 Sketch 导出设置无关，未擅自修改。受影响的 Sketch 合同目标已单独全部通过。

官方参考 JSON 不含完整原生渲染链所需的全部资源，且 `color-library.sketch` 没有画板，因此本轮没有把这些样本声明为原生像素验收。这里也没有覆盖所有 Sketch 版本、全部未知字段、全部可编辑语义或全部原生像素组合。通过范围是所下载官方样本的 codec/共享模型往返、导出设置字段和样例色板保留，不是 Sketch 全兼容声明。
