import type { InterfaceLocale } from './interface-preference'
/** Short Chinese for raw engine memory strings. Other messages stay unchanged. */
export function canvasStatusLabel(message: string): string {
  if (/memory allowance|working-memory|wasm memory|out of memory|DOCUMENT_TOO_LARGE|DOCUMENT_RESOURCE_LIMIT/i.test(message))
    return '内存不足，当前画面已保留'
  return message
}

/** Presentation of the kernel status line. Unknown diagnostics stay verbatim. */
export function presentKernelStatus(message: string, locale: InterfaceLocale = 'zh-CN'): string {
  const labeled = canvasStatusLabel(message)
  if (locale !== 'en') return labeled
  return labeled
    .replaceAll('正在初始化自研渲染内核…', 'Starting the rendering kernel…')
    .replace(/(\d+) 图层/g, (_, count: string) => `${count} ${count === '1' ? 'layer' : 'layers'}`)
    .replaceAll(' · 已降级', ' · degraded')
    .replaceAll(' · 浮点 · ', ' · float · ')
    .replaceAll('sRGB SDR 预览（HDR/浮点文档数据保留）', 'sRGB SDR preview (HDR and float document data kept)')
}
