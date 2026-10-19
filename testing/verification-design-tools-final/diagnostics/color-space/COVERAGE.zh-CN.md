# 多色彩空间端到端核查与小范围修补

核查日期：2026-10-19。工程：design-latest-20261019T1209。

## 结论

当前不能承诺 sRGB、Display P3、线性色、HDR 已全链路完成。现有内核有扎实的显式色彩管理基础：f64 色彩矩阵/传递函数、extended linear-sRGB 工作空间、预乘浮点合成和 16-bit tagged PNG。真实现有 WASM 数值探针确认了这些基本路径，也确认了 6 项实质缺陷。显示设备、GPU、浏览器、Electron、socket、Figma/Sketch 原生应用均未在本轮运行；CPU 数值通过不是显示验收。

经协调批准，本次只修改 interop.rs 的 Sketch 色彩交换和相关独立回归。没有改变 renderer、blend、image_adjust、GPU shader，也没有重建共享 WASM。新代码目前须以当前源码的独立 Rust 测试结果为准；旧 WASM 探针只描述修补前二进制。

## 一、覆盖矩阵

| 路径 | 已有能力和本轮证据 | 结论/缺口 |
|---|---|---|
| 色彩解析 | Hex 与严格 numeric color() 子集；12 种空间。Hex 随文档 profile，显式 color() 保留自身空间 | 支持受限表达式，不等于完整 CSS Color 4 parser；无 lab/oklab/hsl/百分数/relative color |
| sRGB/P3/linear 数学 | sRGB 0.5→0.21404114；P3 红→linear-sRGB [1.2249402,-0.042057,-0.019638]；负值和 >1 保留 | WASM 实测支持；没有发现矩阵/传递函数的本轮数值错误 |
| PQ/HLG | 203 nit reference white 与可配置 peak；PQ 0.580688881→1，HLG .75→约203.152 nit | WASM 数值通过；本轮不是 BT.2100 全域标准符合性认证 |
| Assign | ColorPanel 只改 documentSpace；Hex 重解释，显式 color() 不改 | 已支持该语义并可撤销；UI应明确命名为 Assign |
| Convert | 无完整 document Keep appearance 事务 | 缺失；必须覆盖颜色、渐变、阴影、文本、变量、共享样式、动画及预留外来元数据，不能只改默认空间 |
| 普通 source-over | managed 浮点、线性工作域；alpha 一次预乘，转出前 unassociate | 支持；需继续覆盖极低 alpha 和屏幕端量化 |
| 特殊 blend | 使用同一 linear 工作域的模式公式；部分 dodge/burn/nonseparable 公式有 [0,1] 限制 | HDR 语义不完整；这些传统公式本身不是 HDR 保真证明，不擅改算法 |
| 渐变 | managed 空间预乘插值；未管理文档保留旧 encoded SDR 路径 | 核心支持；FIG 非 DEFAULT interpolation 拒绝。P3 Sketch stop profile 不一致本次已修 |
| blur/filter | 线性 blur 有能量/负色域回归；阴影色走统一 color parser | 核心部分支持；图像调整会裁 HDR（B4），并非所有滤镜 HDR 安全 |
| 图像 | PNG cICP 优先，其次 RGB ICC；解码后转换一次并预乘；managed 保留 16-bit/float；无 profile 默认 sRGB、独立于文档 profile | 支持明确子集；gAMA/cHRM 漏解码（B5）。CMYK/gray ICC 和 HDR ICC 明确拒绝；只接收 PNG/JPEG/WebP，非 AVIF/HEIC/EXR 全覆盖 |
| 字体/文字 | 常规矢量 glyph/run 进入同一 paint 管线；Sketch 导出文本颜色本次同样 profile-aware | 常规路径源码覆盖；本轮未测真实字体显示、COLR/彩色 emoji 与所有 run fallback |
| 内部存储 | 文档 ColorSettings + 原始 color()；已有 history/serialization 测试 | 支持；Sketch 不透明 float→Hex 量化仍存在，不能声称该格式 round-trip 全精度 |
| GPU/屏幕 | ColorPresenter 申请 rgba16float、P3、extended toneMapping，并有传输探针与退化逻辑 | 仅审读，不作实际 GPU/OS/面板结果判断；SDR fallback 与显示 profile 仍需实机 |
| PNG 导出 | 16-bit RGBA；sRGB/P3/linear/2020 cICP + SDR ICC；PQ [9,16,0,1]、HLG [9,18,0,1] | 六种目标的实际 chunk 探针通过；整数编码最终必 clamp [0,1]，toneMap:none 也不是无界 float 文件；没有 mDCV/cLLI |
| JPEG/WebP/raster PDF | UI限制为 sRGB；8-bit，PDF DeviceRGB，JPEG白底 | 明确 SDR 路径；未携带 ICC/OutputIntent 的跨查看器行为未保证，且不能保留 HDR/P3原域 |
| vector PDF | 矢量色转换到 sRGB；图片走另一条直接 decode/embed 路径 | 图片 profile 丢失（B6）；gradient/shading 在 DeviceRGB 插值也不等同 managed linear 合成 |
| SVG | managed 文档普通 vector export 拒绝；visual mode 嵌 tagged PNG | 安全拒绝为主；XYZ documentSpace 无 PNG RGB 输出会报错，不属于完整 vector wide-gamut 导出 |
| FIG | 前端只接受 LEGACY/SRGB，拒绝 DISPLAY_P3 与非 DEFAULT interpolation；native fig2sketch 是另外路线 | 有意 fail-closed。没有可用原生 helper/对照显示证据，不能称支持 P3 FIG |
| Sketch native | 原生 preview/display 明确拒绝 P3 | 未完成；compatibility import/export 与 native session 两条路线不能混淆 |
| Sketch compatibility | 文档 0/1/2→unmanaged/sRGB/P3；本次修正显式颜色导出和透明 stop profile | 小范围改善；raw metadata、自适应色和浮点 import 精度仍有独立限制 |

## 二、已实际复现的缺陷

B1：显式 P3→Sketch 变黑。旧 hex_to_rgba 只处理 color(srgb...)，其他表达式落为 [0,0,0]。真实 WASM：P3 文档 color(display-p3 1 0 0) 的导出 colorSpace=2，red=0。

B2：显式 sRGB→P3 Sketch 被重新标记。旧函数把 color(srgb 1 0 0) 原数值直接写入 P3 文档，视觉变为 P3 红，而不是 sRGB 红。正确 P3坐标约 [0.9174875573,0.2002868077,0.1385605912]。

B3：P3 Sketch 透明渐变错误。相同红色的 alpha=1 stop 导入 #ff0000（按文档 P3），alpha=.5 stop 导入 color(srgb 1 0 0 / .5)。同一渐变改变 alpha 同时改变色域。

B4：HDR 图像调整提前裁剪。真实 1×1 PQ图像解码到 [3.9998214,1.9999585,1.0000696]；仅 exposure=0.000001 后变 [1,1,1]。image_adjust.rs::apply_linear 输入和 core 多处 clamp [0,1]，直接套用现有 SDR/Figma shader 数学。需先定义独立 HDR 调整语义和兼容版本，再决定算法；本次没有改它。

B5：PNG legacy gAMA/cHRM 被忽略。合法 PNG 没有 cICP/iCCP/sRGB，gAMA=1，cHRM为sRGB primaries，像素128/255。应是线性0.5019608，实际0.2158605。当前 image_color.rs 只识别 cICP/ICC，否则默认 sRGB。这是错误解释已有元数据，不是未标记文件的合理 fallback。

B6：矢量 PDF 图片忽略 profile。由工作色 [.2,.5,.1] 生成 tagged P3 PNG 后直接 vector PDF；图片 stream 字节 [138,186,101]，正确 sRGB应 [124,188,89]，PDF没有 ICCBased。pdf_export.rs::embed_image 直接 into_rgba8 或 JPEG DCTDecode passthrough，没有调用统一 image_color。建议转用统一 image decode+转换、或保留正确 ICCBased；未实现前明确拒绝/回退该类图片，不能静默误色。

## 三、本次批准的小修

interop.rs：
- 文档目标只支持 None/sRGB/P3，其他 HDR、linear、XYZ 等 target 在产生 ZIP 前明确报错。
- color() 用现有 f64 to_working/from_working 转成目标 sRGB/P3坐标；同空间直接保留数值；Hex继续精确 byte/255，不经 f32中转。
- 显式 PQ/HLG颜色拒绝。转换后实质超出目标[0,1]也拒绝，不自行做 tone-map/gamut-map。
- 唯一边界容差为 encoded channel 1e-10，用于浮点矩阵/传递函数舍入；超出该值不是“近似保真”，直接错误。绝无降低渲染精度。
- intrinsic alpha与外层 opacity每个只应用一次。solid/gradient/border/shadow/text/typed override/shared style统一走该函数。
- Importer 将 document profile传到 gradient stop解析，透明P3 stop正确标记 display-p3。
- 内部 helper传播 Result，错误不被 filter_map吞掉，不产生成功的错误色ZIP。

独立回归：sketch_color_profiles.rs。测试包含真实zip解析、sRGB→P3 W3C数值锚点、exact Hex、alpha、P3透明梯度和再导出、不可表示target/色域/HDR拒绝、shared style/border/shadow/text路径。

范围限制：原 import color_hex 的非字节浮点量化没有扩大修改。P3/source原文保存、native session、完整 gamut mapping、HDR filter策略、vector PDF，以及PNG legacy gamma需要后续分别回归。新测试不会把0.5/255的已有量化称为无损。

## 四、标准/官方对照

- [W3C CSS Color 4](https://www.w3.org/TR/css-color-4/#color-conversion-code)：矩阵、transfer和白点适配的主参考。颜色转换和对目标色域的映射是两项不同操作；alpha在rectangular色域插值时需预乘。核心实现有这些基础，但只实现严格表达式子集。
- [W3C CSS Color HDR](https://www.w3.org/TR/css-color-hdr/)：参考白、PQ/HLG和线性组合约定。该文档仍为演进规范，不能仅凭其样例称完整标准符合性；工作域不得提前截断负值和高光。
- [PNG Third Edition](https://www.w3.org/TR/png-3/#11cICP)：颜色chunk优先级与full-range RGB cICP。实现正确优先 cICP，但遗漏下游 gAMA/cHRM fallback。
- [W3C Compositing and Blending](https://www.w3.org/TR/compositing-1/)：source-over与传统blend参考。实际HDR扩展范围需要明确契约，不将传统SDR模式公式自动解释为无限动态范围保证。
- [Figma官方色彩管理](https://help.figma.com/hc/en-us/articles/360039825114-Manage-color-profiles-in-design-files)：正式区分Assign和Convert，并支持sRGB/P3。Figma默认按文档profile导出；Core普通PNG当前默认sRGB，所以两者默认策略不同。Figma文档说明变量/样式不随Convert改变；Core将来应决定自己的清晰契约，不能假设所有对象都与Figma等价。
- [Sketch官方色彩管理](https://www.sketch.com/docs/designing/color-profiles/)：同样区分Assign和Convert，支持sRGB/P3，要求广色域设备才能评估P3效果。本轮只引用其公开语义，不把JSON导出测试当作Sketch显示验收。

## 五、验证证据与复跑

- probe-current-wasm.mjs：只运行已有真实WASM，不替换binary。wasm-probe-results.json记录SHA256、数值和PNG chunks；各BUG断言的pass表示“成功复现缺陷”，不是“产品通过”。
- metadata-*.png、linear-gama-chrm.png、p3-gradient.sketch、p3-image-vector.pdf：独立小fixture。
- interop-before.rs和interop-color-fix.patch：修改前快照及本轮专属差异，不混入原有工作区修改。
- build-native.py/run-native-tests.py：直接当前源码+已有依赖rlib进行独立Rust编译。cargo offline因workspace所需axum索引缺失而未成功；没有把它标为通过。
- native-test-results.json及各*-tests.log：最终准确状态以这些运行结果为准，后续写入总结。

## 六、下一步建议

1. 完成本次native回归后，由root统一重建WASM；再把B1–B3改为正确行为的运行时断言，并核验共享前端集成。
2. 优先将PNG legacy metadata和vector PDF图片错色改为正确转换或明确拒绝，二者为实际内容静默损坏。
3. 定义版本化HDR image adjustments与blend域合同；保留旧SDR兼容路径的字节/性能基线，再添加HDR数学。不应用删除clamp这种无契约修补。
4. 实现独立Assign/Convert操作与Undo、dirty缓存失效、变量/动画/样式覆盖；有限表示格式的gamut/tone-map显式选择。
5. 在真P3/HDR显示设备上验证OS/browser/gpu/ICC、reference-white与fallback；用仪器或可信显示profile加像素/场景对照。CPU数值测试不能替代这一步。

## 七、本轮最终Native验证

独立 rustc 当前源码构建通过，10个integration suite共59项通过、0失败；新增sketch_color_profiles为7项。具体为sketch_color_profiles 7、color 10、image_metadata 5、sketch_adaptable_color 4、sketch_shared_styles 3、sketch_text_attrs 3、sketch_import_admission 11、sketch_overrides 3、sketch_automation_symbols 6、image_adjust 7。git diff --check通过。该结果不包含GPU/显示/浏览器/socket，也不意味着整个workspace/Cargo全部通过。共享WASM未重建，仍保留其修补前SHA256；新源码与WASM两种证据严格分开。
