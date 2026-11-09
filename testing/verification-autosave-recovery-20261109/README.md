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

## 本机合并复核（2026-11-10）

整合基线为 `4152795ed3cca8966aae13e1a6161ebcefe4e41d`，环境为 macOS arm64、Rust 1.99.1、Node 24.12.0。Rust 测试由本次源码重新编译，构建与测试并发上限为 2。

复核中修正两处原候选问题：测试不再无条件导入 Unix 专用权限 API，改用可跨平台编译的只读权限和清理守卫；报告必须观察到全部 6 个具名恢复测试实际执行为 `ok`，退出 0 但零测试、漏测或忽略测试的结果保持 `not_run`。

- 同一个「零选中测试不能通过」反例在原 PR 报告上失败，修正后通过。
- `node --test frontend/design-desktop/test/autosave-recovery-acceptance.test.mjs`：5 通过，无跳过。
- `node frontend/design-desktop/scripts/accept-autosave-recovery.mjs`：6 个具名 Rust 测试均执行通过，`missingTests` 为空；安装包步骤仍全部 `not_run`。
- `cargo test --locked --manifest-path design-studio/Cargo.toml -p futureox-design-desktop-backend -- --test-threads=2`：192 通过，0 失败，13 个既有显式本机大文件／性能用例被忽略，没有把这些用例计为通过。

本机结果覆盖实际文件、SQLite、恢复与 stdio 后端回归；Windows/macOS 安装包、GUI 完整流程及断电故障没有在此执行。Windows 专属回归仅修正了源码中的不可移植接口，不声称 Windows 实机验收通过。
