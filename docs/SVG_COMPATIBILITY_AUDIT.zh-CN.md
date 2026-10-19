# SVG 导入兼容性专项（2026-10-19）

## 本轮结论

这是可编辑 SVG 子集的增量修正，不是完整 SVG 2 实现，也不是 Figma/Sketch 应用级等价认证。修改只涉及前端 SVG 导入和独立解析辅助模块；不改 path-network、Renderer、GPU、Rust 内核或导出接口。

本轮修复：

1. `rotate(90)` 之前先转换为弧度再传入接收角度的 `geometry.rotate`，实际仅旋转约 1.57°。现在正确保留角度及旋转中心。
2. 变换解析现在检查参数个数、SVG 数字语法、有限值与累计矩阵溢出。支持规范允许的相邻带符号数字。粘连/未闭合括号使用顺序解析，限制每列表 20,000 个变换；不改变路径数据解析器。
3. 几何与描边绝对长度支持 px/in/cm/mm/Q/pt/pc，包括 stroke-width、dashoffset、dasharray；不依靠 parseFloat 丢弃单位。相对单位没有被假装成像素。
4. 本地渐变模板可沿 href/xlink:href 多级继承，最多 64 层，检查缺失、循环、外部引用、错误类型；href 优先。描述性子元素不遮蔽继承的 stops。
5. 渐变保留完整仿射基：归一化 × gradientTransform × 原始渐变基。之前从变换后的端点重新构造垂线，会错误改变剪切和非等比缩放后的颜色位置。
6. userSpaceOnUse 渐变百分比按当前 viewBox/viewport 的宽、高和归一化对角线计算；默认坐标保留百分比含义。stop 样式优先于属性，offset 按规范限制到单调的 [0,1]，不重新排列原始色标。
7. 十六进制不透明颜色直接无损解析；其他既有颜色语法保留 Canvas 解析路径，但每次导入最多使用一个上下文。颜色、渐变模板和色标解析结果只在本次导入中缓存；不同图层仍拥有独立的可编辑 paint/stops 对象。

## 能力矩阵

“已有”指代码路径已经存在；只有“验证”栏列出的项目才获得本轮执行证据。

| 领域 | 当前能力 / 本轮验证 | 明确边界和后续缺口 |
| --- | --- | --- |
| 路径 | 保留 M/L/H/V/C/S/Q/T/A/Z、相对命令、复合闭合路径和 fill-rule 的现有转换；路径模块字节未改；运行原 51 项差分/边界回归，实际 WASM bounds 和 .fd 网络拓扑往返 | 路径仍使用既有弧线到三次曲线表示；不声称解析器数学/输出语义发生改进 |
| transform | matrix/translate/scale/rotate/skewX/skewY；角度、中心、组合顺序、反例与溢出验证 | 根元素 transform 仍显式拒绝；CSS 非 none transform/transform-origin 显式拒绝；CSS transform:none 可正确覆盖属性 |
| viewBox | 根 viewport、非零原点、9 种对齐、meet/slice/none；沿用并执行 14 项 viewport 回归 | 嵌套 SVG viewport、symbol viewport 未实现；零 viewport 明确拒绝；没有模拟浏览器嵌入容器的固有尺寸协商 |
| 长度 | 几何属性与描边使用绝对单位精确转换；有限值、负尺寸和不支持单位有反例 | 普通几何的百分比、em/rem/ex/calc 和 CSS 几何属性尚非完整支持；文本排版没有因绝对长度补丁变成浏览器 CSS 布局 |
| defs/use | 同文档引用展开为可编辑节点；use x/y、旋转、根 viewBox 组合经过实际导入验证；外部引用拒绝 | 展开后不是共享组件实例；symbol/嵌套 viewport 不支持；use 循环通过已有深度/节点预算失败 |
| 渐变 | linear、中心 radial、pad；两种坐标单位、全仿射变换、本地模板链、stop 样式/offset；独立点坐标验证，实际 CPU/WASM 像素和 .fd 往返 | 最多 32 stops，超限明确失败；repeat/reflect、偏心径向/非零 fr、独立 stop alpha、stop currentColor、linearRGB 明确诊断；不冒充完整 SVG paint-server 实现 |
| clip/mask | 既有 alpha/luminance mask 图层、clipPath、局部坐标与部分 objectBoundingBox；本轮未修改 | 同一元素同时 mask/clip、组的 objectBoundingBox 内容等已有拒绝；mask region/单位、复杂 clip 样式继承和 clip-rule 的所有组合未完整覆盖；不能宣称全保真 |
| 描边 | 既有 cap/join、dash；本轮验证绝对 width/dashoffset/dasharray 和错误输入 | non-scaling-stroke、marker、pathLength、非默认 miter-limit 没有完整映射/诊断；应作为下一阶段明确能力检测任务，不能当成支持 |
| 字体/文本 | 单一 text 仍生成可编辑文本；指定字体会给出匹配警告；既有 SVG 导出使用内核字体轮廓 | 基线、文字范围和宽度是现有近似；tspan/textPath/复杂布局不支持；导出轮廓保视觉不保外部文本编辑性，原生 .fd 才保留编辑结构 |
| filters/compositing | 非 none SVG filter 导入显式失败，filter:none 不再误拒；原有根合成限制保持 | 未实现任意滤镜图、背景采样、混合模式全映射；已有 visual SVG 是显式栅格交换路径，本轮没有引入自动栅格化 |
| 颜色空间 | #rgb/#rrggbb 精确；保留其他旧 Canvas 色值解析的兼容路径；linearRGB 渐变（含继承）明确失败 | 不透明 SDR 以外不能概括为完整支持；半透明 color、P3/HDR、ICC/线性光 SVG import 未实现；真实浏览器的命名色/色彩转换没有本轮像素验证 |
| 资源/安全 | 不联网取图、不执行 SVG 脚本；DOCTYPE/ENTITY 拒绝；use/gradient 外部引用拒绝；image 仅接受现有内嵌 PNG/JPEG/WebP 路径 | 原有源码上限是 16×1024×1024 个 JS 字符，不是已核准 UTF-8 字节数；20,000 个访问节点、64 层展开、单 path 20,000 个规范化命令仍保留；不能据此声称完整恶意 SVG 安全认证 |

### 已发现但未越界修改的内核问题

`gradient_sampling_grid` 在重复 offset 的精确边界使用 `< t` 查找，可能选中较早色标；SVG 在同位置要求后一个色标占优。本轮保留色标顺序和重复值，没有擅自修改渲染器。仿射与持久化测试通过，不代表此边界或所有浏览器 SVG 像素已经等价。

## 与官方格式说明对照

Figma 官方说明 SVG 文本默认转成字形轮廓，可关闭 Outline text；描边通常导出为填充。Sketch 官方同时支持 SVG 文件和粘贴 SVG 代码，并指出 SVG 不直接支持其内外边框语义。因此，路径、描边和文本的“可编辑”必须区分结构化原生对象、展开路径和栅格图；不能用能够打开文件代替无损互换证明。本轮没有运行 Figma 或 Sketch 客户端。

- [SVG 2 坐标、viewport 和单位](https://www.w3.org/TR/SVG2/coords.html)
- [CSS Transforms 1 的 SVG 属性语法与组合](https://www.w3.org/TR/css-transforms-1/)
- [CSS Values 4 绝对长度](https://www.w3.org/TR/css-values-4/)
- [SVG 2 paint servers、模板与 stops](https://www.w3.org/TR/SVG2/pservers.html)
- [SVG 2 文档结构与 use](https://www.w3.org/TR/SVG2/struct.html)
- [Figma 导出格式与设置](https://help.figma.com/hc/en-us/articles/13402894554519-Export-formats-and-settings-for-static-designs)
- [Sketch 导入与导出](https://www.sketch.com/docs/designing/importing-and-exporting/)

## 验证与复现

详见 `testing/verification-svg-compatibility/README.md`、完整日志、官方 Vitest JSON 和 benchmark.json。基线保留为 `.before.ts`，不是从当前文件重新拼出“旧算法”。基准用完全相同的既有 model/geometry/WASM 依赖执行保留的生产函数，校验公共子集序列化文档严格相同；JSON 将正负零编码为同一个零。

本轮无浏览器、GPU、网络取资产、OS socket、Figma/Sketch 客户端或 macOS/Windows 实机验收。CPU/WASM 真像素、DOMParser、缓存边界替身和源码合同在证据中分别标明。
