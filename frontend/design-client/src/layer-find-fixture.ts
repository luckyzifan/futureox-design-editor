import { blank, node, uid, type DesignDocument } from './model'

/**
 * Structural stand-in for the Find case in issue 494.
 * This is not the copyrighted file `01有料素材 (Copy).fig` and it does not
 * reproduce that file's layout measurements. The same-named text is the
 * group's child, so a preorder walk lists the Group before the Text.
 * The rectangle sibling does not match the query.
 */
export function topPerformanceFindDocument(): {
  doc: DesignDocument
  pageId: string
  otherPageId: string
  frameId: string
  groupId: string
  textId: string
  otherTextId: string
} {
  const doc = blank('Find fixture')
  const page = doc.pages[0]
  page.name = 'Meher Admin Dashboard Ui Kit Light'
  const frame = node('frame', 0, 0, 1440, 900)
  frame.name = '01_Dashboard'
  const group = node('group', 48, 48, 280, 160)
  group.name = 'Top Performance'
  const text = node('text', 16, 16, 200, 32)
  text.name = 'Top Performance'
  text.text = 'Top Performance'
  const decoy = node('rectangle', 48, 240, 120, 40)
  decoy.name = 'Sidebar'
  group.children = [text.id]
  frame.children = [decoy.id, group.id]
  const other = node('text', 0, 0, 180, 32)
  other.name = 'Top Performance'
  other.text = 'Top Performance'
  const otherPageId = uid()
  doc.nodes[frame.id] = frame
  doc.nodes[group.id] = group
  doc.nodes[text.id] = text
  doc.nodes[decoy.id] = decoy
  doc.nodes[other.id] = other
  page.children = [frame.id]
  doc.pages.push({ ...page, id: otherPageId, name: 'Campaigns', children: [other.id] })
  return {
    doc, pageId: page.id, otherPageId, frameId: frame.id, groupId: group.id, textId: text.id, otherTextId: other.id,
  }
}
