# SVG 导入独立审查

## 结论

本轮有限范围修改可接受，未发现需要阻止集成的新增缺陷。没有改动任何产品代码。

独立执行：
- 原聚焦 Vitest：161/161，通过 8 个文件，0 跳过。
- 原 presentation 合同：7/7。
- TypeScript：退出码 0。
- 新增独立 CPU/XML/WASM 探针：34/34。
- 10 个有效公共子集 before/after 像素差分：每例 160×100 RGBA，全部 64,000 字节逐字节相等。
- 3 个溢出输入分别通过真实 readDesignFile 和 Editor.importClipboard 验证失败原子性：全部拒绝，原文档对象及序列化内容未变；原剪贴板随后仍能正常粘贴。

这是针对已声明可编辑 SVG 子集的代码及 CPU 验证。不是浏览器 SVG 全规范认证、GPU 验收或 Figma/Sketch 客户端互通认证。

## 源码与运行时归属

仓库：__DESIGN_REPO__
Git 基点：71d32153e6f55b3723c99708b4c4c49ac7342e67（工作树包含多个并行专项；本报告仅审查列出的 SVG 修改）。
Node：v24.19.0。
本报告纳入结论的初次运行时测试均使用重建前 WASM：
e002c8fe2efc46b09fed04bbc21404c5b7bdfb773e12081c41cfc004c824ea1b
生成 JS：
11aeca21feaad973b20453c604768484470575267635b7503cd158a5efe31e99

父任务正在进行 Sketch 色彩导入补丁的协调重建；本报告不声称最终新 WASM 已获独立认证。父任务的聚合复跑负责最终运行时归属。16:36 的额外快速复跑通过，但批次前后产物由 7763b301d43cbaa14d8bd2916594739a9e04b1fbf765bdb71f48dd7bf7b61c0a 变为 faf8c90ac98452196ce3737b2957efab263bdd21c49c6203b05c526c86dfcdd6，不能精确归属单一产物，因此明确排除出结论；日志保留为 *.transitional-runtime.*。主日志和 *.old-wasm.* 保持原始 e002 的权威结果。manifest.json 和 sources.sha256 含完整源码、测试、基线、文档和运行时哈希；9 个 SVG 产品/测试文件均与专项最终 summary.json 完全一致。

## 审查要点

1. 旋转角度：geometry.rotate 接受角度。移除额外角度转弧度正确。独立负角、非零中心、450°、反射和组合顺序断言通过。
2. 数字/transform：数值语法、参数个数、有限值、累积 transform 矩阵溢出及 20,000 项预算都有覆盖。允许参数中相邻带符号数字符合规范；函数之间分隔符仍存在基线已有的宽松接受，详见下面。
3. 单位/viewBox：Q/pt/pc/in、嵌套 shape 坐标与根 viewBox 缩放的独立实例通过；非零 viewBox 原点、slice 对齐通过。没有把百分比几何、相对单位或嵌套 viewport 算作支持。
4. 渐变模板：本地 href 优先、跨线性/径向模板链、覆盖自身 stops、坐标继承、循环/缺失/外部/类型错误以及 64/65 层和 32/33 stops 边界均有证据。
5. 渐变 basis：独立从 SVG 源梯度坐标生成垂线采样点，再经仿射变换映射，验证逆矩阵中的 t；不是复制生产实现作为 oracle。径向中心与半径向量另行断言。userSpaceOnUse 百分比与 root viewBox 宽高一致。
6. color-interpolation：正确来自被 fill/stroke 直接引用渐变的 XML 祖先树；不是 href 模板或被绘制形状的属性。独立实例确认 linearRGB 模板不会错误污染 sRGB 引用者。对直接/祖先 linearRGB 的拒绝已有测试。
7. 缓存：每次 importSvg 独立 closure。跨导入、不同形状、同一形状填充/描边的 stops 与 matrix 变更不串扰。没有静态 DOM/模板缓存。
8. 资源：执行外部 gradient/use/image/fill/CSS-url、ENTITY、事件、循环和非法 XML 负例，均按相应规则拒绝；在这些 CPU 探针中 fetch/XMLHttpRequest/WebSocket/Canvas 入口被抛错哨兵保护，计数为 0。静态审查 SVG 新模块没有网络请求 API。JSDOM 没有开启资源加载或脚本执行。不能据此扩大为全面恶意输入安全证明。
9. 持久化/像素：真实 VectorEngine CPU/WASM 输出非透明、空间变化的渐变像素；.fd 往返后逐字节一致。既有 affine 旧基底负控制也随 161 项套件复跑通过。

## 非阻断的基线问题与边界

下面 7 个异常探针均在保留的原生产源码上复现，见 baseline-compare.json；没有归因为本轮新增回归。

### A. 函数间没有分隔符仍被接受

位置：import-svg.ts:29。

translate(10)scale(2) 被解析为两个函数。CSS Transforms 1 §7.2 的函数列表 BNF 要求函数之间有 comma-wsp；可选分隔符仅适用于部分函数的数字参数。保留该宽松行为不造成已支持有效输入的新回归，但“严格语法拒绝”不应扩展为完全规范验证。建议作为独立严谨性/兼容性决定处理，不在本轮贸然收紧。
规范：https://www.w3.org/TR/css-transforms-1/#svg-syntax

### B. 有限输入仍可能在后续几何/viewport 计算中溢出

位置：import-svg.ts:260–263、304；import-svg-viewport.ts:22–26。

- circle r=1e308 的直径溢出。
- rect x=1e308 与 scale(2) 的组合平移溢出。
- width=1e308 与 viewBox width=1e-308 的比例溢出。

importSvg 本身会返回包含 Infinity/NaN 的中间结果，但应用的文件读取和剪贴板入口随后都拒绝。admission.json 记录真实入口测试，文档和原剪贴板没有部分变更。现有错误为“图层数据无效：<id>”，可用但无法指出具体 SVG 属性；更明确的边界诊断可后续改善。这不是本轮数据污染阻断项。

### C. stop 内部动态内容没有完整拒绝

位置：svg-gradient.ts:48–51、75–84。

stop 下的 animate 被忽略，生成静态颜色；gradient 上事件属性也被忽略而不执行。这与基线相同，没有外部请求或脚本执行证据，但不能宣称所有嵌套动态 SVG 都被显式诊断。无需实现动画，可在能力说明保持“不支持动态内容”的边界，之后补一致拒绝。root transform-origin 单独存在也会被忽略；由于 root transform 已被拒绝，本探针没有视觉影响。

## 核心有效子集无回归证据

common-valid-differential.json 记录 10 例保留基线与当前生产函数的真实 CPU 像素差分：
rectangle、circle/ellipse、嵌套 opacity/transform、currentColor、cubic/arc path、dash line、use、clip、objectBoundingBox linear/radial gradient。

基线使用保留 .before.ts；依赖仍为同一生产 model/geometry/path/WASM。基线颜色解析使用严格标注的 opaque-hex Canvas host double，当前 opaque hex 路径不需要 Canvas。因此这些是几何及 CPU 输出差分，并不是浏览器颜色解析兼容性证明。

## 性能结论

未重复运行耗时基准，也没有把作者时间比率包装成独立性能测量。核验现有 benchmark.json 的源码归属及报告陈述：
- repeated gradient：该共享 CPU fixture 中中位数约改善 18.9%。
- rectangles no paint：约 +5.8%。
- paths no paint：约 +1.9%。
- 彩色基线用了 opaque-hex Canvas double；不得推导为真实浏览器/Canvas 性能。
- 不支持“全面导入加速”的结论。hex 路径的 canvas/context 分配消除与每导入一次 fallback context 的设计是更确定的优化结果。

## 复现

从仓库根目录执行：

node --experimental-transform-types --import ./testing/lib/register-typescript.mjs __REVIEW_ROOT__/review-svg-import/probe.mjs
node --experimental-transform-types --import ./testing/lib/register-typescript.mjs __REVIEW_ROOT__/review-svg-import/baseline-compare.mjs
node --experimental-transform-types --import ./testing/lib/register-typescript.mjs __REVIEW_ROOT__/review-svg-import/admission.mjs

原聚焦命令同 testing/verification-svg-compatibility/README.md；本次独立日志为 focused-independent.log/.json、presentation-independent.log、typecheck-independent.log。没有浏览器、GPU、服务监听、socket launch、包安装或产品编辑。

## 规范交叉核验

- gradient 模板、basis、坐标、stops：https://www.w3.org/TR/SVG2/pservers.html
- gradient color-interpolation 取直接引用渐变：https://www.w3.org/TR/SVG2/painting.html#ColorInterpolation
- transform 语法及角度：https://www.w3.org/TR/css-transforms-1/#svg-syntax

没有新增集成阻断项。待父任务新 WASM 产物生成后，聚合验证应明确更新运行时哈希并复跑受影响 CPU 测试；旧产物通过不能充作新产物的执行证据。
