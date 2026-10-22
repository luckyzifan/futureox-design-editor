# 手势捕获自适应栅格密度（Figma viewer §2.4 移植）验证记录（2026-10-22）

## 变更

新增 `frontend/design-client/src/kernel/interaction-adaptive-density.ts` 并接入 `interaction-renderer.ts` 的 `renderLive`：手势活跃（`props.active`）且捕获像素需求超过 8M 预算时，按 Figma viewer 瓦片调度器的阶梯算法（密度 ÷ 2^⌈log₄(需求/预算)⌉，仍超再 ÷2；无固定档位表）降低捕获密度。低倍率 reduced 档、结算 exact 瓦片、导出与预算语义均不变；`resident.scale` 不被自适应样本回写。严格 opt-in：`VITE_DESIGN_INTERACTION_ADAPTIVE_DENSITY=1`（构建期），默认关。

动因：detail8 实测 zoom 2480% 下交互捕获 graph 758–961ms、单请求 1.1–1.5s，且 4.75s 请求的 fence 链证实工作量随 zoom 缩放——与逆向结论一致（Figma 高倍率按需 4×/2× 降密度，计算量不随 zoom 增长）。

## 单元验证

`interaction-adaptive-density.test.ts` 6 项：flag 关不降密度；预算内不降；非手势/reduced 档不降；2× 超预算减半；8× 超预算除以 4；相邻 zoom（20 vs 21）共享同一阶梯除数（档内密度仍随 zoom）。连同 `interaction-renderer.test.ts`（63）、`interaction-editor-recovery.test.ts`（32）共 101 项通过；完整 `tsc --noEmit` 通过。

## 真机 A/B（同 HEAD `d1d72ca`+本变更、同文档、同 Playwright 驱动：⌘+ 阶梯缩放至 zoom 32 → 两次拖拽手势）

| 指标（交互通道完成的捕获请求） | flag off（[基线日志](baseline-hizoom-off.log)） | flag on（[候选日志](candidate-hizoom-on.log)） |
| --- | ---: | ---: |
| graph 耗时 | 758 / 948 / 951 ms | **10 / 81 / 94 / 188 / 216 ms** |
| 最佳单请求总耗时 | 1114 ms | **320 ms** |
| 手势期内姿态 ACK | 0–1（本对 1） | 2（另一对 1） |

图处理耗时坍缩是机制的直接验证；compile（263–789 ms，WASM 场景编译、内容驱动）成为下一个瓶颈，不随密度变化。两组各单次运行，样本量不足以给 p50/p90 结论；ACK 改善方向为正但不具统计效力。flag-on 构建产物已核对编译结果（`enabled` 编译为 `true`，log₄ 阶梯在 bundle 中）。

## 未覆盖（不得宣称）

未验收：多文档/多缩放档遍历、旋转/缩放手势专项、长时间会话稳定性、画质主观对比（手势期降密度的视觉代价未评估）、117 整机回放、与 Figma 像素一致性。exact 通道的 4.75s fence 链问题**不在本变更范围**（本变更只作用于交互捕获）。默认关；开启需单独整机验收。
