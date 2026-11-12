import { recordLocalError, startLocalDiagnostics } from './local-diagnostics'
import { createRoot } from 'react-dom/client'
import App from './App'
import { desktopBridge } from './desktop'
import { GpuMemoryPanel } from './GpuMemoryPanel'
import { RenderProfilePanel } from './RenderProfilePanel'
import './styles.css'
import './chrome-polish.css'
startLocalDiagnostics()
createRoot(document.getElementById('root')!, {
  onUncaughtError: error => { recordLocalError('react', error, 'REACT_ERROR'); console.error(error) },
  onCaughtError: error => { recordLocalError('react', error, 'REACT_ERROR'); console.error(error) },
  onRecoverableError: error => { recordLocalError('react', error, 'REACT_ERROR'); console.error(error) },
}).render(desktopBridge() ? (
  <>
    <App />
    <GpuMemoryPanel />
    <RenderProfilePanel />
  </>
) : <main>Futureox Design 桌面渲染器 · 请通过 Electron 启动。</main>)
