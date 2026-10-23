# Resident image-table 退役候选：证据入口

此入口在 2026-10-23 集成时补齐。来源包的开发契约和诊断词典引用本路径，但其源码清单没有交付原验证目录。本页将引用绑定到实际导入代码和本地联合复验，不补写未交付的实机证据。

候选将同设备 capture 提交与有界 image-table 退役分开，保留总预算、来源引用和完成边界。后续 navigation/present 增量继续叠加在同一实现上。提交 ACK 不等于 GPU 完成、物理呈现或性能改善。

实现与测试：

- [renderer](../../frontend/design-client/src/kernel/gpu/renderer.ts)、[webgpu](../../frontend/design-client/src/kernel/gpu/webgpu.ts)、[诊断词典](../../docs/IMAGE_TABLE_RETIREMENT_DIAGNOSTICS_20261022.md)。
- [resident image retirement](../../frontend/design-client/src/kernel/gpu/resident-image-retirement.test.ts)、[resource boundary](../../frontend/design-client/src/kernel/gpu/gpu-resource-boundary.test.ts)、[pending pool admission](../../frontend/design-client/src/kernel/gpu/pending-pool-admission.test.ts)。

来源 ZIP、逐路径前后哈希和版本选择见[集成来源清单](../verification-package-merge-20261023/packages.json)与[源码清单](../verification-package-merge-20261023/source-manifest.json)。当前联合测试实际结果见[集成记录](../verification-package-merge-20261023/README.md)及[完整日志索引](../verification-package-merge-20261023/validation.json)。来源包历史统计与当前组合复验分列，不能将两者相加。

当前测试包含受控 GPU descriptor、jsdom 与 portable WASM；硬件 GPU 像素、实际 worker、GUI/物理同帧、整应用时延和完整 117 回放仍未由此建立。
