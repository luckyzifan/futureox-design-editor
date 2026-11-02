/** Local editing API chrome. This is not a Figma plugin host. */
const phrases = {
  open: ['设计 API', 'Design API'],
  title: ['设计 API 与 MCP', 'Design API and MCP'],
  close: ['关闭', 'Close'],
  closeLabel: ['关闭设计 API 与 MCP', 'Close Design API and MCP'],
  loading: ['正在载入设计 API 与 MCP…', 'Loading Design API and MCP…'],
  loadFailed: ['面板载入失败：', 'Could not load the panel: '],
  retry: ['重试', 'Retry'],
  webOnly: ['Web 版可使用下方编辑 API、检查和导出；本地外部 MCP 连接需要 Electron 桌面版。', 'The web app can use the editing API, checks and export below. A local MCP connection needs the Electron app.'],
} as const
const catalog = (column: 0 | 1) => Object.fromEntries(Object.entries(phrases).map(([key, pair]) => [key, pair[column]])) as { readonly [K in keyof typeof phrases]: string }
export const automationText = { 'zh-CN': catalog(0), en: catalog(1) } as const
