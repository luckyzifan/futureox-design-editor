# 字体目录、字重匹配与缺失替换

2026-11-02。对照 Figma 的本机字体、常见西文/CJK 家族、缺字回退和缺失字体对话框。不下载字体，不改绘制预算。sRGB 导出和逐 run 字距/行高不在这次改动里。

## 这次能用的

- 桌面字体目录：macOS（`/System/Library/Fonts`、`/Library/Fonts`、`~/Library/Fonts`）、Linux（`/usr/share/fonts`、`/usr/local/share/fonts`、`$XDG_DATA_HOME/fonts`、`~/.local/share/fonts`、`~/.fonts`）、Windows（`%WINDIR%\Fonts`、`%LOCALAPPDATA%\Microsoft\Windows\Fonts`）。目录之外的 fontconfig 配置不读。文件符号链接只在解析后仍落在这些根目录内时读取；目录符号链接不进入。
- 每个面带 OS/2 字重、斜体/倾斜、是否可变，以及最多 16 条变体轴。`font_faces_json` 仍保留原来的 name ID 1/2，并额外给出 typographic family/style。导入 TTF/OTF 时优先用 typographic 名称。
- 原字体匹配：PostScript 或「家族 + 样式」完全一致；`微软雅黑` 这类目录别名也算一致。可变字体的 `wght` 轴若盖住请求的字重，可以用这一份文件。字重差不为 0 的静态近似（例如 Black 对 Bold）只出现在缺失字体列表里，要点「替换」才写入。
- 缺失字体面板列出未解析的原字体名。建议顺序是：文档里已有的同名或同族字重、目录里的替代家族（如 Arial → 已嵌入的 Arimo）、最后才是内置 Noto Sans SC。繁体、日文、韩文若落到这套简体内置字体，界面会说明可能出现简体字形。确认写入 `fontSources.resolved`，原名还在；内置字体的 id 仍是 `default`，所以不能只靠「不是 default」来判断已经替换。锁定图层和未分离的共享样式不改。
- 字形缺字仍走原来的回退链，最后是内置 Noto Sans SC。不会为了回退再嵌一份字体。
- 可编辑 SVG 的 `@font-face` 写出 `font-style`，可变字体再写出 `font-weight` 范围；旧的无描述符规则仍能导入。文字元素的 `font-style` 跟家族名里的 Italic/Oblique 一致。

## 仍未做

- 不从 Google Fonts 或任何网络地址下载、安装或子集化字体。Poppins 四个静态字重仍只在导入匹配到确切名称时嵌入。
- 浏览器 `queryLocalFonts` 不提供变体轴。网页端的自动匹配只看家族、样式和 PostScript 名。
- 字重滑块仍驱动当前文件的 `wght` 或静态伪粗体，不会在字重一变时自动换成同族的另一份静态文件。
- 没有独立的 Noto Sans TC/JP/KR 或 Source Han 内置文件。CJK 回退是简体 Noto Sans SC，不是按语言分形的 Noto。
- 彩色字体、emoji、字体服务优先级（团队共享字体 > 本机 > 内置）和 Figma 的 Inter 特例都没有。
- PDF 仍整文件嵌入，不为可变字体写一个具体实例。可编辑 SVG 的字重仍可能和画布上的伪粗体不一致；外形导出才是像素路径。
- 没有重编 WASM，前端现成的 `font_faces_json` 绑定要等下一次 `design-studio/scripts/build-web.py` 才带上新字段。旧绑定忽略未知字段时，导入名称仍走原来的 family/style。
- 33/100ms 和完整 G2/G5 没有跑。

## 测试

在本机 Linux 上通过：

- `cargo test -p futureox-design-desktop-backend --lib fonts::tests`：8 通过。其中包括根内符号链接只列一次、越界符号链接不读、内置 Noto Sans SC 的 `wght` 轴，以及 `/usr/share/fonts` 下 DejaVu Sans 的 400/700 和斜体标记。
- `cargo test -p futureox-design-kernel --lib -- bundled_noto_sans_sc_reports_variable_weight_axis resolved_font_names_round_trip`：2 通过。
- `vitest` 跑 `src/font-catalog.test.ts`（不加载 WASM 初始化）：7 通过。覆盖别名、可变轴、字重差不为 0 时不自动替换、确认内置字体后清除缺失提示、锁定图层、只读样式覆盖不改继承 run，以及 SVG 新旧 `@font-face`。

没有重编 `design-studio/scripts/build-web.py`，所以浏览器里的 `font_faces_json` 绑定还不会返回新字段。没有跑 33/100ms 或完整 G2/G5。
