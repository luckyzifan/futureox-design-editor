# 云端画布性能（2026-11-08）

在这台云端 Linux 上实测。分支 `cursor/page-agent-codex-8568` 当时已包含 `origin/main`（`git rev-list --left-right --count origin/main...HEAD` 为 `0 3`）。开发 WASM `public/kernel/design_kernel_bg.wasm` 的 sha256 是 `22aa7cb71dea8372a4e44308f70ddcc44981f9dc1f164e9333381f33313bcf85`。

没有改光栅、瓦片预算或 GPU 开关。带效果的缩放在 zoom 32 触发了已有的合成内存预算，这是这次跑出来的失败，不是相对一条更早通过记录的回归。

没有 Electron、GPU、浏览器合成或上屏延迟。33 ms 可见、100 ms 精修、完整 G2/G5 这次没有测，仍然开着。`117.sketch`（5,013,257 字节）在 `/cursor/stores/bot/compare-fixtures`，这次没有打开。

## 已有正确性测试

`bun x vitest run` 这 7 个文件：`coverage-stack`、`navigation-coverage`、`navigation-zoom`、`pan-preview`、`cpu-tile-frame`、`source-opening-preview`、`overview-coverage`。

7 个文件、90 个测试通过，整次运行 5.87s。这些测试不断言也不打印每一帧的毫秒数。

`bun scripts/benchmark.ts`（只含场景加空间索引，不是浏览器帧率）：

| 节点 | sceneAndIndexP95Ms | queryP95Ms |
| --- | ---: | ---: |
| 1000 | 16.622 | 0.010 |
| 10000 | 17.215 | 0.001 |

## 3009 个节点的 CPU 缩放和平移

现有 `src/cpu-zoom-pan.benchmark.ts`。视口 640×480，`renderCpuFrame` → `VectorEngine.render_rgba`。效果关掉的那一轮（`CPU_ZOOM_PAN_EFFECTS=0`）通过，原始记录在 `cpu-zoom-pan-effects-off.json`。效果留着的那一轮失败，记录在 `cpu-zoom-pan-effects-on.json`。

效果关掉：

| 阶段 | 毫秒 |
| --- | ---: |
| WASM init | 145.332 |
| 冷字体加载 | 715.206 |
| 文档加载 | 399.698 |
| 第一帧，zoom 0.1 | 416.152 |

从 0.1 放大到 32，九帧：257.697、273.122、358.892、383.472、515.100、573.912、611.336、628.553、608.758。这一组含第一帧在内的 p95 是 628.553，最大 628.553。

zoom 32 上平移 24 帧：p95 646.631，最大 692.602（第 16 帧，zoom 32，x=-4512，y=-4264）。生产 RenderMailbox 最近一次提交到像素返回的 p95 是 624.642。这一轮没有单独的“从 32 缩回去”的帧。

同一套关效果文档，在放大到 32 之后再缩回（`src/cpu-zoom-out.benchmark.ts`，`cpu-zoom-out.json`）：

| zoom | 毫秒 |
| ---: | ---: |
| 25.6 | 749.386 |
| 12.8 | 601.102 |
| 6.4 | 565.457 |
| 3.2 | 504.475 |
| 1.6 | 366.491 |
| 0.8 | 347.394 |
| 0.4 | 264.895 |
| 0.2 | 246.899 |
| 0.1 | 270.699 |

p95 和最大都是 749.386。

效果留着：zoom 0.1 到 25.6 的九帧是 1007.789、951.830、1134.146、2090.495、1534.142、2266.055、3273.237、5751.888、14314.744。下一帧 zoom 32（x=-4480，y=-4240）在 5626.462 ms 时失败，错误是 `Compositing memory budget exceeded`。平移帧没有开始。

## 打开 `01有料素材.fig`

`importFig` 加同一条 CPU 光栅。文件 sha256 `90eb4dc4d09b67cbcc7afa790bb373c28560f97e2111e8adfcfa269bc2afb82c`。第一页 `Meher Admin Dashboard Ui Kit Light`，4 页，9063 个节点。相机从 x=0、y=0 开始，不是适配整页。字体是 Noto Sans SC 和 DejaVu Sans，不是文件里的 Poppins / ABeeZee。记录在 `cpu-fig-open.json`。

| 阶段 | 毫秒 |
| --- | ---: |
| importFig | 1360.966 |
| 字体加载 | 574.177 |
| load_document | 1060.567 |
| 打开第一帧，zoom 0.1 | 3203.369 |

放大：0.25 → 531.462，0.5 → 254.341，1 → 160.634，2 → 74.696。

zoom 2 平移四帧：75.465、72.056、73.998、71.724。

缩回：1 → 156.417，0.5 → 245.113，0.25 → 539.586，0.1 → 818.938。缩回 0.1 比第一次打开的 3203.369 快，第一次包含冷光栅。

测试里的 `wasmInitMs` 是 0.043。套件的 `beforeAll` 已经通过 `initializePicking` 加载过这块 WASM，所以这个数不是进程冷启动。
