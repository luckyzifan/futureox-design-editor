# 当前源码与统一运行资源完整 CPU 验证

所有表内阶段在同一冻结源码、便携 desktop-dev WASM 与新构建 native 二进制上实际执行。源文件、运行资源、独立测试输入和既有输出在前后哈希比较中未变化。

| 阶段 | 通过 | 明确跳过 |
|---|---:|---:|
| runner-contracts | 23 | 0 |
| frontend-contracts | 300 | 0 |
| desktop-contracts | 210 | 0 |
| python-tools | 15 | 0 |
| typecheck | 静态检查通过 | 0 |
| frontend-vitest | 2298 | 4 |
| mcp-example | 1 | 0 |
| bun-unit | 31 | 0 |
| automation-storage | 1 | 0 |
| mcp-contracts | 51 | 0 |
| native-preparation | 3 | 0 |
| native-sidecar | 8 | 0 |

新运行的 Rust 与附加检查：
{"kernel-tests": {"passed": 1194, "failed": 0, "ignored": 1}, "backend-tests": {"passed": 83, "failed": 0, "ignored": 1}, "render-codec-tests": {"passed": 5, "failed": 0, "ignored": 0}, "native-render-final": {"tests": 4, "pass": 4, "fail": 0, "skipped": 0}, "workspace-runtime": {"tests": 2, "pass": 2, "fail": 0, "skipped": 0}}

第一次全量运行有一个 Vitest worker 被 SIGKILL，未完成的 9 个案例不算通过。保留失败日志；第二次设置 VITEST_MAX_WORKERS=2，未删测试、未改断言，重新跑全部阶段并通过。随后打包检查发现字体测试依赖本地生成 TTF，改为源码生成器后，又对最终源码完整重跑并通过。SIGKILL 的具体资源原因未确认。

每项为框架执行次数，不是互不重复的功能覆盖率；Node/Vitest 的共享注册另见 aggregate-results.json，不合计成独立覆盖数。各切片审查的历史通过数也不叠加。

## 明确跳过与残余限制
- real 117 repeated three times: independent nodes, fonts, editable groups and one-step undo
- reproduce direct addPage during a live vertex transaction
- external corpus: DESIGN_TEST_SKETCH
- external corpus: DESIGN_TEST_FIG

Rust ignored 是原有微基准，未并入通过数。真实 GPU/桌面窗口/浏览器 CSP/OS socket/Windows/macOS 安装包未验收；此前受限操作未换路径重试。CPU 产品 PNG 不是 GPU 截图。直接内部 Editor.addPage 在正在进行的拖动中仍有已知复现；可达页面 UI 已加守卫，该选择性复现保持明确跳过。

Sketch 非 solid stroke 现在在输出 ZIP 前明确拒绝，避免静默变黑；并不宣称新增渐变描边兼容。HDR 图像调整、PNG gAMA/cHRM、矢量 PDF 图片 profile、完整颜色 Convert、部分原生 override 与文字导入 alpha 仍有已记录缺口。SVG 深度兼容、真实预览、跨平台和 Figma/Sketch 全功能对齐没有因此全部完成。

复跑：设置真实 BUN、DESIGN_PREPARE_BINARY、CORE_DESKTOP_SIDECAR、FUTUREOX_BACKEND_TEST_BINARY、DESIGN_RENDER_BINARY 与 codec fixture 路径，VITEST_MAX_WORKERS=2；按 testing/verify-local.mjs 的明确 suite 列表运行（见 aggregate-results.json）。不选择 socket-integration。生成资产从源码重建，不包含在源码 ZIP 中。字体测试需要 Python >=3.10 和固定 fonttools 4.61.1，按 testing/FONT_TEST_FIXTURES.md 安装测试依赖；测试从基线自带 Noto 字体生成临时夹具，不自动下载安装，也不需要未交付的历史 TTF。
