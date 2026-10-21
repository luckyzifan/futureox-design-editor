# FIG 撤销后的自动保存重试

`baseline-d2-passive2-fig` 中，X 属性编辑后撤销已经恢复原画面，但持久化文档仍保留编辑后的 X。日志表明撤销后自动恢复流程确实运行：encode 约 1339.7 ms，随后 save 以 24,990,131 个 UTF-16 code units 提交，长度与原快照一致；编辑版长度是 24,990,119。该 save 仅约 43.2 ms 便返回，之后没有新的自动保存尝试。阶段结束只表示 Promise 已返回，不表示返回状态为成功；原日志没有记录具体拒绝码。

源码中 `main.mjs` 的 workspace-open 和 workspace-commit 共用排他操作门。大型 workspace.open 尚未结束时，commit 可以返回 BUSY。DesktopSession 原先对自动保存失败没有重排，而手动保存有 run() 的 finally 重排。真实 Editor/WASM 的定向回归复现了这一机制：先保存原文档、保存 X 编辑版、undo 恢复原文档，令第一次 undo autosave 收到 BUSY 后，即使等待 10 秒，持久化仍停在编辑版。它与原记录吻合；真实 FIG 的最终验收仍须由 Electron 回归完成，不能把模拟 host gate 当作原日志直接记录了 BUSY。

修复仅对 BUSY 和 WORKSPACE_BUSY 保留自动重试标记，按 600、1200、2400、4800、5000 ms 退避。重试复用原 documentJson、expectedRevision 和 mutationId；若期间有新编辑，先确认旧请求，再提交新快照。已有 busy/手势/输入门仍阻止写入，但取消而未产生新 authored revision 后不会丢失这次已知忙碌重试。dispose、批准关闭、暂停恢复和 clean 状态停止重排。非忙碌失败、transport throw、无效 ACK 不会循环重试。

旧请求的成功确认现在使用与首次确认相同的文档 ID/版本检查，清除已解决错误；若当前捕获的较新 generation 具有完全相同字节，也确认该捕获，而不会确认捕获之后的新编辑。

验证：

- workspace-session、desktop-session、document-baseline-certificate、desktop-async-review、desktop-integrity-review：114 项通过。
- workspace-autosave-sqlite：真实 Editor/WASM、release backend、独立临时 SQLite；用受控 host gate 持有真实原生读取，第一次自动保存返回 BUSY，随后同一 receipt 保存撤销后的完整原文档；停止并重新启动 sidecar 后，全部 JSON 字节仍与原持久化快照一致，revision 由 2 追加为 3。1 项通过。
- typecheck、git diff --check 通过；未构建或运行 GPU/实际 FIG。

原生二进制：`frontend/design-desktop/dist/sidecar/futureox-design-desktop-backend`，SHA-256 `86dd751e4af33216241a1f0f15f64b2a985346733a78685bb20cc3f67eb67468`。真实存储测试最初因 macOS 临时目录未 canonicalize 被后端拒绝，改用 realpath 后通过；未修改后端路径准入，也未接触用户数据库。

复现命令（从 `frontend/design-client` 运行）：

```sh
bun run test src/workspace-session.test.ts src/desktop-session.test.ts src/document-baseline-certificate.test.ts src/desktop-async-review.test.ts src/desktop-integrity-review.test.ts --maxWorkers=1
FUTUREOX_BACKEND_TEST_BINARY="$(pwd)/../design-desktop/dist/sidecar/futureox-design-desktop-backend" bun run test src/workspace-autosave-sqlite.test.ts --maxWorkers=1
bun run typecheck
```
