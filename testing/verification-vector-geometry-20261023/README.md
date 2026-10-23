# 主画布工作集与双精度路径验证

基线：`c65ed474141825968cb5e032d6add4cecd584a6d`。这是尚未提交的候选实现，不能视作完整大文档渲染验收通过。来源、4 GiB 源存储与调度的历史证据见相邻 `verification-large-document-4gib-20261023`；这些容量结果不代表完整 4 GiB live scene。

## 实现

- 页面/画板进入既有主 Canvas、Editor、Layers、Inspector；源 JSON 和全部 ZIP 成员留在原生存储，保存只回写已修改字段。
- schema 16 的 f64 render geometry 与按需可编辑 network 分离；FIG 的二进制曲线解码共享 Rust 实现。Sketch 保留现有 codec，并修复路径坐标单位、矩形圆角、空形状、等价轴向渐变和多操作数组合。
- 原生布尔工作集拆分只解决单组超过 64 个操作数的情形，并不解决单条密集轮廓超过 CSG 段数上限。
- 实际 GUI 暴露并修复：前端对极细 group 的尺寸校验与 Rust 不一致；实例 resize 的 `$root` 覆盖被误判为结构修改；新增源属性被拒绝；准备失败后原画布与原生保存基线不一致。

## 已执行

- 完整 kernel lib：555 passed、4 ignored。native geometry 集成：7 passed。CPU 1x/3x/32x 等价曲线像素比较通过；不冒充硬件 GPU 像素一致性。
- 最新 backend lib：48 passed、6 ignored。真实控件整页（773 authored nodes、42 roots、1,550,293 模型字节）另行运行：修改名称、将组件宽度改为 120、保留同步覆盖、完整 64 成员导出、重新打开均通过。
- 最新前端三套回归：6 passed；包含真实 Editor/WASM、源属性差量和页面准备失败后恢复原保存基线。Canvas 与 native I/O 在挂载测试中使用替身，另有实际 Electron 测试。
- 桌面传输测试：受控文档容量 fixture 下 23 passed；此配置仅用于 mock 传输测试，真实 Electron 使用自动容量策略。默认环境的一次大 payload fixture 拒绝记录于 `host-environment-failure.txt`。
- TypeScript 与最终桌面构建通过。真实源文件 118,272,240 字节、64 个 ZIP 成员、总展开 831,806,447 字节、124,399 源对象。

## 真实 Electron 发现

使用独立 bundle `com.futureox.codex.topologytest`、`--desktop-isolated-profile` 和专有 PID 树，只关闭本任务创建的实例。未停止其他任务的 Electron、服务或构建。

“控件”整页已经在共享主画布实际显示 WebGPU 图标、渐变与文字；尺寸 100 → 120、撤销到 100、重做到 120 已通过 UI 操作。最终构建的独立 Electron PID 为 45064：再次从下载目录导入，Inspector 将地球实例宽度从 100 改为 120，保存成功，从原生保存对话框导出全新文件 `topology-main-canvas-20261023-2145.sketch`。673.3% 适合选择视图仍显示实际 WebGPU 像素。详见 `gui-results.json`；截图仅存本机桌面并记录 hash。

`gui-export-verification.json` 核对了实际 GUI 导出的全部 ZIP 成员：64 个成员齐全，63 个成员解压字节完全一致；唯一变化页的语义差异仅为目标实例 frame.width 和新增 userInfo。原文件 SHA-256 保持 `b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12`。原生重新打开已另行通过，GUI 重新打开该导出文件未执行。

以下仍是失败项，不能计入通过：

1. 306 个真实顶层转换窗口中 304 可转换，2 个窗口（`1:32480`、`1:81474`）包含 36 色标径向渐变，超过现有单渐变 32 色标能力。原始色标完整保留，没有截断。
2. 第一块 57.1 MiB 源画板能生成约 30 MiB 模型，但真实 GUI 准备在布尔节点 `04AD0502-D8B1-4126-87A2-130302EE21AA` 拒绝。两个单闭合轮廓分别有 28,728 和 27,889 条 cubic，超过 8,192 CSG 输入段上限；转换成功不代表可渲染。
3. 最大完整页面超出本机会话 live Document 准入；没有抬 GPU/工作内存预算或删除 guard。完整 4 GiB live scene、全矩阵高倍率/旋转/连续编辑、通用外部格式保真仍未验收。

遵循用户“没问题就提交推送”的条件：存在上述渲染失败时不提交、不推送。私有原文件、源片段、截图与完整导出不放入仓库；性能数据受并行任务影响，本轮不作 FPS 或速度收益声明。
