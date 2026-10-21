# 五个未修复上游失败

本批单 worker 全量：4146 pass / 5 fail / 0 skip。下列名称与 exact d2d 的独立 Git baseline 对照逐项一致。未修改用户渲染源码或断言。

- src/kernel/render-worker-image-hydration.test.ts > multiple exact tiles hydrate each newly compiled dependency once in the actual worker route
- src/kernel/render-worker-image-hydration.test.ts > resumed canvas tiles invalidate real image textures after repeated color-lane switches (reverse=false)
- src/kernel/render-worker-image-hydration.test.ts > resumed canvas tiles invalidate real image textures after repeated color-lane switches (reverse=true)
- src/kernel/render-worker-image-hydration.test.ts > cancel-preview during lane yield does not recreate stale canvas resources or dispose the current lane
- src/kernel/render-worker-image-hydration.test.ts > cancel-tile-fill during lane yield does not recreate stale canvas resources or dispose the current lane

首项 backend 期望 webgpu 而收到 undefined；两项恢复切换报 PREVIEW_CPU_FALLBACK: TypeError: gpu?.releaseFilterBatch is not a function；两项取消断言 disposed 期望 [1]、实际 [1, 2]。这是已复现的测试/合同结果，不据此宣称实际 GPU 故障根因。

另保留本批首轮双 worker 的两项 SIGKILL 与18项未完成记录；完整单 worker 重跑已覆盖全部测试，但不将首轮记为成功。
