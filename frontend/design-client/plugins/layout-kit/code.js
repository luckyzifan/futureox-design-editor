// Local fixture for the Electron plugin host. It is not a marketplace plugin.
// Load the folder, or zip this directory, from Plugins. The sandbox runs this
// as a script, so the awaits stay inside one async function.
;(async function () {
const runs = await figma.clientStorage.getAsync('runs')
const nextRun = typeof runs === 'number' && Number.isFinite(runs) ? runs + 1 : 1
await figma.clientStorage.setAsync('runs', nextRun)

const board = figma.createFrame()
board.name = 'Board'
board.resize(220, 140)
board.layoutMode = 'VERTICAL'
board.primaryAxisSizingMode = 'FIXED'
board.counterAxisSizingMode = 'AUTO'
board.itemSpacing = 8
board.paddingTop = 12
board.paddingRight = 12
board.paddingBottom = 12
board.paddingLeft = 12

await figma.loadFontAsync({ family: 'Noto Sans SC', style: 'Regular' })
const title = figma.createText()
title.characters = 'Layout kit'
title.fontSize = 16
board.appendChild(title)

const component = figma.createComponent()
component.name = 'Chip'
component.resize(72, 28)
const label = figma.createText()
label.characters = 'Chip'
component.appendChild(label)
const instance = component.createInstance()
instance.name = 'Chip instance'
board.appendChild(instance)

const left = figma.createRectangle()
const right = figma.createEllipse()
right.x = 48
const pair = figma.group([left, right], figma.currentPage)
pair.name = 'Pair'
const released = figma.ungroup(pair)
if (released.length !== 2) throw new Error('ungroup did not return both children')

// 1×1 gray PNG. The previous fixture's IDAT CRC did not match its bytes
// (expected 0xef9ad787, file had 0xefa2a75b), so the renderer rejected it.
const png = figma.base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mPo6OgAAAM0AZn/URMdAAAAAElFTkSuQmCC')
const image = figma.createImage(png)
const swatch = figma.createRectangle()
swatch.name = 'Swatch'
swatch.resize(24, 24)
swatch.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }]
board.appendChild(swatch)

figma.currentPage.selection = [board]
figma.notify('Layout kit ' + nextRun)
figma.closePlugin('layout-kit')
})()
