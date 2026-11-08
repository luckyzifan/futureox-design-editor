# 2026-11-08 阴影模糊的三次测量

内核没有留下新改动。正式阶梯仍是 WASM `8ae67279280e1f9d1f39f2dc9f8a4e8797c88cca9824063bbf1cff9e02a1125e`。效果开启，640×480，`render_rgba`。对照是 `2026-11-08T05:43:53.059Z` 的 541.471 / 555.251 / 191.854 / 195.769 ms。三次改动的 34 帧哈希都与那次相同，时间都没有低于 zoom 3.2 的 555.251 ms，所以都没有留下。

zoom 3.2 上只有一次阴影模糊。表面 732×588（430416 像素），实心核 552×420（231840 像素）。zoom 0.8 的表面是 459×363，核是 413×322。zoom 6.4 和 32 没有调用阴影模糊。

| 改动 | WASM | collectedAt | 0.8 | 3.2 | 6.4 | 32 |
| --- | --- | --- | --- | --- | --- | --- |
| 分析路径的上色改为只采样 alpha | `3bbdb9f09b0c12661fc7d9403296f735fd345eab983a358a5e80fd59c8c96d8a` | `2026-11-08T06:18:56.806Z` | 558.527 | 604.468 | 210.562 | 192.527 |
| 分轴、带填充的盒模糊 | `7ebd69492e93b998784c8565b6c258ab43513a7efa7d6bf6494c15b7500473a3` | `2026-11-08T06:26:59.702Z` | 569.085 | 585.844 | 191.963 | 206.230 |
| 实心核分成三段扫描 | `ae9ad919ca5a805efce65675333bf47b41bf5a17580f7ec18b41b9767ba97224` | `2026-11-08T06:30:02.076Z` | 568.308 | 586.145 | 205.001 | 279.201 |

第二次的 zoom 6.4 是 191.963 ms，和 191.854 ms 对齐，那次机器是稳的，阴影帧变慢可以算在改动上。第三次 zoom 32 也从 195.769 ms 升到 279.201 ms，阴影在这一档并不运行，所以不能把整次变慢都算成盒模糊。

缺的夹具不在这台机器上：`testing/fixtures/design/figma-materials-native-2026-10-08.fig`、`testing/fixtures/design/sketch-text-layout-flow.sketch`、`testing/verification-sketch-text-layout-flow-20261027/library-v1.sketch`、`library-v2.sketch`。`/cursor/stores/bot/compare-fixtures/foreign-consumer.sketch` 是另一份对照，没有拿它冒充这些文件。
