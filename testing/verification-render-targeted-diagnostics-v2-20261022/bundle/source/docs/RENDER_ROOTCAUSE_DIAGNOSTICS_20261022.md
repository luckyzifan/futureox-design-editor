> 后续1e4a3ba基线的诊断增量使用错误码字典V2；详见 RENDER_FAILURE_GAPS_V2.md。下文保留第一版字段与构建来源说明。

# 117 渲染诊断增量：错误预算快照与构建输入来源

基线：ee97b408860990e2aa89c5510c11eb05ca8a3ba6。本增量仅增加诊断，不改变渲染、资源预算、回退、缓存、取消或文件保存行为。

## 补齐的证据

1. 构建输入来源：实际执行的 renderer / Worker 中嵌入当前构建时的源码清单 SHA-256、错误字典源码 SHA-256、生成 WASM 输入 SHA-256，以及可取得的 Git HEAD。
2. 原始错误拥有的分配失败快照：failureRequestedBytes（本次请求）、failureWorkingBytes（拒绝时占用）、failureBudgetBytes（当时限额）、可用的分配宽高、coherent 标记。缺失时明确 failureBudgetAvailable=0，不拿稍后全局计数代替。
3. 以既有 session、source、requestId、generation、documentRevision 关联既有 fence/admission 事件，不再加入逐帧时间事件。主线程 error 常是 Worker error 的镜像，统计失败须先按 Worker 请求去重。

## 来源字段的准确含义

- diagnosticProducerVersion=1；failureDictionaryVersion=1。精确字典随包附带，使用 failureDictionarySha256 与当前字典源码摘要核对，不能仅凭版本号认定旧日志来自此版本。
- producerSourceSha256：现有 buildInputs 清单中源码文件的 SHA-256 清单摘要，包含未提交的文件内容。它不是整棵 Git 树、编译输出哈希或编译器版本证明；生成 JS bindings 与 public/kernel 原本就不在该清单。
- producerWasmInputSha256：构建配置阶段唯一生成 WASM 输入文件的摘要。不是“实际运行时加载字节”的验证，不证明 native design-prepare/design-render 二进制身份，也不能排除外部替换、旧缓存或工具链差异。
- producerCommit：可获得的 Git HEAD，仅供定位；相同 HEAD 可以有不同源码输入摘要，不表示 clean、全部内容相等或应用已验收。producerCommitStatus=0 表示未知，不填猜测值。
- producerIdentityStatus=0：没有已验证源码输入清单；1：源码清单已哈希但 WASM 输入缺失/歧义；2：源码清单与唯一 WASM 输入均有摘要。
- producerBuildMode=1：Vite build；2：serve。serve/HMR 故意标记来源未知且不计算启动快照，避免热更新后误报。未经过 Vite 注入的 Node host 明确未知。
- 这些字段是诊断证据而不是安全认证；进程内恶意代码可以伪造遥测。

所有摘要仅在构建配置时计算，不在帧/请求路径读文件或做哈希。运行时只给首次记录、错误、失败摘要及丢弃摘要加少量固定字段。原有 512 环形缓冲、64 条批次、节流和关闭开关保留。摘要只接受固定长度小写十六进制，禁止路径、文档、节点、URI、原始异常消息或堆栈。

## 117 已知代码及读法

- stage13 / category3 / code20：GPU 表面内存预算超限。
- stage13 / category3 / code21：GPU 浮点图片内存预算超限。
- stage5 / category3 / code64：native 编译器 surface-area guard，不能与 renderer 字节预算混为一谈。
- code200：分配拒绝的通用来源标签。精确 code20/21 已存在时保留精确码，并不是 code200 缺失说明版本错配。
- code1：PREVIEW_CANCELLED，需要结合 superseded / generation 等字段判断；不是 GPU 预算故障。

对新错误：先核对来源/字典摘要，再算 failureRequestedBytes + failureWorkingBytes - failureBudgetBytes；这是该次拒绝的超额数，不是可安全释放量。再看同 session / requestId 的 admissionRequiredBytes、admissionReclaimableBytes、fence reason 与 queueWaitMs。fence 等待属于 CPU 观察到的 GPU 完成等待，不等于 GPU timestamp 性能或真实显示帧率。

旧的 core-render-detail3.log 没有这些构建来源字段，也缺少错误所属分配快照。本补丁无法从旧日志反推出它们；旧日志仍可定位预算失败与 fence 等待，但不能据此证明其运行源码身份或完整分配根因。

## 验证与界限

最终源码：50 项 Node 测试通过（既有39项、新增11项）；既有 render-failure-telemetry Vitest 7项通过。新增覆盖来源缺失/脏源码/WASM输入变化、HMR未知、隐私边界、环形缓冲、错误快照、实际 Node MessageChannel 传输与两层清洗。TypeScript 对受影响遥测模块和 Vite 配置的局部检查通过，Node语法检查通过。

没有运行完整项目 typecheck、生产 Vite/Rust/WASM build、实际 Electron Worker/GUI/设备验收或117复测。MessageChannel 测试不是实际 Electron Client 回调或 GPU 证据；字面量注入测试不是最终打包产物验证。本增量可用于补齐下一份日志，不是117问题已修复或GPU实时性能达标的声明。

复测使用原项目既有诊断启动方式：CORE_RENDER_DIAGNOSTICS=detail，并重新构建使来源字段进入新 renderer/Worker。若来源状态仍未知，应先保留日志并核对构建步骤，而不是补填假摘要。
