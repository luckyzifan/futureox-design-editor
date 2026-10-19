import { createRoot } from 'react-dom/client'
import App from './App'
import { GpuMemoryPanel } from './GpuMemoryPanel'
import { RenderProfilePanel } from './RenderProfilePanel'
import './styles.css'
createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <GpuMemoryPanel />
    <RenderProfilePanel />
  </>,
)
