// Lossless LZ4 block decoder for FGSZ scene packets.
// Matches lz4_flex::compress_prepend_size: little-endian uncompressed size,
// then one independent LZ4 block. Matches are copied a byte at a time because
// a match may overlap its own output.
export const FGSZ = 0x5a534746
const SCENE_PACKET_LIMIT = 128 * 1024 * 1024

export function inflateScenePacket(input) {
  if (input.byteLength < 8) return input
  const header = new DataView(input.buffer, input.byteOffset, input.byteLength)
  if (header.getUint32(0, true) !== FGSZ) return input
  if (header.getUint32(4, true) !== 1) throw Error('Unsupported GPU scene packet')
  return decompressLz4Prepended(input.subarray(8))
}

function decompressLz4Prepended(src) {
  if (src.byteLength < 4) throw Error('Truncated GPU scene packet')
  const size = new DataView(src.buffer, src.byteOffset, 4).getUint32(0, true)
  if (size < 24 || size > SCENE_PACKET_LIMIT) throw Error('Invalid GPU scene packet length')
  const out = new Uint8Array(size)
  decompressLz4Block(src.subarray(4), out)
  return out
}

function decompressLz4Block(src, dst) {
  const limit = src.length, output = dst.length
  let read = 0, written = 0
  while (written < output) {
    if (read >= limit) throw Error('Truncated GPU scene packet')
    const token = src[read++]
    let literals = token >>> 4
    if (literals === 15) {
      let extra = 255
      while (extra === 255) {
        if (read >= limit) throw Error('Truncated GPU scene packet')
        extra = src[read++]
        literals += extra
        if (literals > output - written) throw Error('Invalid GPU scene packet length')
      }
    }
    if (literals > output - written || literals > limit - read) throw Error('Invalid GPU scene packet length')
    dst.set(src.subarray(read, read + literals), written)
    read += literals
    written += literals
    if (written === output) {
      if (read !== limit) throw Error('Invalid GPU scene packet length')
      return
    }
    if (limit - read < 2) throw Error('Truncated GPU scene packet')
    const offset = src[read] | (src[read + 1] << 8)
    read += 2
    if (offset === 0 || offset > written) throw Error('Invalid GPU scene packet length')
    let match = (token & 15) + 4
    if ((token & 15) === 15) {
      let extra = 255
      while (extra === 255) {
        if (read >= limit) throw Error('Truncated GPU scene packet')
        extra = src[read++]
        match += extra
        if (match > output - written) throw Error('Invalid GPU scene packet length')
      }
    }
    if (match > output - written) throw Error('Invalid GPU scene packet length')
    const from = written - offset
    for (let index = 0; index < match; index++) dst[written++] = dst[from + index]
  }
  if (read !== limit) throw Error('Invalid GPU scene packet length')
}
