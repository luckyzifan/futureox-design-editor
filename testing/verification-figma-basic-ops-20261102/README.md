# 画布基础操作与 Mac Figma 对照（2026-11-02）

对照官方说明（读取于 2026-11-02）：[选择图层](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects)、[对齐、旋转、位置与尺寸](https://help.figma.com/hc/en-us/articles/360039956914-Adjust-alignment-rotation-position-and-dimensions)、[缩放与视图](https://help.figma.com/hc/en-us/articles/360041065034-Adjust-your-zoom-and-view-options)。参考文件仍是 `design/LAIzSshpSIxcE8eNrXW5G7`（01有料素材）。本轮没有打开该实时文件，也没有改粘性仿射、无空白缩放边缘或蓝色强调色。

## 本轮与 Figma 对齐

- 单击未进入的画板、编组、组件或实例，选中该容器，不选子级。悬停框与单击目标相同。Cmd/Ctrl 单击仍深选叶子。选中子级后，下一次单击停在这一层，并按绘制顺序命中最前的兄弟。
- 双击只进入下一层容器。落到文字上进入编辑；已经选中的矢量路径才进入节点编辑。矩形不会因为双击或 Enter 变成矢量。
- Enter 在容器上选择子级；在已选文字上进入编辑并保持全文选中。Shift+Enter 仍回到父级。
- 框选必须超过与移动相同的拖动阈值。页面级框选命中画板而不是画板内部。Cmd/Ctrl 框选命中相交的嵌套叶子。Figma 预设下，按下或松开时按住的 Shift 都会加选，不做 Sketch 的异或。
- 已有行为保持：Shift 移动锁主轴；Shift 缩放锁比例，Control 临时取消已锁定的比例并关闭吸附；Option 拖动复制；方向键小/大微移为一次撤销；边缘与角手柄缩放；Shift 旋转 15°；空格拖移；Shift+2 按选区适应并留 40px；Delete/Backspace 删除；撤销恢复操作前的选区。

## 仍推迟

- Shift 框选“匹配图层”、参考线在缩放过程中的对象吸附、空选区方向键是否平移、以及和实时 Figma 文件的 GUI 对照。
- 33/100ms 与完整 G2/G5 未测，本轮也不声称通过。
