# 画布操作与 Figma 基本操作对照

2026-11-02。对照用户在 Mac Chrome 中打开的同一文件「01有料素材」（Meher Admin Dashboard / Style Guide / Symbols）。本轮只改选择拖动、选区名称、旋转手柄、尺寸标签、创建填充和自动化文案。

不改缩放覆盖、粘性仿射、标签缓存、瓦片导航或 GPU 预算。Shift-1 适应页面仍走原有 `fitView`。33/100ms 与完整 G2/G5 未测，不算通过。

## 行为

- 已选中的图层在其轮廓内拖动时保持为拖动目标。重叠文字只在松手且没有越过拖动阈值时才改选中。细条在约 8 CSS 像素的抓取范围内同样保持拖动。
- 选区四角外侧有可见的旋转标记，指针使用原有旋转光标。数值旋转仍在属性里。
- 选区名称画在框的上方，已选画板标题变为 `#0d99ff`，不再叠第二行名字。SVG 不再使用 `<title>设计画布</title>`，避免系统提示盖住手柄。
- 尺寸标签最多两位小数。`91.712 × 20.6079998016` 显示为 `91.71 × 20.61`。不写回几何。
- 矩形、椭圆、多边形、星形和画板单击都是 100×100。拖拽使用指针跨度。填充从按下就开始画，并保持到该文档成为已呈现帧。设备画板仍由预设命令创建。
- 工具条在创建工具下显示一行说明，不接收指针。自动化入口文案为「设计 API / Design API」，对话框关闭按钮按文字宽度排，不按 30px 裁切。这不是 Figma 插件宿主。

## 2026-11-02 续：旋转符号、选框和粘贴

对照 Mac 桌面 Figma（顺时针为正，逆时针为负）。拖动手柄时对象跟手。画布角度和右侧「旋转 °」读同一局部顺时针角（`clockwiseDegrees`），两位小数，松手之前就更新。父级旋转不会让画布数字和检查器各用一套符号。Shift 把这个局部角吸到 15°。选框描边为 2 CSS 像素 `#0d99ff`，角上的缩放方块为 8px。旋转抓取区在角的外侧。移动工具下，选中图层就会挂上旋转和缩放手柄，不需要先等到呈现快照。

⌘C / ⌘V 复制图层。普通粘贴把检查器里的 X/Y 加上 10，再粘贴再加 10。选中画板时副本进入该画板，局部位置是原来的 X/Y 加这一步，不再停在 (0, 0) 偏移上。Ctrl/⌘D 同样先走 +10,+10；之后若移动过副本，下一次副本重复那次世界位移。顶层画板仍按宽度加 24 向右排。矩形、画板、分区上存了的单角圆角会画进填充，不会被一份直角轮廓盖住。图层列的选中高亮在选择变化时立即发布。拖动已选中的图层不会中途改选区。

未在本机打开 Figma GUI。33/100ms 与完整 G2/G5 未测。

## 测试

`frontend/design-client` 下与本轮直接相关的 vitest：

- `src/canvas-pointer-intent.test.ts`
- `src/selection-size-label.test.ts`
- `src/shape-creation.test.ts`
- `src/selection-chrome-label.test.ts`
- `src/AutomationPanel.test.tsx`
- `src/AutomationPanelLauncher.test.tsx`
- `src/selection-handles.test.ts`
- `src/electron-resize-rotate-boundaries.test.tsx`
- `src/native-duplication.test.ts`
- `src/clipboard-semantics.test.ts`

`tsc --noEmit` 通过。内核 `figma_rotation` 单测通过。粘性仿射仍在；旋转样本会把同一矩阵写进预览，供右侧角度和选框读取。

未在本机打开「01有料素材」的 GUI，也未测量 Ctrl-滚轮缩放。
