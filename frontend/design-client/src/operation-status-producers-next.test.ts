import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { operationStatusText, type OperationStatus } from './operation-status-messages'
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const commands = readFileSync(new URL('./editor-commands.ts', import.meta.url), 'utf8')
const fonts = readFileSync(new URL('./font-management.ts', import.meta.url), 'utf8')
// Exact 21-producer allowlist. These checks are wiring contracts, not twenty
// independently mounted workflows or twenty claimed Electron GUI operations.
const sources: Record<OperationStatus['key'], string> = {
 exportPreviewGenerating: app, exportFileReady: app, sketchExportGenerating: app, sketchExportReadyCompatibility: app,
 openBlockedActiveOperation: app, imageImportBlockedActiveOperation: app, singleDesignFileRequired: app, importedGroupsAppended: app, designImportComplete: app,
 imageImportFailed: app, saveFailedCanvasRetained: app, kernelStartupFailed: app, recoveryFailedAutosavePaused: app, closeFailedDocumentRetained: app, workspaceSwitchFailedDocumentRetained: app,
 finishOrCancelDrag: commands, propertiesCopied: commands, toolUnavailable: commands, unknownToolCommand: commands, sharedFontStyleNeedsLocalOverride: fonts,
 instanceDetachHint: readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8'),
}
test.each(Object.keys(sources) as OperationStatus['key'][])('explicit producer %s localizes only tagged display; raw diagnostic/history APIs remain raw', key => {
 expect(sources[key]).toContain(`'${key}'`)
 const raw = '作者原文 <>& 已复制属性', error = '原错误 /file:文件 <>&'
 const status = { key, error, count: 3, commandId: 'set-tool-not-real' } as OperationStatus
 const tagged = { raw, status }
 expect(operationStatusText(raw, tagged, 'zh-CN')).toBe(raw)
 expect(operationStatusText(raw, undefined, 'en')).toBe(raw)
 const translated = operationStatusText(raw, tagged, 'en')
 if (key === 'toolUnavailable') expect(translated).toBe(raw) // Unknown registry entry is not invented.
 else expect(translated).not.toBe(raw)
 if (key.endsWith('Failed') || ['saveFailedCanvasRetained','kernelStartupFailed','recoveryFailedAutosavePaused','closeFailedDocumentRetained','workspaceSwitchFailedDocumentRetained'].includes(key)) expect(translated).toContain(error)
})
test('raw failure/author boundaries stay explicit and errors are never globally translated', () => {
 expect(app).toContain('if (error instanceof StaleImageImport) editor.notify(error.message)')
 expect(app).toContain('setStartupError(`设计内核载入失败：${String(e)}`)')
 expect(fonts).toContain('return emptyResult(editor.state.message)')
 expect(commands).toContain('未知工具命令 ${command}')
 expect(app).toContain('{operationStatusText(s.message, s.messagePresentation, locale)}')
})
