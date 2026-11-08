# 2026-11-08 云端阶梯与功能验收

内核没有新的保留改动。打包 alpha 平面再跑六次盒模糊，34 帧像素哈希与 `8ae67279280e1f9d1f39f2dc9f8a4e8797c88cca9824063bbf1cff9e02a1125e` 相同，但 zoom 3.2 从 555.251 ms 升到 586.491 ms，没有留下。

## 便携字体后的正式阶梯

`941686a8`。效果开启，640×480，`render_rgba`。字体先读 `public/fonts/dejavu/DejaVuSans.ttf` 与 `DejaVuSerif.ttf`（sha256 `ae7b7855e115a5966d8b1b3f80f254ccc117ec86f9965e202ee2940453837280` 与 `8f2c103bfa3fd5de71f1b92b18f21906b5a26871fb7e19a9a4c9af539c3cc7ab`），与这台机器上的 Linux 包字节相同。

WASM `8ae67279280e1f9d1f39f2dc9f8a4e8797c88cca9824063bbf1cff9e02a1125e`，`collectedAt` `2026-11-08T06:10:15.458Z`。四档哈希与 `2026-11-08T05:43:53.059Z` 那次相同。

| zoom | ms | 距 33 ms | 距 100 ms |
| --- | --- | --- | --- |
| 0.8 | 585.377 | 552.377 | 485.377 |
| 3.2 | 574.326 | 541.326 | 474.326 |
| 6.4 | 206.380 | 173.380 | 106.380 |
| 32 | 196.642 | 163.642 | 96.642 |

最慢放大帧仍是 zoom 3.2。缩出峰值 zoom 25.6 = 265.872 ms。`01有料素材.fig` sha256 `90eb4dc4d09b67cbcc7afa790bb373c28560f97e2111e8adfcfa269bc2afb82c`，import 1128.017 ms，zoom 0.1 = 3175.635 ms，zoom 2 = 78.118 ms。

`05:43:53` 那次同 WASM 的 541.471 / 555.251 / 191.854 / 195.769 ms 仍是这台机器上更快的一次；这次哈希没变，时间更高，不当成内核退步。不是 33/100 ms。

## 验收

`bun x vitest run` 19 个文件，`maxWorkers=1`，2026-11-08。2 个文件失败，17 个通过。149 项里 143 通过、6 失败。失败都是仓库里没有的 `testing/fixtures` 文件，不是断言。

通过：`chrome-acceptance.test.tsx`，`ui-mode.test.ts`，`cpu-bench-fonts.test.ts`，`design-ai/page-hover.test.tsx`，`design-ai/agent-page.test.ts`，`kernel/high-zoom-preview.test.ts`，`source-opening-preview.test.ts`，`import-fig-nodes.test.ts`，`import-fig-text.test.ts`，`import-fig-archive.test.ts`，`sketch-display.test.ts`，`kernel/coverage-stack.test.ts`，`kernel/tile-preview.test.ts`，`kernel/reference-zoom-frame.test.ts`，`kernel/navigation-coverage.test.ts`，`kernel/cpu-tile-frame.test.ts`，`zoom-precision.test.ts`。

失败：`import-fig-layout.test.ts` 缺少 `testing/fixtures/design/figma-materials-native-2026-10-08.fig`。`sketch-followup.test.ts` 六项都缺少 `testing/fixtures/design/sketch-text-layout-flow.sketch` 或 `testing/verification-sketch-text-layout-flow-20261027/foreign-consumer.sketch`。

`bun run typecheck`（`tsc --noEmit`）通过。
