import { useState, useSyncExternalStore } from 'react'
import { localDiagnostics } from './local-diagnostics'

export function LocalDiagnosticsPanel() {
  const {records, dropped, status} = useSyncExternalStore(localDiagnostics.subscribe, localDiagnostics.snapshot)
  const [exportStatus, setExportStatus] = useState('')
  const exportLogs = () => {
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob([localDiagnostics.exportJSON()], {type:'application/json'}))
      const link = document.createElement('a'); link.href = url; link.download = 'local-errors.json'; link.click()
      setExportStatus('已请求浏览器或桌面端下载本地日志。')
    } catch { setExportStatus('导出不可用，请稍后重试。') }
    finally { if (url) { const released = url; setTimeout(() => URL.revokeObjectURL(released), 1000) } }
  }
  return <section aria-label="本地错误日志">
    <h3>本地错误日志</h3>
    <p>Web 与桌面端共用错误分类与查看方式。最多保留 256 条，仅保存在当前浏览器或桌面配置中，不自动上传。</p>
    <p className="settings-help">只记录时间、级别、组件、错误分类和本地诊断请求编号，不记录文档内容、原始错误文本、调用栈、令牌或文件路径。请求编号用于关联本地诊断，不是服务端请求编号。</p>
    <p role="status">{status === 'saved' ? '日志已保存到本地。' : status === 'loading' ? '正在读取本地日志。' : status === 'pending' ? '日志等待写入本地。' : '本地存储不可用，当前日志仅在本次会话保留。'} 已保留 {records.length} 条，累计淘汰 {dropped} 条。</p>
    <p className="settings-help">错误以短延迟批量写入，突然崩溃可能丢失最后一批；清除网站数据或桌面配置会删除对应记录。多个 Web 标签页采用最后写入者的快照，不保证合并。</p>
    <button type="button" onClick={exportLogs}>导出本地错误 JSON</button>
    <p role="status">{exportStatus}</p>
    <ol style={{maxHeight:260, overflow:'auto', paddingLeft:24}}>{records.slice().reverse().map((row,index) => <li key={`${row.requestId}-${index}`}>
      <time>{new Date(row.time).toLocaleString()}</time> · {row.severity} · {row.component} · {row.code}<br />{row.requestId}
    </li>)}</ol>
    {!records.length && <p>尚无已记录错误。</p>}
  </section>
}
