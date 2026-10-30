import { decodeSvgFileBytes } from './export-options'
import { importSvg } from './import-svg'
import { validateDocument } from './model'
export const SVG_ARTIFACT_IMPORT_LIMITS = Object.freeze({ bytes:48*1024*1024,fontBytes:24*1024*1024,expansionRatio:200 })
/** Separate bounded admission. A marker never substitutes for parsing/validation. */
export function importSvgArtifact(bytes: Uint8Array, format: 'svg'|'svgz', signal?: AbortSignal, name='Imported SVG artifact') {
 signal?.throwIfAborted()
 const limit=SVG_ARTIFACT_IMPORT_LIMITS
 if (!['svg','svgz'].includes(format) || !bytes.length || bytes.length>limit.bytes) throw new Error('Invalid SVG artifact format or size')
 const gzip=bytes[0]===0x1f && bytes[1]===0x8b
 if ((format==='svgz')!==gzip) throw new Error('SVG artifact format does not match bytes')
 if(gzip){if(bytes.length<18)throw new Error('Truncated SVGZ');const size=new DataView(bytes.buffer,bytes.byteOffset+bytes.length-4,4).getUint32(0,true);if(size>bytes.length*limit.expansionRatio)throw new Error('SVG artifact decompression ratio exceeded')}
 const source=decodeSvgFileBytes(bytes,gzip,limit.bytes)
 if(new TextEncoder().encode(source).byteLength>limit.bytes || gzip && source.length>bytes.length*limit.expansionRatio)throw new Error('SVG artifact expansion budget exceeded')
 signal?.throwIfAborted()
 const imported=importSvg(source,name,undefined,{sourceChars:limit.bytes,fontBytes:limit.fontBytes,strictTree:true})
 validateDocument(imported.document)
 signal?.throwIfAborted()
 return imported
}
