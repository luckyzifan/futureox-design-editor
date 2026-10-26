# 绘制图与等待分解：2026-10-26

目标：真实拓扑工作集 1:5 最终20瓦片约5.6秒绘制图、其中约3.47秒checkpoint及8.2万draw calls，寻找减少实际绘制/合成的精确优化。沿用当前全部源码进度；上轮准备缓存候选未采纳，本轮不自动带入。

起点发现8个已有Rust文件比桌面manifest更新（fig/font/image_adjust/interop/pattern_fill/scene/sketch preview/text_case）。已记录baseline.json，全部纳入冻结当前源码，并重建本轮基线Native/WASM，不将新源码与旧二进制混测。

固定真实拓扑1:5，100% / DPR2，855×868 CSS画布，24步×8ms、360×160、四次连续正反对象移动。原件只读，隔离profile和外部鼠标输入，原生事件仍检查trusted；最后实际DOM pointerup→当前精修完成。候选须至少3组交替A/B，中位数改善≥5%，每组方向均改善，最慢候选不回退超过10%；不能挑快样本。质量：非预期透明0、coverage/nativePhase=1、maxUpscale≤1、>250ms UI stalls=0；标准姿态去DOM叠层画布逐通道一致、实际硬件浮点逐位一致。四采样、HDR/导出、原预算、guard、资源完成和事务语义保持。

先运行完整pass/fence计数；探针记录计数与同步编码wall，不将其当纯CPU或GPU执行时间。GPU timestamp如使用，另列覆盖率与改变的诊断开销，不与未采样A/B混用。性能测量不与构建、重测试或其他测量并发，构建最多2个Cargo job。只有实际受益且正确性通过的差异才hash保护集成；否则归档候选，当前运行时源码保留。

影响G0/G1/G2/G3/G4/G6/G7。完整G5、跨平台和物理scanout另列，不因本轮定向通过宣称整体渲染目标完成。取消仅针对自有可选像素任务，保持已提交编辑与导出及物理fence。
