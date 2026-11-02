async function createLabels(text, count) {
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' })
  const label = String(text || 'Label').slice(0, 80)
  const total = Math.max(1, Math.min(12, Number(count) || 1))
  const created = []
  for (let index = 0; index < total; index += 1) {
    const frame = figma.createFrame()
    frame.name = label
    frame.x = 48 + index * 168
    frame.y = 72
    frame.resize(148, 76)
    frame.fills = [{ type: 'SOLID', color: { r: 0.204, g: 0.349, b: 0.831 } }]
    const title = figma.createText()
    title.characters = label
    title.fontSize = 16
    title.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]
    title.x = 16
    title.y = 26
    frame.appendChild(title)
    created.push(frame)
  }
  figma.currentPage.selection = created
  await figma.clientStorage.setAsync('label', label)
  figma.notify(label)
  return created.length
}

const saved = await figma.clientStorage.getAsync('label')
const initial = typeof saved === 'string' && saved ? saved : 'Label'
if (figma.command === 'run') await createLabels(initial, 3)
figma.showUI(__html__, { width: 320, height: 230, title: 'Labeled frames' })
figma.ui.postMessage({ type: 'ready', label: initial })
figma.ui.onmessage = async (message) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'create') await createLabels(message.text, message.count)
  if (message.type === 'close') figma.closePlugin('Closed')
}
