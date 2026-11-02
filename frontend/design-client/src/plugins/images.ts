/** SHA-1 of the raw bytes, lowercase hex. FIG archives name image blobs `images/<sha1>`,
 * and Figma plugin image hashes are that same content id. */
export function imageContentId(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8
  const padded = bytes.length + 1 + ((55 - bytes.length) % 64 + 64) % 64 + 8
  const data = new Uint8Array(padded)
  data.set(bytes)
  data[bytes.length] = 0x80
  const view = new DataView(data.buffer)
  view.setUint32(padded - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(padded - 4, bitLength >>> 0)
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0
  const words = new Uint32Array(80)
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4)
    for (let index = 16; index < 80; index++) words[index] = rotl(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], 1)
    let a = h0, b = h1, c = h2, d = h3, e = h4
    for (let index = 0; index < 80; index++) {
      const mixed = index < 20 ? ((b & c) | (~b & d)) >>> 0
        : index < 40 ? (b ^ c ^ d) >>> 0
          : index < 60 ? ((b & c) | (b & d) | (c & d)) >>> 0
            : (b ^ c ^ d) >>> 0
      const constant = index < 20 ? 0x5a827999 : index < 40 ? 0x6ed9eba1 : index < 60 ? 0x8f1bbcdc : 0xca62c1d6
      const next = (rotl(a, 5) + mixed + e + constant + words[index]) >>> 0
      e = d
      d = c
      c = rotl(b, 30)
      b = a
      a = next
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  return [h0, h1, h2, h3, h4].map(part => part.toString(16).padStart(8, '0')).join('')
}

function rotl(value: number, bits: number) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

export function imageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return 'application/octet-stream'
}

export function imageSize(bytes: Uint8Array, mime = imageMime(bytes)): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === 'image/png' && bytes.length >= 24 && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (mime === 'image/gif' && bytes.length >= 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  if (mime === 'image/jpeg') {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break
      const marker = bytes[offset + 1]
      const length = view.getUint16(offset + 2)
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
      }
      if (length < 2) break
      offset += 2 + length
    }
  }
  return { width: 0, height: 0 }
}

export function dataUrlForImage(mime: string, base64: string) {
  return `data:${mime};base64,${base64}`
}

export function bytesFromDataUrl(value: string): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(value)
  if (!match || match[2].length % 4 !== 0) return null
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return { mime: match[1], bytes }
}
