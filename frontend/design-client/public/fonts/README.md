# 捆绑字体

这些文件是可再分发的开源字体，用来在 Fig 导入后按家族名匹配。没有把整套商业字体放进仓库。

| 家族 | 文件 | 许可 | 来源 |
| --- | --- | --- | --- |
| Poppins | `poppins/Poppins-{Regular,Medium,SemiBold,Bold}.ttf` 和对应的 Italic | OFL-1.1 | https://github.com/google/fonts/tree/main/ofl/poppins 。作者 Indian Type Foundry / Jonny Pinhorn。斜体包括 Italic、Medium Italic、SemiBold Italic、Bold Italic。Version 4 的 SHA-1 见 `bundled-import-fonts.ts`。 |
| Poppins 2.000 | `poppins/v2.000/Poppins-{Regular,Medium,Bold}.ttf` | OFL-1.1，许可文本同目录上一级 `OFL.txt` | https://github.com/google/fonts/tree/c93ee27fc0/ofl/poppins （2015-06-01）。FIG `fontDigest` 是这份文件的 SHA-1。和 Version 4 同名但字宽不同，摘要不一致时不能互相替代。清单和校验在 `v2.000/sources.json`。 |
| Inter | `inter/Inter-{Regular,Medium,SemiBold,Bold}.ttf` | OFL-1.1 | https://github.com/rsms/inter/releases/tag/v4.1 的 `extras/ttf`。斜体未打包，导入时改用同字重的正体并写明。 |
| ABeeZee | `abeezee/ABeeZee-Regular.ttf` | OFL-1.1 | https://github.com/google/fonts/tree/main/ofl/abeezee |
| DejaVu Sans | `dejavu/DejaVuSans.ttf` | Bitstream Vera + DejaVu 变更，见 `dejavu/COPYRIGHT.txt` | 发行版 `fonts-dejavu-core` 的同一文件 |
| Noto Sans SC | `NotoSansSC.ttf` | OFL-1.1 | 画布中文渲染已经使用。约 17MB，不复制进每一份导入文档。上游：https://github.com/notofonts/noto-cjk |

还没打进仓库、但可以自行下载的家族：

- Roboto，Apache-2.0：https://github.com/googlefonts/roboto/releases
- Source Sans 3，OFL-1.1：https://github.com/adobe-fonts/source-sans/releases
- Noto Sans，OFL-1.1：https://github.com/notofonts/latin-greek-cyrillic/releases

导入匹配不到捆绑文件时，警告里带上述链接。未列出的家族只保留文字，并说明没有捆绑文件。
