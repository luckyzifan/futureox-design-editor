# 5494bb5 基线容量/实时仿射源码增量合并记录（2026-10-22）

将开发增量包 `core-5494bb5-latest-source-increment-dev-20261022T1503Z.zip`（压缩包 SHA-256 `06fcaef38db9b2e65259c207e7a3decf6264a52759512cb37ea15a0f000f876a`）合入主线。适用基线 `5494bb50b3057ccf5f6b9cc9056fb4221dbbb420` 与合并时 HEAD 完全一致，直接执行包内哈希守卫的 `apply_increment.py apply`（117 个路径全部命中，无手工改动，未触碰数据库）。包体、逐文件前后 SHA-256 与证据见 [bundle/](bundle/)。

## 合并内容（117 文件：frontend/design-client 61、design-studio crates 29、frontend/design-desktop 21、docs/testing 6）

- 字体缓存、受信任资源容量与 FD 生命周期改进。
- 桌面分片传输与存储 schema-6 迁移（含 recovery 路径）。
- 缩放覆盖、实时仿射交互与生命周期。
- 20,000 活跃 solid 容量回退及测试有效性修补。
- Graph Arc 共享（signed-zero-safe 版本，已过 29 Graph + 6 NodeStore/history native 测试；不安全旧版本未打包）。

组件级证据与限制以包内 [VALIDATION.zh-CN.md](bundle/VALIDATION.zh-CN.md) 为准；不同批次/运行不能相加为最终组合通过数。

## 本地执行

仅执行包内完整性与应用流程：`apply_increment.py check`（validatedFiles 117）与 `apply`（filesChanged 117）。**本次合并没有在本地复跑任何功能测试、类型检查或构建**，不构成对最终组合的验证。

## 未覆盖边界（不得宣称）

- 本包不含编译产物：必须从最终源码重建 WASM 与桌面组件。已有 `431b7395…` WASM 对应较早快照，不匹配本包；封包时生成的开发 WASM（`e7940afe…`）未随包分发。
- 最终全项目类型检查在打包侧被终止（退出 137），不是通过；真实 Electron/GPU 缩放像素、连续缩放后编辑/撤销、十份大文档同页内存与性能、整机迁移恢复均未验收。
- schema-6 迁移不可自动降级：应用到真实 profile 前须按包内 README 做经过验证的 SQLite 一致备份；`rollback_increment.py` 只恢复源码。
- 32 MiB 不可信外部导入/归档安全边界保留，"大文档容量改进"不等于无限制接受外部输入。
