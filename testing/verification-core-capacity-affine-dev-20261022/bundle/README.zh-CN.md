# Core 最新源码增量包

**开发包：最终组合尚未验证（DEVELOPMENT PACKAGE — FINAL COMBINATION UNVERIFIED）。不是可直接安装的发行版。**

- 唯一基线：`5494bb50b3057ccf5f6b9cc9056fb4221dbbb420`。
- 源码冻结：2026-10-22 15:03 UTC。精确时间、117 个文件的修改前后 SHA-256 和模式见 `manifest.json`。
- 包含字体缓存、受信任资源容量与 FD 生命周期改进、桌面分片传输与数据库迁移、缩放覆盖、实时仿射交互、20,000 solid 容量回退及测试有效性修补。
- 包含完成静态复核且通过 29 个 Graph / 6 个 NodeStore 原生测试的 signed-zero-safe Arc 共享版本，不包含此前不安全版本。
- **不包含编译好的 WASM、桌面二进制或依赖。必须从本包最终源码重建 WASM 和桌面相关组件。** 已有 `431b7395…` WASM 仅对应较早快照，不能视作本包匹配构建。
- 这是相对上述完整 Git 提交的一次性增量，不应叠加到未知旧增量包。若当前工作区有其他改动，请先保留它们，另建干净的该基线工作区。

## 内容

- `source/`：本次新增或修改的产品源码、测试和产品文档。
- `baseline/`：对应文件的原始基线内容，供精确源码回滚。
- `changes.patch`：同一 117 文件增量的标准 Git 补丁。
- `manifest.json`：逐文件修改前后 SHA-256、模式和排除说明。
- `apply_increment.py`、`rollback_increment.py`：全部文件预检、精确基线保护及逐文件原子替换。
- `VALIDATION.zh-CN.md`、`evidence/`：经过整理的组件证据及未完成项。不同批次和重复运行不能相加成“最终全部通过”。
- `SHA256SUMS`：包内文件校验清单。压缩包本身的 SHA-256 单独提供。

## 应用

先退出所有 Core 实例、sidecar 和使用该工作区的进程，保留当前源码修改。Python 3 和 Git 必须可用。解压后在包目录执行：

```sh
python3 apply_increment.py check /absolute/path/to/Core
python3 apply_increment.py apply /absolute/path/to/Core
```

脚本要求目标目录就是 Git 根目录，HEAD 必须精确等于基线；存在暂存改动、其他已跟踪文件改动、受影响文件未知修改或符号链接时拒绝执行。全部文件先验证再写入，不改 Git 索引，不下载依赖，不自动构建，不运行应用或迁移数据库。重复运行仅接受精确基线/候选字节以恢复中断；不是全仓库事务。修改脚本或绕过保护不会获得兼容性保证。

随后遵循项目文档安装已有锁定依赖并重建 WASM、frontend 和 desktop/backend。旧生成物必须更新，不能只替换 TypeScript/Rust 源码就宣称已启用修复。完整最终组合的类型检查、匹配 WASM 回归及实际桌面/GPU验收仍待完成。封包时已生成新的开发 WASM（SHA-256 `e7940afed3992ac586e34d3fc2816e23c77265992645524c0ef20e001b953613`），但不包含在此源码包内，集成压力验收尚未完成。

## 数据库迁移和回滚：必须先读

本包桌面持久化会把工作区迁移到 schema 6。应用到真实 profile 前，应关闭全部实例和 sidecar，制作并验证 SQLite 一致备份，包括工作区和 recovery 数据。使用静止数据库的 SQLite backup 工具/API，或保留完整已关闭 profile 及必要的 `-wal`、`-shm` 文件。不要只复制仍在使用的 `.sqlite3` 文件，不要删日志或手工降低 `user_version`。

备份原件保持不可变，先验证其副本能重新打开。详细约束见 `source/docs/DOCUMENT_CAPACITY_V1.md`。

源码回滚命令：

```sh
python3 rollback_increment.py /absolute/path/to/Core
```

**这个命令只恢复源码，不会降级数据库，也不能使 schema 6 或超过旧 32 MiB 上限的新文档兼容旧版本。** 回滚前先关闭新应用，另做一份包含升级后全部编辑、版本及 receipt 的一致备份。只在独立 profile/位置用旧应用打开升级前备份，绝不覆盖当前数据库。旧备份没有升级后的编辑；保留 schema-6 数据供兼容构建使用，并先导出、校验较新的文档。不存在自动无损降级的承诺。

如果产生了新的源码修改，脚本会拒绝覆盖；应先保存这些修改并人工合并，不要强制重置。
