# Sketch 画布空间模糊续轮 · 2026-10-26

这是“全部支持”任务的第二组候选，不能当作 Sketch 全特性完成，也不能把跨后端一致当作原生 Sketch 像素相等。缩放/平移故障由用户确认恢复；本轮保留交互回归。

## 实现与精度边界

- schema 18：新增 `gaussian-blur`（显式 sigma）与 `motion-blur`（sigma、节点局部角度 `motionAngle`），Rust 校验、动画、组件/共享样式、脏区支持域、CPU/WASM/Metal/WebGPU/WebGL2、Inspector 和操作描述一起接入。旧 `blur` 的模型、默认预算及实验开关保持原样。
- 高斯使用三次有理盒式滤波，运动使用归一化方向高斯和单次舍入双线性采样；HDR/负值不截断。高斯 device sigma 上限仍为 512；运动新增同等上限，不能用扩大预算掩盖准入失败。
- 旧 FD blur 经本项目 Sketch 往返，由有原生效果投影校验的元数据保持原模型；原生 Sketch 修改 blur 后，该记录失效。节点和共享样式均覆盖。
- 新版 Sketch `style.blurs` 数组优先于旧 `style.blur`。未编辑的原始数组保留；导出写入当前原生数组，同时保留旧字典供旧读取器使用。未知 zoom、layering 和多 blur 顺序仍有兼容提示。共享颜色调整不再被默认值覆盖。
- 严格矢量 SVG 在实际导出范围含运动模糊时明确拒绝；已有保留视觉效果的 SVG/位图导出仍可用。没有用 SVG 临时预览替代精确画布。

## 已测与失败记录

| 路径 | 结果与证据 | 限制 |
| --- | --- | --- |
| 原生 Metal / CPU | 8 个 SDR/managed、0/37.5/90°用例最终 RGBA 零差异，`spatial-metal-3.log` | 小合成，非 G5 或性能测量 |
| 浏览器 WebGPU / WebGL2 | 各 8 个同类用例最终 RGBA 零差异，`webgpu.json` / `webgl2.json` | 早期报告的 float 0 未明确区分缺失值；不得据此宣称全部 float 通过 |
| HDR 扩展 | 初次失败见 `hdr-*-failure.json`；发现旧 CPU Gaussian 在内部 clamp，已独立修复新效果路径 | 最终结果另记录，不删除失败 |
| Rust 互通 | `spatial-integration-4.log` 5 项通过；原生新数组样本、旧模型往返、原生改动优先、共享样式、方向/支持域/schema | 参数与自己的像素一致不代表与 Sketch 原生像素相等 |
| 原有互通 | `interop-regressions-final.log`：46 通过、1 默认忽略 | 忽略项在真实文件行单独运行 |
| 真实文件 | `real-111-roundtrip.log`、`real-117-roundtrip.log`：导入/导出/再导入通过 | 未声称整文件 GPU/连续编辑通过 |
| 客户端 | `client-tests-2.log`：9 项通过；`typecheck-3.log` 通过 | 合并后的检查另记录 |
| Sketch 原生再导出 | `native-modern-reexport-pixels.json`：19 画板全通道零差异 | 证明原生文件往返，含仅保存的 zoom；不证明本项目画布支持 zoom |
| 本项目 vs Sketch 像素 | `sketch-pixel-difference.json`：Gaussian alpha 最大 18/255，motion 最大 62/255 | **FAIL：原生像素一致性尚未达到**；导入明确提示 portable kernel |
| 实际 GUI | WebGPU 导入；运动角 30→60、半径 10→7.5；撤销→10、重做→7.5；本机保存/重开仍为 60/7.5；200%放大、适合全部、滚动条平移后清晰 | 小样本；尚非完整 G2/G5；FD、Sketch 下载及主目录组合另记录 |

环境：本机 macOS、Sketch 2025.1.3 (203472)、IAB Chromium；输入为基于合法 117 容器的自建图片/参数副本，原件只读。`make-oracle.py` 生成 19 个透明画板；`migrated` 是 Sketch CLI 真实迁移结果（格式 168），小型测试副本在 `testing/fixtures/design/sketch-spatial-blur-modern.sketch`。

早期失败保留：`spatial-metal.log` 参数格式误读；`spatial-metal-2.log` 未启用 hardware-tests，实际 ignored，不是通过；`native-reexport-pixels.json` 仅旧 blur 字典导致原生未生效；`webgpu-adapter-failure.json` 一次适配器不可用，后重试通过；`client-tests.log` 测试导出目标枚举写错。没有放宽像素阈值。

## 复现

在工作区根目录运行：

```sh
cargo test --manifest-path design-studio/Cargo.toml --profile desktop-dev -p futureox-design-kernel --test spatial_blur
cargo test --manifest-path design-studio/Cargo.toml --profile desktop-dev -p futureox-design-gpu --features hardware-tests --test native spatial_ -- --nocapture
python3 design-studio/scripts/build-web.py --profile desktop-dev
```

客户端启动既有 Vite 后，用实际浏览器访问 `/spatial-blur-check.html?backend=webgpu` 或 `backend=webgl2`；`&hdr=1` 包含半透明、负值/HDR 和非均匀仿射变换。测试页只调用生产 KernelClient，不注入私有状态。原生参考由 `sketch_canvas_oracle` 示例与 Sketch CLI `export artboards` 产生，PNG 比较不得只比较不透明区。

## 待完成

原生 Gaussian/Motion 核像素校准、zoom、噪声填充、段落排版/彩色字形、inferred/modern layout、原型/overlay、库更新与复杂效果组合仍未完成。G4/G5 全量矩阵与物理呈现延迟本轮 NOT_RUN。继续前一组的 `WORK.md`，不把本记录视为全部任务完成。


## 最终续验与主目录状态

- **HDR 修复已验**：`spatial-metal-final-2.log` / `main-metal.log` 中 8 个 SDR/managed 最终字节和 4 个 HDR 仿射场景通过；后者逐 f32 位相同。`hdr-webgpu-final.json`、`hdr-webgl2-final.json` 中各 4 例原始浮点差为 0，同时保留负值及大于 1 的分量。另存 WebGL2 轴对齐 HDR 4 例。
- **预览路径单独修复**：`main-gui-gaussian-failure.jpg` 是真实 937.5% 黑块。高斯盒核曾误走无上限 display-tent 分派，现显式区分核并准备精确管线。运动也使用独立精确采样/算术管线，避免预览快速算术改变累积舍入。`preview-motion-rounding-failure.json` 保留修复前 1 ULP 差异，`preview-webgpu-final.json` 的 4 个真实 preview 请求最终 RGBA 和 float 均为 0 差异。
- **真实 GUI 最终**：主目录生产 bundle 读取下载的 `gui-saved.fd`，角度 60、半径 7.5 均保留；角度 60→45→撤销60→重做45→撤销60。高斯图层 937.5% 和缩回 200% 后均显示 `WebGPU · 清晰`，见 `main-gui-gaussian-final.jpg`、`main-gui-final.jpg`。中途构建更新资源时旧页面 Worker 失效，截图单独保留为 `main-gui-rebuild-stale-worker.jpg`；最终验证在构建结束后重新加载页面执行。
- **实际生产导出**：`main-gui-export.sketch` 由主目录 GUI 下载；Sketch 原生重新渲染的 4 个画板在 `main-gui-native-pixels.json` 全通道零差异。
- **组合检查**：`main-kernel-tests.log` 8 项通过；`main-client-tests.log` 16 项通过；`main-metal.log` 12 组合通过。`main-build-preview-final.log` 完整桌面构建成功；`main-build-identity-final.json` 在该次检查时全部 2248 个记录输入匹配。构建期间其他任务修改 6 个渲染文件的失败保留在 `main-build-2.log`，之后基于最新状态重建，不覆盖并发更改。
- 主目录按 `integration.json`、`preview-fix-integration.json`、`preview-motion-fix.json` 记录合入。最终 UI 截图证明该小样本可见，不代替整套 G2/G5、Electron 窗口或物理显示延迟验收。严格原生 Sketch 核像素一致性依然 FAIL，后续特性清单依然有效。

- **实际位图预览补测**：`spatial-blur-file-check.html` 通过正式 WASM 导入测试 Sketch，再用生产 KernelClient 的 preview 请求分别在 100%/200% 渲染；`bitmap-preview-webgpu.json` 两例与 CPU 最终 RGBA 零差异。首次测试的静态 URL 错误仅是 fixture 加载失败，修正为 Vite `?url` 资源导入后运行。此检查新增文件为测试入口，不改变生产功能。

最终包含位图测试入口的重建见 `main-build-complete-2.log`，来源身份见 `main-build-identity-complete-2.json`；先前 `main-build-complete.log` 因新增测试入口漏写必填 `grid:false` 被 TypeScript 阻止，已修正，运行时透明背景的网格行为不变。所有旧日志保留。

最终交付页已在 `main-build-complete-2.log` 对应构建后重新加载，截图 `main-gui-delivered.jpg` 显示高斯属性和 200% 清晰画布。门与 case 结果、命令、退出码及证据 hash 见 `verification.json`；本轮文件当前 hash 见 `final-source-hashes.json`。
