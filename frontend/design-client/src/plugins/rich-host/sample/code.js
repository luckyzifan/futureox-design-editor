const frame = figma.createFrame()
frame.name = 'Plugin sample'
frame.resize(320, 140)
frame.x = 72
frame.y = 64
frame.fills = [{ type: 'SOLID', color: { r: 52 / 255, g: 89 / 255, b: 212 / 255 } }]
const text = figma.createText()
text.characters = 'Futureox'
text.fontSize = 28
text.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]
frame.appendChild(text)
text.x = 24
text.y = 48
figma.currentPage.selection = [frame]
figma.notify('Sample plugin created a frame')
figma.closePlugin('created')
