# 自动保存和撤销（2026-11-08）

这是当前代码里真实存在的行为，不是计划。

## 已经有的

浏览器端：`App.tsx` 在没有桌面会话、也不是源文件工作副本时，文档 `version` 变化后等 350 ms，调用 `SaveCoordinator.save`，写入本机浏览器文档库。界面文案是「浏览器端在修改停顿约 350 毫秒后安排保存」。第一次恢复完成前不会开始。关闭页面前，如果还有未保存修改，会拦住刷新。

桌面端：`DesktopSession.scheduleRecovery` 在变脏后约 600 ms 写恢复副本。支持工作区时，同一轮还会把快照提交到本机文档库（`persistWorkspace`）。状态条写的是「已自动保存到工作副本」。失败时修改留在内存里，并提示自动保存失败。

撤销：`Editor.undo` / `redo` 走 `historyCore`。一次 `batch.apply` 是一条原生撤销记录，自动化来源记成 `ai`，撤销策略和用户编辑相同。代理出图走 `design_batch_apply` → `batch.apply`，所以会进这条撤销栈。

## 这次补上的检查

`agent-page.test.ts`：一键出图提交后 `canUndo` 为真，撤销后「秋日特惠」页消失，重做后页还在。同一版本交给 `SaveCoordinator.observe`，相对打开时的版本 0 是脏的，也就是浏览器那条 350 ms 自动保存会看到的状态。

没有另做一套第二撤销系统。
