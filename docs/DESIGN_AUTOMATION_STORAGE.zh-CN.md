# 本地编辑记录与自动化 SQLite 存储

基线：2026-10-19。此文描述现有CPU后端合同，不宣称Figma完整兼容或自动恢复任务执行。

## 1. 数据与授权边界

配置、操作审计、人工/AI/API编辑记录和任务状态复用桌面现有workspace SQLite连接池。当前schema版本为5，使用现有WAL、同步提交、应用私有路径与数据库大小限制。没有第二份JSON记录存储。

存储的内容仅为：事件种类、操作方法、来源、简短动作摘要、文档/会话/修订ID、结果状态、错误代码、耗时及时间。摘要由调用方生成为动作名称/数量，例如“调整布局 · 3 个节点”，不应包含节点正文、输入文本或原始提示词。

不存储token、临时socket/endpoint、授权凭据、原始prompt、文档内容、操作参数、结果、文件路径或错误堆栈。未知字段会被拒绝，而非静默接受。存储的preferredScope只是界面偏好，不能开启或恢复权限；实际桥接仍需每次显式确认，关闭文档/应用后失效。

## 2. 接口

所有参数均为严格JSON对象，不接受额外字段。时间为Unix毫秒；session/revision为非负JavaScript安全整数；标识符只允许ASCII字母、数字及`._:-`，不是文件路径。

| 方法 | 输入 | 输出/行为 |
|---|---|---|
| automation.config.get | `{}` | auditEnabled、retentionDays、maxAuditEntries、preferredScope、updatedAt |
| automation.config.set | 上述前4项可选 | 返回合并后的配置；事务内立即执行容量/年龄清理 |
| automation.audit.append | event、status及下述元数据 | `{recorded:true,id}`；禁用记录时`{recorded:false}` |
| automation.audit.list | limit?、beforeId?、documentId?、source? | entries、hasMore、nextBeforeId；ID倒序，筛选后分页 |
| automation.task.put | id、method、status；documentId/session/revision/code/durationMs/scope可选 | `{task}`；稳定目标身份，终态不能重启或改变结果 |
| automation.task.list | limit? | tasks、hasMore；最近更新在前 |
| automation.status | `{}` | available、config、auditCount、taskCount、limits、authorizationPersisted=false |

审计字段：

- event：grant、revoke、execute、edit。
- status：succeeded、failed、cancelled、unknown。
- source可选：user或automation。AI/API共用automation来源，不能仅凭来源推断具体模型或操作者身份。
- summary可选：非空，最多200个Unicode字符，不含控制字符；不传则为null。
- method可选：最多100字符的点分操作名称；execute事件必须提供。
- requestId最多128字符，documentId最多256字符；code最多64个大写ASCII字母、数字或下划线。
- durationMs：0至86400000；scope：read或write。
- edit事件必须提供source、documentId、session、revision。其revision为编辑器修订号，不等同于workspace快照版本号。

旧记录迁移后source/summary为null，不猜测旧记录属于人工还是AI/API操作。带source筛选时这些旧记录不会混入对应来源。

## 3. 容量、失败与恢复

- 默认开启记录，保留30天、最近1000条；retentionDays允许1至90，maxAuditEntries允许100至10000。禁用记录对人工与自动化记录统一生效。
- 审计单页默认50、最多100；beforeId必须为正整数。历史数据变化时，游标避免重复已读ID，但不提供跨多页快照隔离。
- 任务元数据最多256条；只清理到期或容量溢出的终态。活跃任务不被挤掉，满额返回AUTOMATION_LIMIT。
- 保留期清理在写入/配置变更时执行，不是定时后台清理。因此长期不写入时，旧行可保留至下次维护；SQLite删除后页空间可复用，不保证数据库文件立即缩小或取证级安全擦除。
- 写入使用参数化SQL和BEGIN IMMEDIATE。v3→v4建立基础表；v4→v5增加编辑来源与摘要，保留行、ID与AUTOINCREMENT高水位。失败回滚，并保留已有数据库。
- INVALID_REQUEST不回显输入；AUTOMATION_STORAGE_ERROR不暴露SQL或路径；不可用workspace返回WORKSPACE_UNAVAILABLE，不切换为不受控文件日志。
- 宿主异步记录失败不改变已经提交的设计操作结果。历史可用于诊断，不是“每次操作必有一条”的合规审计保证；界面应显示记录失败/队列溢出。
- 任务表只记录状态。应用重启不会据此执行任务或恢复访问；进行中的记录可成为旧状态，需要显式核查，不当作已完成。

## 4. 验证与复现

专用测试覆盖13项：配置/审计/任务重启持久化、敏感字段拒绝、容量/分页/禁用、年龄清理、活跃任务保护、身份不可变与终态、不可用workspace、人工与自动化来源筛选、摘要边界、v3/v4迁移及回滚。完整CPU后端回归：83通过、0失败、1个已有全CJK字体基准忽略。

从`design-studio`运行：

```sh
cargo test -p futureox-design-desktop-backend --locked
```

独立性能基线从仓库根目录运行：

```sh
python3 testing/automation-sqlite-benchmark.py \
  --backend /absolute/path/to/futureox-design-desktop-backend \
  --build-kind debug \
  --output testing/verification-automation/sqlite-benchmark.json
```

脚本仅创建并清理自己的临时目录，使用虚构编辑元数据、真实stdio进程与SQLite提交。它不读取用户文档、启动GUI或使用GPU；目前要求POSIX。

本次Linux x86_64 debug结果：1000次写入p50 1.172ms、p95 1.759ms；100条来源/文档筛选读取p95 6.573ms；重启校验成功，保留1000行，workspace文件258048字节，子进程峰值RSS约13.6MiB。这是一次本地测量，不是跨设备性能承诺；日志及JSON保存在`testing/verification-automation/`。
