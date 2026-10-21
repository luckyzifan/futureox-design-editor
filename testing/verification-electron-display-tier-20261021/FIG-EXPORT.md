# FIG 导出目标身份核对 — 2026-10-21

`final-default-fig` 的标准流程、完整落盘撤销和三倍率 PNG 导出均完成。原 `compare-visual.py` 因两次 FIG 导入的目标 UUID 不同而拒绝比较；**原比较门和原始 results 均未修改**。下面是独立的只读身份核对与实际文件字节证据，不是把原比较判为通过。

参考运行：[baseline-bf3-export-fig/results.json](baseline-bf3-export-fig/results.json)。候选运行：[final-default-fig/results.json](final-default-fig/results.json)。本地完整证明：[export-target-proof.json](final-default-fig/export-target-proof.json)。可提交的重现脚本：[verify-fig-export-target.py](verify-fig-export-target.py)。

两次输入均为 `01有料素材 (Copy) (1).fig`，fixture SHA-256 为 `3b2f071aebe931a1cfee60f04d5a1b49ea438dc9134ea628d584cce38949716c`。每次导入有 19,959 个节点、15 个页面。导出目标分别为：

| 运行 | 原始目标 UUID |
| --- | --- |
| baseline-bf3-export-fig | `8d7ac642-0367-49b2-a5b6-0da7a8afa709` |
| final-default-fig | `b7e6c25a-1cb4-4467-9fe7-20adb85f9c6b` |

目标名称 `Whooops, that page i`、类型 `text` 在每份文档中各出现 **2 次**，所以名称本身不是唯一身份。原结果记录的具体 UUID 都对应唯一完整路径 `[0,0,1,2]`：

`pages[0] Meher Admin Dashboard Ui Kit Light → children[0] frame 21_404_Error → children[1] frame 404 error → children[2] text Whooops, that page i`

正文均为 `Whooops, that page is gone.`，尺寸为 456×49，字号 30、字重 700、默认字体，局部变换均为 `[1,0,0,1,75.85958862304688,0]`。完整目标对象只相差 `node.id` 与 `fills[0].id`。脚本进一步比较了页面、全部祖先及目标的 authored 字段；只移除 schema 明确的节点/填充/描边/效果条目 ID，并把有序 children 引用改为完整树路径。文本、未知字段及其余值不被忽略。目标语义 SHA-256 为 `5d4af5bdd52d3101baf8b4446d1b3e91571bacfc3ebb58b959624869a87199d4`；页面及祖先语义 SHA-256 为 `ef2760569961cae6f9481789ad1d36e58a2954e14a9c4f6fe44fbb3ab42c3ee4`，两次一致。

两个 SQLite head 均为 revision 3，编码快照与各自 revision 1 的原始 BLOB 完全相同；原运行的完整文档 undo hash 及导出前后持久化 hash 也各自一致。脚本以 `mode=ro&immutable=1`、`PRAGMA query_only=ON` 打开已关闭测试的数据库，并拒绝非空 WAL，避免忽略未 checkpoint 的内容或写入数据库。此目标/祖先链没有外部资源占位符；含此类占位符的目标会拒绝，不能把两个 `null` 当作同一资源。

| 倍率 | PNG 尺寸 | 文件字节数 | 两次原始文件字节 | SHA-256 |
| --- | --- | ---: | --- | --- |
| 1x | 456×49 | 7,274 | 完全相同 | `9d966a3d6ed0011443ad207bd4c6d96b0a70105aa5bf10c19ccf89822208d988` |
| 2x | 912×98 | 14,477 | 完全相同 | `51c1fc63b067f95c97b4b233e701feb71ac6b09256fe968a8e0c53588f6cfe1d` |
| 3x | 1368×147 | 22,833 | 完全相同 | `9b35705e9355d469e871c4edb05e48ea97fd76345d47a2ea00ba838270bee1f8` |

脚本读取实际保存的 PNG，并核对原报告的大小、尺寸、SHA，再执行完整 bytes equality。没有重绘、重新导出、启动 GUI/GPU 或修改原结果。本次提取的首版曾误把 SQLite 存储的 revision hash 当成编码 envelope 的 SHA，因而拒绝；已改为分别记录 `storedRevisionHash` 和实际 `encodedSnapshotSha256`，并保留初始/最终 BLOB 的完整相等检查。

从仓库根目录重现：

```sh
python3 testing/verification-electron-display-tier-20261021/verify-fig-export-target.py \
  testing/verification-electron-display-tier-20261021/baseline-bf3-export-fig \
  testing/verification-electron-display-tier-20261021/final-default-fig \
  --output testing/verification-electron-display-tier-20261021/final-default-fig/export-target-proof.json
```

该证明只覆盖此叶文本导出目标及其祖先语义，不证明整份 FIG 的任意 ID 映射、全部导入保真度或运动清晰度/FPS。不同 UUID 的原严格比较仍不通过；以上结果是独立、明确限定范围的补充证据。

最终审查后的 `final-audited-fig` 已使用同一只读脚本再次核验：路径
`[0,0,1,2]`、上述目标/祖先语义 hash 和三个 PNG hash 完全相同；
完整证明在本地 `final-audited-fig/export-target-proof.json`。最终运行仍未
改动原严格 UUID 比较门。此运行和 `final-audited-117` 的实际构建资产
一致，详见 [summary.json](summary.json)。
