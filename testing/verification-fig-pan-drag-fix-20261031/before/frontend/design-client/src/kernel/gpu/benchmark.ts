import { blank, node, demo, paint, stroke } from '../../model'
import { KernelClient } from '../client'
const dimensions = { width: 1024, height: 768 }
function grid(count: number, columns: number, step: number) {
  const d = blank(`grid-${count}`)
  d.id = `grid-${count}`
  d.pages[0].id = 'page'
  for (let i = 0; i < count; i++) {
    const n = node(
      i % 3 ? 'rectangle' : 'ellipse',
      (i % columns) * step,
      Math.floor(i / columns) * step,
      step * 0.7,
      step * 0.7,
    )
    n.id = `n${i}`
    n.radii = [step * 0.08, step * 0.08, step * 0.08, step * 0.08]
    n.fills = [paint(i % 2 ? '#8273cd' : '#dd9977')]
    d.nodes[n.id] = n
    d.pages[0].children.push(n.id)
  }
  return d
}
const fixtures = [
  { name: 'effects-17', doc: demo(), motion: 'pan' },
  { name: 'visible-1000', doc: grid(1000, 40, 24), motion: 'pan' },
  { name: 'document-10000', doc: grid(10000, 100, 70), motion: 'pan' },
  { name: 'edit-1000', doc: grid(1000, 40, 24), motion: 'edit' },
]
const unique = grid(1000, 40, 24)
Object.values(unique.nodes).forEach((n, i) => {
  n.width = 12 + i * 0.005
  n.height = 15 + i * 0.003
})
fixtures.push({ name: 'unique-1000', doc: unique, motion: 'pan' })
for (const uniqueWidth of [false, true]) {
  const doc = grid(1000, 40, 24)
  Object.values(doc.nodes).forEach((n, i) => {
    n.kind = 'vector'
    n.fills = []
    n.network = {
      fillRule: 'nonzero',
      vertices: [
        { id: 'a', x: 0, y: 12 },
        { id: 'b', x: 18, y: 8 },
      ],
      edges: [{ id: 'ab', from: 'a', to: 'b', c1: { x: 5, y: -4 }, c2: { x: 14, y: 26 } }],
    }
    n.strokes = [
      {
        ...stroke('#744dcc', 4),
        widthProfile: [
          { position: 0, left: 0, right: 0 },
          { position: 0.5, left: uniqueWidth ? 0.5 + i * 0.001 : 1, right: 1 },
          { position: 1, left: 0, right: 0 },
        ],
      },
    ]
  })
  fixtures.push({
    name: uniqueWidth ? 'width-unique-1000' : 'width-repeated-1000',
    doc,
    motion: 'pan',
  })
}
function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(3)
}
const button = document.querySelector<HTMLButtonElement>('#run')!,
  status = document.querySelector('#status')!,
  output = document.querySelector('#results')!,
  canvas = document.querySelector<HTMLCanvasElement>('#preview')!,
  ctx = canvas.getContext('2d')!
button.onclick = async () => {
  button.disabled = true
  output.replaceChildren()
  const records: unknown[] = []
  for (const backend of ['webgpu', 'webgl2'] as const) {
    const client = new KernelClient()
    try {
      for (const fixture of fixtures.filter(
        (f) =>
          document.querySelector<HTMLSelectElement>('#scenario')!.value !== 'width' ||
          f.name.startsWith('width-'),
      )) {
        status.textContent = `运行 ${backend} / ${fixture.name}`
        const section = document.createElement('section'),
          title = document.createElement('h2'),
          pre = document.createElement('pre')
        title.textContent = `${backend} / ${fixture.name}`
        section.append(title, pre)
        output.append(section)
        const samples: {
          wall: number
          serialize: number
          load: number
          compile: number
          graph: number
          finish: number
          draws: number
          pixels: number
          memory: number
          visible: number
          maskHits: number
          maskRasterizations: number
        }[] = []
        let doc = fixture.doc
        try {
          for (let i = 0; i < 35; i++) {
            if (fixture.motion === 'edit') {
              const id = doc.pages[0].children[0],
                n = doc.nodes[id]
              doc = {
                ...doc,
                nodes: {
                  ...doc.nodes,
                  [id]: { ...n, fills: [{ ...n.fills[0], color: i % 2 ? '#cc4477' : '#5577cc' }] },
                },
              }
            }
            const start = performance.now()
            const result = await client.render(
              doc,
              {
                ...dimensions,
                pageId: doc.pages[0].id,
                view: { x: fixture.motion === 'pan' ? -i * 1.25 : 0, y: 0, zoom: 1 },
                transparent: false,
                grid: false,
              },
              false,
              backend,
            )
            if (result.backend !== backend) throw new Error('Unexpected fallback')
            if (result.bitmap) {
              ctx.drawImage(result.bitmap, 0, 0)
              result.bitmap.close()
            }
            const wall = performance.now() - start
            if (i >= 5)
              samples.push({
                wall,
                serialize: result.serializeMs,
                load: result.loadMs,
                compile: result.compileMs,
                graph: result.graphMs || 0,
                finish: result.finishMs || 0,
                draws: result.drawCalls,
                pixels: result.passPixels || 0,
                memory: result.stats.allocatedLayerPixels * 4,
                visible: result.stats.nodes,
                maskHits: result.maskHits || 0,
                maskRasterizations: result.maskRasterizations || 0,
              })
          }
          const summary = Object.fromEntries(
            Object.keys(samples[0]).map((k) => {
              const values = samples.map((s) => s[k as keyof typeof s])
              return [k, { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }]
            }),
          )
          const record = {
            backend,
            fixture: fixture.name,
            documentNodes: Object.keys(doc.nodes).length,
            dimensions,
            samples: 30,
            summary,
            rawSamples: samples,
            environment: { userAgent: navigator.userAgent, dpr: devicePixelRatio },
          }
          records.push(record)
          pre.textContent = JSON.stringify(record, null, 2)
        } catch (e) {
          const record = { backend, fixture: fixture.name, error: String(e) }
          records.push(record)
          pre.textContent = JSON.stringify(record, null, 2)
        }
      }
    } finally {
      client.dispose()
    }
  }
  status.textContent = '完成'
  status.setAttribute('data-results', JSON.stringify(records))
  button.disabled = false
}
