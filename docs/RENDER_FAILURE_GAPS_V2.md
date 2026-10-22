# 117 原因定位补充：V2

基线：1e4a3ba07b6922444801e81ba2ad3fbc7f7d5733。此增量只补诊断，不包含浮点图片准入修复、缓存优化、设置 UI 或原生 Rust 改动。现有 WebGPU 默认 1 GiB 策略不变。

## 已确认的证据缺口

新日志的 9 个失败请求在 Worker 端已经是 stage/category/code=0，不能归因于随后主线程重建 Error。原生绑定存在将 Rust 错误转为 JsValue 字符串的路径；WeakMap 无法给字符串贴标签，后续包装又会把它变成 Error。用实际遥测函数复现该路径，可得到和这 9 个请求相同的计数组合。这证明诊断有缺口，不证明原始 9 次失败的具体文本。

新字段 lastFailureBoundaryStage 独立记录最后失败的受控 attempt 边界，范围1..13，0未知；lastFailureThrownKind 记录最初抛出值的类型，1 Error、2 string、3 number、4 boolean、5 null、6 undefined、7其他object、8 function、9 symbol、10 bigint。lastFailureClassCode 保留该边界原有的安全错误类别码。已有 failureStage 仍表示该精确错误实际携带的标签，未知不伪装成已知。不会为了贴标签替换原始抛出值。

## 精确错误码字典

新增 RENDER_FAILURE_DICTIONARY_V2.json，failureDictionaryVersion=2。保留旧码，新增80..118共39条经源码验证的静态完整字面量，覆盖原生变换/坐标字段/玻璃域等失败、设备纹理参数和相关协议守卫。仅精确匹配，不匹配私人文本中的子串、动态前缀，不记录原始消息或消息哈希。比如数学精度约束是validation，不冒充显存预算。

V1文件保留作为旧日志的历史字典；当前字典源SHA-256绑定当前遥测源模块。源码输入摘要仍有之前文档说明的边界，不证明实际运行WASM/native二进制。

## failure-origin：失败时的受控来源

这不是逐帧日志。仅在对应调用抛错时发出，沿已有session/requestId通道，包含当前运行时配置和安全分类字段。failureOriginCode：

1 driver.prepareScene；2 driver.prepareFilters；3 loadImages的异步准备结果；4图执行/driver.begin；5 driver.finish；6原生材质参数build；7参数纹理upload。

failureBuildKind：0未知，1 image-axes-support，2 image-grid，3 gradient-grid，4 gradient-lookup，5 figma-gradient-field，6 texture，7 glass，8 glass-border，9 glass-interior。仅比较代码内固定辨别字，不序列化inputs、变换矩阵、路径、像素或文档数据。failureBoundaryStage独立标记所处边界；failureThrownKind即使原生直接抛字符串也存在。

嵌套边界可能各有一条事件，例如材质build与外层graph；它们是同一请求的不同观察边界，不是额外失败次数。失败代码与最早对象标签保持既有优先级。事件仍受原有日志限流和缓冲限制，不承诺每条记录都保留。

## 分配失败位置与O(1)账本快照

仅在实际budgetError生成时保存不可变标量，并通过既有包装和Worker平面字段保留。failureAllocationSnapshotVersion=1。failureAllocationKind：

0未知；1 acquire表面；2 materialField预估准入；3 materialField实际字节准入；4浮点图片；5字节图片；6图集页；7图片坐标稠密回退；8字节阴影中间场；9系数字段；10纹理重放参数；11纹理数学表；12渐变查找表。

快照含：failureLedgerTotalBytes、InteractionBytes、NestedPrefixBytes、DriverScratchBytes、MaterialFieldBytes、CoverageBytes、KernelBytes，以及BusyCount、ImageCount、AtlasPageCount、RetiredUploadCount、CoordinateCount。实际完整字段名均带failureLedger前缀。仅读取已有常量时间计数器和集合size，不遍历资源，不等GPU，不改变释放时机。

失败时还读取已有failureMaterialFieldBuilds、failureMaterialFieldUploadBytes、failureImageAxisFields、failureImageFieldBytes计数，均为当前尝试已发生的工作，非逐像素事件。

这些类别可能重叠，不能相加推导总显存，也不是已完成/可回收字节证明。实际拒绝仍由failureRequestedBytes + failureWorkingBytes > failureBudgetBytes解释。新日志请求130已经证明超出1GiB，但旧记录不能区分acquire还是materialField；新allocationKind用于区分。

## 验证与限制

测试覆盖原生字符串与Error对照、真实公开render的try/finally生命周期、同步/异步准备失败、材质build和上传前失败、预估/实际分配区别、不可变账本及错误包装、真实Node MessageChannel、清洗边界和全部静态字典项。新增代码不修改分配策略、上传内容、采样、GPU等待或错误返回身份。

尚未运行生产构建、真实Electron Worker、117/FIG或GPU图像/性能验收。不是所有任意动态native错误都能自动得到已知code；未识别时仍保持unknown，由受控来源和边界缩小范围，不泄露文本。
