;(async function () {
  const before = await figma.clientStorage.getAsync('runs')
  const runs = before && typeof before.n === 'number' ? before.n : 0
  await figma.clientStorage.setAsync('runs', { n: runs + 1 })
  const keys = await figma.clientStorage.keysAsync()
  if (keys.indexOf('runs') < 0) throw new Error('missing storage key')
  await figma.clientStorage.setAsync('temp', 'x')
  await figma.clientStorage.deleteAsync('temp')
  if (await figma.clientStorage.getAsync('temp') !== undefined) throw new Error('storage delete')

  const frame = figma.createFrame()
  frame.name = 'Kit'
  frame.resize(160, 120)
  frame.layoutMode = 'VERTICAL'
  frame.primaryAxisAlignItems = 'CENTER'
  frame.counterAxisAlignItems = 'MIN'
  frame.itemSpacing = 8
  frame.layoutSizingHorizontal = 'HUG'
  frame.layoutSizingVertical = 'FIXED'

  const component = figma.createComponent()
  component.name = 'Swatch'
  component.resize(48, 48)
  component.fills = [{
    type: 'GRADIENT_LINEAR',
    gradientStops: [
      { position: 0, color: { r: 0.204, g: 0.349, b: 0.831 } },
      { position: 1, color: { r: 1, g: 1, b: 1 } },
    ],
  }]
  const instance = component.createInstance()
  instance.name = 'Swatch instance'
  frame.appendChild(instance)

  const child = figma.createRectangle()
  child.name = 'Loose'
  child.resize(20, 20)
  const group = figma.group([child], figma.currentPage)
  const lifted = figma.ungroup(group)
  if (!lifted || lifted.length !== 1) throw new Error('ungroup')
  lifted[0].name = 'Lifted'

  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3, 8, 2, 0, 0, 0, 0, 0, 0, 0])
  const image = figma.createImage(png)
  const again = figma.getImageByHash(image.hash)
  if (!again || again.hash !== image.hash) throw new Error('hash')
  const photo = figma.createRectangle()
  photo.name = 'Photo'
  photo.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }]

  const radial = figma.createRectangle()
  radial.name = 'Radial'
  radial.fills = [{
    type: 'GRADIENT_RADIAL',
    gradientStops: [
      { position: 0, color: { r: 0.2, g: 0.35, b: 0.83 } },
      { position: 1, color: { r: 1, g: 1, b: 1 } },
    ],
  }]
  var kept = false
  try { radial.fills = [{ type: 'VIDEO' }] } catch (error) { kept = true }
  if (!kept) throw new Error('video paint accepted')
  if (radial.fills[0].type !== 'GRADIENT_RADIAL') throw new Error('paint dropped')
  figma.notify('kit ready')
})()
