exec(open('/tmp/sketch-text-impl.py').read().split("p='design-studio")[0])
edit('frontend/design-client/src/import-worker.ts',lambda s:s.replace("'fig' | 'sketch' | 'pdf'", "'fig' | 'sketch' | 'sketch-library' | 'pdf'",1).replace("if (event.data.format === 'sketch') {", "if (event.data.format === 'sketch' || event.data.format === 'sketch-library') {",1).replace('      result.document.id = uid()',"      if (event.data.format !== 'sketch-library') result.document.id = uid()",1))
edit('frontend/design-client/src/import-file-worker.ts',lambda s:s.replace("export type WorkerImportFormat = 'fig' | 'sketch' | 'pdf'", "export type WorkerImportFormat = 'fig' | 'sketch' | 'sketch-library' | 'pdf'",1))
def ds(s):
 # Stable document page ID makes identical file imports digest-identical.
 s=s.replace("doc.pages = [{ id: uid(), name: doc.name, children: rootIds, background: '#ffffff' }]", "doc.pages = [{ id: doc.id, name: doc.name, children: rootIds, background: '#ffffff' }]",1)
 # Native provenance stored in bindings must not be mistaken for variable IDs.
 s=s.replace('references.bindings[field] = ids.variables.get(id) || id','if (!isSourceBinding(field)) references.bindings[field] = ids.variables.get(id) || id',1)
 at=s.index('function designReferences(')
 s=s[:at]+'''function isSourceBinding(field: string) {
  return field.startsWith('sketch') || field.startsWith('fig') || ['symbolID','instanceOf','interopLimited'].includes(field)
}
'''+s[at:]
 # Leave legacy malformed unknown keys subject to native validation; no new executable source fields.
 at=s.index('/** Import immutable releases')
 s=s[:at]+'''/** Explicit local file refresh. The native archive identity and template keys
 * are stable; content hashes determine a new local release. No network watch. */
export async function prepareSketchLibrary(source: DesignDocument, target: DesignDocument): Promise<LibraryPackage> {
  if (!Object.values(source.nodes).some(n=>n.component && !n.instanceOrigin)) throw new Error('Sketch 文件中没有可发布的 Symbol')
  const old = target.designSystem?.libraries[source.id]
  const candidate = await publishLibrary(source, old?.version ?? 1)
  if (old && candidate.digest !== old.digest) candidate.version = old.version + 1
  return candidate
}
'''+s[at:]
 return s
edit('frontend/design-client/src/design-system.ts',ds)
def ui(s):
 s=s.replace('  verifyLibrary,','  verifyLibrary,\n  prepareSketchLibrary,',1)
 s=s.replace("import { download }", "import { importFileInWorker } from './import-file-worker'\nimport { download }",1)
 s=s.replace('accept=".fdlib"','accept=".fdlib,.sketch"',1)
 old='''                    const source = await importStep(request, () => f.text())
                    const p = await importStep(request, () => verifyLibrary(JSON.parse(source)))'''
 new='''                    const target = editor.state.doc
                    let warnings: string[] = []
                    const p = f.name.toLowerCase().endsWith('.sketch')
                      ? await importStep(request, async () => {
                          const imported = await importFileInWorker(f, '', 'sketch-library', request.signal)
                          warnings = imported.warnings
                          return prepareSketchLibrary(imported.document, target)
                        })
                      : await (async () => {
                          const source = await importStep(request, () => f.text())
                          return importStep(request, () => verifyLibrary(JSON.parse(source)))
                        })()'''
 assert old in s;s=s.replace(old,new,1)
 s=s.replace("editor.change('安装组件库', (d) => installLibrary(d, p))\n                    setError('')", "editor.change('安装组件库', (d) => installLibrary(d, p))\n                    setError(editor.state.doc === target && editor.state.message !== '安装组件库' ? editor.state.message : warnings.join('；'))",1)
 return s
edit('frontend/design-client/src/DesignTools.tsx',ui)
