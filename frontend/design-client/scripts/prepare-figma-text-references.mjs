import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const templatesFile = new URL('../public/fidelity/text-2026-10-09/cases.json', import.meta.url)
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** Prepare the two reference scales for the existing strict image checker. */
export async function prepareFigmaTextReferences(source, destination) {
  const templates = JSON.parse(await readFile(templatesFile, 'utf8'))
  const entries = []
  for (const template of templates) {
    for (const scale of [1, 2]) {
      const suffix = scale === 1 ? '' : '@2x'
      const reference = `KernelTextQA-${template.id}${suffix}.png`
      const bytes = await readFile(join(source, reference))
      const { options } = template
      const width = options.width * scale, height = options.height * scale
      if (bytes.length < 33 || !bytes.subarray(0, 8).equals(pngSignature) ||
          bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
        throw new Error(`Invalid PNG header: ${reference}`)
      }
      const actualWidth = bytes.readUInt32BE(16), actualHeight = bytes.readUInt32BE(20)
      if (actualWidth !== width || actualHeight !== height) {
        throw new Error(`${reference} is ${actualWidth}×${actualHeight}, expected ${width}×${height}`)
      }
      const record = {
        ...template,
        id: `${template.id}${suffix}`,
        reference,
        referenceSha256: createHash('sha256').update(bytes).digest('hex'),
        options: {
          ...options, width, height,
          view: { x: options.view.x * scale, y: options.view.y * scale, zoom: options.view.zoom * scale },
        },
      }
      entries.push({ reference, bytes, record })
    }
  }

  // Validate every input before creating the output directory. Write the
  // manifest last so consumers never read a reference pack in progress.
  await mkdir(destination)
  try {
    for (const { reference, bytes } of entries) await writeFile(join(destination, reference), bytes, { flag: 'wx' })
    const records = entries.map(entry => entry.record)
    await writeFile(join(destination, 'cases.json'), JSON.stringify(records, null, 2) + '\n', { flag: 'wx' })
    return records
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, destination, ...extra] = process.argv.slice(2)
  if (!source || !destination || extra.length) {
    throw new Error('Usage: node scripts/prepare-figma-text-references.mjs FIGMA_PNG_DIR NEW_PACK_DIR')
  }
  const cases = await prepareFigmaTextReferences(source, destination)
  console.log(`Prepared ${cases.length} references in ${resolve(destination)}`)
}
