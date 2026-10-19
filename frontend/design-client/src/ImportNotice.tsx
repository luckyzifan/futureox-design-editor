export function importWarningText(message: string): string {
  if (message.includes('fonts without embedded resources')) return '文件未嵌入所用字体，已使用内置字体；可在文字面板导入并匹配字体。'
  if (message.includes('unsupported source fields')) return '部分 Sketch 专有属性暂不支持完整编辑，建议保留原始 .sketch 文件。'
  if (message.includes('operand boolean')) return '布尔组合已转换为本地矢量结构，原始设置已保留。'
  if (message.includes('zero-sized layers')) return '零宽或零高路径已保留，编辑时显示最小选择框。'
  if (message.includes('text-vertical-alignment-not-modeled')) return '部分文字的垂直对齐可能与 Sketch 不同。'
  if (message.includes('textbehaviour-fixed-size-not-modeled')) return '部分固定文字框的换行和尺寸可能与 Sketch 不同。'
  if (message.includes('radial') && message.includes('ellipse')) return '部分椭圆径向渐变仍为近似显示，原始渐变参数已保留。'
  return message
}

/** Compatibility information never captures the rest of the editor's input. */
export function ImportNotice({ warnings, onClose }: { warnings: string[]; onClose(): void }) {
  return <aside className="import-notice" aria-label="导入兼容提示">
    <div className="import-notice-summary">
      <span role="status">已导入，可以继续编辑 · {warnings.length} 项兼容提示</span>
      <button type="button" aria-label="关闭导入提示" onClick={onClose}>×</button>
    </div>
    <details>
      <summary>查看兼容说明</summary>
      <ul>{warnings.map(message => <li key={message}>{importWarningText(message)}</li>)}</ul>
    </details>
  </aside>
}
