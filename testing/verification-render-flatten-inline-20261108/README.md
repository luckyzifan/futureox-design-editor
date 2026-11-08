# 展平微优化没有留下（2026-11-08）

对照仍是这台 Linux，视口 640×480，`render_rgba`，`rasterProfile` analytic。没有 Electron、GPU、上屏。没有跑四条正式阶梯，因为孤立 zoom 3.2 没有比玻璃边缘那份 WASM 更快。

玻璃边缘留下的 WASM 是 `c8d4f199cfc38d77682379c7f388d3461ba5a5b32ea77fcfe177adb4d8dee8de`。同一次会话里它的孤立 zoom 3.2 是 564.007 ms 和 557.421 ms，zoom 0.8 是 534.177 ms。

## 没有留下

把三次曲线细分的堆从 `Vec` 换成固定数组，算法和弹出顺序不变。WASM `833d977067819e9da4ba77a5ceb791f91f6afc27ef443c1d0c92942395771322`。孤立 zoom 3.2 是 551.077、554.087、559.818、560.210 ms，另有一次 663.603 ms。和基线的 557.421–564.007 ms 重叠。哈希仍是 `9c342bcedc9349495cedc5065352c7db31032a5b364ca6ad519bd59fe4753410`。没有留下。

把点运算和三次平坦判断标成 `inline(always)`，并去掉平坦判断里的闭包，运算顺序不变。WASM `67754bb587bdf10b3babf2826396b53a8e1b5231f9258cd3f3408899d0cc451c`。孤立 zoom 3.2 是 561.196、566.025、566.169 ms。zoom 0.8 是 518.647 ms 和 505.750 ms，哈希仍是 `ce06260b0d0ac332f0eecd59f580e81a85e40c897e841289331b1aa0e4d4eb09`。效果关掉 zoom 0.1 是 178.653 ms，哈希仍是 `830ec043167825b774a35724cc3f196c86d6fa5faa60d031bf6c5d7746b7f1a8`。zoom 3.2 没有低于基线。没有留下。

`origin/main` 仍是 `b6d906a41db7273a8889140122edddaf26324af5`。没有合并 pull request。没有使用 GitHub Actions。

33 ms 和 100 ms 没有作为这组交互帧达到。效果开启最慢的正式放大帧仍是玻璃边缘那次的 zoom 3.2，843.736 ms。
