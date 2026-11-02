/** Presentation-only activity copy. Not a document name, history label, or render status. */
export type ActivityKind = 'boot' | 'open' | 'import'
export type ActivityHost = 'source' | 'desktop' | 'web'
export type ActivityLocale = 'zh-CN' | 'en'

const zhCN = {
  boot: '正在准备设计内核…',
  openCanvas: '正在打开画板…',
  localFile: '正在处理本机设计文件…',
  savingOpen: '正在保存并打开设计…',
  importing: '正在导入设计…',
  emptyTitle: '空白画布',
  emptyBody: '选择工具，画出第一个图层。',
} as const
const en: Record<keyof typeof zhCN, string> = {
  boot: 'Preparing the design kernel…',
  openCanvas: 'Opening the canvas…',
  localFile: 'Working on the local design file…',
  savingOpen: 'Saving and opening the design…',
  importing: 'Importing the design…',
  emptyTitle: 'Blank canvas',
  emptyBody: 'Choose a tool and draw the first layer.',
}
export const activityText = { 'zh-CN': zhCN, en } as const

export function activityKind(input: { ready: boolean; switching: boolean; transitioning: boolean; importing: boolean }): ActivityKind {
  if (input.importing) return 'import'
  if (!input.ready && !input.switching && !input.transitioning) return 'boot'
  return 'open'
}

export function activityLabel(kind: ActivityKind, locale: ActivityLocale, host: ActivityHost, sourceNotice?: string) {
  const text = activityText[locale]
  if (kind === 'boot') return text.boot
  if (host === 'source') return sourceNotice || text.openCanvas
  if (kind === 'import') return text.importing
  if (host === 'desktop') return text.localFile
  return text.savingOpen
}
