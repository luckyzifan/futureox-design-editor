# FIG / Sketch 实际格式修复与验证（2026-10-29）

工作依据为用户下载的 `fig-sketch-support-analysis-2026-10-29.md`，结论逐项重新核对源码、真实 FIG v106 内嵌 schema、Sketch 官方 schema 和本机 Sketch。参考文件不是验收结果。当前工作树原有大量修改；`baseline.json` 和 `baseline/` 只冻结本轮起始的五个主要实现文件，不能用 Git HEAD 代表本轮起点。没有重置其他工作。

## 已落地的格式修复

- Rust FIG 的 rectangle / vector / line / boolean 类型改为共享场景接受的规范类型；零尺寸线保留真实端点与零描边宽度；所有成功返回的原生文档都经过 `Document::validate`。
- v106 Image 的 `hash` 和 `dataBlob` 都连接到真实资源；STRETCH / FIT / FILL 的映射修正；基础 TILE 接入已有模型。缺资源明确失败。
- TS XOR 改为 exclude；两端未知布尔语义拒绝。Rust fillGeometry 使用隐式闭合专用解码。
- Rust 保留 disabled paints、PASS_THROUGH、LINEAR_BURN / LINEAR_DODGE、渐变 stop alpha 与原始浮点色值。TS 同步避免无条件 RGB 字节量化。Rust 文本 run 也保留 alpha 和 fill opacity。
- 原生 GLASS / GRAIN 接入已有执行模型；未知现代效果拒绝。椭圆 arcData 接入共享圆弧/圆环模型。非默认色域/插值、OUTLINE 蒙版、尚未执行的图片调整和平铺参数不再静默冒充支持。
- 组件属性以 definition GUID 为同一键，解包 bool/TextData/GUID 值，通过真实 componentPropRefs 连接模板图层。TS/Rust 同时更新；实例物化测试验证指定文字与可见性。当前需要一个明确属性目标；多个目标、变量驱动属性或缺主组件明确拒绝。
- FIG 诊断字段迁入已有 `designSystem.sketchContainers.nodeMetadata` 源元数据槽位，避免被当成可执行变量绑定。`import_fig_report` 返回实际 backend、warning 和 fallback native error；转换器失败同时保留两条错误链。
- Sketch 文本 alpha、禁用填充/描边/阴影及其顺序保留；只读显示的 Difference=2 / Intersection=3 修正。
- AdaptableColor 用导入时模型凭据控制原文回放；编辑颜色后不再恢复旧 light 值。共享样式也检查凭据。未编辑原文仍保留，修改后的原生导出以当前编辑为准。
- Sketch 颜色 intrinsic alpha 与部件 context opacity 分别保留；native Plus 模式验证发现合并两者会改变原生结果，已修正填充和描边写出。
- native PlusDarker / PlusLighter 编码 16/17 不再丢成 Normal；原生文件往返通过。本应用合成与 Sketch 仍不同，导入报告明确提示，不能称为画布像素一致。
- 原生旧约束实测确认 1=Start、2=Stretch、4=End、7=Scale。原始 mask 有模型凭据保护；3/5/6 混合弹性组合仍需 native resize solver，兼容模型报告近似。Mask 0 的原生迁移缩放行为亦记录。
- 星形使用官方 `radius` 字段，保留旧读取别名；输出星形/多边形/椭圆的实际 curve points，避免只有参数但原生无可绘制几何。普通 line 使用已有 open-path codec。
- 已是 UUID 的 native object ID 保持原样，图片名改为真正 SHA-1 内容标识；第三方图层 plugin userInfo 保留；同侧共线手柄不再错误标为 mirrored/asymmetric。
- 源局部保存增加 image transform/adjust/tile、textPath/pathOffset 的未表示编辑检查。混合可保存字段与未支持字段不能以已保存的名字掩盖未保存的材质变化。完整导出遇到不可表示的图片变换/调整、平铺布局或 parametric arc/rounded polygon 也明确拒绝。

## 独立证据

- `baseline-fig.log`：真实 `figma-materials-native-2026-10-08.fig` 的起始结果为 381 节点，rect/path 类型，`Document::validate` 失败。
- `baseline-regressions.log`：新增五项 Rust 格式回归在修改前全部失败。
- `generate-v106-corpus.mjs` 从真实文件提取 schema，用独立 kiwi-schema writer 生成 `testing/fixtures/design/fig-interop-v106.fig`。同一字节输入由 TS 和 Rust 读取，验证图片、布尔、透明禁用样式、组件定义与赋值；不使用 Rust reader 的私有 writer 作为唯一 oracle。
- `native-resize-oracle.py` 生成八种 native Symbol 约束，Sketch `sketchtool detach` 实际展开 100→200 尺寸实例。结果：bits 0/7 → x=40,w=60；1 →20,30；2 →20,130；3 →20,67.5；4 →120,30；5 →55,30；6 →60,90。只证明此固定几何及已安装版本。
- `native-style-oracle.py` 生成两种星形、四种 Plus blend/alpha 与禁用填充。`native-style-comparison-final.json`：7/7 原生 Sketch 重渲染往返逐字节相同；portable 原始星形边缘仍不同，Plus 场景也仍不同。这两类结论分开报告。
- 最早的 style oracle 用空 points，Sketch 输出空白。该夹具错误被修正为实际原生 curve points；不能把那一轮空白输出算成功。
- 共享 FIG 小图初次 fixture PNG 的 CRC 错误被真实 renderer 揭出，已换成实际 PNG 编码器生成的资源；保留失败日志，不将仅 metadata 校验当成图片已绘制。

## 不作完整格式/渲染支持承诺的边界

仍无 FIG 导出。没有建立 Sketch 全历史版本迁移链，兼容输出仍是现有声明版本与选择性重建，不能声称任意未知字段、archive 元数据或字节级归档完全保真。源归档会话/源局部保存与兼容全量导出是三个不同保证。

OUTLINE、复杂多目标/变量组件、GRID/BASELINE/混合旧弹性、完整原型与云库同步、高级文本排版、尚未执行的图片调整/复杂平铺以及未知现代效果，不由本轮字段修复自动成为可执行功能。明确拒绝与可执行支持必须分开计数。

该记录不关闭完整 G2/G5、跨渲染器滤镜/文字/混合像素一致或全编辑器延迟目标。测试汇总与最终源码 hash 在本轮验证结束时另行写入，历史中间日志不能代替当前组合结果。

## 格式来源

- [Sketch 官方文件格式说明](https://developer.sketch.com/file-format/)
- [Sketch 官方 schema 3.6.2](https://unpkg.com/@sketch-hq/sketch-file-format@3.6.2/dist/file-format.schema.json)：本轮保存为 `sketch-schema.json`，确认 blend 8/9、16/17、Star Layer.radius 等。8=Soft Light、9=Hard Light 的旧实现正确，没有按冲突草稿交换。
- FIG 内嵌 schema 来源为仓库真实 v106 文件；参考 `/Users/Apple/project/core/figma-wasm-analysis/evidence/round-2026-10-26/fig106-schema-full.txt`，不把私有测试枚举当作真实格式规范。
