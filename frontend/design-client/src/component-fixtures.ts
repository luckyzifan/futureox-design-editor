import { blank, node, paint, uid, defaultLayout, defaultSizing, type DesignDocument } from './model'
import { stampKeys, insertInstance } from './components'
export function componentFixture() {
  const doc = blank('组件与变体验收'),
    page = doc.pages[0]
  const add = (n: ReturnType<typeof node>, parent?: ReturnType<typeof node>) => {
    doc.nodes[n.id] = n
    ;(parent ? parent.children : page.children).push(n.id)
    return n
  }
  const iconA = add(node('frame', 40, 260, 24, 24))
  iconA.name = '星形图标'
  iconA.fills = []
  const star = add(node('star', 0, 0, 24, 24), iconA)
  star.name = '图形'
  star.fills = [paint('#8672cf')]
  iconA.component = { variants: {}, properties: {} }
  stampKeys(doc, iconA.id)
  const iconB = add(node('frame', 105, 260, 24, 24))
  iconB.name = '圆形图标'
  iconB.fills = []
  const circle = add(node('ellipse', 0, 0, 24, 24), iconB)
  circle.name = '图形'
  circle.fills = [paint('#dc8b6e')]
  iconB.component = { variants: {}, properties: {} }
  stampKeys(doc, iconB.id)
  const button = add(node('frame', 40, 65, 200, 54))
  button.name = '按钮'
  button.layout = { ...defaultLayout(), padding: [12, 16, 12, 16], gap: 10, align: 'center' }
  button.sizing = { ...defaultSizing(), width: 'hug', height: 'hug' }
  button.radii = [10, 10, 10, 10]
  button.fills = [paint('#eee8ff')]
  const slot = doc.nodes[insertInstance(doc, iconA.id, page.id, { x: 56, y: 81 }, button.id)]
  slot.name = '图标'
  const label = add(node('text', 0, 0, 80, 27), button)
  label.name = '标题'
  label.text = '继续'
  label.fontSize = 20
  label.fills = [paint('#483866')]
  label.sizing = { ...defaultSizing(), width: 'hug', height: 'hug' }
  button.component = { variants: {}, properties: {} }
  stampKeys(doc, button.id)
  const title = uid(),
    show = uid(),
    icon = uid()
  button.component.properties[title] = {
    name: '标题',
    kind: 'text',
    targetKey: label.componentKey!,
    defaultValue: '继续',
  }
  button.component.properties[show] = {
    name: '显示图标',
    kind: 'boolean',
    targetKey: slot.componentKey!,
    defaultValue: true,
  }
  button.component.properties[icon] = {
    name: '图标',
    kind: 'instance-swap',
    targetKey: slot.componentKey!,
    defaultValue: iconA.id,
  }
  const a = insertInstance(doc, button.id, page.id, { x: 350, y: 65 }),
    b = insertInstance(doc, button.id, page.id, { x: 350, y: 160 })
  return {
    doc,
    ids: {
      button: button.id,
      label: label.id,
      slot: slot.id,
      iconA: iconA.id,
      iconB: iconB.id,
      a,
      b,
      title,
      show,
      icon,
    },
  }
}
export function originNode(doc: DesignDocument, owner: string, key: string) {
  const n = Object.values(doc.nodes).find(
    (n) => n.instanceOrigin?.owner === owner && n.instanceOrigin.key === key,
  )
  if (!n) throw new Error(`Missing instance layer ${key}`)
  return n
}
