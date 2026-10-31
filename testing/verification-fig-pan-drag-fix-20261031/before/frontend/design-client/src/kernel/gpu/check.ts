import { fixture, parityFixtures } from '../../parity-fixtures'
import { strokeFixture } from '../../stroke-fixtures'
import { freehandFixture } from '../../freehand-fixtures'
import { initializePicking } from '../picking'
import { figmaFixture } from '../../figma-fixtures'
import { precisionFixtures } from '../../kernel-regression-fixtures'
// Explicit development harness: all render calls use the same public worker client as the editor.
import { KernelClient, type KernelResult } from '../client'
import {
  blank,
  node,
  paint,
  stroke,
  effect,
  demo,
  type DesignDocument,
  type DesignNode,
  type Blend,
} from '../../model'
import { blends } from './types'
await initializePicking()
const fixtures = parityFixtures()
function compare(a: Uint8Array, b: Uint8Array) {
  let sum = 0,
    max = 0,
    bad = 0,
    differentBytes = 0,
    maxChannelError = 0
  for (let i = 0; i < a.length; i += 4) {
    let pixel = 0
    for (let c = 0; c < 4; c++) {
      const raw = Math.abs(a[i + c] - b[i + c])
      if (raw) differentBytes++
      maxChannelError = Math.max(maxChannelError, raw)
      const aa = c === 3 ? a[i + c] : (a[i + c] * a[i + 3]) / 255,
        bb = c === 3 ? b[i + c] : (b[i + c] * b[i + 3]) / 255
      const d = Math.abs(aa - bb)
      sum += d
      max = Math.max(max, d)
      pixel = Math.max(pixel, d)
    }
    if (pixel > 12) bad++
  }
  return {
    differentBytes,
    maxChannelError,
    mae: +(sum / a.length).toFixed(3),
    max: +max.toFixed(2),
    badPercent: +((bad / (a.length / 4)) * 100).toFixed(3),
  }
}
const fidelity = new URLSearchParams(location.search).has('fidelity')
const button = document.querySelector<HTMLButtonElement>('#run')!,
  status = document.querySelector('#status')!,
  results = document.querySelector('#results')!
button.onclick = async () => {
  button.disabled = true
  results.replaceChildren()
  let failures = 0,
    byteDifferentScenes = 0
  const client = new KernelClient()
  try {
    for (const [index, doc] of fixtures.entries()) {
      const section = document.createElement('section'),
        title = document.createElement('h2'),
        output = document.createElement('pre')
      title.textContent = doc.name
      section.append(title, output)
      results.append(section)
      const values = new Map<string, KernelResult>()
      const records: unknown[] = []
      for (const backend of ['cpu', 'webgpu', 'webgl2'] as const) {
        status.textContent = `运行 ${index + 1}/${fixtures.length} ${backend}`
        try {
          const result = await client.render(
            doc,
            {
              pageId: doc.pages[0].id,
              width: 256,
              height: 192,
              view: {
                x: 0,
                y: 0,
                zoom: doc.name.includes('像素预览')
                  ? 1.375
                  : doc.name.startsWith('futureox-desgin')
                    ? 0.2
                    : doc.name.startsWith('可变宽度') || doc.name.startsWith('自研铅笔')
                      ? 0.38
                      : 1,
              },
              transparent:
                index === 6 ||
                doc.name.startsWith('透明背景穿透组') ||
                doc.name.startsWith('精度：'),
              grid: false,
              rasterProfile: fidelity ? 'figma' : 'analytic',
              pixelPreview: doc.name.includes('1×像素预览')
                ? 1
                : doc.name.includes('2×像素预览')
                  ? 2
                  : undefined,
            },
            false,
            backend,
            true,
          )
          if (
            result.backend !== backend ||
            (backend !== 'cpu' && (!result.drawCalls || !result.triangles))
          )
            throw new Error('后端没有执行几何绘制')
          values.set(backend, result)
          const canvas = document.createElement('canvas')
          canvas.width = 256
          canvas.height = 192
          canvas.title = backend
          canvas
            .getContext('2d')!
            .putImageData(new ImageData(new Uint8ClampedArray(result.bytes), 256, 192), 0, 0)
          section.append(canvas)
          result.bitmap?.close()
          records.push({
            backend,
            ms: +result.milliseconds.toFixed(2),
            draws: result.drawCalls,
            triangles: result.triangles,
          })
          if (backend !== 'cpu') {
            const reference = await client.render(
              doc,
              {
                pageId: doc.pages[0].id,
                width: 256,
                height: 192,
                view: {
                  x: 0,
                  y: 0,
                  zoom: doc.name.includes('像素预览')
                    ? 1.375
                    : doc.name.startsWith('futureox-desgin')
                      ? 0.2
                      : doc.name.startsWith('可变宽度') || doc.name.startsWith('自研铅笔')
                        ? 0.38
                        : 1,
                },
                transparent:
                  index === 6 ||
                  doc.name.startsWith('透明背景穿透组') ||
                  doc.name.startsWith('精度：'),
                grid: false,
                rasterProfile: fidelity ? 'figma' : 'analytic',
                pixelPreview: doc.name.includes('1×像素预览')
                  ? 1
                  : doc.name.includes('2×像素预览')
                    ? 2
                    : undefined,
              },
              false,
              backend,
              true,
              true,
            )
            reference.bitmap?.close()
            const difference = compare(result.bytes, reference.bytes)
            if (
              fidelity &&
              doc.name.startsWith('批量：') &&
              result.bytes.some((v, i) => v !== reference.bytes[i])
            )
              throw new Error('批量路径与逐层参考路径未达到逐字节一致')
            records.push({ backend, optimizedVsReference: difference })
            if (difference.max > 2 || difference.mae > 0.5 || difference.badPercent > 0.1)
              throw new Error('优化路径改变了输出')
          }
        } catch (e) {
          records.push({ backend, error: String(e) })
          failures++
        }
      }
      const cpu = values.get('cpu'),
        wg = values.get('webgpu'),
        gl = values.get('webgl2')
      const parity = wg && gl ? compare(wg.bytes, gl.bytes) : undefined
      const comparisons = {
        cpu_webgpu: cpu && wg ? compare(cpu.bytes, wg.bytes) : null,
        cpu_webgl: cpu && gl ? compare(cpu.bytes, gl.bytes) : null,
        gpuParity: parity,
      }
      if (Object.values(comparisons).some((diff) => diff && diff.differentBytes > 0))
        byteDifferentScenes++
      if (parity && (parity.mae > 1 || parity.badPercent > 1)) failures++
      for (const gpu of [wg, gl])
        if (cpu && gpu) {
          const diff = compare(cpu.bytes, gpu.bytes)
          if (diff.mae > 5 || diff.badPercent > 8) failures++
          if (
            fidelity &&
            doc.name.startsWith('精度：') &&
            cpu.bytes.some((v, i) => v !== gpu.bytes[i])
          )
            failures++
        }
      output.textContent = JSON.stringify({ records, comparisons }, null, 2)
    }
    const lifecycle = document.createElement('pre')
    results.append(lifecycle)
    const report: unknown[] = []
    for (const backend of ['webgpu', 'webgl2'] as const) {
      const retained = new KernelClient(),
        fresh = new KernelClient()
      try {
        const doc = fixtures.find((d) => d.name === '嵌套组效果与共享模糊表面')!
        const opts = {
          pageId: doc.pages[0].id,
          width: 256,
          height: 192,
          view: { x: 0, y: 0, zoom: 1 },
          transparent: true,
          grid: false,
          rasterProfile: 'figma' as const,
        }
        const before = await retained.render(doc, opts, false, backend, true)
        const again = await retained.render(doc, opts, false, backend, true)
        if (!again.compileCacheHit || !again.drawCalls)
          throw new Error('未复用编译结果或跳过了真实绘制')
        before.bitmap?.close()
        again.bitmap?.close()
        if (
          before.effectLayers !== 2 ||
          again.effectLayers !== 2 ||
          compare(before.bytes, again.bytes).max !== 0
        )
          throw new Error('效果作用域重复构建或重绘结果不稳定')
        const edited = structuredClone(doc)
        const ink = Object.values(edited.nodes).find((n) =>
          n.fills.some((p) => p.color === '#4477dd'),
        )!
        ink.fills[0].color = '#dd4477'
        const current = await retained.render(edited, opts, false, backend, true)
        if (current.compileCacheHit) throw new Error('文档变更后复用了过期的编译结果')
        const expected = await fresh.render(edited, opts, false, backend, true)
        current.bitmap?.close()
        expected.bitmap?.close()
        if (
          compare(current.bytes, expected.bytes).max !== 0 ||
          compare(current.bytes, before.bytes).max === 0
        )
          throw new Error('编辑后保留了陈旧效果像素')
        report.push({
          backend,
          foregroundEffects: 'passed',
          scopeBuildsPerFrame: again.effectLayers,
          editInvalidation: 'exact',
        })
        const masked = structuredClone(fixtures.find((d) => d.name === '带模糊的蒙版与子图层效果')!)
        const mask = Object.values(masked.nodes).find((n) => n.mask)!
        mask.opacity = 0
        mask.effects = [{ ...effect('background-blur'), radius: 4 }]
        const hidden = await retained.render(
          masked,
          { ...opts, pageId: masked.pages[0].id },
          false,
          backend,
          true,
        )
        hidden.bitmap?.close()
        if (hidden.bytes.some((v) => v !== 0)) throw new Error('零透明度蒙版被错误地当作不存在')
        report.push({ backend, zeroOpacityMask: 'passed' })
        const pass = figmaFixture('pass-through-opacity')
        const passOptions = { ...opts, pageId: pass.pages[0].id, width: 128, height: 128 }
        const passBefore = await retained.render(pass, passOptions, false, backend, true)
        passBefore.bitmap?.close()
        const normal = structuredClone(pass)
        Object.values(normal.nodes).find((n) => n.kind === 'group')!.blend = 'normal'
        const switched = await retained.render(normal, passOptions, false, backend, true)
        const switchedFresh = await fresh.render(normal, passOptions, false, backend, true)
        switched.bitmap?.close()
        switchedFresh.bitmap?.close()
        const restored = await retained.render(pass, passOptions, false, backend, true)
        restored.bitmap?.close()
        if (
          compare(switched.bytes, passBefore.bytes).max === 0 ||
          switched.bytes.some((v, i) => v !== switchedFresh.bytes[i]) ||
          restored.bytes.some((v, i) => v !== passBefore.bytes[i])
        )
          throw new Error('切换穿透与隔离模式后出现陈旧合成结果')
        report.push({ backend, passThroughModeSwitch: 'exact', restoredFrame: 'exact' })
        const backdrop = figmaFixture('backdrop-blur')
        const backdropOptions = { ...opts, pageId: backdrop.pages[0].id, width: 128, height: 128 }
        const baseline = await retained.render(backdrop, backdropOptions, false, backend, true)
        const oracle = await fresh.render(backdrop, backdropOptions, false, 'cpu', true)
        baseline.bitmap?.close()
        oracle.bitmap?.close()
        if (
          baseline.backdropReads !== 1 ||
          baseline.bytes.some((value, i) => value !== oracle.bytes[i])
        )
          throw new Error('分数像素背景采样未与 Rust 逐字节一致')
        const changed = structuredClone(backdrop)
        const stripe = Object.values(changed.nodes).find((n) =>
          n.fills.some((p) => p.color === '#000000'),
        )!
        stripe.fills[0].color = '#4477dd'
        stripe.transform[4] += 3.25
        const editedBackdrop = await retained.render(changed, backdropOptions, false, backend, true)
        const freshBackdrop = await fresh.render(changed, backdropOptions, false, backend, true)
        editedBackdrop.bitmap?.close()
        freshBackdrop.bitmap?.close()
        if (
          editedBackdrop.backdropReads !== 1 ||
          editedBackdrop.bytes.some((value, i) => value !== freshBackdrop.bytes[i]) ||
          !editedBackdrop.bytes.some((value, i) => value !== baseline.bytes[i])
        )
          throw new Error('移动背景图层后保留了陈旧滤镜输入')
        const transparentBackdrop = fixture('透明背景滤镜', (add) => {
          add(node('rectangle', 0, 0, 256, 192)).fills = [{ ...paint('#4466cc'), opacity: 0.5 }]
          const lens = add(node('rectangle', 32.125, 24.125, 128, 104))
          lens.fills = []
          lens.effects = [{ ...effect('background-blur'), radius: 4 }]
        })
        const alpha = await retained.render(
          transparentBackdrop,
          { ...opts, pageId: transparentBackdrop.pages[0].id },
          false,
          backend,
          true,
        )
        alpha.bitmap?.close()
        for (let y = 40; y < 100; y++)
          for (let x = 48; x < 140; x++)
            if (alpha.bytes[(y * 256 + x) * 4 + 3] !== 128)
              throw new Error('背景模糊重复叠加了透明度')
        report.push({
          backend,
          backdropEffects: 'passed',
          fractionalCapture: 'exact',
          readsPerFrame: 1,
          editInvalidation: 'exact',
          uniformAlpha: 128,
        })
      } catch (error) {
        failures++
        report.push({ backend, foregroundEffectsError: String(error) })
      } finally {
        retained.dispose()
        fresh.dispose()
      }
    }
    for (const backend of ['webgpu', 'webgl2'] as const) {
      const retainedClient = new KernelClient(),
        freshClient = new KernelClient()
      try {
        const doc = strokeFixture().doc
        const opts = {
          pageId: doc.pages[0].id,
          width: 256,
          height: 192,
          view: { x: 0, y: 0, zoom: 0.38 },
          transparent: true,
          grid: false,
        }
        const warm = await retainedClient.render(doc, opts, false, backend, true)
        warm.bitmap?.close()
        const repeat = await retainedClient.render(doc, opts, false, backend, true)
        repeat.bitmap?.close()
        if (
          compare(warm.bytes, repeat.bytes).max !== 0 ||
          repeat.maskRasterizations !== 0 ||
          !repeat.maskHits
        )
          throw new Error('跨帧路径覆盖缓存没有精确复用')
        const edits = structuredClone(doc),
          id = edits.pages[0].children[0]
        edits.nodes[id].strokes[0].widthProfile![1].left = 2.5
        const recolor = structuredClone(edits)
        recolor.nodes[id].strokes[0].paint.color = '#dd3355'
        const scenarios = [
          { doc, options: { ...opts, view: { x: 4, y: 3, zoom: 0.38 } } },
          { doc, options: { ...opts, view: { x: 0.25, y: 0.75, zoom: 0.38 } } },
          { doc: edits, options: opts },
          { doc: recolor, options: opts },
          { doc, options: opts },
          { doc, options: { ...opts, width: 123, height: 117 } },
          { doc, options: { ...opts, view: { x: -20, y: -10, zoom: 0.7 } } },
          { doc, options: opts },
        ]
        for (const item of scenarios) {
          const reused = await retainedClient.render(item.doc, item.options, false, backend, true)
          const fresh = await freshClient.render(item.doc, item.options, false, backend, true, true)
          reused.bitmap?.close()
          fresh.bitmap?.close()
          if (compare(reused.bytes, fresh.bytes).max > 2)
            throw new Error('跨帧覆盖缓存产生陈旧像素')
        }
        report.push({
          backend,
          retainedCoverage: 'passed',
          changesChecked: scenarios.length,
          repeatRasterizations: repeat.maskRasterizations,
          repeatMaskHits: repeat.maskHits,
        })
      } catch (e) {
        failures++
        report.push({ backend, retainedCoverageError: String(e) })
      } finally {
        retainedClient.dispose()
        freshClient.dispose()
      }
      const doc = fixtures[6],
        opts = {
          pageId: doc.pages[0].id,
          width: 256,
          height: 192,
          view: { x: 0, y: 0, zoom: 1 },
          transparent: true,
          grid: false,
        }
      try {
        const before = await client.render(doc, opts, false, backend, true)
        before.bitmap?.close()
        await client.loseDeviceForTesting()
        const after = await client.render(doc, opts, false, backend, true)
        after.bitmap?.close()
        const recovery = compare(before.bytes, after.bytes)
        if (recovery.max !== 0 || after.backend !== backend) throw new Error('设备重建后结果改变')
        const png = await client.render(doc, opts, true, backend)
        if (png.backend !== 'cpu') throw new Error('PNG 导出必须来自 CPU')
        const pngReference = await client.render(doc, opts, false, 'cpu', true)
        pngReference.bitmap?.close()
        if (pngReference.backend !== 'cpu') throw new Error('PNG 参考必须来自 CPU')
        const decoded = await createImageBitmap(
          new Blob([new Uint8Array(png.bytes)], { type: 'image/png' }),
        )
        const canvas = document.createElement('canvas')
        canvas.width = 256
        canvas.height = 192
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(decoded, 0, 0)
        decoded.close()
        const pngDiff = compare(pngReference.bytes, new Uint8Array(ctx.getImageData(0, 0, 256, 192).data))
        if (pngDiff.max > 2) throw new Error('PNG 往返像素错误')
        report.push({ backend, recovery: 'passed', png: 'passed', pngBackend: png.backend, pngReferenceBackend: pngReference.backend, pngDiff })
        const times: number[] = []
        const full = fixtures.find((doc) => doc.name.startsWith('futureox-desgin'))!,
          large = {
            ...opts,
            pageId: full.pages[0].id,
            width: 1024,
            height: 768,
            transparent: false,
          }
        for (let i = 0; i < 6; i++) {
          const frame = await client.render(full, large, false, backend)
          frame.bitmap?.close()
          if (i > 0) times.push(frame.milliseconds)
        }
        report.push({
          backend,
          warmFrame1024x768MedianMs: +times.sort((a, b) => a - b)[2].toFixed(2),
        })
      } catch (e) {
        failures++
        report.push({ backend, lifecycleError: String(e) })
      }
      lifecycle.textContent = JSON.stringify(report, null, 2)
    }
    // A scene-specific GPU budget error must not permanently disable that backend.
    try {
      const doc = fixture('fallback', (add) => {
        add(node('rectangle', 10, 10, 20, 20)).effects = [{ ...effect('blur'), radius: 600 }]
      })
      const opts = {
        pageId: doc.pages[0].id,
        width: 32,
        height: 32,
        view: { x: 0, y: 0, zoom: 1 },
        transparent: false,
        grid: false,
      }
      const fallback = await client.render(doc, opts, false, 'auto')
      fallback.bitmap?.close()
      if (fallback.backend !== 'cpu' || !fallback.reason) throw new Error('降级没有报告原因')
      const next = fixtures[0],
        restored = await client.render(next, { ...opts, pageId: next.pages[0].id }, false, 'auto')
      restored.bitmap?.close()
      if (restored.backend !== 'webgpu') throw new Error('场景恢复后未恢复 WebGPU')
      report.push({ fallback: 'cpu with reason', nextFrame: 'webgpu restored' })
    } catch (e) {
      failures++
      report.push({ fallbackError: String(e) })
    }
    lifecycle.textContent = JSON.stringify(report, null, 2)
    status.textContent = `完成：${fixtures.length} 场景，回归门限失败 ${failures} 项；逐字节差异 ${byteDifferentScenes} 个场景（非 Figma 外部对照）`
    status.setAttribute('data-failures', String(failures))
    status.setAttribute('data-byte-different-scenes', String(byteDifferentScenes))
  } finally {
    client.dispose()
    button.disabled = false
  }
}
