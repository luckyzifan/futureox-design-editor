import { recordLocalError, startLocalDiagnostics } from './local-diagnostics'
import { createRoot } from 'react-dom/client'
import App from './App'
import { GpuMemoryPanel } from './GpuMemoryPanel'
import { RenderProfilePanel } from './RenderProfilePanel'
import './styles.css'
import './chrome-polish.css'
startLocalDiagnostics()
createRoot(document.getElementById('root')!, {
  onUncaughtError: error => { recordLocalError('react', error, 'REACT_ERROR'); console.error(error) },
  onCaughtError: error => { recordLocalError('react', error, 'REACT_ERROR'); console.error(error) },
  onRecoverableError: error => { recordLocalError('react', error, 'REACT_ERROR'); console.error(error) },
}).render(
  <>
    <App />
    <GpuMemoryPanel />
    <RenderProfilePanel />
  </>,
)
