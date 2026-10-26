# 运动连续性修复与仍未通过的清晰度：2026-10-26

**这是部分修复记录，不是“三文件无延迟、无模糊”通过报告。** 原始工作区 `39ff10be` 加已有修改被冻结到 `baseline.json` / `baseline.patch`，在独立 worktree 和独立 Electron profile 实施。下载原件不修改。具体场景和质量目标先登记在 `RUN_SCOPE.md`。

## 默认路径的改动

- 保留完整旧画面，直到新的交互图层全部导入；缺失 GPU 句柄不能被解释为有意透明。旧实现复现、新实现回归见 `continuity-old-failure.log`。
- viewport 裁片不能代表完整页面。整页移动必须有实际像素覆盖，或由编译器保守 paint support 证明空缺只有页面背景；缺少内容时请求同所有者的原始世界瓦片，不能清空画布或推进输入呈现 ACK。
- 修复 1×1 常量背景初始化误用世界空间 scissor，导致不透明背景被清零。`background-old-failure.log` 复现；`hardware.json` 在 Apple Metal-3 非 fallback 设备上，对白色、灰色、HDR/负值及 authored 透明，共 24576 个浮点 word 与正常路径逐位一致。
- 四层裁剪遮罩、描边对齐、可选根缓存复制、最终四样本 resolve/HQ resolve/crop 都经过实际存活资源准入。预算和采样算式不变。可选缓存无法容纳时保留已完成内容，不因缓存副本拒绝而丢掉整帧。
- 同密度、严格整设备像素相位的平移复用已有 native 像素。可选预览取消限定到自己的请求，避免覆盖分支的全局取消同时饿死原生细节任务；原始物理请求仍持有完成 fence。
- 已接受的原生整页平移可尝试复制实际完成的最终画面。需要私有源内容身份、完整像素覆盖、完全一致的采样/相位、编译参数及原生 translationOnly 证明；不能凭公共文档 receipt、诊断采样或请求 ACK 续期。117 的一次实际命中与重新绘制 PNG 比较为零通道差异；其他移动仍可能不符合条件。

## 真实文件结果与限制

原始输入是下载目录的 `117.sketch`、`01有料素材 (Copy).fig`、`拓扑素材.sketch`，SHA-256 见 `runtime.json`。拓扑主要运动回放使用真实首工作集 `1:5`；不能据此声称所有工作集、所有页通过。

| 场景 | 非预期透明 | 清晰度与延迟 |
| --- | --- | --- |
| 117 旧版快速对象移动 | 133 次探测中 19 次；最多 790856 个透明像素 | 旧故障复现 |
| matrix-5 三文件对象移动 | 已测帧均为零 | 密度/相位完整，但 117 最终收敛约 1925 ms，拓扑约 16836 ms |
| matrix-5 三文件快速缩放 | 已测帧均为零 | 旧纹理最大放大约 21.76× / 29.76× / 72.93×，FAIL |
| 最新宽整数滤波 + 可见瓦片实验，117 | 199 个 Alpha 探针零透明 | 停手收敛约 620 ms，运动中仍最大 27.82×，FAIL |
| 最新宽整数滤波实验，拓扑快速编辑 | 30 个 Alpha 探针零透明 | 最终收敛约 16717 ms，FAIL |

零透明不代表对象及时跟随输入：保留旧完整 backing 也可能零透明。拓扑后续回放仍出现 `interactionCoverageMissing`、没有可采样背景 texel的来源和原生重绘长等待。完整视口覆盖、背景支持、实际对象位置跟随必须分别验证。不能用维持旧画面的质量统计掩盖冻结。

早期 `quality.json` 的 `motionGate=PASS` 实际只计算 Alpha/覆盖/密度/错误，遗漏姿态延迟。该历史文件保留以便审计；新版 summarizer 将其改称 `coverageGate`，姿态延迟为 `NOT_MEASURED`，物理延迟阈值未登记为 `BLOCKED_THRESHOLD_UNREGISTERED`；几何通过也只能得到 `motionGate=INCOMPLETE`。

## 独立滤波候选，默认关闭

`VITE_DESIGN_WIDE_RATIONAL_PREFIX=1` 用原始 Rust 生成的有理系数。现有扫描和存储仍为 signed-128 / 4 MiB，仅窗口加权及精确 nearest-even 除法扩大到本地 256 位整数。私有上传证明限制半径 32..512、系数字数及中间值；无证明、非有限值或范围不满足时使用原精确路径。任何纹理写入撤销证明。

`wide-hardware.json`：实际 Apple Metal-3，10 组原算法/候选浮点逐位比较全部零差异，含极端指数、subnormal、NaN/Inf 中间值、clamp 及完整 514×514 输出。大样例约 485 ms → 31 ms；这是算子 wall time，不能当作整编辑器加速倍数。较小输入有变慢。`wide-tests-3.log` / 最终组合测试覆盖资源更换、所有写入撤销、flag off、预算及生命周期。

真实 117 组合回放仍失败，所以该开关、`NATIVE_NAVIGATION`、`NATIVE_VISIBLE_TILES`、`EXACT_CLAMP_PREFIX` 等既有实验均未改为默认开启。没有改变 desktopFullMath、HDR/浮点/导出精度，也没有增大预算。

## 检查与未完成门槛

- `combined-tests-final.log`：22 个测试文件，414 通过、5 失败、1 跳过。五项 progressive-damage 失败均由冻结原始 Surface 复现，见 `progressive-baseline-control.log`；未删除或忽略。
- `typecheck-final.log`：通过。`desktop-diagnostics-final.log`：27 通过。
- `default-14-functional.json`：最终默认配置三文件的平移、对象移动、撤销重做、保存、导出、重新导入全部完成；拓扑验证的是工作集 `1:5` 的非零修改和完整原格式导出重开。该轮用于功能回归，不用于性能 A/B。
- 所有 GUI/Alpha/浮点 readback 是实际硬件证据，仍不是物理输入到光子测量。完整 G2、G5 固定大场景矩阵、跨平台和 HDR/export 全矩阵未通过或未运行；用户“全部修复”的目标未完成。
- 下一步需要解决：铺满视口时独立、精确且受预算管理的页面背景来源；对象/画板范围的提交复用；高倍缩放下可及时完成的原生绘制与旧目标抢占。继续加低分辨率预览不能消除当前问题。

`changes.json` 绑定 39 个变化文件相对冻结基线的 hash。已在全体前置 hash 匹配后应用到主工作区，保留原有其他修改，并完成默认 `bun run build --fast`。备份与应用结果见 `integration.json`；`final-build-identity.json` 核对 2232 个构建输入、最终 manifest 和渲染器产物，重建的三个原生二进制与已测基线逐字节一致。下载的三个原件 SHA-256 未变。旧的用户窗口未自动重启。不得把克隆旧 host 的原 manifest 当作新 renderer 的构建证明。
