// Return the startup promise as the script result so the host waits for the labels.
;(async function () {
const accent = { r: 52 / 255, g: 89 / 255, b: 212 / 255 }
const ink = { r: 23 / 255, g: 32 / 255, b: 51 / 255 }
const font = { family: 'Noto Sans SC', style: 'Regular' }

async function createLabels(label, count) {
  // The bundled Noto Sans SC face resolves everywhere, so the sample runs on a
  // clean install instead of rejecting on machines without Inter installed.
  await figma.loadFontAsync(font)
  const page = figma.currentPage
  const created = []
  const total = Math.max(1, Math.min(20, Number(count) || 1))
  for (let index = 0; index < total; index += 1) {
    const x = 32 + (index % 5) * 180
    const y = 32 + Math.floor(index / 5) * 120
    const rect = figma.createRectangle()
    rect.name = String(label || 'Label')
    rect.resize(160, 96)
    rect.x = x
    rect.y = y
    rect.fills = [{ type: 'SOLID', color: accent }]
    const text = figma.createText()
    text.fontName = font
    text.characters = String(label || 'Label')
    text.fontSize = 16
    text.x = x + 12
    text.y = y + 36
    text.fills = [{ type: 'SOLID', color: ink }]
    created.push(rect, text)
  }
  page.selection = created
  figma.viewport.scrollAndZoomIntoView(created)
  return created
}

figma.showUI(__html__, { width: 300, height: 220, title: 'Labeled rectangles' })

figma.ui.onmessage = async (message) => {
  if (!message || message.type === 'cancel') figma.closePlugin('Closed')
  if (message.type === 'create') {
    const created = await createLabels(message.label, message.count)
    figma.notify('Created ' + created.length / 2 + ' labels')
  }
}

if (figma.command === 'run') {
  const created = await createLabels('Label', 3)
  figma.notify('Created ' + created.length / 2 + ' labels')
}
})()
