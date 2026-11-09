# 自动保存异常退出与存储失败恢复（2026-11-09）

这是云端可运行的恢复路径验收，不是正式 release 安装包上的桌面流程，也不是已确认的数据丢失故障。

## 覆盖

| 故障 | 证据 | 本环境 |
| --- | --- | --- |
| 保存中退出 | 未提交的 SQLite 事务在连接丢弃后回滚；`journal.next` 半截内容不会替换 `journal.json` | 模拟通过后记入报告 |
| 写入失败 | 临时文件写入返回 `StorageFull` 时原字节保留，错误不是「File saved」；只读工作副本拒绝覆盖 | 模拟通过后记入报告 |
| 重开恢复 | 失败保存之后，恢复快照仍可读，工作副本仍是上一一致版本 | 模拟通过后记入报告 |
| 升级迁移 | 人为留下 `assets_v6` 使 v5→v6 迁移失败时，`user_version` 停在 5，文档行还在；去掉阻挡后可以迁移并读回 | 模拟通过后记入报告 |
| 原文件 | `recovery.write` 和失败的 `.fd` 保存不改导入字节 | 模拟通过后记入报告 |
| 正式安装包 | 安装、打开、导航、编辑、撤销、自动保存、关闭重开、原生导出 | `not_run`。本机没有 release 包，脚本不把开发测试写成安装包通过 |

## 命令

在仓库根目录：

```bash
node frontend/design-desktop/scripts/accept-autosave-recovery.mjs
node --test frontend/design-desktop/test/autosave-recovery-acceptance.test.mjs
```

脚本退出码 0 只表示模拟后端检查通过，并且 release 步骤被明确标成 `not_run`。`releaseAcceptance` 保持 `not_closed`。

## 云端结果

2026-11-09，linux x64：

- `cargo test -p futureox-design-desktop-backend autosave_recovery`：6 通过。其中库内 2 项，集成 4 项。
- `node --test frontend/design-desktop/test/autosave-recovery-acceptance.test.mjs`：2 通过。
- `node frontend/design-desktop/scripts/accept-autosave-recovery.mjs`：退出码 0。五类模拟故障为 `passed`，安装包上的打开、导航、编辑、撤销、自动保存、关闭重开和原生导出为 `not_run`。

