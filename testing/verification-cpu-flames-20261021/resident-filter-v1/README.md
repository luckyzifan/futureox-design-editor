# resident-filter-v1：实际后续 CPU 采样

[火焰图](flamegraphs.html) 与 [summary.json](summary.json) 由真实117/FIG continuous-wheel、FIG property-X/undo 的renderer和render-worker采样生成。算法、线程边界、WASM索引与采样扰动说明见[父级记录](../README.md)。`extended.cpuProfiling=true`，这些窗口不是无profiler延迟基准。

复查使用 `analyze.mjs --run-prefix resident-filter-v1 --assets-root testing/verification-cpu-flames-20261021/resident-filter-v1-runtime --out-dir testing/verification-cpu-flames-20261021/resident-filter-v1`。匹配构建资产和原始私有设计/profile被忽略；摘要保留实际输入及JS/source map SHA。

本轮发现FIG属性仍执行完整WASM解析，原因是组件清理无变化也替换22个主组件身份。[随后独立CPU修复证明](editor-translation/summary.json) 为77/77通过，含完整实际FIG、真实Inspector回调对应的Editor入口零解析断言、完整强制WASM oracle及undo/redo。该CPU候选源码晚于本轮火焰图，不将图中数值算作修复后的体验。
