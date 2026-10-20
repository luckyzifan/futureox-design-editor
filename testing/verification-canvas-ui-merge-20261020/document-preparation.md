# 文档准备路径的静态合并记录

本次仅合并源码和检查文本引用。遵照用户要求，没有运行测试、
typecheck、构建或应用实测；早先验证记录不能代表此次合并后的结果。

## 保留并合入

- 保留本地 `currentEncodings`、`preparedDocumentEncoding.bindCurrent`、
  `currentPreparedDocumentJson` 与 `forgetPreparedDocumentEncoding`。
  一次性私有所有权、文档对象身份、编辑版本/session 的证书约束继续保留。
- 保留 `ensurePreparedDocument` 对已消费令牌的明确拒绝，以及接收时的字体重绑。
- 保留 `DesktopSession.load` 对同步订阅者重入的判断、首次保存的已验证 JSON
  复用及已持久化文档的 baseline 复用。渲染端继续调用当前证书接口。
- 合入包中的 `prepareDocumentJson`、`prepareDocumentJsonForEditing` 和共用的
  `prepareAdmittedDocument`。对象入口与字符串入口共用布局、派生几何检查、
  最终 Rust 验证和私有所有权交接。
- 合入安装态冻结 codec 的原始 JSON 准入路径、UTF-8 大小限制、按尝试绑定的
  JSON 语法错误凭证及未知 codec 的原有回退路径。
- 保留包中 `authoredDocument` 与属性预览的保存/离开边界。
- 诊断编号同时保留 `snapshotReuse = 216` 和 `rawJsonPrepare = 219`；
  既有 201–215 编号不变。

## 暂存而未纳入

未完成边界修复的异步文档准备实验已从当前工作树移至合并备份根下的
`parked-experiment`，完整原始源码也保留在该备份的 `files` 中：

- `src/document-preparation-worker.ts`
- `src/document-preparation.test.ts`
- `scripts/check-document-preparation.ts`
- `testing/verification-async-document-preparation-20261020`

生产代码中移除了 `DocumentPreparer`/实验错误类、默认字体指纹、
实验开关分支和 Worker 生命周期管理。`DesktopSession.replace` 恢复同步
准备路径；App 及相应源码合同恢复两参数调用。只撤掉模块初始化合同中的
实验开关替换行，保留其他导入所有权和 VM 提取边界修正。

暂存原因是实验仍缺少发送前的扩展原型/共享图检查、真正私有的铸证状态，
以及有界传输成本检查。此次没有通过删除实验来宣称这些问题已修复。

## 已做的静态核对

- 本次负责的四个合并模块已无 Git 冲突标记。
- `src`、`scripts`、`docs` 中没有遗留实验类、字体指纹或实验开关引用。
- 私有 JSON 证书出口与 Editor、KernelClient 的调用链仍存在；
  原始 JSON 准入入口与对应诊断阶段调用同时存在。
- App 的 `replace(document, adoption.isCurrent)` 与相应源码合同一致。
- 对本次相关七个已跟踪文件执行的 `git diff --check` 未报告格式问题。

这些检查只证明文本合并和引用保留情况，不等于 TypeScript 编译或运行验证。
