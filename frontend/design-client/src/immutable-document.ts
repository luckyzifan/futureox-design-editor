/** Only graphs traversed here can be shared as immutable. A shallow freeze
 * from a caller neither proves the children immutable nor validates a document. */
const immutable = new WeakSet<object>()
const unsupported = Symbol('unsupported publication value')

function dataKeys(value: object): string[] {
  const prototype = Object.getPrototypeOf(value)
  if ((prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length) throw unsupported
  const keys = Object.keys(value)
  if (Object.getOwnPropertyNames(value).length !== keys.length + (Array.isArray(value) ? 1 : 0)) throw unsupported
  for (const key of keys) {
    if (!('value' in Object.getOwnPropertyDescriptor(value, key)!)) throw unsupported
  }
  return keys
}

export function immutableDocument(value: object) {
  return immutable.has(value) && Object.isFrozen(value)
}

/** Copy caller-owned additions while preserving already privately frozen branches. */
export function captureImmutable<T>(value: T): T | undefined {
  const copies = new WeakMap<object, object>()
  function copy(input: unknown, depth: number): unknown {
    if (typeof input === 'function' || typeof input === 'symbol') throw unsupported
    if (!input || typeof input !== 'object' || immutable.has(input)) return input
    if (depth > 256) throw unsupported
    const existing = copies.get(input)
    if (existing) return existing
    const target = Array.isArray(input) ? new Array(input.length) : Object.create(Object.getPrototypeOf(input))
    copies.set(input, target)
    for (const key of dataKeys(input)) {
      Object.defineProperty(target, key, {value:copy((input as Record<string,unknown>)[key],depth+1),
        enumerable:true,writable:true,configurable:true})
    }
    Object.freeze(target)
    immutable.add(target)
    return target
  }
  try { return copy(value,0) as T }
  catch (error) { if (error !== unsupported) throw error }
}

function prepareFreeze(value: object) {
  const pending = [value], ordered: object[] = [], seen = new WeakSet<object>()
  let scan = true
  return (): boolean => {
    const deadline = performance.now() + 4
    do {
      if (scan) {
        const next = pending.pop()
        if (!next) { scan = false; continue }
        if (immutable.has(next) || seen.has(next)) continue
        seen.add(next)
        ordered.push(next)
        for (const key of dataKeys(next)) {
          const child = (next as Record<string, unknown>)[key]
          if (typeof child === 'function' || typeof child === 'symbol') throw unsupported
          if (child && typeof child === 'object') pending.push(child)
        }
      } else {
        const next = ordered.pop()
        if (!next) return true
        Object.freeze(next)
        immutable.add(next)
      }
    } while (performance.now() < deadline)
    return false
  }
}

export function freezeOwnedDocument(value: object) {
  try {
    const step = prepareFreeze(value)
    while (!step()) { /* synchronous private ownership transfer */ }
    return true
  } catch (error) { if (error === unsupported) return false; throw error }
}

export async function freezeOwnedDocumentInTasks(value: object, current: () => boolean) {
  try {
    const step = prepareFreeze(value)
    for (;;) {
      if (!current()) throw new DOMException('文档准备已过期','AbortError')
      if (step()) return true
      await new Promise<void>(resolve => setTimeout(resolve,0))
    }
  } catch (error) { if (error === unsupported) return false; throw error }
}
