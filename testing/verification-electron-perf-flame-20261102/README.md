# Electron 缩放、拖动与打开 FIG 的主线程序列化

2026-11-02。对照当前 `63ad10c` 上的火焰：缩放时整份文档 `JSON.stringify`（`augmentedDocumentJson`），拖动离开 translation-only 并刷新图层面板，打开 `.fig` 时布局准入再次序列化且开发启动默认打开渲染诊断。Mac 上与 Figma 的拖动对比只作为问题背景，本轮没有重测那台机器，也不把桌面拖动说成已经和 Figma 一样快。

## 改动

1. **缩放。** 视口提交只改相机。编辑图在画面稳定 200ms、且没有停着的滚轮相机时才打开。已校验的文档 JSON 只拼接页面投影，不再把每个节点再走一遍 `JSON.stringify`。渲染请求在文档对象没变时仍只带视口，不重发整份文档。
2. **拖动。** 父级不变、且 `translationOnlyChanges` 成立时，预览停在这条证明上，不跑全文档组件解析。动画校验留在这条证明失败之后。预览事务期间图层和检查器保持事务开始前的快照；松手、取消、换选择、换页或换工具才发布。颜色预览仍更新检查器。
3. **打开 `.fig`。** 布局内核已经序列化且结果仍是同一对象时，准入直接复用那段 JSON。同一回执上的后续编辑继续走既有 `resolve_components_patch`。第一次载入没有可对照的基线时仍全量解析。`frontend/design-desktop` 的 `dev` 脚本不再默认设置 `CORE_RENDER_DIAGNOSTICS=1`。需要诊断时显式导出该变量。导入诊断在桌面标志关闭时不记录。

未改光栅、瓦片导航、GPU 预算或实验开关。33/100ms 与完整 G2/G5 未通过。没有在本环境做 Electron GUI 或硬件 GPU 回放。

## 单页编辑

多页素材文件里，只改当前页时不再把整份文档重新布局、重新校验或重新收成一份图操作。

**已经按页收住的：**

- 当前页上的普通改动（文字、填充、不带动布局的尺寸）不再调用 `resolve_components_full` / `resolve_components_patch`，也不再 `JSON.stringify` 整份文档。其它页的节点对象保持原引用。
- 当前页里需要重排的岛屿（自动布局、约束、非固定尺寸）只把该根子树交给布局内核。子集不带 `designSystem`，因此不会换掉常驻组件回执。其它页节点引用不变。
- 预览布局按根判断：别的页上的组件、连接线或实例不再让当前页的普通根失效。
- 校验、schema 升级和组件扫描在这条证明成立时只看改动节点。结构没变时不再走整棵树。
- 父级链接没变时，`allParents` 沿上一次快照复用；可变草稿仍每次重算。
- 单个内容节点（例如改文字）编译成一条 `removeNode` + `insertNode`，带上原来的子节点列表，不再为这条操作展开整张图。
- 另一页上的连接线不再仅仅因为存在就让 `plan_patch` 退回全量解析；只有端点指向本次改动时才全量。定义集合为空时不再为了找实例把每个节点走一遍。
- 损伤不是全页时，现有瓦片逻辑仍只丢掉与脏区相交的当前页视口瓦片。这条编辑不改瓦片预算。

**仍然是整份文档或整张图的：**

- 第一次打开 `.fig` / 新文档仍然全量准入。
- 跨页组件、实例、样式、变量、布尔、重复、被连接线指到的节点，以及改页面结构、动画或文档字段，仍走原来的全量路径。
- `translationOnlyChanges` 在平移证明上仍会看一遍节点；文档里任意连接线仍会让这条平移证明失败，随后若该连接线不指向本次改动，布局会停在当前页。
- Rust `RemoveNode` 仍会扫描存储来找父级。损伤计算里的 `parent_index` 仍是整份文档。`plan_patch` 仍会为父级和“连接线是否指向本次改动”走一遍节点，但那次不再因此做全量解析。
- 布局岛屿如果真的改了节点，仍会浅拷贝一次节点表，不是把每个节点再序列化一遍。
- 预览布局每个新手势仍会分类一次根，用来知道哪些根不能进岛屿。
- 没有重测 Electron GUI、硬件 GPU 或 Figma 耗时。33/100ms 与完整 G2/G5 仍未通过。

## 已跑

在已构建的 debug WASM 上：

- `bun x vitest run` 覆盖 `augmented-document-json`、`camera-state`、`prepared-document`、`translation-preview`、`translation-preview-kernel`、`import-diagnostics`、`interaction-ui-runtime`、`local-edit-proof`、`editor-move-preview-reuse`，以及本轮 `page-edit-scope`、`parent-map-reuse`、`preview-layout`、`local-edit-work`、`components`、`authoring`、`document-patch`。
- `cargo test -p futureox-design-kernel --lib component_updates::tests`（7 项通过，含另一页连接线不强制全量 plan）。
- `bun test src/kernel/op-sync-history.test.mjs`（18 项通过）。
- `node --test frontend/design-desktop/test/render-terminal-diagnostics.test.mjs`（27 项通过，上一轮）。
- `tsc --noEmit` 通过。

这些是 jsdom、Node 和 WASM CPU 证据，不是物理显示或 Figma 对照计时。
