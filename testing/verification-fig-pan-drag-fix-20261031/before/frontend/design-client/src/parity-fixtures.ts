import corpus from '../../../testing/fixtures/design/precision-corpus.json'
import { blank, type DesignDocument, type DesignNode } from './model'
import type { KernelOptions } from './kernel/client'

export type PrecisionCase = { document: DesignDocument; options: KernelOptions }
const data = corpus as unknown as { cases: PrecisionCase[]; interactiveCases: number }
// One authored corpus feeds Rust, WebGPU and WebGL2. Every request still goes
// through the real kernel's document validation before any rendering.
export function precisionCases(): PrecisionCase[] {
  return structuredClone(data.cases)
}
export function parityFixtures(): DesignDocument[] {
  return precisionCases()
    .slice(0, data.interactiveCases)
    .map((c) => c.document)
}
export function parityOptions(
  doc: DesignDocument,
  index: number,
  profile: KernelOptions['rasterProfile'],
): KernelOptions {
  return {
    ...structuredClone(data.cases[index].options),
    pageId: doc.pages[0].id,
    rasterProfile: profile,
  }
}

export function fixture(
  name: string,
  build: (add: (n: DesignNode, parent?: DesignNode) => DesignNode) => void,
) {
  const d = blank(name)
  build((n, p) => {
    d.nodes[n.id] = n
    ;(p ? p.children : d.pages[0].children).push(n.id)
    return n
  })
  return d
}
