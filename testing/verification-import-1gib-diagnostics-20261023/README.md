# 1GiB 导入准入与导入因果诊断增量合并记录（2026-10-23）

将 `core-increment-e411-import1gib-diagnostics-dev-20261023T0203Z.zip` 增量合入主线。适用基线 `e411af08f7b3e901f83415932c05d50515a00cdd` 与合并时 HEAD 完全一致，执行包内哈希守卫的 `apply_increment.py check` + `apply`（26 个路径全部命中，previous 整态 → candidate 整态，3,211 个受控输入前后校验一致，无手工改动，幂等）。应用脚本与上一增量包不再字节一致，SHA-256 `ebe6dd32…096b`（上一包为 `7779f3b2…65f8`）。归档见 [bundle/](bundle/)，完整性清单 [SHA256SUMS](bundle/SHA256SUMS)（`__pycache__` 按运行时产物处理未入库）。

## 合并内容（导入准入与诊断，非渲染修复）

- 统一设计文件编码输入上限为 1GiB=1,073,741,824 字节（含边界），替换旧 32MiB/48MiB 入口门槛；Rust 侧 Sketch/FIG 编码输入政策同步（`interop.rs`、`sketch/archive.rs`）。
- PNG/JPEG/WebP 选择器正确走已有图片导入；主页未打开画布时给出明确中英文反馈。
- 导入按 action/request 关联准入、读取、worker、解码、验证、提交等固定阶段；取消/被替代/真正失败明确区分，多图片逐文件归因，无重复解码，保留一次历史提交。
- 新增 17 个固定 native 编译错误码 119–135（真实 adapter 及 FPR1 帧测试）；未知或夹带内容的错误仍未知，不输出文档内容/文件名/任意异常文本。

## 安全边界（不是全部放开）

1GiB 仅编码输入业务准入，不等于 1GiB 文件可完成解压、编辑、保存或实时渲染。Sketch/FIG 展开 64MiB 及条目/压缩比保护、SVG/SVGZ 解析/展开 48MiB、FD/JSON 可信文档资源准入均保留；Inspector/Canvas 独立图片入口 8MiB 编码、12MiB dataURI、16MP 保护未改；导出限制、当前精度、HDR、GPU 1GiB 工作预算均未改。本轮无新增数据库迁移（`noNewSchema`）。

## 验证边界

包内 [VALIDATION.json](bundle/VALIDATION.json) 与 [README_FIRST](bundle/README_FIRST.zh-CN.md) 记录：完整 tsc 通过（初次新测试跨端 `.mjs` 无类型声明 TS7016 失败已保留，仅该 import 加精确 test-only expect-error 后重跑）；45 套 Vitest 1043/1043，额外独立缩放 30、overlay 39/4/10（与主联合有重叠，不相加）；实际 Node 导入 ownership 20/20；5 套 desktop Node 53/53；实际 Web 构建通过；Rust archive 模块 4/4 及真实源文件编译；完整新 policy WASM 链接通过；真实 117（5,013,257B）新 WASM 导入 1 页 + 752 节点，输出原始 JSON 与旧生产逐字相同，坏/截断 ZIP 拒绝（这是导入，不是渲染）。WASM 功能验证构建为 opt0/ltooff/cgu256，SHA-256 `09ff44d26dbd365a7551a9de56d135c21fb44b387d8f11a51b155887f84d9b28`；Web producer 源码身份 `462753251bec9fd3735dfa820fa6df4b198b7e8f0f2283fa6fb38447d06a54ad`；二进制不随源码增量入库。

**依用户方向，本次合并在本地未复跑上述测试；包内结果是唯一测试证据。** 未验：完整 native backend 程序集、真实 1GiB 文件全流程、完整 GUI/硬件 GPU、十份 117 连续编辑/保存重开；模糊、白板、3200% 缩回、旋转/拖动实时跟手等渲染体验仍未通过验收，17 个错误码只是诊断，不修复 GPU 积分模糊 512 上限。

## 应用后重建要求

应用后需在 `frontend/design-desktop` 执行 `bun run build --fast` 完整重建 WASM 及 native backend/kernel 并重启；单独 vite build 或只复制 TS 不会更新 native 限制。回滚用包内 `apply_increment.py rollback-previous`，仅完整本包后态可回滚，回滚后仍需重新完整构建。

## 测试入口

全部新增/修改测试随 [bundle/source/](bundle/source/)；未变测试基线索引见 [unchanged-tests-base-index.json](bundle/unchanged-tests-base-index.json)。复跑入口：[bundle/verification/run_frontend_checks.py](bundle/verification/run_frontend_checks.py)（支持 `--repo`、`--private-117`、`--wasm-sha256`、`--run-id`，场景 hash 固定）与 `verification/import-real117.mjs`（绑定 JS、WASM、真实 117.sketch、预期 WASM SHA 及结果 JSON 路径）。私有素材不在包中，缺素材必须记未执行。Rust 完整契约命令从 `design-studio` 运行 `cargo test --locked -p futureox-design-kernel`。
