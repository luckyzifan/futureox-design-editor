# 画布选区、框选与测距（2026-11-02）

对照 Mac 桌面 Figma 的选区描边、拖动框选和按住 Option 的红色间距。网页和 Electron 共用 `design-client`。不改光栅、瓦片、预算或实验开关。没有设计 API 浮块，也没有协作服务器。33/100ms 与完整 G2/G5 未运行。

## 对齐

对照 Mac gaps5 的取样，不是 figma.com。

- **选区**：描边约 `#4597F7`，大约 1pt，落在整像素上，不再是两条半透明边。四角是白底方块。尺寸药丸例如 `60 × 47`，蓝底白字。角上不再画白色圆。直角矩形不画出圆角圆点。工具栏强调色仍是 `#3459d4`。
- **悬停**：同一支蓝的 1 CSS px 实色填充，和选区描边共用整像素路径。没有手柄，也没有尺寸药丸。空白画布上没有这支蓝。
- **框选**：拖动时填充约 `#DCE9F5`。边不再是落在像素边界上的居中 1px 描边，改成同一条实色填充。过了拖动阈值，相交图层先画出并集手柄和尺寸药丸，松手才写入选区。例如 3 个。X 或 Y 不一致时检查器显示 Mixed。
- **红色间距**：`#E05634`。相邻图层画出两边的宽（或高）和间隙。间隙小到放不下药丸时，数字标在缝的两端（例如两个 `1`）。画板空白处仍是四边内边距。红线在手柄下面。不穿透已选图层。

## 仍未对齐

- 本环境没有打开用户的 Mac 桌面 Figma。
- 完整编辑器窗口（`electron . --desktop-gui-test --core-cpu-only`）没有启动。桌面 sidecar 和打包后的渲染器没有编。下面的 Electron 取样只光栅画布叠层实际使用的 SVG。
- 悬停和选区是同一支 `#4597F7`。多选成员也是这支蓝的 1pt 线，靠手柄和尺寸药丸区分。成员轮廓这次没有改。
- 33/100ms 与完整 G2/G5 未测。

## 核对

`design-studio/scripts/build-web.py --profile dev` 只为 vitest 准备内核。它被 gitignore，不是渲染验收构建。退出码 0。

`bun x vitest run src/kernel/gpu/canvas-overlay.test.ts src/figma-canvas-chrome-parity.test.tsx src/figma-canvas-chrome-parity.test.ts src/canvas-selection-workflows.test.tsx src/figma-selection-chrome.test.ts` 退出码 0。5 个文件、58 个测试通过。选区仍是 1px `crispEdges` 描边和 GPU 实色填充。框选填充仍是 `#DCE9F5`。Option 间距仍是 `#E05634`。编组单击、空选区方向键和空格拖动平移仍按 #42。

GPU 零长度选区的顶点跨度按 8px 角方块计。主线上这段轮廓不画零长度线段，跨度本来就是 8，旧断言写的 9 对不上。

### DISPLAY=:2

Xvfb `:2`，1280×800×24。Electron 44.7.0 有头窗口，`--force-device-scale-factor=1`，`capturePage` 420×280，DPR 1。同一份 SVG 也在 Google Chrome 156 的有头窗口里对过，像素相同。底是 `#F5F5F5`。

居中 1px 描边（改之前的悬停和框选边）没有一颗精确 `#4597F7`。悬停顶边两行是 `#9DC6F6` 和 `#9CC6F6`。框选顶边外侧 `#9CC6F6`，内侧压在填充上是 `#90C0F6`，再往里是 `#DCE9F5`。这和框选复测里的两条约 50% 蓝、精确 `#4597F7` 计数为 0 是同一类结果。本页空白底没有复现 `#8EB8E8`。

实色填充之后，悬停顶边只有 y=20 一行 `#4597F7`，上下仍是 `#F5F5F5`。框选顶边只有 y=120 一行 `#4597F7`，里面仍是 `#DCE9F5`。选区 `crispEdges` 描边同样是一行 `#4597F7`。四条边的精确蓝像素各 260，和 1px 周长一致。画面上没有 `#E05634`。
