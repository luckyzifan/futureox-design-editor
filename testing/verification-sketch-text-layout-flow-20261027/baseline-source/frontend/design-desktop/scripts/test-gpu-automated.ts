#!/usr/bin/env bun
// 自动化 GPU 性能测试 - 使用 Playwright 控制 Electron

import { join } from 'path'
import { existsSync, writeFileSync, readFileSync } from 'fs'

const SKETCH_FILE = '/Users/Apple/Downloads/117.sketch'
const PROJECT_ROOT = join(import.meta.dir, '..')
const RESULTS_FILE = join(PROJECT_ROOT, 'GPU-TEST-RESULTS-AUTOMATED.json')

interface GPUMetrics {
  timestamp: string
  sketchFile: string
  fileSize: number
  device: {
    gpu: string
    memory: string
  }
  performance: {
    loadTimeMs?: number
    firstRenderMs?: number
    zoomOperations?: Array<{
      from: number
      to: number
      durationMs: number
    }>
  }
  gpuStats?: {
    textureMemoryMB?: number
    geometryMemoryMB?: number
    drawCalls?: number
    batchGroups?: number
    batchInstances?: number
    solidBufferBytes?: number
  }
  consoleLogs: string[]
}

console.log('='.repeat(70))
console.log('🧪 自动化 GPU 性能测试')
console.log('='.repeat(70))
console.log()

// 检查文件
if (!existsSync(SKETCH_FILE)) {
  console.error(`❌ 找不到测试文件: ${SKETCH_FILE}`)
  process.exit(1)
}

const fileStats = require('fs').statSync(SKETCH_FILE)
console.log(`✅ 测试文件: ${SKETCH_FILE}`)
console.log(`   大小: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`)
console.log()

// 收集设备信息
console.log('📊 设备信息:')
const deviceInfo = { gpu: 'Unknown', memory: 'Unknown' }

try {
  if (process.platform === 'darwin') {
    const { execSync } = require('child_process')
    const gpu = execSync('system_profiler SPDisplaysDataType | grep "Chipset Model"', { encoding: 'utf-8' })
    deviceInfo.gpu = gpu.split(':')[1]?.trim() || 'Unknown'
    const memory = execSync('sysctl hw.memsize', { encoding: 'utf-8' })
    const memoryGB = parseInt(memory.split(':')[1]) / 1024 / 1024 / 1024
    deviceInfo.memory = `${memoryGB.toFixed(0)} GB`
  }
} catch (e) {
  // Ignore
}

console.log(`   GPU: ${deviceInfo.gpu}`)
console.log(`   内存: ${deviceInfo.memory}`)
console.log()

const metrics: GPUMetrics = {
  timestamp: new Date().toISOString(),
  sketchFile: SKETCH_FILE,
  fileSize: fileStats.size,
  device: deviceInfo,
  performance: {},
  consoleLogs: [],
}

// 使用 Electron 的测试模式
console.log('🚀 启动测试...')
console.log()

try {
  // 尝试启动 Electron 并注入测试代码
  const { _electron: electron } = await import('playwright')

  console.log('✅ Playwright 可用，启动自动化测试...')

  const app = await electron.launch({
    args: [join(PROJECT_ROOT, 'dist/main.js')],
    env: {
      ...process.env,
      VITE_DESIGN_IMAGE_MIPS: '1',
      VITE_DESIGN_PATH_BATCHING: '1',
      VITE_DESIGN_GPU_STROKE_COMPUTE: '1',
      ELECTRON_ENABLE_LOGGING: '1',
    },
  })

  const window = await app.firstWindow()

  // 监听控制台日志
  window.on('console', msg => {
    const text = msg.text()
    metrics.consoleLogs.push(text)
    if (text.includes('DESIGN_GPU_BATCH')) {
      console.log(`📋 ${text}`)
    }
  })

  console.log('⏳ 等待应用就绪...')
  await window.waitForLoadState('domcontentloaded')
  await window.waitForTimeout(2000)

  console.log('📂 导入 Sketch 文件...')
  const startLoad = Date.now()

  // 触发文件导入（通过 Electron IPC）
  await window.evaluate(async (filePath) => {
    // @ts-ignore
    const { ipcRenderer } = window.require('electron')
    ipcRenderer.send('open-file', filePath)
  }, SKETCH_FILE)

  // 等待导入完成
  await window.waitForTimeout(5000)
  const loadTime = Date.now() - startLoad
  metrics.performance.loadTimeMs = loadTime
  console.log(`✅ 导入完成: ${loadTime} ms`)

  // 等待首次渲染
  await window.waitForTimeout(1000)
  const firstRenderTime = Date.now() - startLoad
  metrics.performance.firstRenderMs = firstRenderTime
  console.log(`✅ 首次渲染: ${firstRenderTime} ms`)

  // 执行缩放操作
  console.log('🔍 执行缩放测试...')
  const zoomOps = [
    { from: 1, to: 2 },
    { from: 2, to: 4 },
    { from: 4, to: 1 },
    { from: 1, to: 0.5 },
  ]

  metrics.performance.zoomOperations = []

  for (const op of zoomOps) {
    const start = Date.now()
    await window.evaluate((zoom) => {
      // @ts-ignore
      if (window.designCanvas) {
        // @ts-ignore
        window.designCanvas.setZoom(zoom)
      }
    }, op.to)
    await window.waitForTimeout(500)
    const duration = Date.now() - start
    metrics.performance.zoomOperations.push({ ...op, durationMs: duration })
    console.log(`   ${op.from}x → ${op.to}x: ${duration} ms`)
  }

  // 收集 GPU 统计
  console.log('📊 收集 GPU 统计...')
  const gpuStats = await window.evaluate(() => {
    // @ts-ignore
    if (window.designKernel) {
      try {
        // @ts-ignore
        const stats = JSON.parse(window.designKernel.stats())
        return stats
      } catch (e) {
        return null
      }
    }
    return null
  })

  if (gpuStats) {
    metrics.gpuStats = gpuStats
    console.log('✅ GPU 统计:')
    console.log(`   纹理内存: ${(gpuStats.textureMemoryMB || 0).toFixed(2)} MB`)
    console.log(`   几何内存: ${(gpuStats.geometryMemoryMB || 0).toFixed(2)} MB`)
    console.log(`   Draw Calls: ${gpuStats.drawCalls || 'N/A'}`)
    console.log(`   批次组: ${gpuStats.batchGroups || 0}`)
    console.log(`   批次实例: ${gpuStats.batchInstances || 0}`)
  }

  // 截图
  console.log('📸 截图...')
  const screenshotPath = join(PROJECT_ROOT, 'gpu-test-screenshot.png')
  await window.screenshot({ path: screenshotPath })
  console.log(`✅ 截图已保存: ${screenshotPath}`)

  // 关闭应用
  await app.close()

  console.log()
  console.log('✅ 自动化测试完成')

} catch (error) {
  console.error('❌ 自动化测试失败:', error)
  console.log()
  console.log('⚠️  回退到手动测试模式')
  console.log()
  console.log('请手动运行:')
  console.log('  cd frontend/design-desktop && bun run dev')
  console.log()
}

// 保存结果
console.log()
console.log('💾 保存测试结果...')
writeFileSync(RESULTS_FILE, JSON.stringify(metrics, null, 2))
console.log(`✅ 结果已保存: ${RESULTS_FILE}`)
console.log()

// 分析结果
console.log('='.repeat(70))
console.log('📈 性能分析')
console.log('='.repeat(70))

if (metrics.performance.loadTimeMs) {
  console.log()
  console.log('⏱️  加载性能:')
  console.log(`   文件导入: ${metrics.performance.loadTimeMs} ms`)
  console.log(`   首次渲染: ${metrics.performance.firstRenderMs} ms`)
}

if (metrics.performance.zoomOperations?.length) {
  console.log()
  console.log('🔍 缩放性能:')
  const avgZoomTime = metrics.performance.zoomOperations.reduce((sum, op) => sum + op.durationMs, 0) /
                      metrics.performance.zoomOperations.length
  console.log(`   平均缩放时间: ${avgZoomTime.toFixed(0)} ms`)
}

if (metrics.gpuStats) {
  console.log()
  console.log('🎮 GPU 使用:')
  console.log(`   显存占用: ${((metrics.gpuStats.textureMemoryMB || 0) + (metrics.gpuStats.geometryMemoryMB || 0)).toFixed(2)} MB`)
  if (metrics.gpuStats.batchGroups && metrics.gpuStats.batchInstances) {
    console.log(`   批渲染效率: ${metrics.gpuStats.batchInstances} 实例 / ${metrics.gpuStats.batchGroups} 批次`)
    console.log(`   平均批次大小: ${(metrics.gpuStats.batchInstances / metrics.gpuStats.batchGroups).toFixed(1)} 实例/批`)
  }
}

console.log()
console.log('='.repeat(70))

// 查找关键日志
const batchLogs = metrics.consoleLogs.filter(log => log.includes('DESIGN_GPU_BATCH'))
if (batchLogs.length > 0) {
  console.log()
  console.log('✅ 批渲染已生效:')
  batchLogs.forEach(log => console.log(`   ${log}`))
}

console.log()
