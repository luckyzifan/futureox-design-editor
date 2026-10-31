/** Presentation only. Never translate authored names, paths, command IDs or diagnostic codes. */
const menuLabels = {
  'File': '文件', 'New': '新建', 'New Page': '新建页面', 'Open…': '打开…', 'Open Pending Finder File': '打开等待中的 Finder 文件',
  'Clear Recent': '清除最近记录', 'Save': '保存', 'Save As…': '另存为…', 'Recover unsaved design…': '恢复未保存的设计…',
  'Edit': '编辑', 'Settings… / 设置': '设置…', 'Undo': '撤销', 'Redo': '重做', 'Cut': '剪切', 'Copy': '复制',
  'Copy as PNG': '复制为 PNG', 'Copy Properties': '复制属性', 'Paste Properties': '粘贴属性', 'Copy as SVG': '复制为 SVG',
  'Paste': '粘贴', 'Paste to Replace': '粘贴并替换', 'Paste Over Selection': '粘贴到所选图层上方', 'Paste in Place': '原位粘贴',
  'Duplicate': '创建副本', 'Select Matching': '选择相似图层', 'Select Inverse': '反向选择', 'Select All': '全选',
  'Object': '对象', 'Group': '编组', 'Ungroup': '取消编组', 'View': '视图', 'Capture GUI test screenshot': '截取 GUI 测试截图',
  'Center Selection': '居中显示所选图层', 'Actual Size': '实际大小', 'Zoom In': '放大', 'Zoom Out': '缩小',
  'Automation': '自动化', 'Enable local automation (read-only)…': '启用本机自动化（只读）…',
  'Enable local automation (read and edit)…': '启用本机自动化（读写）…', 'Disable local automation': '停用本机自动化',
}
const roles = {
  recentDocuments: ['最近打开', 'Open Recent'], close: ['关闭窗口', 'Close Window'],
  togglefullscreen: ['切换全屏', 'Toggle Full Screen'], windowMenu: ['窗口', 'Window'],
}
export function localizeNativeMenu(template, locale) {
  if (locale !== 'zh-CN' && locale !== 'en') throw new TypeError('Unsupported interface locale')
  return template.map(item => {
    const copy = { ...item }
    if (typeof item.label === 'string' && Object.hasOwn(menuLabels, item.label))
      copy.label = locale === 'zh-CN' ? menuLabels[item.label] : item.label === 'Settings… / 设置' ? 'Settings…' : item.label
    else if (!item.label && Object.hasOwn(roles, item.role)) copy.label = roles[item.role][locale === 'zh-CN' ? 0 : 1]
    if (Array.isArray(item.submenu)) copy.submenu = localizeNativeMenu(item.submenu, locale)
    return copy
  })
}
const en = {
  designFileFilter: 'futureox-desgin design', sketchFileFilter: 'Sketch native document', exportFileFilter: 'Design export',
  openDesign: 'Open futureox-desgin design', saveDesign: 'Save futureox-desgin design',
  chooseProjectFolder: 'Choose a local futureox-desgin project folder', inspectSketch: 'Inspect native Sketch document (editing unavailable)',
  replaceTitle: 'Replace existing futureox-desgin file?', replaceMessage: name => `Replace “${name}”?`,
  replaceDetail: path => `The .fd extension was added. The existing file at ${path} will be replaced.`, cancel: 'Cancel', replace: 'Replace',
  recoverTitle: 'Recover unsaved design?', recoverMessage: name => `Recover “${name}” as an unsaved copy?`,
  recoverDetail: 'The original file will not be overwritten. Use Save As to choose where to keep the recovered design.',
  recoverCopy: 'Recover copy', nextSnapshot: 'Next snapshot',
  recoveryUnreadable: 'Recovery files were found but could not be read. They have been preserved.',
  recoveryWarning: count => `${count} recovery file(s) could not be read and have been preserved. Other snapshots are still available.\n\n`,
  workspaceNotChanged: 'Workspace was not changed', keepWorkspace: 'Keep current workspace',
  unresponsiveTitle: 'Editor is not responding', closeUnsavedMessage: 'Close without saving the current canvas?',
  closeUnsavedDetail: 'The last recovery snapshot is kept, but changes after that snapshot may be lost.',
  keepOpen: 'Keep open', closeWithoutSaving: 'Close without saving', exportDesign: 'Export design',
  backendUnavailableTitle: 'Local backend unavailable',
  backendUnavailableMessage: 'The local Rust backend could not start. File operations and recovery are unavailable.',
  backendUnavailableDetail: 'Build or reinstall the desktop bundle before editing important work.',
  canvasOnlyExport: 'This export format is not supported here. Use Save or Save As for .fd documents.',
  exportUnknownSize: 'The export has an unknown size or exceeds the 64 MiB desktop limit.',
  exportInterrupted: 'The export was interrupted and was not completed. Please export again.',
  exportTooLarge: 'The export exceeds the 64 MiB desktop limit.',
  tooManyPendingFiles: 'At most 16 design files can wait to open. Process the current files before opening more.',
}
const zhCN = {
  designFileFilter: 'futureox-desgin 设计文件', sketchFileFilter: 'Sketch 原生文档', exportFileFilter: '设计导出文件',
  openDesign: '打开 futureox-desgin 设计', saveDesign: '保存 futureox-desgin 设计',
  chooseProjectFolder: '选择本机 futureox-desgin 项目文件夹', inspectSketch: '查看原生 Sketch 文档（暂不支持编辑）',
  replaceTitle: '替换现有的 futureox-desgin 文件？', replaceMessage: name => `替换“${name}”？`,
  replaceDetail: path => `已补充 .fd 扩展名。现有文件 ${path} 将被替换。`, cancel: '取消', replace: '替换',
  recoverTitle: '恢复未保存的设计？', recoverMessage: name => `将“${name}”恢复为未保存的副本？`,
  recoverDetail: '不会覆盖原文件。请使用“另存为”选择恢复设计的保存位置。',
  recoverCopy: '恢复副本', nextSnapshot: '下一个快照',
  recoveryUnreadable: '找到了恢复文件，但无法读取。文件已保留。',
  recoveryWarning: count => `${count} 个恢复文件无法读取，已保留。仍可使用其他快照。\n\n`,
  workspaceNotChanged: '工作区未切换', keepWorkspace: '保留当前工作区',
  unresponsiveTitle: '编辑器未响应', closeUnsavedMessage: '不保存当前画布并关闭？',
  closeUnsavedDetail: '将保留最近的恢复快照，但此快照之后的修改可能丢失。',
  keepOpen: '保持打开', closeWithoutSaving: '不保存并关闭', exportDesign: '导出设计',
  backendUnavailableTitle: '本机后端不可用',
  backendUnavailableMessage: '本机 Rust 后端无法启动。文件操作和恢复功能不可用。',
  backendUnavailableDetail: '编辑重要文件前，请先构建或重新安装桌面应用包。',
  canvasOnlyExport: '此处不支持该导出格式。请使用“保存”或“另存为”保存 .fd 文档。',
  exportUnknownSize: '导出大小未知，或超过桌面端 64 MiB 的限制。',
  exportInterrupted: '导出中断，尚未完成。请重新导出。',
  exportTooLarge: '导出超过桌面端 64 MiB 的限制。',
  tooManyPendingFiles: '最多同时等待打开 16 个设计文件，请先处理当前文件后再打开。',
}
export const desktopText = Object.freeze({ en: Object.freeze(en), 'zh-CN': Object.freeze(zhCN) })
