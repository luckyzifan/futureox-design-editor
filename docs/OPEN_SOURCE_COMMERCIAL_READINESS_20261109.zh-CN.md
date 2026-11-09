# 整个应用开源与商业分发评估（2026-11-09）

范围为 Electron 应用、前端、Rust/WASM/native、随包工具、字体/图标、仓库内测试素材以及拟公开的历史。依据本机代码、构建和实际 GUI 回归评估，不是法律授权结论或完整安全审计。

**当前适合定位为开发者 Alpha。整个应用开源在技术上可行，但公开前的代码/素材授权尚未闭环；当前不宜作为生产级商业设计工具正式分发。** 开源不要求先做到 Figma 全功能，也不禁止收费；源码公开、分发授权和产品质量分别验收。

## 渲染能力与产品成熟度

| 范围 | 已有证据 | 对发布的影响 |
| --- | --- | --- |
| 桌面 GPU 主路径 | 本地 WebGPU 优先，CPU 兜底；真实 test/FIG/拓扑/117 GUI 回归，原密度覆盖和预览遮挡修复 | 可用于说明 Alpha 的实测支持范围；不能宣传所有文件全保真。 |
| 缩放清晰度 | 117 的 3200% 首个原密度区域约 10.5 → 0.8 秒，整屏约 10.5 → 8.5 秒；同视口最终像素一致 | 渐进改善明显；大模糊/复杂素材仍为秒级，持续输入的全场景低延迟尚未验收。 |
| 大源 | 306 素材、124447 派生节点的完整拓扑已运行；前一轮点击完整精修至当前视口原密度完成约 110–115 秒，初始打开另计 | 尚不适合承诺大型设计文件即时打开、任意操作流畅。分段定位见[拓扑耗时分析](TOPOLOGY_RENDER_COST_ANALYSIS_20261109.zh-CN.md)。 |
| 编辑与数据 | 本轮 117/FIG 编辑撤销重做、SQLite 新后端重开文档一致，原文件 SHA 不变 | 是限定场景的数据证据；断电/磁盘满/升级迁移和长期多文档压力仍须针对 release 构建验收。 |
| 格式兼容 | 实际 FIG 三个用户页面、Sketch 复杂素材和高倍视口均有回放 | 字体匹配、导入诊断、效果与结构差异需逐项给出支持边界；“能打开”不等于无损互换。 |
| 正式包与平台 | 本轮验证为 macOS arm64 的 `desktop-dev`，WASM 为优化构建 | 本轮未验正式 release 安装包、签名/公证、升级回滚及 Windows/Linux 实机；历史包验证不能替代当前产物。 |
| 安全与完整矩阵 | 本轮有相关回归，未做整应用恶意输入、插件/本地服务/API key 边界审计 | 不宣称已完成安全认证；完整 G2/G5、33/100 ms 和跨 GPU 矩阵仍未关闭。 |

具体故障原因、候选选择、逐项证据和边界见[缩放清晰度报告](ZOOM_CLARITY_SELECTION_20261109.zh-CN.md)及[前一轮 GPU 回归报告](ELECTRON_GPU_REPAIRS_20261109.zh-CN.md)。[SVG 专项](SVG_COMPATIBILITY_AUDIT.zh-CN.md)记录的是此前子集审计；本轮没有重新认证该文列出的全部能力。

## 公开前必须解决的实际问题

| 优先级 | 检查结果 | 完成条件 |
| --- | --- | --- |
| P0 源码授权 | 没有顶层项目 LICENSE；5 个 workspace crate 的 license 元数据均为空。GitHub 连接器确认 origin 当前仍为 private。 | 确认自有代码及贡献者授权范围，再为自有部分选择许可证、补元数据和第三方例外说明。公开可见不自动授予使用/修改/分发许可，见 [GitHub 官方说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。 |
| P0 来源待核代码 | `frontend/design-client/src/kernel/gpu/stroke-compute.ts` 明写“移植自 Figma GpuStrokeBatcher”；prefix-sum shader 与 Rust memory 模块保留参考来源说明。 | 核对原始来源、可用许可、真实改写历史和运行时可达性；无授权依据的实现需独立重写或从公开范围排除。注释不能单独证明侵权，也不能证明获准。删除来源注释、改名或测试通过都不能关闭此项。 |
| P0 源码素材 | `public/fidelity/` 有 349 个跟踪文件；`testing/fixtures/` 下另有 139 个被跟踪的二进制/图像文件。既有来源清单仍列出部分参考图与 FIG 文档的许可待核。 | 逐文件归属/许可记录；未核准素材保留私有，公开测试改用可分发的合成夹具。这些数字是检查范围，不是认定全部无授权。生产包排除 fidelity 不代表 Git 源码/历史可以公开。 |
| P0 历史披露范围 | 当前历史可能包含已从产品输出排除的素材和旧证据，本轮没有完成拟公开历史的逐项复核。 | 明确公开历史范围，核对设计文件、日志、个人路径/凭据及第三方材料；可准备独立的清理后源码快照，不直接改私有仓库可见性或重写现有历史。 |
| P0 随包依赖 | 本次 locked/offline Cargo metadata 列出 357 个包，5 个未填许可证的是本仓库 crate。Electron/Chromium、JS、Rust、native 和 vendor 尚无按目标平台闭合的最终包清单。 | 对实际 release 包生成组件、版本、hash、许可与 notice 清单；区分开发依赖与真正分发依赖。旧清单里的 337 为历史计数，不是当前完整清单。MPL 等许可表达式应按实际分发文件履行义务，不能仅凭名称认定不可商用。 |
| P0/P1 字体与来源映射 | Noto/Poppins、Lucide、MIT/Apache/BSD 等已有保留 notice；Kiwi npm 包缺少原始 LICENSE，已补上游文本，但精确源码版本映射未闭环。 | 保留已有授权文本和 hash；核对每一实际随包组件及修改声明，补 Kiwi 的精确来源映射。 |
| P0 二进制 FFmpeg | Linux x64 vendor 是 `7.0.2-static`，含 `--enable-gpl --enable-version3 --enable-static --enable-libx264`；由 Rust 启动独立进程。macOS/Windows 当前目录仅有说明。 | 保留该组件的 GPL 文本，并为实际发布的构建闭合完整对应源码、外部库、修改/构建脚本及取得方式；仅有上游版本号和下载链接不足以在此认定完成。见 [FFmpeg 该版本许可](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.0.2/LICENSE.md)和 [GPLv3 对应源码条款](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.0.2/COPYING.GPLv3)。 |

详细已存在的来源记录见 [UI_ASSET_PROVENANCE.md](UI_ASSET_PROVENANCE.md) 与 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。本轮保留全部 attribution；没有将来源待核代码/素材重新声明为自有。

GPL 允许收费；独立程序的集合也不会仅因同包就自动使其他独立部分适用 GPL。是否属于独立集合仍须结合实际集成判断，FFmpeg 的调用方式不能单独当成整应用许可结论；上述源码与 notice 条件仍需履行。[GPLv3 第 4–6 节](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.0.2/COPYING.GPLv3)。

## 建议的整个应用开源路线

对已经确认拥有授权的应用代码，建议采用 **Apache-2.0**，与开放整个应用、允许社区商业使用及收费服务的方向相符；其授予范围包含版权和特定贡献专利，并要求随分发保留许可证、修改说明及适用的 notice。第三方代码、字体、图标和独立工具继续使用各自条款，不能被顶层许可证覆盖。[Apache-2.0 正文](https://www.apache.org/licenses/LICENSE-2.0)。这是当前推荐，未在授权范围未闭环时直接应用 LICENSE。

1. 先形成可公开源码清单：保留完整应用功能，参考素材换为可分发夹具，逐项处理来源待核实现和贡献权属。
2. 在权属明确后落实项目 LICENSE、crate/package 元数据、第三方 notices 和可复现的依赖/构建说明；单独处理源码公开历史与 FFmpeg 分发范围。
3. 发布 `0.1.x Alpha` 时明确 macOS arm64 实测范围、已测文件类型、字体/导入差异、大源等待时间和未验平台。源码 Alpha 可以早于完整性能目标，不能用模糊的“全部支持”替代限制说明。
4. 商业试点前冻结正式 release 构建，验证打包后文件打开/编辑/撤销/自动保存/重开/导出、异常退出恢复及升级，并限定支持场景和设备。商业正式分发前再完成目标平台安装、授权清单、关键安全边界与性能/兼容矩阵。

可继续用于已有的自有文件内部验证与受控试用；本报告没有证明任意第三方设计文件、素材或整个当前仓库已获得对外再分发权。渲染测试通过也不为图像/字体内容授予许可。

## 本轮交付与未执行动作

已实施普通桌面 WebGPU 的渐进精修并保留旧版有收益的连续性策略。相关测试 562 通过、2 原有跳过；独立策略测试 28 通过；117/FIG 新后端重开及两份高倍最终画面像素对照通过。

仓库可见性仍为 private，没有发布应用、改写历史或对未核准材料添加新许可证。开源前的材料和贡献权属需要实际来源/授权证据，不能通过渲染代码修改推断补齐。
