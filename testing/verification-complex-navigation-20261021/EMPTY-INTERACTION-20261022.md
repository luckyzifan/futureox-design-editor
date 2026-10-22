# 空 interaction prepare 的只读评估

本轮没有实施空 prepare 快捷分支，也没有改变 React、采样、取消或资源生命周期。原问题仍保留，后续只能在真实证据充分时另行优化。

## 实际调用证据

Deep2 两个有效主线程 profile（见 [对应火焰图](../verification-cpu-flames-20261021/deep2-complex/README.md)）中，React layout → ResidentCompositeSurface 的 effect → InteractionRenderer.prepare → nextGeneration 有重复采样。`nextGeneration` 在 layout 内累计 self：117 **178.395 ms**，FIG **195.504 ms**；各自完整 profile 窗口为 40,049.561 / 24,769.470 ms。这是累计样本，不是一次卡顿、每次分配耗时或本轮可直接节省的延迟。CPU profile 不记录 prepare 的参数身份，不能证明这些样本都是完全相同 scope 的多余调用。

导航暂时传入 undefined interaction props。prepare 先维护 viewport、idle warm、control 绑定，然后 undefined 分支执行 nextGeneration、releaseClient、清空 pending 和 closeResidents。nextGeneration 会取消当前 AbortController 并创建新实例。ResidentCompositeSurface 仍须处理真实帧、输入 ACK、items 与资源；不能因 interaction 为空而跳过该组件的整个 layout/repaint。

Deep2 layout 的其它可见成本应与此分开：117/FIG ResidentCompositeSurface effect inclusive 1,104.827 / 1,841.753 ms，repaint inclusive 771.072 / 806.795 ms。FIG dependency scope inclusive 756.821 ms，已经包含 rootBounds 363.587 ms，不能重复相加。

## 为什么当前不做内部记忆短路

`prepare(undefined, pageId, view, dpr, profile, backend, settledDocument?, size?)` 没有被隐藏 selection、完整 sourceDocument、session、device incarnation 或 import/呈现 lease 的参数。PageTranslation 分支还不传 settledDocument 与 size。只比较 page/camera/DPR 无法区分同相机切文档、同 ID 重开、选中变化或 GPU 所有权变化。settledDocument 在活动导航阶段也可能为 undefined，不能当通用内容身份。

resident/pending 已清空不等于所有异步回调已经收尾：liveRunning 可在取消后保持到 finally，retained capture 的旧异步闭包也必须按原 generation/ownership 路径释放迟到结果。仅凭当前几个可空字段无法证明所有 active、pending、warming、held 资源和回调均不存在。

向调用方追加严格 witness 会涉及 frame/document/session/selection/device/lease 的身份域。现 presentation/items 常在 render 中创建新对象，直接引用守卫难有命中；重新计算完整 frame signature 又会增加已被采样的序列化成本。没有现成、廉价且可信的 token，本轮不为这一累计成本增加新的帧身份协议或选中副作用。

## 后续可验证方向

后续应先在原有 ownership 域内观测空 prepare 的参数变化、未完成 capture 数量和完整取消边界，分清真正重复空调用与真实 camera/frame/内容变更。只有存在明确同 scope witness、control 已解绑、所有 capture/idle warm/held 资源及回调都已收尾，才可测试幂等取消；真实 view/frame/document/session/selection/device/lease 变化仍须走原准备与取消。不能粗略 memoize items、移除 layout effects 或节流真实呈现 ACK。

当前 harness 的 phase journal、受控 profiler timeout/cleanup 和 editZoom 检查属于独立测试控制流，不能为这个未实施优化提供速度或画质证书。Deep3 operator correction 保持原事实：90 个压力阶段完成，后续独立参考阶段被人为中断，既不是整体验收通过，也不是 profiler 启动卡住。
