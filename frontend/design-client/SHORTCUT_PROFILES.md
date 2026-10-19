# 本机快捷键方案与右键菜单一致性

核对日期：2026-10-19。适用于当前本机编辑器；名称为 **Figma-like / Sketch-like**，不承诺第三方产品完整兼容。

## 使用方式

打开左上角文件菜单，在“快捷键方案”中切换。方案保存到当前本机应用/浏览器站点存储，不写入设计文件，不上传；存储拒绝时显示“仅本次会话生效”。相同存储域的窗口会同步更新。工具栏和画布/图层右键菜单使用同一份实际绑定提示。

| 常用动作 | Figma-like | Sketch-like |
| --- | --- | --- |
| 选择 / 框选工具 | V | 按住 X 临时框选；tap-X 持续模式未实现 |
| 画板 | F | F |
| 钢笔 / 矢量绘制 | P | V |
| 铅笔 | Shift+P，保留 Alt+P 别名 | P |
| 切片 | S | E |
| 评论 | C | N |
| 添加 / 移除自动布局 | Shift+A / Alt+Shift+A | Shift+S / Alt+Shift+S |
| 键盘尺寸微调 | 无本批对应绑定 | Mod+方向键 1；Mod+Shift+方向键 10 |
| 覆盖粘贴（保留目标） | Shift+Mod+V，单目标 | Shift+Mod+V，每个目标一份 |
| 选区居中，保持倍率 | 菜单 | 桌面 Mod+3；浏览器用菜单 |
| 原始大小 / 适合全部 / 适合选择 | Shift+0 / 1 / 2 | 桌面 Cmd+0 / 1 / 2；浏览器 Shift+0 / 1 / 2 |

Sketch 文档已改为 F=Frame；不是旧版 Artboard 的 A。Windows/Linux 用 Ctrl 替代 Cmd。Sketch 的 stack layout 在此只对应已有自动布局命令，不代表布局语义完全一致。双方原有的本地编组、复制属性、导出 PNG、反选等命令继续保留；例如 Cmd+Shift+C 仍是复制 PNG，不能理解为 Sketch 的复制在线链接。抓手 H、区域缩放 Z、画笔 B 等已有本地工具仍可使用。Sketch-like 的 E 归切片使用，橡皮不再显示错误的 E 提示。

浏览器保留 Cmd/Ctrl+R、Shift+Cmd/Ctrl+R、Cmd/Ctrl+F、Cmd/Ctrl+0/1/2/3；重命名用 F2，粘贴替换用菜单。桌面保留相应本地编辑命令。Ctrl+Alt 输入在 Windows/Linux 原生入口交由 DOM 的 AltGraph 判断，避免把文本输入误当复制属性。

## 安全与一致性

- 编辑器命令沿用 `dispatchEditorCommand` 和工具注册表，不新增第二套编辑操作。已有 Rust `ShortcutApi` 仍可单独验证解码能力，活动画布不再绕过当前预设调用旧工具表。
- 输入框、textarea、select、contenteditable、textbox/combobox、菜单和模态弹窗保留键盘所有权。原生菜单入口也检查焦点；文本控件的复制/撤销等仍转交文本编辑命令。
- 合成输入、229/Dead/Process、AltGraph、已处理事件和不匹配的修饰键不会触发画布命令。破坏性/切换命令不因按住重复执行；缩放和微移允许重复。
- 画布右键菜单的提示随平台与方案变化；忙碌/交互期间全部命令禁用。菜单的合成输入和重复 Enter 不会触发点击。
- 画布聚焦时，Shift+F10 / ContextMenu 键在当前选区附近打开菜单，并保留选择。Escape 恢复之前焦点。
- 预设绑定按方案/平台/宿主缓存，工具提示仅在方案变化时重新计算；不改绘制或渲染管线。

## 官方参考

以下为核对时可访问的官方页面，快捷键按 US/Generic 键盘语义适配；未复制完整第三方表：

- [Figma：快捷键与键盘操作](https://help.figma.com/hc/en-us/articles/360040328653-Use-shortcuts-and-quick-actions)
- [Figma：键盘布局和平台修饰键](https://help.figma.com/hc/en-us/articles/5665442977431-Select-keyboard-layout)
- [Figma：缩放和视图](https://help.figma.com/hc/en-us/articles/360041065034-Adjust-your-zoom-and-view-options)
- [Figma：铅笔工具](https://help.figma.com/hc/en-us/articles/4402723791511-Sketch-on-the-canvas-with-the-pencil-tool)
- [Sketch：Mac 快捷键，页面更新于 2026-10-01](https://www.sketch.com/docs/shortcuts/mac/)
- [Electron：before-input-event 的 isComposing、isAutoRepeat 与菜单抑制](https://www.electronjs.org/docs/latest/api/web-contents#event-before-input-event)

## 验证范围与剩余差距

`shortcut-profiles.test.ts` 运行真实 Editor/WASM 的工具、复制、撤销、编组、显示隐藏和缩放状态变化，覆盖两种方案、三种平台、浏览器/桌面组合。`shortcut-dom.test.tsx` 使用真实 jsdom DOM 事件、React 选择控件和菜单；验证保存/重挂载、跨窗口 storage 事件、文本/模态保护、IME/repeat，以及菜单 Duplicate/Undo 和焦点恢复。原生 Node 测试覆盖真实 main 模块已注册的键盘处理器，替换的仅是 Electron/OS 边界。

这些测试不证明真实浏览器排版、Chromium/Electron OS 焦点顺序、键盘驱动、系统布局或 GPU 输出。当前环境未运行浏览器/Electron GUI；需要用户运行环境验证。没有绕过沙箱启动浏览器。

本次审计仍有以下明确差距，未扩张为无关大改：

1. Figma 文档中的“工具激活后 Enter 插入新对象”和键盘框选不是当前 Canvas 的行为；现有 Enter 分支用于结束钢笔、深入选择或进入编辑模式。
2. Sketch-like 新增 Mod+方向键尺寸微调（Shift 为 10，默认 1），复用 Inspector 尺寸函数，跳过隐藏/锁定路径；支持 undo/redo。它按每个图层调整尺寸，未实现自定义步长、仅改容器不改内容的 Mod+Alt 变体。按住 X 强制框选、Option 世界 AABB 完全包含、Shift 异或、Sketch Escape 父级导航已补齐并经实际 Canvas 测试；tap-X 持续模式、符号 Y 与完整 stack/矢量点操作仍有缺口。
3. 没有任意自定义按键、第三方插件快捷键或逐语言键盘布局配置；相应操作仍可从现有菜单访问。
4. 右键多级菜单的位置、窄屏滚动、平台真实 ContextMenu 键和原生 IME 仍需实际桌面验证，不能以 jsdom 的零尺寸布局代替。

## 2026-10-19 流程核对补充

- 全选入口统一使用当前预设：Sketch-like 选择共同已进入容器的可见、未锁定直属兄弟；Figma-like 保留本地页级直属对象策略并修复隐藏/锁定过滤。后者不是已证明的 Figma 全部嵌套全选规则。
- Figma Windows/Linux 置顶/置底修正为 Ctrl+Shift+] / [；macOS 保持 Cmd+Option。Sketch-like 保留独立适配。
- Shift+Mod+V 现在路由独立“覆盖粘贴”，原目标保留；旧“粘贴到原位”仍在菜单且无冲突 accelerator。Figma-like 仅单目标；Sketch-like 每目标一份，父局部顶左定位是明确的本地适配，未验证原生 Sketch 旋转锚点。最多 64 个目标，展开 32 MiB/20000 层；独立 root-mask 需先编组，失败不部分应用。
- 覆盖粘贴共享命令含过期异步拒绝与单步撤销，输入控件的原生菜单命令转交文本 Paste；Cmd+3 保持落地后的 zoom，隐藏/空/异页选区不动，锁定可见对象可居中。
- 小地图/缩略导航已依用户要求移除，不属于待补兼容功能。
- 第一批 6 套件 89/89 的历史记录保留于 testing/verification-canvas-workflows/。新增综合影响测试 11 套件 169/169 与 tsc 通过，见 testing/verification-paste-over-selection/；真实 Canvas 29/29 包含于该客户端影响集；原生模块 66/66 是单独的 Node 测试运行（又包含于其 desktop-contracts 157/157）。真实浏览器、Windows/macOS 键盘与 GPU 未运行。
- 逐操作官方来源、代码和差距见 [本地画布流程逐项对照](../../docs/LOCAL_CANVAS_WORKFLOW_COMPARISON.zh-CN.md)。
