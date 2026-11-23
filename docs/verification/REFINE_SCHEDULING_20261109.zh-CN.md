# 精修调度与准备窗口核对（2026-11-09）

本轮对照当前 `origin/main`。没有降低分辨率，没有放宽预算、效果或采样。GPU 优先、CPU 兜底不变。

## 留下的改动

- 视口驱动的素材范围若与已经呈现、至少六项的范围重叠且不是其子集，先等一个 120 ms 采样再决定是否发布。不相交的范围和显式页面选择不等待。返回已覆盖的范围不会新开快照。
- 同一修订下最近四个素材场景描述留在宿主里。返回同一范围时复用原来的令牌，不再向原生侧要一次新快照。修订变化或换文件即丢弃。当前只有活动令牌可被解析；切走之后旧授权仍然失效，回到该范围才恢复。
- 并集准备若触发场景路径预算（131）或解析区间程序预算（94），按原裁剪重试一次。这不是放宽预算。

## 测过并撤回的准备窗口

低倍大源现在按块缩小准备窗口。把窗口改成整批并集可以复用几何，但在真实 FIG 上场景字节并不相同，因此没有改默认。

发布构建（`cargo test --release`）四块 514×514、zoom 1、figmaSubpixel，2400 个带描边矩形，场景 JSON 一致，`prepareReuses=3`：

| 次数 | 逐块准备 | 共享并集 | 收益 |
| --- | ---: | ---: | ---: |
| 1 | 77.730 ms | 44.769 ms | 42.40% |
| 2 | 45.328 ms | 40.953 ms | 9.65% |
| 3 | 43.528 ms | 40.247 ms | 7.54% |
| 4 | 43.365 ms | 40.442 ms | 6.74% |
| 5 | 43.146 ms | 40.597 ms | 5.91% |

五次样本各自排序后的中位是 43.528 → 40.597 ms，约 6.73%。第一次明显更冷。这是可裁剪的合成场景，不是完整拓扑。

`01有料素材 (Copy).fig`（19402 节点，649304 字节）在同一发布构建里，第 0 块场景不一致。节点 `fig-0-8200` 的 `rect`：逐块准备是 `x:427,y:131,w:87,h:195`，共享并集是 `x:427,y:90,w:87,h:236`。计时 341.328 → 326.633 ms 不能当成同等像素的提速。因此没有改默认。`01有料素材.fig`（9063 节点，387579 字节）两条路径一致，207.959 → 197.364 ms，约 5.09%，`prepareReuses=3`。这份文件低于默认仍使用单块窗口的条件，产品路径没有切到并集。

`01有料素材 (Copy) (1).fig` 原生导入拒绝：`TILE spacing/scale/rotation/alignment is not rendered`，且本机没有 fig2sketch。

## 已跑的检查

云端 Linux，无 GPU，无 Electron。

| 命令 | 结果 |
| --- | --- |
| `node --test test/large-document.test.mjs`（`frontend/design-desktop`） | 17/17 通过 |
| `node --test test/main.test.mjs` | 63/63 通过。日志里的 `design-render` 未安装是本机没有桌面产物 |
| `bun x vitest run --config vitest.prepare-scope.config.ts`（`frontend/design-client`） | 3 个文件、22 项通过 |
| `cargo test -p futureox-design-kernel --release --test shared_prepare_tiles` | 合成场景通过；真实 FIG 的矩形差异见上，测试只对合成场景要求字节一致 |

`cargo test --lib` 无法编译。测试代码引用了检出里没有的 `testing/fixtures/design/coreimage-color-controls-vectors.json` 和 `spectral-q4-natural-vectors.json`。

## 没有测到、因此不能关闭的项

- 完整拓扑、117.sketch、20082 节点 FIG 的 GPU 端到端精修。117 与拓扑原件本轮没有从 LFS 展开；本机没有 GPU / Electron。#69 的 5% 端到端门和最终像素没有在那份素材上重测。
- #62 的 100 ms 停手精修、#63 的主线程长任务、#66 的 3200% 整屏、#67 的首次密集长尾、#68 的同轨迹返回清晰时间，都没有在对应原件和 GPU 上重测。

不是 33/100 ms，也不是完整 G2/G5。
