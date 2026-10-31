# 渲染数据流深度分析证据

主报告：[RENDER_DATAFLOW_DEEP_AUDIT_20261031.zh-CN.md](../../docs/RENDER_DATAFLOW_DEEP_AUDIT_20261031.zh-CN.md)。分析没有修改生产代码；已有工作区改动由 source-before.json 冻结，manifest.json 记录结束核对。

## 探针与边界

- `layout-probe.rs`：真实 kernel 类型的 size/align/offset；读取冻结拓扑快照的字段、几何、图片和效果清点。只输出汇总，不输出私有文本/图片内容。
- `native-layout.jsonl`、`native-final-layout.jsonl`：ARM64 布局。
- `wasm-layout-probe.rs`、`wasm-layout.ll`、`layout-comparison.json`：WASM32 release 库的编译期布局。首次探针未包含宿主 proc-macro 库目录而失败，加入对应搜索路径后成功，没有因此重建或修改 kernel。
- `release-inventory.jsonl`：无计数分配器的 release Document.clone 三轮样本。首次/暖态分别保留，不是 GUI/整帧延迟。time 包装器的 RSS 系统查询被拒绝，未使用其 RSS 作为证据。
- `allocation_metrics.rs`：只用于诊断的 System 透传分配器；记录 Rust 请求的存活字节，未改分配行为，没有写入业务代码。
- `heap-capacity-verified.jsonl`：915.1 MiB 原存活请求量、710.8 MiB map 重建后、542.3 MiB 再收紧三类 Vec 后；重建期间峰值约 1160.1 MiB。不是 RSS，也不含 GPU/系统分配器的全部成本。重写后的完整 Descriptor/Merkle 回执和 300,408,797 字节长度一致；临时 compacted.scene 仅用于验证，随后删除。
- `reverse-blur-table.py/json`：解释保存的 Sketch scale selector 指令，核对分界常数；不是运行当前 Sketch，也未修改父目录资料。

## 运行方式

在仓库根目录，使用已有 Rust 1.96.1 库与当前冻结快照：

```sh
rustc --edition=2024 -O testing/analysis-render-dataflow-20261031/layout-probe.rs -L dependency=design-studio/target/release/deps --extern futureox_design_kernel=design-studio/target/release/deps/libfutureox_design_kernel.rlib -o /tmp/design-layout-probe
/tmp/design-layout-probe testing/analysis-render-dataflow-20261031/snapshot-descriptor.txt --clone-bench

rustc --edition=2024 -O --cfg audit_alloc testing/analysis-render-dataflow-20261031/layout-probe.rs -L dependency=design-studio/target/release/deps --extern futureox_design_kernel=design-studio/target/release/deps/libfutureox_design_kernel.rlib -o /tmp/design-heap-probe
/tmp/design-heap-probe testing/analysis-render-dataflow-20261031/snapshot-descriptor.txt --verify-repack

rustc --edition=2024 --target wasm32-unknown-unknown --crate-type=lib --emit=llvm-ir -O -C panic=abort testing/analysis-render-dataflow-20261031/wasm-layout-probe.rs -L dependency=design-studio/target/wasm32-unknown-unknown/release/deps -L dependency=design-studio/target/release/deps --extern futureox_design_kernel=design-studio/target/wasm32-unknown-unknown/release/deps/libfutureox_design_kernel.rlib -o /tmp/design-wasm-layout.ll

python3 testing/analysis-render-dataflow-20261031/reverse-blur-table.py
```

更换编译器、库、模型或 fixture 后必须重新记录 hash。不得把 instrumented 分配器运行时间和普通 clone 样本混合；也不得把单文档内存结果外推为所有文件的帧率提升。
