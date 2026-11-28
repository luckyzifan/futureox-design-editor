# 验证结论

Markdown 结论记录一次实际运行能够支持的范围。复现入口见[本地测试使用方式](../../testing/README.md)，提交标准见[测试贡献指南](../TESTING_CONTRIBUTIONS.zh-CN.md)。

## 一条结论需要的信息

- 日期、平台与架构。涉及画面或计时时，再记录系统、设备、驱动、DPR、窗口、构建 profile 和相关开关。
- 待测源码的提交或工作区差异，工具链和实际 WASM／原生构建来源，夹具标识与哈希。基线和候选分别注明。
- 运行的命令、输入、可复用脚本、预期断言、实际结果和边界。写清通过、失败、跳过或未运行的具体范围。
- 画质、性能或发布结论写明该次执行的对应门槛、测量结果和拒绝条件。需要追溯的日志、截图、trace 可保留摘要、关键数值与哈希。调试原件在复核后清理。

## 记录

- [2026-11-28 0.0.0.1 release 包验收复核](RELEASE_ACCEPTANCE_20261128.zh-CN.md)
- [2026-11-26 117.sketch 原生 Sketch 对照](SKETCH_117_NATIVE_20261126.zh-CN.md)
- [2026-11-25 开放 PR 与真实文件回归](PR_BATCH_20261125.zh-CN.md)
- [2026-11-24 117.sketch 高倍缩放和画板交互](117_HIGH_ZOOM_20261124.zh-CN.md)
- [2026-11-23 测试清理与复跑](TESTING_CLEANUP_20261123.zh-CN.md)
- [2026-10 早期桌面与渲染验证](HISTORICAL_ACCEPTANCE_202610.zh-CN.md)
- [2026-11-10 八个 PR 的复核](../PR_REVIEW_20261110.zh-CN.md)
- [2026-11-10 Linux FFmpeg 构建](FFMPEG_SOURCE_20261110.md)
- [2026-11-10 USWDS 文本基线](USWDS_COLORS_TEXT_20261110.md)
- [2026-11-09 精修调度与准备窗口](REFINE_SCHEDULING_20261109.zh-CN.md)
- [2026-11-09 Sketch sRGB 合成](SKETCH_SRGB_COMPOSITE_20261109.zh-CN.md)

历史结论适用于各自的提交、机器、输入和工具链。当前发布按[本地验收说明](../LOCAL_RELEASE_ACCEPTANCE.zh-CN.md)取证。
