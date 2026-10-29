exec(open('/tmp/sketch-text-impl.py').read().split("p='design-studio")[0])
def ds(s):
 at=s.index('/** Import immutable releases')
 s=s[:at]+'''type SketchNodeMetadata = { bindings?: Record<string,string>; styleRefs?: Record<string,string> }
function sketchMetadata(d: DesignDocument) { return (d.designSystem?.sketchContainers?.nodeMetadata || {}) as Record<string,SketchNodeMetadata> }
/** Adopt only embedded foreign symbols whose native symbol ID matches the
 * explicitly selected local source. Never match by visible name or position. */
function embeddedSketchLibrary(doc: DesignDocument, p: LibraryPackage): DesignSystem['libraries'][string] | undefined {
  const localMeta=sketchMetadata(doc), sourceMeta=sketchMetadata(p.document), nodeMap:Record<string,string>={}, roots:string[]=[]
  for (const source of Object.values(p.document.nodes).filter(n=>n.component && !n.instanceOrigin)) {
    const symbol=sourceMeta[source.id]?.bindings?.symbolID
    if (!symbol) continue
    const matches=Object.values(doc.nodes).filter(n=>n.component && localMeta[n.id]?.bindings?.sketchForeignLibraryID && localMeta[n.id]?.bindings?.symbolID?.toUpperCase()===symbol.toUpperCase())
    if (matches.length>1) throw new Error('外部 Symbol 身份重复，无法安全更新')
    if (!matches.length) continue
    const local=matches[0];roots.push(local.id);nodeMap[source.id]=local.id
    let remote:Record<string,string>={}
    try {remote=JSON.parse(localMeta[local.id].bindings?.sketchForeignSymbolRaw || '{}').remoteToLocalIDMap || {}} catch {throw new Error('外部 Symbol 身份映射损坏')}
    const descendants=(d:DesignDocument,n:DesignNode):DesignNode[]=>{const out:DesignNode[]=[];const visit=(id:string)=>{const x=d.nodes[id];if(!x||x.instanceOrigin)return;out.push(x);x.children.forEach(visit)};n.children.forEach(visit);return out}
    const localChildren=descendants(doc,local)
    for(const child of descendants(p.document,source)){
      const key=child.componentKey||child.id, remoteKey=Object.keys(remote).find(k=>k.toUpperCase()===key.toUpperCase())
      const identity=remoteKey?remote[remoteKey]:key
      const matches=localChildren.filter(n=>(n.componentKey||n.id).toUpperCase()===identity.toUpperCase()||n.id.toUpperCase()===identity.toUpperCase())
      if(matches.length>1)throw new Error('外部 Symbol 子图层身份重复')
      if(matches.length===1)nodeMap[child.id]=matches[0].id
    }
  }
  return roots.length ? {name:p.name,version:0,digest:'',componentIds:roots,nodeMap} : undefined
}
'''+s[at:]
 s=s.replace('old = s.libraries[p.id]','old = s.libraries[p.id] || embeddedSketchLibrary(doc,p)',1)
 s=s.replace('''    n.componentKey ??= id''','''    n.componentKey = doc.nodes[n.id]?.componentKey ?? n.componentKey ?? id''',1)
 old='''    for (const [id] of authored) if (source?.[id] !== undefined) next[map[id]] = structuredClone(source[id])'''
 new='''    for (const [id] of authored) if (source?.[id] !== undefined) {
      const value = structuredClone(source[id])
      if (key==='nodeMetadata') {
        const prior=(previous?.[map[id]] as SketchNodeMetadata | undefined)?.bindings
        if (prior?.sketchForeignLibraryID) {
          const metadata=value as SketchNodeMetadata;metadata.bindings ??= {}
          for (const k of ['sketchForeignLibraryID','sketchForeignSymbolRaw']) if(prior[k]) metadata.bindings[k]=prior[k]
        }
      }
      next[map[id]] = value
    }'''
 assert old in s;s=s.replace(old,new,1)
 return s
edit('frontend/design-client/src/design-system.ts',ds)
