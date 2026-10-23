# 1GiB导入与因果诊断开发增量

注意：不是渲染性能验收包。模糊、白板、3200%缩回和旋转/拖动实时跟手仍未通过GUI/硬件GPU验收。17个新固定错误码只是诊断，不修复GPU积分模糊512上限。

## 精确前置
裸main：e411af08f7b3e901f83415932c05d50515a00cdd。本提交已合并此前包，无需且不得重新混装旧518增量链。只包含本轮26个新增/修改路径及验证材料。清单列前后SHA256，3,211个源码/配置/测试前置受控；生成WASM/JS不是用户前置，允许用户合法不同构建。

## 变更
- 统一设计文件编码输入上限为1GiB=1,073,741,824字节，包含边界；替换旧32MiB/48MiB入口门槛，Rust Sketch/FIG编码输入政策同步。
- PNG/JPEG/WebP选择器正确走已有图片导入，主页未打开画布时明确中英文反馈。
- 导入按action/request关联准入、读取、worker、解码、验证、提交等固定阶段；取消/被替代/真正失败明确区分，多图片逐文件归因，无重复解码，保留一次历史提交。
- 补17个固定native编译错误码119–135，真实adapter及FPR1帧测试，未知或夹带内容的错误仍未知，不输出文档内容/文件名/任意异常文本。

## 安全边界不是全部放开
1GiB仅编码输入业务准入，不等于1GiB文件可完成解压、编辑、保存或实时渲染。Sketch/FIG展开64MiB及条目/压缩比等保护仍保留；SVG/SVGZ解析/展开48MiB保留；FD/JSON仍需可信文档资源准入。Inspector/Canvas独立图片入口8MiB编码、12MiB dataURI、16MP保护未改；App图片追加不走该独立入口，不能据此声称1GiB图片解码安全。导出限制、当前精度、HDR、GPU1GiB工作预算均未改。

## 实际最终验证
新main+26路径+干净policy新WASM，同一源码：
- 完整tsc通过。初次新测试跨端.mjs无类型声明TS7016失败已保留；仅该import加精确test-only expect-error后重跑，不换mock、不减断言。
- 45套Vitest：1043/1043；额外独立缩放30，overlay39/4/10。重复入口覆盖与主联合有重叠，不相加冒充唯一测试数。
- 实际Node导入ownership20/20，5套desktop Node53/53；实际Web构建通过。
- Rust实际archive模块4/4及真实源文件编译；完整新policy WASM链接通过，无ROI诊断cfg。真实117（5,013,257B）新WASM导入1页+752节点，输出原始JSON与旧生产逐字相同，坏/截断ZIP拒绝。这是导入，不是渲染。
- 3,211源码输入前后不变；guard整体前态/后态、幂等、回滚及负控已运行，实际ZIP解包复验另见随包或交付回执。

WASM功能验证构建为opt0/ltooff/cgu256，不是发布性能构建；SHA09ff44d26dbd365a7551a9de56d135c21fb44b387d8f11a51b155887f84d9b28。实际Webproducer源码身份462753251bec9fd3735dfa820fa6df4b198b7e8f0f2283fa6fb38447d06a54ad。二进制不装入本源码增量。

未验：完整native backend程序集、真实1GiB文件全流程、完整GUI/硬件GPU、十份117连续编辑/保存重开、上述渲染体验。File.size边界stub不分配1GiB，不冒充大文件解析。

## 应用、重建和回滚
在干净e411仓库根执行：

    python3 /path/to/package/apply_increment.py check /path/to/Core
    python3 /path/to/package/apply_increment.py apply /path/to/Core

全部前置通过后才写入；错误HEAD、混装、未知修改、符号链接均拒绝。重复apply为幂等。不要边编辑边应用。应用后在frontend/design-desktop执行：

    bun run build --fast

必须成功完整重建WASM及native backend/kernel后重启。--fast只选native desktop-dev profile，不跳过Rust；该脚本源指纹覆盖两Rust政策文件。Web在frontend/design-client执行bun run build。单独vite build或只复制TS不会更新native限制。

回滚：

    python3 /path/to/package/apply_increment.py rollback-previous /path/to/Core

仅完整本包后态可回滚；后续用户改动保留并拒绝覆盖。回滚后仍需重新完整构建。本轮无新增DB迁移，但源码回滚不等于数据库降级。备份工程与数据库后再试。

## 测试入口
全部新增/修改测试随source目录；未变测试见unchanged-tests-base-index.json。verification/run_frontend_checks.py支持--repo、--private-117（已解析的117私有输入JSON）、--wasm-sha256、--run-id，场景hash固定。verification/import-real117.mjs接受绑定JS、WASM、真实117.sketch、预期WASM SHA及结果JSON路径。私有素材不在包中，缺素材必须记未执行。Rust完整契约命令从design-studio运行cargo test --locked -p futureox-design-kernel；本次云端实际只报告上述模块/匹配WASM层，不声称完整crate/backend测试通过。
