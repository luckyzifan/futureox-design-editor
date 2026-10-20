/** Compact syntax only. The dispatcher expands these into existing granular
 * operations; these wrappers never edit a document or bypass native history. */
import { granularExtensions } from './granular'
import { AutomationError, type AutomationExtension } from './types'

type Obj = Record<string, unknown>
const definitions = [
  ['node.patchMany', 'node.patch'],
  ['layout.patchMany', 'layout.patch'],
  ['paint.patchMany', 'paint.patch'],
  ['text.replaceMany', 'text.replaceRange'],
  ['text.styleMany', 'text.styleRange'],
] as const

export const bulkExtensions: AutomationExtension[] = definitions.map(([name, method]) => {
  const base = granularExtensions.find(entry => entry.name === method)!
  const original = base.inputSchema.properties as Obj
  const hasIds = Object.hasOwn(original, 'ids')
  const properties = { ...original }
  if (hasIds) {
    delete properties.ids
    properties.nodeId = { type: 'string', minLength: 1, maxLength: 128 }
  }
  const required = (base.inputSchema.required as string[]).map(key => key === 'ids' ? 'nodeId' : key)
  return {
    name, mutates: true,
    description: `Apply ${method} to 1–500 explicit distinct nodes with per-target arguments and expected values. No selection inference or silent skips. Targets use nodeId; all other arguments have the underlying operation semantics. Duplicate node IDs are rejected, including multiple ranges in one text node (use batch.apply for explicitly sequential ranges). Requires permission for both ${name} and ${method}. All targets share one atomic native undo transaction; expanded operations count toward the 500-operation request budget.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['targets'], properties: {
      targets: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object', additionalProperties: false, properties, required } },
    } },
    expand(params: Obj) {
      const targets = params.targets as Obj[], seen = new Set<string>()
      return targets.map((target, targetIndex) => {
        const nodeId = target.nodeId as string
        if (seen.has(nodeId)) throw new AutomationError('duplicate_target', 'Each bulk target must identify a distinct node; use batch.apply for sequential edits', { nodeId, targetIndex })
        seen.add(nodeId)
        const params = { ...target }
        if (hasIds) { delete params.nodeId; params.ids = [nodeId] }
        return { method, params }
      })
    },
    execute() { throw new AutomationError('invalid_operation', 'Bulk operations must be expanded by the shared dispatcher') },
  }
})
