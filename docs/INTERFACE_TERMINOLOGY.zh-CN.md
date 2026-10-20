# 界面术语与自适应面板 / Interface terminology and adaptive panels

范围：本轮新增的面板尺寸、界面偏好和属性标签。不是全仓库国际化完成声明。默认仍为简体中文；“面板控件语言”仅切换新控件，设置中明确告知其范围。文档名称、用户内容和持久化数据不会被翻译。

## 专业术语 / Glossary

| 中文 | English | 使用约定 |
| --- | --- | --- |
| 图层 | Layers | 图层树及图层选择；Sketch 的列表称 Layer List |
| 图层面板 | Layers panel | 左侧图层列表面板 |
| 属性面板 | Properties panel | 右侧属性面板；Sketch 对应 Inspector |
| 画布 | Canvas | 设计内容的编辑区域 |
| 工具栏 | Toolbar | 底部浮动设计工具栏 |
| 设计 | Design | 图层的设计属性 |
| 原型 | Prototype | 交互与原型属性 |
| 填充 | Fill | 图层填充，不将其称为“背景” |
| 描边 | Stroke | 图层轮廓样式 |
| 组件 | Component | 可复用设计元素；不把 Sketch Symbol 任意改写为同义的数据模型 |
| 收起 / 展开 | Collapse / Expand | 面板显示状态 |
| 减少动态效果 | Reduce motion | 应用界面动画偏好，系统设置仍有优先保护 |

英文名称依据官方文档；中文为本产品的编辑术语，不声称是 Figma/Sketch 官方中文翻译。

官方参考（检索日期 2026-10-20）：
- Figma, Explore the navigation bar and left sidebar: https://help.figma.com/hc/en-us/articles/360039831974-Explore-the-navigation-bar-and-left-sidebar
- Figma, Design, prototype, and explore layer properties in the right sidebar: https://help.figma.com/hc/en-us/articles/360039832014-Design-prototype-and-explore-layer-properties-in-the-right-sidebar
- Sketch, The Inspector: https://www.sketch.com/docs/interface-and-settings/the-mac-app-interface/the-inspector/
- Sketch, The Layer List: https://www.sketch.com/docs/interface-and-settings/the-mac-app-interface/the-layer-list/

## 行为与边界

- 桌面面板保存目标宽度与显示状态。左侧目标范围 208–480 px，右侧 260–480 px。实际布局另外限制视口占比，避免两个宽面板挤空画布。
- 拖动时仅更新当前 shell 的 CSS 变量；释放指针后保存一次。取消或卸载撤回未提交的宽度；键盘方向键每次 8 px，Shift 为 32 px，Home/End 到目标范围两端。
- 900 px 及以下采用覆盖式侧栏，首次默认收起。紧凑视图的临时开关不覆盖桌面已保存的开关。更窄的工具栏允许换行。
- 隐藏侧栏不卸载其字段；待完成输入和活动手势会阻止显式面板收起或调整。缩放/画布渲染和文档历史不属于面板偏好。
- 默认启用 140–160 ms 的面板与设置弹窗进入动画，只使用 opacity/transform。减少动态效果是可选开关，且支持系统媒体查询；没有增加模糊背景、持续动画或渲染循环。
- 偏好保存失败时保留当前会话值，并在界面设置显示提示。重置面板布局不会重置语言；总偏好重置会重置界面偏好。

## 验证范围

`adaptive-panels.test.tsx` 是真实挂载 React/jsdom 的控件与状态测试，包括实际 pending-edits 注册表保护输入、拖动/取消、键盘范围、存储重新读取、语言控件、减少动态效果开关及重置。
CSS 断点和系统媒体查询检查是静态源码契约，不是浏览器布局或像素验收。实际浏览器/Electron 中的宽度、触摸、焦点、字体、阴影与屏幕阅读器体验尚需设备验收。没有绕过 GUI 访问限制。
