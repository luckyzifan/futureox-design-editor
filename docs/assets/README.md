# 首页视觉素材 · README assets

## readme-banner.svg

为项目首页原创的矢量封面。沿用 Futureox 的靛蓝配色和[现有 F 标识](../../frontend/design-client/public/branding/futureox-desgin.svg)，搭配路径与控制点插画；它是品牌插画，不是应用截图。没有引用第三方插画或外部字体文件。

An original vector cover using the existing Futureox mark, indigo palette, and path/control-point artwork. It is a brand illustration, not an application screenshot.

## workspace.png

来源为本仓库共享客户端的真实网页界面，载入 `frontend/design-client/src/model.ts` 中的内置 `demo()`「探索画布」示例。画布内容来自项目自带的原创示例，没有使用用户设计文件。

截取日期：2026-11-10。应用源码：`70f72c2`；视口：1600 × 1000，DPR 1.5，输出：2400 × 1500。通过实际文件菜单打开示例，缩放至适合画布并选中星形；截图时未捕获到页面脚本异常。

复现：从仓库启动共享客户端，在独立浏览器配置中通过文件菜单打开内置示例，将画布缩放到合适大小，再截取整个工作区。截图用于介绍当前界面，不是渲染性能或跨平台验收证据。

The actual web editor displaying the built-in `demo()` exploration document from `frontend/design-client/src/model.ts`. No private design files are included. Reproduce by starting the shared client, opening the built-in example in an isolated browser profile, fitting the canvas, and capturing the workspace. The image illustrates the interface; it is not performance or cross-platform acceptance evidence.

本目录原创素材随项目自有代码采用 [MIT License](../../LICENSE)。应用中出现的字体与其他第三方资源仍遵循[各自许可](../../THIRD_PARTY_NOTICES.md)。
