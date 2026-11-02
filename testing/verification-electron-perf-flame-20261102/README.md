# Electron 缩放、拖动与打开 FIG 的主线程序列化

2026-11-02。对照当前 `63ad10c` 上的火焰：缩放时整份文档 `JSON.stringify`（`augmentedDocumentJson`），拖动离开 translation-only 并刷新图层面板，打开 `.fig` 时布局准入再次序列化且开发启动默认打开渲染诊断。Mac 上与 Figma 的拖动对比只作为问题背景，本轮没有重测那台机器，也不把桌面拖动说成已经和 Figma 一样快。

## 改动

1. **缩放。** 视口提交只改相机。编辑图在画面稳定 200ms、且没有停着的滚轮相机时才打开。已校验的文档 JSON 只拼接页面投影，不再把每个节点再走一遍 `JSON.stringify`。渲染请求在文档对象没变时仍只带视口，不重发整份文档。
2. **拖动。** 父级不变、且 `translationOnlyChanges` 成立时，预览停在这条证明上，不跑全文档组件解析。动画校验留在这条证明失败之后。预览事务期间图层和检查器保持事务开始前的快照；松手、取消、换选择、换页或换工具才发布。颜色预览仍更新检查器。
3. **打开 `.fig`。** 布局内核已经序列化且结果仍是同一对象时，准入直接复用那段 JSON。同一回执上的后续编辑继续走既有 `resolve_components_patch`。第一次载入没有可对照的基线时仍全量解析。`frontend/design-desktop` 的 `dev` 脚本不再默认设置 `CORE_RENDER_DIAGNOSTICS=1`。需要诊断时显式导出该变量。导入诊断在桌面标志关闭时不记录。

未改光栅、瓦片导航、GPU 预算或实验开关。33/100ms 与完整 G2/G5 未通过。没有在本环境做 Electron GUI 或硬件 GPU 回放。

## 已跑

在已构建的 debug WASM 上：

- `bun x vitest run` 覆盖 `augmented-document-json`、`camera-state`、`prepared-document`、`translation-preview`、`translation-preview-kernel`、`import-diagnostics`、`interaction-ui-runtime`、`local-edit-proof`、`editor-move-preview-reuse`（109 项通过）。
- `bun test src/kernel/op-sync-history.test.mjs`（18 项通过）。
- `node --test frontend/design-desktop/test/render-terminal-diagnostics.test.mjs`（27 项通过）。
- `tsc --noEmit` 通过。

这些是 jsdom、Node 和 WASM CPU 证据，不是物理显示或 Figma 对照计时。
