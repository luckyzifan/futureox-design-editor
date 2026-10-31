// Trusted startup policy, never authored metadata or a renderer/MCP parameter.
import { totalmem, freemem } from 'node:os'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const MIB = 1024 * 1024
export function macosAvailableMemoryBytes(text) {
  const size=/page size of ([0-9]+) bytes/.exec(text.split('\n')[0])?.[1]
  if(!size)return undefined
  const page=Number(size)
  if(!Number.isSafeInteger(page)||page<4096||page>65536||(page&(page-1))!==0)return undefined
  const pages=label=>{const value=text.split('\n').find(line=>line.startsWith(label))?.slice(label.length).trim();return value&&/^[0-9]+\.$/.test(value)?BigInt(value.slice(0,-1)):undefined}
  const free=pages('Pages free:'),inactive=pages('Pages inactive:')
  if(free===undefined||inactive===undefined)return undefined
  const bytes=(free+inactive)*BigInt(page)
  return bytes>0n&&bytes<=BigInt(Number.MAX_SAFE_INTEGER)?Number(bytes):undefined
}
export function selectDocumentMemoryBytes({ total, available, constrained = 0, configured } = {}) {
  const usable = [total, available, constrained].filter(value => Number.isSafeInteger(value) && value > 0)
  // This application shares documents with wasm32. Its address space is a
  // separate architectural ceiling, not evidence of available machine memory.
  const detected = Math.floor(Math.min(4 * 1024 * MIB, ...usable) / 2)
  const fallback = 512 * MIB
  const ceiling = usable.length ? detected : fallback
  if (configured === undefined || configured === '') return ceiling
  if (!/^[1-9][0-9]*$/.test(configured)) throw new TypeError('CORE_DOCUMENT_MEMORY_BYTES must be a positive decimal integer')
  const value = Number(configured)
  if (!Number.isSafeInteger(value) || value < MIB || value > ceiling)
    throw new TypeError('CORE_DOCUMENT_MEMORY_BYTES exceeds the detected startup memory allowance')
  return value
}
function availableMemory() {
  if(process.platform==='darwin'){
    // Node's free-memory reading omits reclaimable inactive queues on macOS.
    // Match native startup accounting, once, using a fixed OS executable.
    try{const available=macosAvailableMemoryBytes(execFileSync('/usr/bin/vm_stat',[],{encoding:'utf8',env:{LC_ALL:'C'},timeout:1000,maxBuffer:16*1024}));if(available)return available}catch{}
  }
  const reported = typeof process.availableMemory === 'function' ? process.availableMemory() : 0
  if (Number.isSafeInteger(reported) && reported > 0) return reported
  if (process.platform === 'linux') {
    try { const match = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8')); if (match) return Number(match[1]) * 1024 } catch {}
  }
  return freemem()
}
// Sample once. Free-memory fluctuation must not change a document's accepted
// capacity halfway through an atomic edit/save/reopen operation.
const inherited = process.env.CORE_DOCUMENT_MEMORY_INHERITED === '1'
const inheritedBytes = Number(process.env.CORE_DOCUMENT_MEMORY_BYTES)
if (inherited && (!Number.isSafeInteger(inheritedBytes) || inheritedBytes < MIB || inheritedBytes > 4 * 1024 * MIB)) throw new TypeError('Invalid inherited document memory policy')
export const DOCUMENT_MEMORY_BYTES = inherited ? inheritedBytes : selectDocumentMemoryBytes({ total: totalmem(), available: availableMemory(),
  constrained: typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0,
  configured: process.env.CORE_DOCUMENT_MEMORY_BYTES })
export const DOCUMENT_BYTE_LIMIT = Math.floor(DOCUMENT_MEMORY_BYTES / 16)
export const DOCUMENT_TRANSFER_BYTES = DOCUMENT_BYTE_LIMIT * 2 + 64 * 1024
// Children inherit this exact admission, rather than independently resampling.
export const documentChildEnvironment = env => ({ ...env, CORE_DOCUMENT_MEMORY_BYTES: String(DOCUMENT_MEMORY_BYTES), CORE_DOCUMENT_MEMORY_INHERITED: '1' })

// Count the plain JSON carrier before allocating its serialized string. This is
// deliberately a codec check, not document validation or a second scene model.
export function assertDocumentSerialization(value, limit = DOCUMENT_BYTE_LIMIT) {
  let bytes = 0
  const ancestors = new Set(), stack = [{ value, inArray: false }]
  const add = count => { bytes += count; if (!Number.isSafeInteger(bytes) || bytes > limit) throw Error('Document exceeds the available working-memory allowance') }
  const stringBytes = value => {
    let count=Buffer.byteLength(value)+2
    if(count>limit) throw Error('Document exceeds the available working-memory allowance')
    // Native UTF-8 length plus only the JSON escape deltas. Avoid a JavaScript
    // per-character scan over large ordinary font/image base64 strings.
    const escapes=/["\\\u0000-\u001f\uD800-\uDFFF]/g
    let match
    while((match=escapes.exec(value))!==null){
      const unit=value.charCodeAt(match.index)
      if(unit>=0xd800 && unit<=0xdbff){
        const next=value.charCodeAt(match.index+1)
        if(next>=0xdc00 && next<=0xdfff){escapes.lastIndex++;continue}
        count+=3
      }else if(unit>=0xdc00 && unit<=0xdfff)count+=3
      else count+=unit===34 || unit===92 || [8,9,10,12,13].includes(unit)?1:5
      if(count>limit)throw Error('Document exceeds the available working-memory allowance')
    }
    return count
  }
  while (stack.length) {
    const item=stack.pop(), current=item.value
    if (item.exit) {ancestors.delete(current);continue}
    if (current===null || (current===undefined && item.inArray)) {add(4);continue}
    if (typeof current==='string') {add(stringBytes(current));continue}
    if (typeof current==='number') {add(Number.isFinite(current)?String(current).length:4);continue}
    if (typeof current==='boolean') {add(current?4:5);continue}
    if (!current || typeof current!=='object' || ancestors.has(current)) throw Error('Invalid plain document JSON')
    if (!Array.isArray(current) && ![Object.prototype,null].includes(Object.getPrototypeOf(current))) throw Error('Invalid plain document JSON')
    ancestors.add(current);stack.push({value:current,exit:true});add(2)
    if (Array.isArray(current)) {
      add(Math.max(0,current.length-1))
      for(let i=current.length-1;i>=0;i--)stack.push({value:current[i],inArray:true})
    } else {
      const entries=Object.entries(current).filter(([,value])=>value!==undefined)
      add(Math.max(0,entries.length-1))
      for(const [key,value] of entries){add(stringBytes(key)+1);stack.push({value,inArray:false})}
    }
  }
  return bytes
}
