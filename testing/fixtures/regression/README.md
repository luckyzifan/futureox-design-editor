# 固定回归输入

这些文件由回归脚本直接读取，属于输入和参考实现。

| 文件 | 来源和用途 |
| --- | --- |
| `export.before.tsx.txt`、`import-svg.before.ts.txt` | 从 `4ca0b6a74` 和 `b6238b7a3` 恢复原始导出与 SVG 路径解析源码。测试直接校验原 SHA-256 |
| `composite-draw-plan.before.ts.txt` | 从 `fd7555469` 的旧验证目录移入。软件合成计划测试以原 SHA-256 校验 |
| `Canvas.before.tsx.txt`、`exact-image-range.before.ts.txt` | 从 `5f5ad9bd9^` 恢复前序 Canvas 与图片范围实现，分别供历史场景复用负对照和图像范围 CPU 基准使用 |
| `sketch-text-layout-flow.sketch` 与 `sketch-text-layout-flow/` | 从 `0ee084a8c` 恢复的原有 Sketch 文本、原型和组件库合成夹具。Rust 与客户端共享输入 |
| `canvas-spatial-blur.sketch` | 从 `5f5ad9bd9^` 恢复的小型位图模糊用例，含三张合成位图，用于比较 Sketch 导入后 CPU 与 WebGPU 预览 |

恢复时逐字节沿用 Git 中封存的输入。新增夹具记录来源和许可信息。[测试贡献指南](../../../docs/TESTING_CONTRIBUTIONS.zh-CN.md)
