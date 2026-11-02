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

## 测试

`frontend/design-client` 下与本轮直接相关的 vitest：

- `src/canvas-pointer-intent.test.ts`
- `src/selection-size-label.test.ts`
- `src/shape-creation.test.ts`
- `src/selection-chrome-label.test.ts`
- `src/AutomationPanel.test.tsx`
- `src/AutomationPanelLauncher.test.tsx`

未在本机打开「01有料素材」的 GUI，也未测量 Ctrl-滚轮缩放。
