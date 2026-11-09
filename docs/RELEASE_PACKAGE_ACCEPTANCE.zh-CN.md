# 正式 release 包验收与组件清单

这是发布准备清单。没有冻结的正式安装包时，打开、导航、编辑、撤销、自动保存、关闭重开和原生导出都保持 `not_run`。开发包或 `desktop-dev` 的记录不能填这些格子。这些缺口不是已确认的运行故障。

## 桌面流程

```bash
node frontend/design-desktop/scripts/release-desktop-flow.mjs
```

设置 `FUTUREOX_RELEASE_PACKAGE` 时，脚本只计算包文件的哈希，仍然不启动安装器或 GUI。原设计文件的只读 SHA、签名和公证都不在云端这次运行里。

## 组件清单

```bash
node frontend/design-desktop/scripts/release-component-inventory.mjs
```

脚本核对 `frontend/design-client/public/licenses/` 与 `inventory.json` 的哈希，列出 `design-mcp` 源文件和 Linux FFmpeg 的 SHA-256。`Cargo.lock` 里的 `name` 条目和 `package.json` 里的 Electron 版本只标成构建输入。没有 release 目录时，范围是 `packaging_inputs_not_a_release_bundle`，不是已分发组件清单。

## 云端结果

2026-11-09，linux x64。本机没有 `frontend/design-desktop/release` 正式包，也没有启动 Electron 安装器。桌面流程 12 步都是 `not_run`。组件清单里 10 条 UI notice 的哈希与 `inventory.json` 一致。Electron 版本记录为 44.7.0，Chromium 二进制没有被哈希。`Cargo.lock` 当前有 381 条 `name` 记录，脚本把它标成构建输入，不是随包清单。
