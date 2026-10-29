exec(open('/tmp/sketch-text-impl.py').read().split("p='design-studio")[0])
edit('design-studio/crates/design-kernel/src/prototype.rs',lambda s:s.replace('pub struct Action {','''pub struct Action {
    /// Explicit directional transition; absent retains existing smart animation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_style: Option<String>,''',1).replace('if a.duration_ms > 10000 {','''if a.transition_style.as_deref().is_some_and(|v|doc.schema_version<20 || !["none","slide-left","slide-right","slide-top","slide-bottom"].contains(&v) || !matches!(a.kind.as_str(),"navigate"|"back")) {return Err("Invalid directional prototype transition".into());}
                if a.duration_ms > 10000 {''',1))
edit('design-studio/crates/design-kernel/src/scene.rs',lambda s:s.replace('    pub fn requires_schema20(&self) -> bool {','''    pub fn requires_schema20(&self) -> bool {
        fn extended(a:&crate::prototype::Action)->bool {a.transition_style.is_some() || a.then_actions.iter().flatten().chain(a.else_actions.iter().flatten()).any(extended)}
        if self.prototype.as_ref().is_some_and(|p|p.interactions.values().flatten().flat_map(|e|&e.actions).any(extended)) {return true}''',1))
def interop(s):
 a=s.index('        if let Some(animation) = payload.get("animationType")');b=s.index('        if destination.is_some() || back {',a)
 s=s[:a]+'''        let transition_style = if !overlay {
            match payload.get("animationType").and_then(Value::as_i64).unwrap_or(-1) {
                -1=>Some("none".into()), 0=>Some("slide-right".into()), 1=>Some("slide-left".into()),
                2=>Some("slide-bottom".into()), 3=>Some("slide-top".into()),
                other=>{notes.push(format!("flow-animationType={other}")); None}
            }
        } else { if payload.get("animationType").and_then(Value::as_i64).is_some_and(|v|v!=-1) {notes.push("flow-overlay-animation-unmapped".into());} None };
        let duration_ms=if transition_style.as_deref()==Some("none") {0} else if duration_ms==0 && transition_style.is_some() {300} else {duration_ms};
'''+s[b:]
 s=s.replace('''                        trigger: "click".into(),''','''                        trigger: "click".into(),''',1)
 s=s.replace('''                        transition_preserve_scroll: payload''','''                        transition_style,
                        transition_preserve_scroll: payload''',1)
 s=s.replace('flow.insert("animationType".into(), json!(-1));','''flow.insert("animationType".into(), json!(match action.transition_style.as_deref() {Some("slide-right")=>0,Some("slide-left")=>1,Some("slide-bottom")=>2,Some("slide-top")=>3,_=>-1}));''',1)
 return s
edit('design-studio/crates/design-kernel/src/interop.rs',interop)
def ts(s):
 s=s.replace('export type PrototypeAction = {',"export type PrototypeTransitionStyle = 'none'|'slide-left'|'slide-right'|'slide-top'|'slide-bottom'\nexport type PrototypeAction = {\n  transitionStyle?: PrototypeTransitionStyle",1)
 s=s.replace('  transitionMs: number',"  transitionStyle?: PrototypeTransitionStyle\n  transitionFrom?: string\n  transitionSerial?: number\n  transitionMs: number",1)
 s=s.replace('      next.transitionEasing = undefined','      next.transitionEasing = undefined\n      next.transitionStyle = undefined\n      next.transitionFrom = undefined',1)
 s=s.replace('''        next.transition = a.transitionShouldSmartAnimate === false
''','''        next.transitionFrom = next.current
        next.transitionStyle = a.transitionStyle
        next.transitionSerial = (next.transitionSerial ?? 0) + 1
        if (a.transitionStyle === 'none') next.transitionMs = 0
        next.transition = a.transitionStyle || a.transitionShouldSmartAnimate === false
''',1)
 return s
edit('frontend/design-client/src/prototype.ts',ts)
edit('frontend/design-client/src/model.ts',lambda s:s.replace('  const style = (s: any) => s?.verticalAlign', '''  const action = (a: import('./prototype').PrototypeAction): boolean => a.transitionStyle !== undefined || !!a.thenActions?.some(action) || !!a.elseActions?.some(action)
  if (Object.values(d.prototype?.interactions||{}).some(es=>es.some(e=>e.actions.some(action)))) return true
  const style = (s: any) => s?.verticalAlign''',1))
edit('frontend/design-client/src/automation/interactions.ts',lambda s:s.replace("const keys=['expression'", "const keys=['transitionStyle','expression'",1).replace("if(a.kind==='set-variable'", "if(a.transitionStyle!==undefined && (!['none','slide-left','slide-right','slide-top','slide-bottom'].includes(String(a.transitionStyle)) || !['navigate','back'].includes(String(a.kind)))) throw new Error('Invalid directional transition')\n        if(a.kind==='set-variable'",1))
def player(s):
 s=s.replace('if (!transition || !state.transitionMs) { setProgress(1); return }',"if ((!transition && !state.transitionStyle?.startsWith('slide-')) || !state.transitionMs) { setProgress(1); return }",1)
 s=s.replace('  }, [transition, state.transitionMs])','  }, [transition, state.transitionMs, state.transitionSerial, state.transitionStyle])',1)
 a=s.index('  const previousScroll =')
 s=s[:a]+'''  const slideProgress = prototypeEase(state.transitionEasing, progress)
  const slideOffset = state.transitionStyle?.startsWith('slide-') && progress < 1
    ? `${state.transitionStyle==='slide-left'?-(1-slideProgress)*100:state.transitionStyle==='slide-right'?(1-slideProgress)*100:0}%,${state.transitionStyle==='slide-top'?-(1-slideProgress)*100:state.transitionStyle==='slide-bottom'?(1-slideProgress)*100:0}%` : '0%,0%'
  const previousEntry = state.transitionFrom ? entries.find(e=>e.id===state.transitionFrom) : undefined
  const previousDoc = useMemo(()=> {
    if (!state.transitionFrom || !settled.nodes[state.transitionFrom]) return undefined
    const d = structuredClone(settled)
    d.pages = d.pages.map(p=>({...p,children:p.id===page.id?[state.transitionFrom!]:[]}))
    return d
  }, [settled,state.transitionFrom,page.id])
'''+s[a:]
 s=s.replace('''            <div
              key={current}''','''            {previousDoc && previousEntry && state.transitionStyle?.startsWith('slide-') && progress<1 && <div aria-hidden="true" style={{position:'absolute',inset:0,pointerEvents:'none'}}>
              <KernelSurface document={previousDoc} pageId={page.id} width={Math.ceil(frame.width*zoom)} height={Math.ceil(frame.height*zoom)} view={{x:-previousEntry.bounds.x*zoom,y:-previousEntry.bounds.y*zoom,zoom}} grid={false}/>
            </div>}
            <div
              key={current}''',1)
 s=s.replace('''                height: frame.height * zoom,

''','''                height: frame.height * zoom,
                transform: `translate(${slideOffset})`,
                background: '#fff',
''',1)
 return s
edit('frontend/design-client/src/PrototypePlayer.tsx',player)
edit('frontend/design-client/src/DesignTools.tsx',lambda s:s.replace('''                          <select
                            aria-label="过渡曲线"''','''                          <select
                            aria-label="过渡曲线"''',1)) if False else None
