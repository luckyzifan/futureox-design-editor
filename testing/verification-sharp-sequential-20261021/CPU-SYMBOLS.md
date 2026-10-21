# 默认版本 CPU 采样的符号边界

本记录只读取已有 `default-current-117` / `default-current-fig` CPU profiles、启动前 runtime manifest 和对应实际构建产物，没有重新采样、编译或执行 GPU 测试。

已逐项核对以下产物 SHA-256 与两份运行目录的 `runtime-artifacts.json` 一致：

| 实际产物 | SHA-256 |
| --- | --- |
| `render-worker-hEm-Dt3g.js` | `09d97c87d32ce8870b0c2d7a9482bd21e75e7c8ba4f1a05341fa78e4d2057389` |
| `render-worker-hEm-Dt3g.js.map` | `9bc433807f47f78e03863b306103d6877b936164b8f78ac712005a489d6a718c` |
| `design_kernel_bg-CvRV2NPE.wasm` | `9cddc0c6b91a48474037a4f64f6ac844f8bbea696596a241b3d31b49cf9678c5` |
| `design_kernel-CTnOS3u4.js.map` | `255f3c1b024cd4f54c3e53a9163b8f910415554952bee93582c5b7b1642484aa` |

目标列表将 `*-1.cpuprofile` 对应到 `design-app://app/assets/render-worker-hEm-Dt3g.js`，不能把它混为主线程或 preparation worker。采样中的 WASM URL 为 `design-app://app/kernel/design_kernel_bg.wasm`；对应本次实际加载的同一 SHA 产物。

`wasm-objdump -h` 显示该 WASM 仅包含 `producers` 和 `target_features` 两个 custom section，**没有 `name`、DWARF 或 source-map 符号 section**。因此 `wasm-function[1627]`、`[1129]`、`[1777]` 等内部索引不能可靠命名为 Rust 函数。其他 debug/desktop-dev WASM 即使带有名字，也不能直接套用索引。

以下对应关系由**同一实际 WASM 的 Export section** 核实，而非根据另一份二进制或压缩 JS 名猜测：

| 函数索引 | 确认的导出名 | 已有 profile 中的外层调用链 |
| --- | --- | --- |
| 5447 | `gradient_sampling_grid` | 117 pointer-drag：`gradientGrid → materialField → 导出 → 内部 WASM` |
| 5300 | `image_sampling_axes_placed` | 117 pointer-drag：`imageGrid → materialField → 导出 → 内部 WASM` |
| 5728 | `rational_tent_kernel_rgba` | 117 undo-edit：`applySampleEffects → blur → filterKernel → 导出` |
| 5729 | `certified_box_kernel_rgba` | FIG undo-edit：`node → blur → certifiedKernel → filterKernel → 导出` |

特别更正：5300 是 **axes_placed**，不是 grid_placed；5729 是 **certified_box**，不是 certified_tent。内部叶函数的名字仍然未知，不能把导出父链的语义逐一赋给它们。

按 profile 原始 `samples/timeDeltas` 聚合，render-worker 的 117 pointer-drag 采到约 8.626 ms WASM self 时间，117 undo-edit 约 6.381 ms，FIG undo-edit 约 1.188 ms；两文件 continuous-wheel 的该目标没有采到 WASM self 样本。这些是对应短阶段的采样估计，不是每次调用耗时、GPU 队列等待或完整加载耗时，也不证明其他 worker 没有计算。现有数据不能支持“全部缩放卡顿来自一个已命名 Rust 函数”的结论。

后续可以按这些可靠的外层调用链定位具体字段/系数构建，或重新构建并实际采样带符号的匹配模块。新符号模块必须保留自己的 SHA 和性能基线，不能回填成当前无符号产物的精确 Rust 栈。
