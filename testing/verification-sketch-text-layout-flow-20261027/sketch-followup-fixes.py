exec(open('/tmp/sketch-text-impl.py').read().split("p='design-studio")[0])
edit('design-studio/crates/design-kernel/src/interop.rs',lambda s:s.replace('id: "imported-sketch".into(),', 'id: document.get("do_objectID").and_then(Value::as_str).filter(|v|!v.is_empty()).map(|v|sketch_id(v).to_lowercase()).unwrap_or_else(||"imported-sketch".into()),',1).replace('''|| a.easing_curve.is_some()
                                || a.overlay_position.is_some()''','''|| a.easing_curve.is_some()
                                || (a.transition_style.is_none() && a.duration_ms > 0)
                                || a.overlay_position.is_some()''',1))
def ds(s):
 # Imported metadata is outside executable bindings; no need to special-case arbitrary names.
 s=s.replace('''function isSourceBinding(field: string) {
  return field.startsWith('sketch') || field.startsWith('fig') || ['symbolID','instanceOf','interopLimited'].includes(field)
}
''','').replace('if (!isSourceBinding(field)) references.bindings[field] =','references.bindings[field] =')
 at=s.index('  for (const [id, font] of Object.entries(p.document.fonts || {}))')
 s=s[:at]+'''  // Copy only provenance for installed authored nodes, remapped to their
  // stable local identities. Document-level foreign containers are not merged.
  for (const key of ['nodeMetadata','textSourceLayouts']) {
    const source = incomingSystem?.sketchContainers?.[key] as Record<string,unknown> | undefined
    const previous = s.sketchContainers?.[key] as Record<string,unknown> | undefined
    if (!source && !previous) continue
    const next = {...previous}
    for (const id of Object.values(old?.nodeMap || {})) delete next[id]
    for (const [id] of authored) if (source?.[id] !== undefined) next[map[id]] = structuredClone(source[id])
    ;(s.sketchContainers ??= {})[key] = next
  }
  for (const id of Object.values(old?.nodeMap || {})) if (s.fontSources) delete s.fontSources[id]
  for (const [id] of authored) if (incomingSystem?.fontSources?.[id]) (s.fontSources ??= {})[map[id]] = structuredClone(incomingSystem.fontSources[id])
'''+s[at:]
 return s
edit('frontend/design-client/src/design-system.ts',ds)
edit('frontend/design-client/src/DesignTools.tsx',lambda s:s.replace('''                          <input
                            aria-label="过渡毫秒"''','''                          {['navigate','back'].includes(a.kind) && <select aria-label="过渡方式" value={a.transitionStyle ?? ''} onChange={ev=>action(i,j,x=>{x.transitionStyle=(ev.target.value || undefined) as PrototypeAction['transitionStyle']})}>
                            <option value="">智能动画</option><option value="none">无动画</option><option value="slide-left">从左滑入</option><option value="slide-right">从右滑入</option><option value="slide-top">从上滑入</option><option value="slide-bottom">从下滑入</option>
                          </select>}
                          <input
                            aria-label="过渡毫秒"''',1))
