# 8070ebe 三项修复与交接 trace 开发测试包

这是按用户要求跳过最终回归的开发测试包，不是已完成最终验收的发布包。

精确适用基线：8070ebeed52f75cadc66b036543e9fcc8fad104f。此前修复已进入该提交，不重复叠加旧包。新组合包含 13 个受影响路径，精确 before/after 和角色见 manifest.json。

## 合并内容

1. 一次性普通图片区域字段安全退休：私有一次性字段不再被当成可复用字段保留，仍走既有退休队列与完成边界，不提前销毁在用资源，不增加预算。
2. 非 tiled 平移 commit handoff：改善该路径从交互到提交画面的交接。
3. Rotation owner/cohort v3：改善旋转所有权和同批次画面交接，保留已有 fatal handler 接线及过时通知保护。
4. 有界 owner/sourceOrder/cohort 交接 trace 开发候选：用于追踪指定交接路径的因果关系，不等于全系统因果 trace 已齐全。当前完成/未完成项见 evidence/FINAL-STATUS.md。

默认不降画质，不改变既有采样质量策略。rotation v1/v2、未接入生产的 FrameCoordinator、paired-tap、其他队列与 leaf 工作集实验均不包含。

## 验证状态，请先看这里

- 追加 trace 前的三修复版本曾通过 542 项去重测试和 strict scoped TypeScript；记录保留在 evidence/base-before-trace/。这不能算作当前最终组合已通过。
- 按用户“测试不要测了，直接合并打包”的要求，最终三修复加 trace 组合没有再跑功能回归、类型检查、12 项 guard 或补丁正反应用测试。
- 本次只检查文件清单、精确基线/候选哈希及 ZIP 完整性。这些是包装完整性检查，不证明功能正确、回滚行为或用户操作结果。
- check/apply/rollback 脚本沿用此前版本且未改写策略，但没有在本最终负载上重新执行 guard 验证。

req173 参数的先前受控 CPU/recording-driver 复现中，旧路径完成 3 条后第 4 条分配失败，新候选可完成 24 条。收益是安全周转，不是峰值下降；追加 trace 后没有再次运行该复现。这不是完整用户文档、硬件 GPU 或实际 WASM 二进制的验收。

不宣称全部工作集峰值或预算错误已解决，不承诺物理同帧、GPU 画质、FPS、Figma 像素一致性或完整真实操作回放。既有 fatal 恢复仍限于有效的活跃手势，不能复活已经结束的手势。

## 应用与撤回

需要 Git 和 Python 3。保存工作并停止并发编辑/构建，在解压后的包目录使用自己的 Core 绝对路径：

1. python3 apply_increment.py check /absolute/path/to/Core
2. python3 apply_increment.py apply /absolute/path/to/Core
3. 按项目既有流程重建后自行测试。应用源码不会更新已安装应用。

撤回：python3 apply_increment.py rollback /absolute/path/to/Core

check/apply 要求 HEAD 精确等于上述 8070ebe，且各受影响文件为精确旧/新字节；遇到未知改动、受影响暂存修改、符号链接或损坏负载会拒绝。rollback 仅恢复本次路径的 8070ebe 状态，不撤销已进入该 Git 提交的先前修复。

脚本不 checkout/reset，不改 Git 索引，不下载或构建，不清理其他文件。单文件替换原子，多文件不是整体事务；中断后仅在各路径仍为精确旧/新字节时重试或撤回。不要绕过保护强行套到未知工作树。

## 文件与限制

source/、baseline/、candidate.patch 和 manifest.json 提供精确新/旧文件及变更列表；SHA256SUMS 校验包内内容。新增文件在 baseline/ 中不存在。

不附用户原始日志、素材、RustFS、工具链、依赖安装包或生成二进制，不附旧包完整负载。此前已交付 ZIP 保持不变。

静态行数：生产 7 文件 +107/-21；测试 4 文件 +316/-3；测试支持配置 2 文件 +2/-0。行数不代表功能正确或性能提升。
