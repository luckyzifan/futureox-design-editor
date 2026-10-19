// 清晰度动态调整 - 手动测试脚本
// 在浏览器控制台运行此脚本验证动态密度是否生效

console.log('🔍 清晰度动态调整测试')
console.log('=' .repeat(50))

// Hook calculateDynamicDensity 函数
const originalCalculate = window.__calculateDynamicDensity

if (!originalCalculate) {
  console.error('❌ 未找到 calculateDynamicDensity 函数')
  console.log('   可能原因：')
  console.log('   1. 函数未导出到 window')
  console.log('   2. 应用尚未初始化')
} else {
  let callCount = 0
  const densityHistory = []

  window.__calculateDynamicDensity = function(viewport) {
    callCount++
    const result = originalCalculate(viewport)

    const scale = viewport.camera.zoom
    densityHistory.push({ scale, density: result, time: Date.now() })

    console.log(`[${callCount}] scale=${scale.toFixed(3)}, density=${result}`)

    return result
  }

  console.log('✅ 已 hook calculateDynamicDensity')
  console.log('')
  console.log('📋 测试步骤：')
  console.log('  1. 缩小到 25% 以下 → 应该看到 density=0.5')
  console.log('  2. 放大到 300% 以上 → 应该看到 density=2.0')
  console.log('  3. 回到 100% → 应该看到 density=1.0')
  console.log('')
  console.log('📊 查看历史记录：')
  console.log('  window.__densityHistory')
}

// 导出历史记录
window.__densityHistory = () => {
  if (!densityHistory || densityHistory.length === 0) {
    console.log('暂无数据')
    return
  }

  console.table(densityHistory.map(d => ({
    时间: new Date(d.time).toLocaleTimeString(),
    缩放比例: `${(d.scale * 100).toFixed(0)}%`,
    密度: d.density
  })))
}

// GPU 使用率模拟
window.__simulateGPULoad = (duration = 5000) => {
  console.log(`🎮 模拟 GPU 密集任务 (${duration}ms)...`)

  const canvas = document.createElement('canvas')
  canvas.width = 2048
  canvas.height = 2048
  const ctx = canvas.getContext('2d')

  const start = Date.now()
  let frames = 0

  function render() {
    if (Date.now() - start > duration) {
      console.log(`✅ 完成 ${frames} 帧`)
      console.log(`   平均帧率: ${(frames / (duration / 1000)).toFixed(1)} FPS`)
      return
    }

    // 模拟复杂渲染
    for (let i = 0; i < 100; i++) {
      ctx.fillStyle = `hsl(${Math.random() * 360}, 70%, 50%)`
      ctx.beginPath()
      ctx.arc(
        Math.random() * 2048,
        Math.random() * 2048,
        Math.random() * 50,
        0,
        Math.PI * 2
      )
      ctx.fill()
    }

    frames++
    requestAnimationFrame(render)
  }

  requestAnimationFrame(render)
}

console.log('')
console.log('🚀 准备就绪！开始缩放测试...')
