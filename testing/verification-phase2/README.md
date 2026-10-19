# 第二轮验证记录

最终前端输入 659 项测试前后字节一致；Vitest 244 文件、1593 通过、1 跳过、0 失败，完整类型检查通过。另有独立 Node 94 项；renderer 25 项与 Vitest 共享用例，不重复计入。

桌面 Node 与真实 Rust/WASM CPU 准备桥组合 118 项通过；Rust 76 项针对性 CPU 测试、构建脚本 6 项通过。Rust 明细位于 ../verification/rust-cpu-math-font-2026-10-19.json。不同组不汇总成产品全验收指标。

明确未运行真实 GPU/GUI/像素/FPS 验收；默认产品 GPU 路径未改为 CPU。用户文件卡死和弧线异常未在合成负载重现，仍需原始样例定位。首轮记录保持历史身份，不替代当前结果。

另有未纳入最终矩阵的历史 Node 测试 export-ownership.test.mjs：早期尝试时源码提取器因 import 数量假设失效而失败，本轮未修。不能将默认 Vitest 和列出的合约通过称为所有历史前端/浏览器矩阵通过。
