# 六包去重集成与联合验证 · 2026-10-23

本次从 `518d8ddad6bf7b3865035f1c89ad6548befd4a2d` 集成用户指定的 8 个 ZIP。两对 ZIP 的 SHA-256 完全一致，去重后为 6 个包。所有变化文件的前置字节、模式、候选哈希与后续完整状态要求逐级匹配；最终保留 90 个唯一源码、测试和文档路径，逐一匹配最新适用包的精确哈希。无需手工解决源码冲突。

| 顺序 | 包 | 该包变化路径 | 处理 |
| --- | --- | ---: | --- |
| 1 | 16:21 render-repair | 33 | 被后续累计包完整包含 |
| 2 | 17:42 partial-repairs | 53 | 被后续累计包完整包含 |
| 3 | 18:29 backend-save-lifetime revision2 | 55 | 采用完整累计状态 |
| 4 | 21:54 navigation-present-admission | 10 | 校验 55 文件前态后叠加 |
| 5 | 23:26 save-local-edit-zoom | 22 | 校验完整前态后叠加 |
| 6 | 00:58 overlay-cohort-ack | 13 | 校验完整前态后叠加 |

90 个文件涵盖 GPU 生命周期与 pool 准入、导航和交互交接、诊断、字体来源保留、构建 WASM 身份、SQLite 保存旧 head 释放、保存传输、局部编辑证明、缩放细化，以及 overlay 捕获身份与同 tracker 的过期 ACK 拒绝。较新累计版本保留较早功能，不重复存放旧源码副本。

包内说明和脚本作为交付资料审阅，没有执行其中的安装、应用或回滚脚本。使用独立预检先模拟全部状态，再写入通过校验的最终文件。原有研究文件及并发研究变化均不纳入提交。

额外修正两份**基线已存在**的后端测试文件：automation 的两个成功迁移断言改为公开 `SCHEMA_VERSION`，因为基线已经是 schema 6；workspace_assets 的损坏资源夹具改为等长错误字节，让它满足 schema-6 长度 CHECK 后继续命中原有哈希拒绝路径。未改变生产迁移、资源校验或内存默认值。项目开发 Skill 增加本记录链接，并补齐来源文档引用但未交付的 image-table 验证入口，指向当前真实来源和复验记录。详细前后哈希见 [integration-adjustments.json](integration-adjustments.json)。

## 本轮实际结果

| 检查 | 终态 |
| --- | --- |
| 锁定依赖安装 | 通过，Vite 8.3.3；包与锁文件哈希不变 |
| 便携 WASM dev 重建 | 通过；generated 与 public 字节一致 |
| 后端完整 cargo test | 102 通过、2 个原有 ignored；无失败 |
| 前端完整类型检查 | 通过 |
| 前端联合 36 文件 | 842 通过、4 跳过 |
| 可移植缩放 3 文件 | 30 通过 |
| 桌面 Node 7 文件 | 73 通过，包含 33 MiB parser 与 64 MiB 跨帧用例 |
| Web 生产构建 | 通过；保留 chunk 大小和两处重复静态/动态导入警告 |
| 导入文件完整性 | 最终 90 路径与来源包精确匹配 |

前端 4 项跳过来自未提供的私有 117 解析输入（1 个导航、3 个姿态用例）。Rust 两个 ignored 为实机集合字体用例和完整 CJK 字体显式 benchmark，未执行、未计为通过。联合测试含真实 Editor/WASM、jsdom、受控 transport/completion 及 GPU descriptor；不代表真实 worker、GUI 或 GPU 像素验收。

初始失败及修正复跑均保留：缺固定字体依赖、过时 schema 断言、默认容量未满足大文档测试前提，以及旧损坏资源夹具被 schema CHECK 拒绝。字体依赖安装在隔离 venv。大文档复跑仅在测试进程设置 `CORE_DOCUMENT_MEMORY_BYTES=805306368`；Node 同时设置 `CORE_DOCUMENT_MEMORY_INHERITED=1`。这是测试输入条件，不是修改产品准入、物理内存测量或性能结论。

实际工具链、WASM/native 构建哈希见 [build-identity.json](build-identity.json)。本轮 WASM 由本地源码重建，不与包内历史 WASM 哈希混称同一产物。完整 argv、相对工作目录、环境、退出码、运行时间、失败和终态日志见 [validation.json](validation.json)。前端固定单 worker 且不并行文件；不同大门顺序运行。重复结果不累计。

## 来源与恢复

- [packages.json](packages.json)：6 个唯一包、2 个重复副本、档案哈希与集成顺序。
- [source-manifest.json](source-manifest.json)：90 个路径的基线、各独立版本和最终来源哈希。
- [validation.json](validation.json)：当前组合验证；包内历史测试不充当当前验证。

本次提交是开发源码集成。真实 GUI、硬件 GPU/物理同帧、完整 117 回放、固定规模/导出矩阵、完整 Electron 保存重开仍未验收。没有启用原有默认关闭的实验配置，也没有作延迟、帧率或所有渲染故障已修复的声明。

如需撤销本次集成，审阅后对本次 Git 提交执行 `git revert`；源码撤销不等于数据库降级或运行数据回滚。研究文件未纳入提交。
