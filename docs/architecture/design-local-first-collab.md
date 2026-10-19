# 设计器本地优先协作架构（纯本地，不含云实现）

> 范围：设计器（design-client / design-desktop / design-desktop-backend）当前"本地优先"的一致性模型与离线行为的架构说明，以及未来上云的迁移路径。本文只做结论性建议，不引入任何云端实现。用户已明确：当前版本不做云。

## 1. 现状盘点：本地多窗口如何协同

```
渲染进程 (design-client)
  └─ preload.cjs  coreDesktop.live: { initial / observe / openWindow }   ← 能力桥，无原生路径
       └─ main.mjs  ipc `live-observe` ─────────────┐
            └─ sidecar.mjs  NDJSON request           │ 同一进程内独占排队
                 └─ design-desktop-backend            ▼
                      protocol.rs: "workspace.observe" → workspace.rs::WorkspaceStore::observe
                        SQLite（单文件，WAL，synchronous=FULL）
                          documents / revisions / mutations / assets / local_sessions
```

关键既有机制：

1. **单写者权威存储**：每个窗口把编辑结果以 `workspace.commit`（文档快照 + expectedRevision + mutationId）提交给 sidecar 的 SQLite。revision 表天然就是"每次保存一个不可变快照"，即本地版本历史。
2. **CAS + 幂等重放**：`documents.head_revision` 上的 compare-and-set 保证并发窗口只能线性化提交；`mutations(mutation_id → request_hash)` 让同一 mutationId 的重试返回同一结果、不同内容则报 `WORKSPACE_MUTATION_CONFLICT`（见 `workspace.rs::replay`）。
3. **presence 与冲突保护**：`workspace.observe` 把 `LocalPresence`（视图、光标、选区）写入 `local_sessions`，并返回同文档其它窗口的 presence；15 秒未续期即过期、64 窗口上限。`viewHash`（文档列表哈希）未变时响应不带文档体，检测到别的窗口推进了 head，客户端经 `refreshLocalHead` 只在"本窗口空闲且干净"时静默跟进，否则保留本地修改等待用户处理（保存副本 / 重新打开）。
4. **协议帧词汇已就位**：内核 `protocol.rs::Envelope`（`Ops{revision,compressed}` / `Presence{session}` / `Subscribe{view_name,view_hash}` / `ViewLoaded` / `DenormalizedMutations`）是同时为本地与远端设计的帧类型；当前本地链路只用 `Subscribe`/`ViewLoaded` + `Presence`，`Ops`（补丁平面）留给未来。
5. **浏览器降级路径**：无桌面宿主时，design-client 用 IndexedDB（`local-store.ts`）——文档槽（binfmt 二进制）+ 版本历史（`revisions` 存储，每文档保留最近 50 条，同一事务内淘汰旧条目）+ `LocalConflictError` 单标签页 CAS。前端通过 `document-history.ts` 的单一 history API 在 sidecar / IndexedDB 间路由，面板不感知传输层。

## 2. 一致性保证（本地模型）

| 保证 | 机制 |
| --- | --- |
| 线性化写入 | SQLite 单写事务（`BEGIN IMMEDIATE`）+ `head_revision` CAS；失败方收到 `WORKSPACE_CONFLICT`，画布内容永不丢失 |
| 幂等重试 | `mutationId` + `request_hash` 重放窗口；写入结果不确定（进程崩溃后）时前端保留同一 mutationId 重新提交（`DesktopSession.workspacePending`） |
| 历史不可变 | 恢复 = 把旧快照写成**新** revision（summary 记"恢复自 rN"）；任何路径都不改写既有 revision 行 |
| 读完整性 | 每次打开/恢复都校验快照 hash、大小与元数据；损坏报 `WORKSPACE_CORRUPT`，绝不覆写存储 |
| presence 一致性 | presence 与文档读取在同一事务内快照；TTL 过期清理避免僵尸窗口 |
| 崩溃安全 | `synchronous=FULL` + WAL；保存先写恢复日志（recovery journal），重启后作为独立副本导入，不会覆盖更新的 head |

**边界（有意为之）**：本地模型是"快照 + CAS"，不是"并发合并"。两个窗口同时对同一 head 提交时，后到方冲突，由用户决定（保存副本 / 重开）。这是当前规模（单机 ≤8 窗口）下复杂度最低、保证最强的选择。

## 3. 离线队列

当前"离线"即常态（没有服务端），队列分三层：

1. **编辑层**：编辑器事务内存队列 + `pending-edits` 提交门（未提交文本/属性编辑阻止切换与保存，先落为文档修改）。
2. **保存层**：`DesktopSession.persistWorkspace` 维护至多一条待确认提交（`workspacePending`）——新一轮保存先结算旧的幂等请求再提交新的，崩溃重启后同一 mutationId 重放，不会重复记 revision。
3. **恢复层**：`updateRecovery` 防抖 600ms 写 recovery journal；进程意外退出后 `start()` 引导用户把 journal 作为独立副本导入（换新 id），避免无基线的恢复稿覆盖权威 head。
4. **浏览器层**：`SaveCoordinator` 版本化串行保存，仅确认自己提交的那份快照；IndexedDB 事务内完成"文档头 + 目录 + 版本快照 + 淘汰"四写，崩溃不会出现有头无史的中间态。

## 4. 未来上云的迁移路径（结论性）

**前提不变**：上云是把"权威存储 + 定序者"从本机 sidecar 换成远端服务，客户端契约（快照、revision、mutationId、viewHash、presence）尽量不动。

1. **第一步：中继而不合并。** 服务端只做 SQLite 同款语义：CAS 定序 + mutationId 幂等 + 快照存储。客户端把 `workspace.commit/observe` 的目标地址参数化即可（协议帧 `Envelope` 已经是为此设计的）。此阶段行为与今天的多窗口一致：并发冲突仍由用户解决。
2. **第二步：补丁化增量。** 把整文档快照换成 `Ops{revision, compressed}` 补丁流：本地 immutable 树让树 diff 廉价（对象 ID 对齐后指针相等即可短路）；必须保留 **move 原语**（delete+insert 会毁掉 override/引用链）——这正是 `sketch-kernel-analysis/12-svg-13-pdf-14-collab.md` 第 14 节 Sketch 协同的实证结论。
3. **追赶三段式**：新加入者先读现档、再上载本地补丁、最后整合远端补丁（同文 14 节 InitialCatchupController），避免双向风暴；大改动分包带进度。
4. **OT 与 CRDT 选型结论：选 OT 风格（服务端定序补丁），不引入 CRDT。** 理由：
   - 设计文档是**树形 + 强 schema** 结构，CRDT 的自由并发合并会产出"结构合法但设计上荒谬"的中间态，且文本 CRDT 的 tombstone 内存模型与现有 immutable 快照/版本历史模型冲突；
   - 我们已有单写者定序点（head_revision CAS）与幂等 mutationId，OT 的服务端定序正是它的自然推广，迁移路径最短；
   - presence / 大文档分包 / 迁移协调均可沿用 14 节的类结构映射。
   - CRDT 只在未来出现"真离线多人长时段分叉再合并"的硬需求时重新评估。
5. **鉴权与多租户**：上云时 Gateway 负责 JWT 验签与租户上下文（见根 AGENTS.md），文档服务的授权走 PDP 拦截器；本地的"窗口即身份"（localSessionId）只作为 presence 标识，不构成权限。

## 5. 与代码的对应

- 本地多窗口与 presence：`frontend/design-desktop/src/main.mjs`（`live-observe`）、`frontend/design-client/src/LocalWindows.tsx`
- SQLite 权威存储与 CAS/恢复：`design-studio/crates/design-desktop-backend/src/workspace.rs`
- 协议帧与注册表：`design-studio/crates/design-desktop-backend/src/protocol.rs`、`design-studio/crates/design-kernel/src/protocol.rs`
- 浏览器本地存储与版本历史：`frontend/design-client/src/local-store.ts`
- 统一 history API：`frontend/design-client/src/document-history.ts`
- 协同算法对照：`sketch-kernel-analysis/12-svg-13-pdf-14-collab.md` 第 14 节
