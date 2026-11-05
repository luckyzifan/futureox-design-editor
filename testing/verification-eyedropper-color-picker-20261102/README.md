# 吸管与取色（Mac gaps6）

2026-11-02。对照 Mac 桌面 Figma（不是 figma.com）的 gaps6 记录。只改共享 `design-client` 的颜色行、取色弹层和吸管提示。不改光栅、瓦片、预算或实验开关。不是 33/100ms，也不是完整 G2/G5。悬停描边和框选边线不在这次改动里。

## 对照

填充和描边收起后是一行：色块、不带 `#` 的 HEX、透明度。点色块打开取色弹层。

弹层从上到下：自定义 / 资料库，填充类型图标（纯色、线性、径向、角度、菱形、图片；视频和变量保持不可用；去掉填充会隐藏这项），饱和度×亮度方块和圆头，吸管在色相彩虹左侧，透明度滑条在色相下面，然后是 Hex / RGB / CSS→HSL|HSB 和透明度。`#D9D9D9` 显示为 Hex `D9D9D9`、RGB `217 217 217`、HSB `0 0 85`，透明度 `100`。

`I` 打开取样。Mac 上 `Control+C` 也打开取样，不占用 `⌘C`。提示是紧凑白卡片：像素网格、色块、`HSB H° S B`、点击取样。不是圆形放大镜。点下去写进当前打开的填充或描边；没有打开弹层时，写进最近点过的填充或描边行。

资料库只列本文件的颜色样式和当前页纯色。没有协作服务器，也没有设计 API 入口。

## 验证

- `bun x vitest run src/color-field.test.ts src/canvas-color-picker.test.ts src/canvas-color-loupe.test.ts src/ColorPickerPopover.mounted.test.tsx src/ColorPickerPopover.native-text.test.tsx src/shortcut-profiles.test.ts src/property-locale-async-combinations-next.test.tsx src/electron-paint-entry-boundaries.test.tsx`
- 本环境没有桌面 sidecar，所以没有启动 Electron 主进程。共享编辑器在 `DISPLAY=:2` 的 Chrome 里走完：新建、单击矩形、打开填充色块、切到 RGB 和 HSB、吸管提示、添加描边并打开同一套弹层。截图在运行机的 color-picker 记录里，不入库。

G0–G8：NOT_APPLICABLE（界面，不改绘制）。G5：NOT_RUN。
