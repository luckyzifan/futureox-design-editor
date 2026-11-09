# 这台云端机器当场跑的测试（2026-11-08）

命令是在这台 Linux 上执行的。数字来自命令输出，没有另编。视口 640×480，`render_rgba`。开发 WASM `93dcca0ce6a5d00bee9c95b42a877cff5dbb062163b9424febd5ab3379fec147`。没有 Electron、GPU、上屏，也没有 Figma 或 Sketch 的帧时间。

性能四段是在画布套件、设计助手测试和 Fig 结构报告结束之后单独跑的，避免和那些进程抢 CPU。

## 画布、导入、页面助手

`frontend/design-client`，2026-11-08 01:46:25 UTC 开始，10.39s：

```
bun x vitest run src/kernel/coverage-stack.test.ts src/kernel/navigation-coverage.test.ts src/kernel/navigation-zoom.test.ts src/kernel/pan-preview.test.ts src/kernel/cpu-tile-frame.test.ts src/source-opening-preview.test.ts src/kernel/overview-coverage.test.ts src/fig-document.test.ts src/import-fig-text.test.ts src/design-ai/agent-page.test.ts src/design-ai/page-hover.test.tsx src/design-ai/fig-leftover-inspect.test.ts src/import-fig-overrides.test.ts src/bundled-import-fonts.test.ts
```

14 个文件，104 个测试通过。

`cargo test -p futureox-design-agent --offline --lib`：20 通过，0 失败，0.02s。包括追问按钮颜色、工具 `tool_call_id`，以及把设计提问切到 API 再切到 Token plan。

`node --test frontend/design-desktop/test/design-agent-host.test.mjs`：1 通过，duration_ms 259.918。

## Fig 结构

`FIG_STRUCTURE_REPORT=/tmp/fig-structure-live-20261108.json`，01:46:27 UTC 开始，18.25s，1 个测试通过。`collectedAt` 是 `2026-11-08T01:46:45.672Z`。夹具目录是 `/cursor/stores/bot/compare-fixtures`。

| 文件 | 用户页 | 隐藏页 | 节点 | 文本节点 | 实例 | 变量 | 警告 | 字体替换 |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| sections.fig | 1 | Internal Only Canvas | 18 | 0 | 0 | 0 | 0 | 无 |
| stacks_wrap.fig | 1 | Internal Only Canvas | 54 | 0 | 0 | 0 | 0 | 无 |
| corners.fig | 1 | Internal Only Canvas | 10 | 0 | 0 | 0 | 0 | 无 |
| structure.fig | 1 | Internal Only Canvas | 23 | 1 | 2 | 0 | 0 | 无 |
| 01有料素材.fig | 3 | Internal Only Canvas | 9063 | 1382 | 37 | 0 | 0 | 无 |
| 01有料素材 (Copy).fig | 14 | Internal Only Canvas | 19402 | 2638 | 74 | 0 | 0 | 无 |
| 01有料素材 (Copy) (1).fig | 15 | Internal Only Canvas | 19412 | 2638 | 74 | 0 | 0 | 无 |
| 06-01有料素材.fig | 3 | 无 | 9064 | 1382 | 37 | 0 | 0 | 无 |
| 06-02有料素材.fig | 3 | 无 | 9029 | 1374 | 45 | 0 | 0 | 无 |
| Forma 内核对照验收 2026-10-06.fig | 3 | Internal Only Canvas | 381 | 0 | 0 | 0 | 0 | 无 |
| gold-preview.fig | 1 | Internal Only Canvas | 3194 | 87（大纲 8） | 1504 | 320 | 91 | 无 |

这些文件都通过 `validateDocument`。gold 的 91 条里没有「没有唯一目标」、`strokePaints` 或矢量圆角/顶点样式。其余警告仍在。

## render_rgba

效果开启，3009 个节点，`collectedAt` `2026-11-08T01:48:35.828Z`，vitest 102.24s，1 通过，34 帧。10 帧放大加 24 帧 zoom 32 平移：

| zoom | ms |
| ---: | ---: |
| 0.1 | 1065.836 |
| 0.2 | 978.821 |
| 0.4 | 1159.427 |
| 0.8 | 2115.017 |
| 1.6 | 1487.710 |
| 3.2 | 2077.531 |
| 6.4 | 3248.950 |
| 12.8 | 1577.135 |
| 25.6 | 1805.237 |
| 32 | 1850.886 |

zoom 32 平移 p95 1919.124 ms，最大 1971.215 ms。没有 `Compositing memory budget exceeded`。

效果关掉，vitest 37.55s，34 帧。放大最慢是 zoom 25.6 的 637.388 ms。第一帧 zoom 0.1 是 359.100 ms。zoom 32 平移 p95 634.347 ms，最大 675.777 ms。

从 32 缩回（效果关），vitest 6.27s。最慢是 zoom 25.6 的 696.205 ms。随后 12.8 为 599.018，6.4 为 571.146，3.2 为 507.925，1.6 为 373.310，0.8 为 356.042，0.4 为 268.596，0.2 为 255.232，0.1 为 277.284。p95 和最大都是 696.205 ms。

`01有料素材.fig`，vitest 10.88s。页是 Meher Admin Dashboard Ui Kit Light，文件 4 页，9063 节点。importFig 1172.650 ms，字体 561.730 ms，load_document 1025.462 ms，第一帧 zoom 0.1 为 3218.832 ms。放大 0.25 / 0.5 / 1 / 2 为 545.611 / 267.622 / 168.500 / 76.011 ms。zoom 2 四次平移为 77.780、74.226、76.039、74.267 ms。缩回 1 / 0.5 / 0.25 / 0.1 为 161.527 / 257.242 / 555.597 / 847.190 ms。`wasmInitMs` 0.028 不是冷启动，套件的 setup 已经加载过 WASM。

33 ms 可见和 100 ms 精修这次没有达到。zoom 6.4 效果开启仍是 3248.950 ms。
