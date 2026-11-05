# 公开市面 Sketch 样例批量往返验证（2026-11-05）

## 范围与来源

官方 sketch.com 设计资源页仅提供需登录的在线工作区文档，无直接 `.sketch` 下载，因此本轮以 GitHub 公开 UI 套件作为「市面真实文件」来源，共 4 个仓库 9 个 `.sketch`（出处与许可见 `../fixtures/sketch-public-20261105/SOURCE.json`）。官方 `sketch-reference-files`（JSON）与 `file-format-series` 样例此前已在 `sketch-official` 覆盖。

批量驱动脚本：`../run_public_sketch_roundtrip_20261105.zsh`（对每个文件执行 `sketch_roundtrip_demo`：导入 → 导出 → 再导入，进程内 `CORE_DOCUMENT_MEMORY_BYTES=4294967296`）。

## 结果

| 文件 | 大小 | 结果 |
|---|---|---|
| wireframe_kit_chevalier.sketch | 286K | ✅ 节点 1312→1312，页 2 |
| semantic-ui-kit.sketch | 113K | ✅ 节点 170→170，页 2 |
| Emergency icons.sketch | 12K | ✅ 节点 33→33，页 1 |
| WFP Favicons.sketch | 906K | ✅ 节点 124→124，页 2 |
| [Legacy] WFP Icons.sketch | 193K | ✅ 节点 777→777，页 2 |
| [Legacy] WFP Template.sketch | 9.8M | ✅ 节点 4436→4436，页 35 |
| [Legacy] WFP UI Kit.sketch | 1.4M | ✅ 节点 3209→3210，页 6（再导入 +1 节点，待查） |
| WFP Logos.sketch | 3.1M | ❌ 导入拒绝：单条目展开 18.1 MiB 超 `MAX_ENTRY_BYTES` 16 MiB |
| free-sketch-bootstrap5-ui-kit.sketch | 40M | ❌ 导出拒绝：紧凑序列化后仍有条目超 16 MiB（write_zip 镜像读取预算，属既有政策） |

## 本轮修复

`import_any` 的格式嗅探会吞掉归档准入的真实原因：zip 形状合法但超预算的文件（如 WFP Logos 的 18 MiB 页面）此前误报「neither .sketch nor .fig markers found」。现在 `read_zip` 的 `Unsupported(archive resource limit)` 直接透传。回归测试 `import_any_reports_archive_limits_instead_of_marker_miss`（`sketch_import_admission`）覆盖超预算 zip 与非 zip 两分支。

验证：`cargo test -p futureox-design-kernel --test sketch_import_admission` 12 项通过；全部 24 个 sketch 目标 135 项通过；WFP Logos 实文件复跑现在报 `archive resource limit: entry expanded bytes`。

## 保留失败与后续

- 两个大文件失败同根：`MAX_ENTRY_BYTES` 16 MiB / `MAX_TOTAL_BYTES` 64 MiB 是 codec 级政策（镜像保证导出物可重开），不是缺陷。放宽上限或走桌面大文档流式路径（4 GiB 准入）属资源政策决策，未擅自更改。
- `[Legacy] WFP UI Kit` 再导入多 1 个节点（3209→3210），不影响通过，待单独定位。
- 本轮不声明原生 Sketch 像素或全部市面文件兼容；范围为上述文件的 codec 往返行为。
