# 安全默认构建：真实CPU采样

[打开八份火焰图](flamegraphs.html)；[summary.json](summary.json)保留原始profile、targets、运行报告及JS/map SHA、self/inclusive权重和精确父栈。来源为`final-safe-default-117/fig`，该构建关闭驻留filter scratch，实验仍仅在明确值`1`启用。42份实际资产在构建覆盖前逐SHA验证并保存到被忽略的`../final-safe-runtime/`。本次八份profile都通过严格非负timeDeltas及节点身份校验，没有裁剪、归零或变换异常时间。

| 段 / 实际线程 | 加权样本ms | 活动CPU ms | idle ms | program未归因ms |
| --- | ---: | ---: | ---: | ---: |
| 117 wheel / renderer | 866.309 | 148.194 | 610.644 | 107.471 |
| 117 wheel / render-worker | 817.444 | 59.794 | 757.650 | 0 |
| FIG wheel / renderer | 1134.008 | 255.882 | 579.316 | 298.810 |
| FIG wheel / render-worker | 909.401 | 117.504 | 791.897 | 0 |
| FIG property X / renderer | 2383.063 | 1220.212 | 825.724 | 337.127 |
| FIG property X / render-worker | 2094.280 | 61.439 | 2026.810 | 6.031 |
| FIG undo / renderer | 1973.116 | 758.030 | 863.925 | 351.161 |
| FIG undo / render-worker | 1649.837 | 88.193 | 1560.117 | 1.527 |

FIG真实属性入口为`Inspector → Editor.updateProperties → change`，inclusive分别510.281 / 505.745ms。`kernelLayout` inclusive17.519ms、self7.207ms；其中`translationOnlyChanges` self8.475ms。这次采样没有观察到`resolve_components`帧，因此没有可归给它的实际采样权重；**采样缺失不是调用次数为零的证明**。真正零调用断言来自另外完整19,959节点FIG的Editor入口CPU/WASM oracle。WASM self合计27.005ms，仍保留真实索引，不推测Rust内部符号。

当前属性段较大的已观测主线程链为`reconcileBaseline → captureSnapshot → encode` inclusive497.170ms，其中`desktop-session.ts:214:44`回调self229.625ms，Electron`invoke` self98.825ms。不能仅凭调用名把未命名原生帧进一步判成某个IPC克隆算法，也没有用未证明的跨generation缓存跳过恢复。Editor变更内部仍有`detachMissing` inclusive70.704ms、`validateDocument` inclusive80.920ms；这些与父级inclusive相互包含，不可相加。

连续wheel的Worker主要是驻留呈现与`compositeDrawPlan`：117 `presentFrame/draw` inclusive46.595ms，FIG `presentFrame`75.165ms、`draw`69.472ms；FIG另有GC self24.153ms。大多数Worker样本为idle，不能说CPU整段算满，也不能把idle全部改称GPU等待。主renderer仍观察到诊断、React提交、FIG重复变换等成本；它们不是GPU shader时间。

这两次操作明确启用了`extended.cpuProfiling=true`。profile窗口和各线程起止不同，不能把这些采样耗时或跨线程和当作无profiler整机延迟。该证据说明旧的全量解析热点在这次实际采样中不再出现，并不说明运动清晰度或低延迟已经达标；独立的`final-safe-motion`两份sharp gate仍失败，只在各自四份绑定视觉样本中没有检测到定义内大块白/透明缺失。详见[运动汇总](../../verification-sharp-sequential-20261021/motion-final-summary.json)。

复查：`node testing/verification-cpu-flames-20261021/analyze.mjs --run-prefix final-safe-default --assets-root testing/verification-cpu-flames-20261021/final-safe-runtime --out-dir testing/verification-cpu-flames-20261021/final-safe`。只读取已保存的真实profile和匹配构建资产，不启动测试、GPU或浏览器。
