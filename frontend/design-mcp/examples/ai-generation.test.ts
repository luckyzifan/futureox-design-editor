import { expect, it } from 'vitest'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { blank, type DesignDocument } from '../../design-client/src/model'
import { decodeDocumentBinary } from '../../design-client/src/kernel/binfmt'
import { connect, sha256, type Json } from './ai-generation-client'
import { composeStudio } from './ai-generation-design'

it('executes the agent-authored workspace design through actual MCP, checks, exports and reopens it', async () => {
  const destination = process.env.FUTUREOX_AI_GENERATION_DIR
  if (!destination || !path.isAbsolute(destination)) throw new Error('FUTUREOX_AI_GENERATION_DIR must be an absolute evidence output directory')
  const phase = process.env.FUTUREOX_AI_PHASE ?? 'draft', final = phase === 'final'
  if (!['draft', 'final'].includes(phase)) throw new Error('Use draft or final phase')
  const start = performance.now(), client = await connect()
  const save = async (file: string, data: unknown) => {
    const target = path.join(destination, file); await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2))
  }
  const regressions: Json[] = [], extraClients: Awaited<ReturnType<typeof connect>>[] = []
  try {
    const brief = 'Create an original editable three-page local design studio: Workspace, Files, Settings. Use a warm neutral palette, forest green, lime accents, readable type, original editable geometric artwork, actual native text and shape nodes, a reusable navigation system, and a clear local-only/export story. Inspect actual returned context/checks before choosing refinements. Export native FD, HTML/CSS, outlined SVG, assets and the bundled licensed font. This is a synthetic UI design, not functioning application behavior or real user data.'
    const prompts = await client.rpc('prompts/list')
    expect(prompts.result.prompts.some((p: Json) => p.name === 'design_generation')).toBe(true)
    const prompt = await client.rpc('prompts/get', { name: 'design_generation', arguments: { brief } })
    await save('brief-and-protocol.json', { brief, phase, prompts: prompts.result, generationPrompt: prompt.result, advertisedToolNames: client.tools.map((t: Json) => t.name), externalModelProviderInvoked: false, transport: 'Node PassThrough NDJSON streams', kernel: 'Repository actual WASM, initialized by src/test-setup.ts' })
    const initial = await client.read('context.get', { limit: 20 })
    expect(initial.result.nodes).toHaveLength(0)
    const font = await readFile(new URL('../../design-client/public/fonts/NotoSansSC.ttf', import.meta.url))
    await client.mutate('font.import', { id: 'forma-noto', data: font.toString('base64'), embeddingAllowed: true })
    expect((await client.read('font.validate')).result.valid).toBe(true)
    const plan = composeStudio(client.editor.state.page)
    await save('authored-operations.json', plan.operations)
    await save('node-references.json', { pages: plan.pages, roots: plan.roots, refs: plan.refs, assets: plan.assets })
    for (let index = 0; index < plan.operations.length; index += 240) {
      const batch = plan.operations.slice(index, index + 240)
      await client.mutate('batch.apply', { operations: batch, label: `Compose Forma UI, operations ${index + 1}-${index + batch.length}` })
    }
    expect(client.editor.state.doc.pages.map(page => page.name)).toEqual(['Workspace', 'Files', 'Settings'])
    expect(Object.keys(client.editor.state.doc.nodes)).toHaveLength(plan.designedNodeCount)
    expect(plan.designedNodeCount).toBeGreaterThan(200)
    const checksBefore: Json[] = []
    for (const [i, pageId] of plan.pages.entries()) {
      const result = (await client.read('design.check', { pageId, nodeIds: [plan.roots[i]], limit: 500, maxDepth: 64 })).result
      expect(result.complete).toBe(true)
      checksBefore.push({ page: client.editor.state.doc.pages[i].name, ...result })
    }
    await save('checks-before.json', checksBefore)
    // The first run stops at draft output. The final run consumes decisions made
    // by the assistant after inspecting real context/checks and CPU SVG previews.
    let refinements: Json = { operations: [], decisions: [], provenance: 'No refinement selected yet; awaiting actual agent inspection.' }
    if (final) {
      const filename = process.env.FUTUREOX_AI_REFINEMENTS
      if (!filename || !path.isAbsolute(filename)) throw new Error('Final phase requires the actual agent-selected refinement file')
      refinements = JSON.parse(await readFile(filename, 'utf8'))
      expect(refinements.decisions.length).toBeGreaterThan(0)
      expect(refinements.operations.length).toBeGreaterThan(0)
      const beforeRefinement = client.editor.state.doc
      await client.mutate('batch.apply', { operations: refinements.operations, label: 'Agent-selected refinements after actual draft inspection' })
      const afterRefinement = client.editor.state.doc
      const expectedChanged = [...new Set(refinements.operations.flatMap((operation: Json) => operation.params.ids))].sort()
      const changed = Object.keys(beforeRefinement.nodes).filter(id => JSON.stringify(beforeRefinement.nodes[id]) !== JSON.stringify(afterRefinement.nodes[id])).sort()
      expect(changed).toEqual(expectedChanged)
      expect(Object.keys(afterRefinement.nodes)).toEqual(Object.keys(beforeRefinement.nodes))
      expect(afterRefinement.pages).toEqual(beforeRefinement.pages)
      expect(afterRefinement.fonts).toEqual(beforeRefinement.fonts)
      for (const operation of refinements.operations) {
        for (const nodeId of operation.params.ids) {
          const before = beforeRefinement.nodes[nodeId], after = afterRefinement.nodes[nodeId]
          expect(after.children).toEqual(before.children)
          expect(after.textStyle).toEqual(before.textStyle)
          if (operation.method === 'text.set') expect(after.text).toBe(operation.params.text)
          if (operation.method === 'node.update') for (const [property, value] of Object.entries(operation.params.patch)) expect((after as any)[property]).toEqual(value)
        }
      }
      regressions.push({ name: 'Inspection-driven refinement changes exactly the three intended nodes, preserving structure/font/styles', passed: true, changedIds: changed })
      await save('applied-refinements.json', refinements)
    }
    await save('fonts/NotoSansSC.ttf', font)
    await copyFile(new URL('../../design-client/public/fonts/OFL.txt', import.meta.url), path.join(destination, 'fonts/OFL.txt'))
    await copyFile(new URL('../../design-client/public/fonts/source.json', import.meta.url), path.join(destination, 'fonts/source.json'))
    const fontFamily = JSON.stringify(client.editor.state.doc.fonts!['forma-noto'].family)
    const fontCss = `/* Delivery packaging only: code.export does not emit font bytes. */\n@font-face{font-family:${fontFamily};src:url("../fonts/NotoSansSC.ttf") format("truetype");font-weight:100 900;font-style:normal;font-display:swap}\n`
    const outputs: Json[] = [], checksAfter: Json[] = []
    for (const [i, pageId] of plan.pages.entries()) {
      const name = client.editor.state.doc.pages[i].name.toLowerCase(), nodeIds = [plan.roots[i]]
      const context = (await client.read('context.get', { pageId, nodeIds, limit: 500, maxDepth: 64 })).result
      expect(context.pagination.nextCursor).toBeNull()
      expect(context.warnings).toHaveLength(0)
      const check = (await client.read('design.check', { pageId, nodeIds, limit: 500, maxDepth: 64 })).result
      expect(check.complete).toBe(true)
      expect(check.issues.filter((issue: Json) => issue.severity === 'error')).toHaveLength(0)
      checksAfter.push({ page: name, ...check })
      const code = (await client.read('code.export', { pageId, nodeIds, maxNodes: 500 })).result
      const vector = (await client.read('vector.export', { pageId, nodeIds, maxNodes: 500 })).result
      expect(code.fidelity).toBe('approximate')
      expect(Object.keys(code.nodeIdMap)).toHaveLength(context.nodes.length)
      expect(code.html).not.toMatch(/<script\b/i)
      expect(vector.content).toContain('<svg')
      expect(vector.content).toContain('<path')
      await save(`${name}/raw-api.html`, code.html)
      await save(`${name}/raw-api.css`, code.css)
      await save(`${name}/index.html`, code.html.replace("style-src 'self';", "style-src 'self'; font-src 'self';"))
      await save(`${name}/styles.css`, fontCss + code.css)
      await save(`${name}/design.svg`, vector.content)
      await save(`${name}/context.json`, context)
      await save(`${name}/export-manifest.json`, { ...code, html: undefined, css: undefined, resources: undefined })
      outputs.push({ name, pageId, rootId: nodeIds[0], nodeCount: context.nodes.length, editableTextNodes: context.nodes.filter((node: Json) => node.kind === 'text').length, htmlSha256: sha256(code.html), cssSha256: sha256(code.css), svgSha256: sha256(vector.content), warnings: code.warnings })
    }
    await save('checks-after.json', checksAfter)
    const assets: Json[] = []
    for (const asset of plan.assets) {
      const svg = (await client.read('vector.export', { pageId: asset.pageId, nodeIds: [asset.nodeId], maxNodes: 500 })).result.content
      await save(`assets/${asset.name}.svg`, svg)
      assets.push({ ...asset, file: `assets/${asset.name}.svg`, sha256: sha256(svg), source: 'Actual native editable geometry via MCP vector.export' })
    }
    await save('assets/manifest.json', assets)
    const manifest: Json = {
      title: 'Forma / local design studio', phase, originalAgentAuthoredDesign: true,
      generationPath: 'Assistant-authored operations -> actual MCP NDJSON -> OperationBackend -> shared operation API -> real Editor/WASM',
      externalModelProviderInvoked: false, osSocketTransportRun: false, browserRun: false, gpuRenderingRun: false,
      syntheticData: true, interactiveAppBehaviorImplemented: false,
      transportIsInMemoryOnly: true, operationsAreNotMocked: true,
      documentId: client.editor.state.doc.id, pages: 3, nodeCount: plan.designedNodeCount,
      authoredOperations: plan.operations.length, refinementOperations: refinements.operations.length,
      outputs, assets,
      font: { family: client.editor.state.doc.fonts!['forma-noto'].family, bytes: font.length, sha256: sha256(font), license: 'SIL Open Font License 1.1', licenseFile: 'fonts/OFL.txt', source: 'Repository bundled NotoSansSC.ttf, unchanged', packagingGlue: true },
      fidelity: { nativeFd: 'Lossless document carrier', html: 'Approximate editable HTML/CSS, static with no application actions', svg: 'Native geometry and outlined font export; CPU raster previews are not product-renderer pixel acceptance', designCheck: 'Structural and native text/overflow heuristics, no aesthetics or overlap guarantee' },
    }
    if (final) {
      const source = client.editor.state.doc
      const native = (await client.read('document.export')).result
      await save('forma-studio.json', native.content)
      expect(JSON.parse(native.content)).toEqual(source)
      const binaryWire = await client.call('document.export', { format: 'fd' })
      expect(binaryWire.isError).toBe(false)
      expect(binaryWire.structuredContent.result.base64).toBeUndefined()
      const binary = (await client.materialize(binaryWire)).result, bytes = Buffer.from(binary.base64, 'base64')
      expect(bytes.subarray(0, 4).toString()).toBe('FXDK')
      await save('forma-studio.fd', bytes)
      manifest.nativeFd = { bytes: bytes.length, sha256: sha256(bytes), resourceFirst: true }

      // Open actual saved native bytes with the real kernel decoder and Editor,
      // then prove the reopened text remains editable through another MCP session.
      const decoded = decodeDocumentBinary(new Uint8Array(await readFile(path.join(destination, 'forma-studio.fd')))) as DesignDocument
      expect(decoded).toEqual(source)
      const reopened = await connect(decoded); extraClients.push(reopened)
      expect(reopened.editor.state.doc.pages.map(page => page.name)).toEqual(['Workspace', 'Files', 'Settings'])
      expect(Object.keys(reopened.editor.state.doc.nodes)).toHaveLength(plan.designedNodeCount)
      const originalTitle = reopened.editor.state.doc.nodes[plan.refs.welcome].text
      await reopened.mutate('text.set', { ids: [plan.refs.welcome], text: 'This is an editable reopened design.' })
      expect(reopened.editor.state.doc.nodes[plan.refs.welcome].text).toBe('This is an editable reopened design.')
      await reopened.mutate('history.undo', {})
      expect(reopened.editor.state.doc.nodes[plan.refs.welcome].text).toBe(originalTitle)
      await reopened.mutate('history.redo', {})
      expect(reopened.editor.state.doc.nodes[plan.refs.welcome].text).toBe('This is an editable reopened design.')
      await reopened.mutate('history.undo', {})
      expect(reopened.editor.state.doc).toEqual(source)
      await save('reopen-transcript.json', reopened.transcript)
      regressions.push({ name: 'Saved FD decoded into actual Editor, all pages/nodes/fonts retained, text edited through MCP, undo/redo verified', passed: true, checkedNodes: plan.designedNodeCount })

      const imported = await connect(blank('FD append validation')); extraClients.push(imported)
      const importResponse = await imported.mutate('document.import', { format: 'fd', base64: binary.base64 })
      const importResult = importResponse.structuredContent.result.operations[0].result, mapping = importResult.nodeIdMap
      expect(Object.keys(mapping)).toHaveLength(plan.designedNodeCount)
      for (const [oldId, newId] of Object.entries(mapping)) {
        expect(newId).not.toBe(oldId)
        const original = source.nodes[oldId], restored = imported.editor.state.doc.nodes[newId as string]
        expect(restored.kind).toBe(original.kind)
        expect(restored.text).toBe(original.text)
        expect(restored.width).toBe(original.width)
        expect(restored.height).toBe(original.height)
        expect(restored.children).toEqual(original.children.map(child => mapping[child]))
        if (original.layout) expect(restored.layout).toEqual(original.layout)
      }
      await imported.mutate('text.set', { ids: [mapping[plan.refs.workspaceName]], text: 'Reimported and still editable' })
      expect(imported.editor.state.doc.nodes[mapping[plan.refs.workspaceName]].text).toBe('Reimported and still editable')
      await save('import-transcript.json', imported.transcript)
      await save('import-node-map.json', mapping)
      regressions.push({ name: 'Actual MCP document.import of saved FD, every node remapped and checked, imported text edited', passed: true, checkedNodes: Object.keys(mapping).length, importedPageContainerCount: importResult.rootIds.length })

      const rejectedWithoutChanges = async (name: string, action: () => Promise<Json>, code?: string) => {
        const before = client.editor.state.doc, version = client.editor.state.version, page = client.editor.state.page, selection = [...client.editor.state.selection]
        const response = await action()
        expect(response.isError, JSON.stringify(response)).toBe(true)
        if (code) expect(response.structuredContent.error.code).toBe(code)
        expect(client.editor.state.doc).toBe(before)
        expect(client.editor.state.version).toBe(version)
        expect(client.editor.state.page).toBe(page)
        expect([...client.editor.state.selection]).toEqual(selection)
        regressions.push({ name, passed: true, error: response.structuredContent.error, exactDocumentIdentityUnchanged: true, revisionUnchanged: true, pageAndSelectionUnchanged: true })
      }
      const current = await client.read('document.get')
      const fence = { documentId: current.documentId, session: current.session, expectedRevision: current.revision }
      // MCP tool schema validation rejects missing required guards before the
      // operation API's lower-level missing_revision check is reached.
      await rejectedWithoutChanges('Missing write guards rejected', () => client.call('text.set', { ids: [plan.refs.welcome], text: 'Must not commit' }), 'invalid_params')
      await rejectedWithoutChanges('Wrong session rejected', () => client.call('node.delete', { ids: [plan.refs.workspace] }, { ...fence, session: current.session + 100 }), 'session_mismatch')
      await rejectedWithoutChanges('Stale revision rejected', () => client.call('node.delete', { ids: [plan.refs.workspace] }, { ...fence, expectedRevision: current.revision - 1 }), 'stale_revision')
      await rejectedWithoutChanges('Atomic batch rolls back an earlier valid text edit when later reparent fails', () => client.mutate('batch.apply', { operations: [
        { method: 'text.set', params: { ids: [plan.refs.welcome], text: 'Must roll back' } },
        { method: 'node.move', params: { ids: [plan.refs.welcome], parentId: 'missing-parent' } },
      ] }, true))
      await rejectedWithoutChanges('Invalid enum rejected', () => client.mutate('node.create', { kind: 'web-page', width: 100, height: 100 }, true), 'invalid_params')
      await rejectedWithoutChanges('Text operation rejects non-text target', () => client.mutate('text.set', { ids: [plan.refs.workspace], text: 'Invalid' }, true), 'invalid_kind')
      await rejectedWithoutChanges('Context rejects node from another page', () => client.call('context.get', { pageId: plan.pages[0], nodeIds: [plan.refs.settings] }), 'invalid_params')
      const corrupted = Buffer.from(bytes); corrupted[corrupted.length - 1] ^= 1
      await rejectedWithoutChanges('Corrupted FD checksum rejected with no partial import', () => client.mutate('document.import', { format: 'fd', base64: corrupted.toString('base64') }, true), 'invalid_document')
      const pageOne = (await client.read('context.get', { pageId: plan.pages[0], nodeIds: [plan.roots[0]], limit: 7 })).result
      expect(pageOne.pagination.nextCursor).toBeTruthy()
      const titleBeforeCursorTest = client.editor.state.doc.nodes[plan.refs.welcome].text
      await client.mutate('text.set', { ids: [plan.refs.welcome], text: 'Real mutation invalidates old context cursor' })
      await rejectedWithoutChanges('Old semantic-context cursor rejected after a real edit', () => client.call('context.get', { pageId: plan.pages[0], nodeIds: [plan.roots[0]], limit: 7, cursor: pageOne.pagination.nextCursor }), 'invalid_params')
      await client.mutate('history.undo', {})
      expect(client.editor.state.doc.nodes[plan.refs.welcome].text).toBe(titleBeforeCursorTest)
      expect(client.editor.state.doc).toEqual(source)
      // Verify a no-op is not misrepresented as a revision-producing change.
      const revision = client.editor.state.version
      const noop = await client.mutate('text.set', { ids: [plan.refs.welcome], text: client.editor.state.doc.nodes[plan.refs.welcome].text })
      expect(noop.structuredContent.result.noChange).toBe(true)
      expect(client.editor.state.version).toBe(revision)
      regressions.push({ name: 'Identical text edit returns noChange and leaves revision unchanged', passed: true })
    }
    await save('regressions.json', regressions)
    manifest.regressions = { passed: regressions.length, failed: 0, run: final }
    manifest.elapsedMs = Math.round(performance.now() - start)
    manifest.maxToolResponseBytes = Math.max(...client.transcript.filter(entry => entry.request.method === 'tools/call').map(entry => entry.responseBytes))
    manifest.mcpRequests = client.transcript.length
    await save('manifest.json', manifest)
    await save('README.txt', `Forma local design studio — original assistant-authored MCP exercise\n\nPages: Workspace, Files, Settings. Open each page/index.html or import forma-studio.fd from the final output. The shapes, text, sidebar, cards, file rows and settings controls are editable native design nodes. These are synthetic design mockups: buttons do not implement application behavior, and file names/storage values are illustrative.\n\nThe actual MCP server received JSON-RPC over in-memory NDJSON streams and called the actual shared operation API, Editor and bundled Rust/WASM. The assistant authored the design and selected refinements after reviewing first-pass output. No external model provider was invoked inside this runner. It is not evidence that an external AI client connected via an OS stdio/socket transport. No browser/Electron/GPU session ran.\n\nNative FD is lossless. HTML/CSS is approximate and static. SVG is the existing native geometry/font-outline export. CPU-rasterized SVG previews, if present, are export inspections, not screenshots from the product renderer. design.check verifies structure and heuristic measured text/child overflow, not aesthetics, overlap, accessibility, or renderer fidelity. All actual warnings remain in checks and export manifests.\n\nraw-api.html/raw-api.css preserve exact exported code. index.html/styles.css add a self-hosted font face and font CSP as delivery packaging, not a product feature. Fonts are the repository's unmodified Noto Sans SC under SIL OFL 1.1; attribution and license are included. assets contains actual exported native SVG geometry.\n\nPhase: ${phase}. A draft run is a checkpoint, not completed acceptance. Refinement decisions are only applied in the final run after real agent inspection, and are recorded in applied-refinements.json.\n`)
    console.info(JSON.stringify({ phase, destination, nodeCount: manifest.nodeCount, operations: manifest.authoredOperations, checks: checksAfter.map(check => ({ page: check.page, checkedNodes: check.checkedNodes, issueCount: check.issueCount, issues: check.issues })), regressions: regressions.length, elapsedMs: manifest.elapsedMs }))
  } finally {
    await save('mcp-transcript.json', client.transcript)
    for (const extra of extraClients) await extra.close()
    await client.close()
  }
}, 180000)
