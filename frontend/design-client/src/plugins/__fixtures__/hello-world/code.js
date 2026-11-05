/* Hello Futureox 测试插件：覆盖 P0 API 面（showUI/UI 消息/loadFontAsync/
 * createFrame/createText/属性写入/appendChild/selection/notify/closePlugin）。 */
figma.showUI(__html__, { width: 300, height: 150 })
figma.notify('Hello Futureox 插件已启动')

figma.ui.onmessage = (msg) => {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'create-card') {
    figma.loadFontAsync({ family: 'Inter', style: 'Regular' }).then(() => {
      const frame = figma.createFrame()
      frame.name = 'HelloCard'
      frame.resize(220, 120)
      frame.cornerRadius = 8
      frame.fills = [{ type: 'SOLID', color: { r: 0.96, g: 0.42, b: 0.32 }, opacity: 1, visible: true }]
      const label = figma.createText()
      label.characters = 'Hello Futureox'
      label.fontSize = 18
      label.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]
      label.x = 16
      label.y = 48
      frame.appendChild(label)
      figma.currentPage.appendChild(frame)
      figma.currentPage.selection = [frame]
      figma.ui.postMessage({ type: 'created', id: frame.id, children: frame.children.length })
      figma.notify('已创建 ' + frame.name)
    })
  } else if (msg.type === 'count') {
    figma.ui.postMessage({ type: 'count', nodes: figma.currentPage.children.length })
  } else if (msg.type === 'close') {
    figma.closePlugin('插件请求关闭')
  }
}
