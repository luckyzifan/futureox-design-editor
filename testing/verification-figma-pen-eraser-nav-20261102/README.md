# 钢笔、橡皮与跳转 — Mac 桌面 Figma 对照

2026-11-02。本轮只改交互：钢笔、矢量橡皮、原型连线跳转、画板缩放和页面切换。不改光栅、瓦片导航、GPU 预算或实验开关。33/100ms 与完整 G2/G5 未测，不算通过。

## 行为

- 钢笔单击落点，拖动拉出曲线。按住 Shift 时新点和手柄按 45° 约束。按住 Option 拖动手柄时不再镜像另一侧。点击起点闭合路径并完成。Esc 或 Enter 完成已有线段的开放路径并回到选择；只有一个点、还没有线段时 Esc 不写入文档。
- 橡皮沿笔画擦除。开放路径留下两端；填充形状减去笔刷区域。结果仍是同一个图层，不拆成多个对象。整段都被盖住时才删除该图层。锁定图层和锁定祖先不产生历史。松开是一步撤销。取消恢复按下前的文档。直接按 E 仍可选中橡皮。Figma 式 Shift+E：正在用钢笔、铅笔、画笔、马克笔或矢量编辑时切到橡皮，再按回到矢量编辑；其它时候在「设计 / 原型」之间切换。
- 原型页显示导航、浮层和滚动连线。点箭头缩放到目标；目标在另一页时先换页再缩放。点线段选中起点。N / Shift+N 按画布阅读顺序缩放到下一张或上一张顶层画板或分区，到头停止。PageDown / PageUp 切换相邻页面并恢复该页记住的相机。Shift+1 / Shift+2 仍是适应全部和适应选区。

## 测试

`frontend/design-client`，vitest 5，Linux，本机构建的 dev WASM（未提交，不是渲染验收构建）：

- `src/pen-constraints.test.ts`
- `src/vector-eraser.test.ts`
- `src/canvas-navigation.test.ts`
- `src/shortcut-profiles.test.ts`
- `src/canvas-utility-fresh.test.tsx`
- `src/electron-vector-utility-entry-next.test.tsx`

`tsc --noEmit` 通过。未做硬件 GPU、打包后的 Electron 点击、33 ms / 100 ms 或完整 G2/G5。

## 仍未对齐

- 橡皮没有 Figma 右侧的笔宽和笔形设置，半径固定为 12 CSS 像素。
- 矢量编辑的可变宽度、形状构建器和多图层同时编辑不在本轮。
- 原型连线只在原型属性页显示，不播放过渡。
