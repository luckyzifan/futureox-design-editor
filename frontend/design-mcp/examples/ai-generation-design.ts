import { paint } from '../../design-client/src/model'
import type { Json } from './ai-generation-client'

/** Original design authored for this task by the assistant, not a copied fixture. */
export function composeStudio(firstPage: string) {
  const pages = [firstPage, '41000000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000003']
  const operations: Json[] = [], refs: Record<string, string> = {}, roots: string[] = [], assets: Json[] = []
  let sequence = 0
  const id = () => `42000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
  const color = { bg: '#f5f4f0', paper: '#ffffff', ink: '#22251f', muted: '#73776e', line: '#e5e7df', dark: '#25352b', green: '#dbeabb', accent: '#d9f17d', peach: '#f4d7c7' }
  const shape = (parentId: string, name: string, x: number, y: number, width: number, height: number, fill: string, radius = 0, kind = 'frame') => {
    const nodeId = id()
    operations.push({ method: 'node.create', params: { id: nodeId, parentId, kind, x, y, width, height, patch: { name, fills: [paint(fill)], radii: [radius, radius, radius, radius] } } })
    return nodeId
  }
  const text = (parentId: string, value: string, x: number, y: number, width: number, size = 16, fill = color.ink, weight = 400, height = 32) => {
    const nodeId = shape(parentId, value.replaceAll('\n', ' ').slice(0, 80), x, y, width, height, fill, 0, 'text')
    operations.push({ method: 'text.set', params: { ids: [nodeId], text: value, fontSize: size, textStyle: { fontId: 'forma-noto', weight, lineHeight: 1.3, wrap: true } } })
    return nodeId
  }
  const line = (parent: string, x: number, y: number, width: number) => shape(parent, 'Divider', x, y, width, 1, color.line, 0, 'rectangle')
  const pill = (parent: string, label: string, x: number, y: number, width: number, fill = color.green, foreground = color.dark) => {
    const p = shape(parent, `${label} badge`, x, y, width, 30, fill, 15)
    text(p, label, 12, 4, width - 20, 12, foreground, 500, 24)
    return p
  }
  const button = (parent: string, label: string, x: number, y: number, width: number, fill = color.dark, foreground = '#ffffff') => {
    const p = shape(parent, `${label} button`, x, y, width, 46, fill, 10)
    const labelId = text(p, label, 18, 11, width - 30, 14, foreground, 600, 25)
    return { id: p, label: labelId }
  }
  const mark = (parent: string, x: number, y: number, scale = 1) => {
    const m = shape(parent, 'Forma original geometric mark', x, y, 32 * scale, 32 * scale, color.accent, 9 * scale)
    shape(m, 'Mark vertical', 8 * scale, 8 * scale, 5 * scale, 17 * scale, color.dark, 1 * scale, 'rectangle')
    shape(m, 'Mark upper', 8 * scale, 8 * scale, 17 * scale, 5 * scale, color.dark, 1 * scale, 'rectangle')
    shape(m, 'Mark middle', 8 * scale, 15 * scale, 13 * scale, 4 * scale, color.dark, 1 * scale, 'rectangle')
    return m
  }
  const shell = (pageId: string, name: string, index: number) => {
    const root = shape(pageId, `${name} / Desktop 1440 x 1000`, 0, 0, 1440, 1000, color.bg)
    roots.push(root)
    const sidebar = shape(root, 'Primary navigation', 0, 0, 232, 1000, color.paper)
    const logo = mark(sidebar, 26, 30)
    if (index === 0) assets.push({ name: 'forma-mark', pageId, nodeId: logo })
    text(sidebar, 'forma', 70, 27, 136, 27, color.ink, 700, 42)
    text(sidebar, 'LOCAL DESIGN STUDIO', 26, 89, 188, 11, color.muted, 600, 25)
    for (const [i, label] of ['Workspace', 'Files', 'Settings'].entries()) {
      if (i === index) shape(sidebar, `${label} selected`, 16, 141 + i * 54, 200, 44, color.green, 10)
      shape(sidebar, `${label} navigation icon`, 30, 156 + i * 54, 12, 12, i === index ? color.dark : '#b7beb1', i === 1 ? 2 : 6, 'rectangle')
      text(sidebar, label, 56, 151 + i * 54, 143, 15, i === index ? color.dark : color.muted, i === index ? 600 : 400, 30)
    }
    line(sidebar, 24, 329, 184)
    text(sidebar, 'YOUR COLLECTIONS', 26, 354, 180, 11, color.muted, 600, 25)
    for (const [i, label] of ['Product design', 'Brand explorations', 'Personal drafts'].entries()) {
      shape(sidebar, `${label} collection marker`, 30, 403 + i * 43, 7, 7, ['#819b71', '#d49f82', '#9da5b2'][i], 3, 'rectangle')
      text(sidebar, label, 50, 392 + i * 43, 165, 13, color.muted, 400, 32)
    }
    const local = shape(sidebar, 'Local storage summary', 18, 795, 196, 112, '#f3f5ee', 12)
    text(local, 'On this device', 16, 14, 170, 13, color.ink, 600, 28)
    text(local, '2.4 GB of 10 GB', 16, 44, 170, 12, color.muted, 400, 24)
    shape(local, 'Storage capacity track', 16, 81, 164, 5, '#e0e6d7', 2, 'rectangle')
    shape(local, 'Storage capacity used', 16, 81, 40, 5, '#7b9560', 2, 'rectangle')
    shape(sidebar, 'Profile avatar', 26, 938, 30, 30, color.peach, 15)
    text(sidebar, 'Alex Morgan', 68, 938, 146, 13, color.ink, 500, 28)
    text(root, 'STUDIO / ' + name.toUpperCase(), 280, 31, 600, 11, color.muted, 600, 26)
    pill(root, 'LOCAL MODE', 1260, 27, 132, '#e7ecdf', '#5a7053')
    line(root, 280, 78, 1112)
    return root
  }
  operations.push({ method: 'page.update', params: { id: pages[0], patch: { name: 'Workspace', background: '#e7e9e1' } } })
  const workspace = shell(pages[0], 'Workspace', 0)
  refs.workspace = workspace
  refs.welcome = text(workspace, 'A good place to make things.', 280, 112, 900, 38, color.ink, 600, 62)
  text(workspace, 'Your files, ideas, and next steps. All right here.', 282, 178, 850, 16, color.muted, 400, 32)
  refs.newFile = button(workspace, '+  New design', 1222, 117, 170).id
  const welcome = shape(workspace, 'Continue working feature', 280, 242, 1112, 220, color.dark, 18)
  pill(welcome, 'PICK UP WHERE YOU LEFT OFF', 28, 25, 253, '#425842', '#e0edcf')
  text(welcome, 'Make room for your next idea.', 28, 75, 770, 29, '#ffffff', 600, 50)
  text(welcome, 'Product dashboard  /  4 pages  /  Edited 12 minutes ago', 30, 132, 750, 14, '#c1ceb9', 400, 32)
  button(welcome, 'Continue editing', 28, 170, 190, color.accent, color.dark)
  // Original editable geometric artwork, rather than stock/screenshot imagery.
  const abstract = shape(welcome, 'Original paper stack artwork', 870, 27, 208, 168, '#425842', 14)
  shape(abstract, 'Paper back', 61, 23, 118, 121, '#8fa781', 12)
  shape(abstract, 'Paper front', 30, 44, 118, 104, color.accent, 12)
  shape(abstract, 'Paper accent circle', 51, 65, 33, 33, color.dark, 16, 'ellipse')
  shape(abstract, 'Paper accent line', 51, 112, 74, 8, '#718e4d', 4, 'rectangle')
  assets.push({ name: 'paper-stack', pageId: pages[0], nodeId: abstract })
  text(workspace, 'Recent files', 280, 501, 700, 23, color.ink, 600, 42)
  refs.viewAll = text(workspace, 'View all files  →', 1230, 509, 165, 14, color.muted, 500, 30)
  const cards = shape(workspace, 'Recent file cards', 280, 558, 1112, 273, color.bg)
  operations.push({ method: 'layout.set', params: { ids: [cards], layout: { mode: 'horizontal', gap: 20, padding: [0, 0, 0, 0] } } })
  for (const [i, file] of [['Product dashboard', 'Product design', '#dde5d3'], ['Identity explorations', 'Brand explorations', '#eadad0'], ['Reading companion', 'Personal drafts', '#dfe3eb']].entries()) {
    const card = shape(cards, `${file[0]} file card`, i * 377, 0, 357, 273, color.paper, 14)
    const thumb = shape(card, `${file[0]} editable thumbnail`, 14, 14, 329, 159, file[2], 10)
    if (i === 0) {
      const mini = shape(thumb, 'Dashboard miniature', 55, 25, 220, 115, '#ffffff', 7)
      shape(mini, 'Mini sidebar', 0, 0, 44, 115, '#5b7456', 7)
      for (let k = 0; k < 3; k++) shape(mini, `Mini card ${k + 1}`, 56 + k * 50, 19, 42, 27, '#e3eadc', 4)
      for (let k = 0; k < 5; k++) shape(mini, `Mini bar ${k + 1}`, 59 + k * 28, 88 - k * 8, 16, 15 + k * 8, '#9cb182', 3, 'rectangle')
    } else if (i === 1) {
      shape(thumb, 'Brand circle', 85, 31, 94, 94, '#3a4a38', 47, 'ellipse')
      shape(thumb, 'Brand square', 157, 57, 75, 75, '#c9936f', 13)
      text(thumb, 'f', 120, 42, 60, 48, '#f9f4eb', 700, 70)
    } else {
      const book = shape(thumb, 'Reading app miniature', 104, 18, 121, 128, '#ffffff', 9)
      shape(book, 'Book cover', 14, 13, 93, 66, '#a8b7cc', 5)
      for (let k = 0; k < 3; k++) shape(book, `Book text line ${k + 1}`, 14, 91 + k * 9, 93 - k * 15, 3, '#a8b7cc', 1, 'rectangle')
    }
    text(card, file[0], 19, 190, 320, 16, color.ink, 600, 32)
    text(card, file[1], 19, 229, 230, 12, color.muted, 400, 26)
    text(card, ['12m ago', '2h ago', 'Yesterday'][i], 265, 229, 80, 11, color.muted, 400, 24)
  }
  const note = shape(workspace, 'Local-first information', 280, 863, 1112, 86, '#e8ecdf', 12)
  text(note, 'Made here. Kept here.', 22, 14, 970, 15, color.dark, 600, 30)
  text(note, 'Your design files stay on this device. Export a copy whenever you need it.', 22, 44, 1050, 13, '#61735a', 400, 28)

  operations.push({ method: 'page.create', params: { id: pages[1], name: 'Files', makeCurrent: false } })
  const files = shell(pages[1], 'Files', 1); refs.files = files
  text(files, 'Your files', 280, 112, 850, 38, color.ink, 600, 62)
  text(files, 'A little order for your work in progress.', 282, 178, 900, 16, color.muted, 400, 32)
  button(files, '+  New design', 1222, 117, 170)
  const search = shape(files, 'Search files field', 280, 246, 620, 48, color.paper, 10)
  text(search, 'Search by file name or collection', 18, 11, 578, 14, '#969c90', 400, 28)
  button(files, 'All collections', 920, 247, 215, '#e8ecdf', color.dark)
  button(files, 'Last edited  ↓', 1155, 247, 237, '#e8ecdf', color.dark)
  const table = shape(files, 'Local files list', 280, 326, 1112, 499, color.paper, 16)
  text(table, 'NAME', 28, 23, 480, 11, color.muted, 600, 25)
  text(table, 'COLLECTION', 527, 23, 270, 11, color.muted, 600, 25)
  text(table, 'LAST EDITED', 810, 23, 175, 11, color.muted, 600, 25)
  text(table, 'SIZE', 1003, 23, 90, 11, color.muted, 600, 25)
  const rows = [
    ['Product dashboard', '4 pages', 'Product design', '12 minutes ago', '8.4 MB'],
    ['Identity explorations', '8 pages', 'Brand explorations', '2 hours ago', '12.1 MB'],
    ['Reading companion', '6 pages', 'Personal drafts', 'Yesterday', '6.8 MB'],
    ['Checkout improvements', '3 pages', 'Product design', 'Oct 16, 2026', '4.2 MB'],
    ['Field notes', '2 pages', 'Personal drafts', 'Oct 12, 2026', '2.7 MB'],
  ]
  for (const [i, row] of rows.entries()) {
    const y = 69 + i * 83
    line(table, 24, y, 1064)
    const icon = shape(table, `${row[0]} document icon`, 28, y + 20, 38, 42, i % 2 ? '#eee0d6' : '#e2ead8', 8)
    shape(icon, 'Document glyph', 10, 10, 18, 22, i % 2 ? '#b88d70' : '#8ea779', 3, 'rectangle')
    text(table, row[0], 85, y + 13, 421, 15, color.ink, 500, 29)
    text(table, row[1], 86, y + 43, 421, 11, color.muted, 400, 24)
    text(table, row[2], 527, y + 28, 268, 13, color.muted, 400, 30)
    text(table, row[3], 810, y + 28, 182, 12, color.muted, 400, 28)
    text(table, row[4], 1003, y + 28, 98, 12, color.muted, 400, 28)
  }
  text(files, '5 files  ·  Stored locally on this device', 282, 845, 850, 12, color.muted, 400, 28)
  refs.importButton = button(files, 'Import a design file', 280, 902, 235, '#e4e9dc', color.dark).id
  text(files, 'Supports native .fd files', 537, 915, 700, 12, color.muted, 400, 26)

  operations.push({ method: 'page.create', params: { id: pages[2], name: 'Settings', makeCurrent: false } })
  const settings = shell(pages[2], 'Settings', 2); refs.settings = settings
  text(settings, 'Make yourself at home.', 280, 112, 1000, 38, color.ink, 600, 62)
  text(settings, 'A few preferences for a calmer, more personal workspace.', 282, 178, 1050, 16, color.muted, 400, 32)
  const general = shape(settings, 'Workspace preferences', 280, 245, 708, 635, color.paper, 16)
  text(general, 'Workspace', 28, 26, 640, 23, color.ink, 600, 40)
  text(general, 'The basics for your local studio.', 29, 74, 640, 14, color.muted, 400, 30)
  line(general, 28, 124, 652)
  text(general, 'Workspace name', 28, 150, 630, 13, color.ink, 600, 28)
  const field = shape(general, 'Workspace name input', 28, 188, 652, 50, '#f4f5f0', 9)
  refs.workspaceName = text(field, 'Alex’s local studio', 16, 12, 610, 15, color.ink, 400, 30)
  text(general, 'Appearance', 28, 270, 630, 13, color.ink, 600, 28)
  for (const [i, label] of ['Light', 'Dark', 'System'].entries()) {
    const option = shape(general, `${label} appearance option`, 28 + i * 224, 312, 204, 67, i === 0 ? color.green : '#f4f5f0', 10)
    shape(option, `${label} swatch`, 16, 19, 27, 27, i === 1 ? color.dark : i === 0 ? '#ffffff' : '#aab59e', 7)
    text(option, label, 58, 20, 135, 14, color.ink, i === 0 ? 600 : 400, 30)
  }
  line(general, 28, 412, 652)
  text(general, 'Autosave', 28, 436, 490, 15, color.ink, 600, 30)
  refs.autosaveDescription = text(general, 'Save changes to this device as you work.', 28, 471, 540, 13, color.muted, 400, 30)
  const toggle = shape(general, 'Autosave enabled switch', 625, 447, 54, 30, '#829b65', 15)
  shape(toggle, 'Autosave switch handle', 28, 4, 22, 22, '#ffffff', 11, 'ellipse')
  line(general, 28, 529, 652)
  refs.saveButton = button(general, 'Save preferences', 28, 558, 215).id
  refs.saveHint = text(general, 'Changes apply to this device.', 268, 571, 400, 12, color.muted, 400, 28)
  const storage = shape(settings, 'Local storage and privacy', 1012, 245, 380, 306, color.dark, 16)
  text(storage, 'Your work stays yours.', 24, 26, 330, 23, '#ffffff', 600, 42)
  text(storage, 'Files are stored on this device.\nYou choose what to export and share.', 25, 91, 330, 14, '#cbd7c2', 400, 64)
  text(storage, '2.4 GB', 24, 171, 325, 34, '#ffffff', 600, 55)
  text(storage, 'used of 10 GB available', 26, 227, 320, 12, '#cbd7c2', 400, 28)
  shape(storage, 'Storage usage track', 26, 271, 328, 6, '#4b5c43', 3, 'rectangle')
  shape(storage, 'Storage usage fill', 26, 271, 79, 6, color.accent, 3, 'rectangle')
  const exporting = shape(settings, 'Export preferences summary', 1012, 575, 380, 305, '#e8ecdf', 16)
  text(exporting, 'Ready to take it with you?', 24, 24, 332, 20, color.dark, 600, 40)
  text(exporting, 'Keep an editable native file, or\nexport a preview for your team.', 25, 85, 331, 14, '#61735a', 400, 63)
  pill(exporting, '.fd native', 24, 169, 112, '#ffffff')
  pill(exporting, 'SVG', 146, 169, 69, '#ffffff')
  pill(exporting, 'HTML', 225, 169, 84, '#ffffff')
  refs.exportHint = text(exporting, 'HTML preserves editable structure.\nSome rendering details may differ.', 25, 226, 333, 12, '#61735a', 400, 54)
  text(settings, 'Forma local studio  ·  Your next idea starts here.', 282, 918, 1040, 12, color.muted, 400, 28)
  return { operations, pages, roots, refs, assets, designedNodeCount: sequence }
}
