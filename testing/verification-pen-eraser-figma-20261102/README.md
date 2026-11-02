# 钢笔与橡皮对照 Mac 桌面 Figma

2026-11-02。网页和 Electron 共用 `frontend/design-client` 的钢笔与橡皮。不改光栅、瓦片、预算或实验开关。33/100ms 与完整 G2/G5 未测，不算通过。

## 钢笔

- 单击放角点，拖动拉出对称贝塞尔手柄。按住 Option（Alt）时只留下向前的手柄，进入该点的一侧保持直线。
- Shift 把新点和手柄方向吸到 45°。像素网格在按住 Shift 时让位给角度。
- 从上一个点到光标的预览是实线选择蓝 `#0d99ff`。锚点是方块，当前点填蓝。靠近可连接的点时画闭合圈。点在线段上会插入点。Option 单击两点之间的锚点会删点并接上两侧。
- Enter 和「完成」提交路径并回到选择工具，路径保持选中。Esc 提交开放路径、取消选中，钢笔保持待命；只有一个点时 Esc 丢弃草稿并回到选择。绘制中的 Command/Ctrl+Z 撤掉最后一点，不写文档历史。
- 点在已选开放端点上会续画该矢量；点在空白处新开一条路径。闭合至少三个点的路径时补上与其他形状相同的默认填充。
- 矢量编辑里拖动手柄时，原本对称的一对继续对称；Option 断开。已选中锚点时只显示它的手柄。

## 橡皮

- 笔刷半径是 12 CSS 像素，跟缩放走，描边是同一选择蓝。
- 开放笔画只删掉笔刷盖住的那一段，两端留在原曲线上，图层还在。整段都被盖住时才删除该图层。
- 有填充的形状用笔刷减去区域，结果仍是一个矢量图层，填充保留。锁住的图层跳过，不产生历史。
- 一次按下到松开是一步撤销。Esc 或指针取消恢复按下前的图形。
- Figma 风格快捷键里 Shift+E 也切到橡皮。原有的 E 不变，工具栏标签仍显示 E。

## 测试

`frontend/design-client` 下 vitest，2026-11-02，Linux：

- `src/pen-geometry.test.ts`
- `src/vector-eraser.test.ts`
- `src/electron-vector-utility-entry-next.test.tsx`
- `src/canvas-utility-fresh.test.tsx`
- `src/canvas-event-batching.test.tsx`（含原有钢笔手柄阈值）
- `src/shortcut-profiles.test.ts`
- `src/selection-chrome-label.test.ts`

`tsc --noEmit` 通过。未跑打包后的 Electron 点击、硬件 GPU、33/100ms 或完整 G2/G5。
