import {useEffect,useRef,useState} from 'react'
import type {SketchDisplaySnapshot} from '../../design-desktop/src/sketch-display-contract.mjs'
import type {DesignDocument,Bounds} from './model'
import {sketchDisplayDocument} from './sketch-display'
import {KernelSurface} from './kernel/Surface'
import {fitBounds,zoomAt,type CanvasCamera} from './canvas-camera'
import {apply,boxPoints,bounds,unionBounds} from './geometry'
import { fontReplacementSummary, useProfessionalDialogText } from './professional-dialog-messages'

export function SketchDisplayPreview({snapshot}:{snapshot:SketchDisplaySnapshot}){
  const { locale, tr } = useProfessionalDialogText()
  const host=useRef<HTMLDivElement>(null),[root,setRoot]=useState(snapshot.artboards[0]||''),[document,setDocument]=useState<DesignDocument|null>(null),[error,setError]=useState(''),[ready,setReady]=useState(false)
  const [size,setSize]=useState({width:900,height:520}),[view,setView]=useState<CanvasCamera>({x:0,y:0,zoom:1})
  const navigated=useRef(false)
  const drag=useRef<{pointer:number;x:number;y:number;view:CanvasCamera}|null>(null),extent=useRef<Bounds>({x:0,y:0,width:1,height:1})
  useEffect(()=>{const target=host.current;if(!target)return;const observer=new ResizeObserver(()=>setSize({width:Math.max(1,target.clientWidth),height:Math.max(1,target.clientHeight)}));observer.observe(target);return()=>observer.disconnect()},[])
  useEffect(()=>{setRoot(snapshot.artboards[0]||'')},[snapshot.owner.document_id,snapshot.pageId])
  useEffect(()=>{
    let current=true;navigated.current=false;setDocument(null);setReady(false);setError('');drag.current=null
    void sketchDisplayDocument(snapshot,root).then(doc=>{
      if(!current)return
      const boxes=doc.pages[0].children.map(id=>{const n=doc.nodes[id];return bounds(boxPoints({x:0,y:0,width:n.width,height:n.height}).map(p=>apply(n.transform,p)))})
      extent.current=unionBounds(boxes);setDocument(doc);setView(fitBounds(extent.current,size,{padding:24,maxZoom:1}))
    },e=>{if(current)setError(String(e))})
    return()=>{current=false}
  },[snapshot,root])
  useEffect(()=>{if(document&&!navigated.current)setView(fitBounds(extent.current,size,{padding:24,maxZoom:1}))},[size.width,size.height,document])
  useEffect(()=>setReady(false),[view.x,view.y,view.zoom,document,size.width,size.height])
  const fit=()=>{navigated.current=false;setView(fitBounds(extent.current,size,{padding:24,maxZoom:1}))}
  const zoom=(scale:number)=>{navigated.current=true;setView(v=>zoomAt(v,scale,{x:size.width/2,y:size.height/2}))}
  useEffect(()=>{
    const target=host.current;if(!target)return
    const wheel=(e:WheelEvent)=>{navigated.current=true;e.preventDefault();e.stopPropagation();const b=target.getBoundingClientRect();setView(v=>e.ctrlKey||e.metaKey?zoomAt(v,v.zoom*Math.exp(-e.deltaY*.01),{x:e.clientX-b.left,y:e.clientY-b.top}):{...v,x:v.x-e.deltaX,y:v.y-e.deltaY})}
    target.addEventListener('wheel',wheel,{passive:false});return()=>target.removeEventListener('wheel',wheel)
  },[])
  return <div className="sketch-display-preview" data-testid="sketch-display-preview" data-ready={ready}>
    <div className="sketch-preview-controls">
      <label>{tr('画板')}<select aria-label={tr('Sketch 预览画板')} value={root} onChange={e=>setRoot(e.target.value)}>{snapshot.artboards.length?snapshot.artboards.map(id=><option key={id} value={id}>{snapshot.document.nodes[id].name||id}</option>):<option value="">{tr('当前页面')}</option>}</select></label>
      <button type="button" onClick={fit}>{tr('适合画板')}</button><button type="button" onClick={()=>zoom(1)}>100%</button><button type="button" onClick={()=>zoom(view.zoom/1.25)}>−</button><span>{Number((view.zoom*100).toFixed(1))}%</span><button type="button" onClick={()=>zoom(view.zoom*1.25)}>＋</button>
    </div>
    <p role="status">{error?tr(error):(!document?tr('正在准备原生图层…'):ready?tr('原生图层已完成绘制；拖动平移，滚轮导航，⌘/Ctrl＋滚轮缩放'):tr('正在按文档精度绘制…'))}</p>
    {snapshot.warnings.map((warning,i)=><p className="muted" key={i}>{warning}</p>)}
    <div ref={host} className="sketch-native-canvas" role="application" aria-label={tr('Sketch 原生只读画布')} data-camera-x={view.x} data-camera-y={view.y} data-camera-zoom={view.zoom} data-testid="sketch-native-canvas" tabIndex={-1}
      onKeyDown={e=>{e.stopPropagation();if(e.key==='0'){e.preventDefault();zoom(1)}if(e.key==='1'){e.preventDefault();fit()}}}
      onPointerDown={e=>{e.stopPropagation();if(e.button!==0&&e.button!==1)return;e.preventDefault();e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);navigated.current=true;drag.current={pointer:e.pointerId,x:e.clientX,y:e.clientY,view}}}
      onPointerMove={e=>{e.stopPropagation();const a=drag.current;if(a?.pointer===e.pointerId)setView({...a.view,x:a.view.x+e.clientX-a.x,y:a.view.y+e.clientY-a.y})}}
      onPointerUp={e=>{e.stopPropagation();const a=drag.current;if(a?.pointer===e.pointerId){setView({...a.view,x:a.view.x+e.clientX-a.x,y:a.view.y+e.clientY-a.y});drag.current=null}}}
      onPointerCancel={()=>{drag.current=null}} onLostPointerCapture={()=>{drag.current=null}}>
      {document&&<KernelSurface key={`${snapshot.owner.document_id}:${snapshot.revision}:${root}`} document={document} pageId={snapshot.pageId} view={view} width={size.width} height={size.height} grid={false} onPresentation={frame=>setReady(!!frame&&frame.document===document&&frame.view.x===view.x&&frame.view.y===view.y&&frame.view.zoom===view.zoom&&frame.width===size.width&&frame.height===size.height)} onRenderFailure={()=>setReady(false)}/>}
    </div>
    <details><summary>{fontReplacementSummary(snapshot.sourceFonts.length, locale)}</summary><p>{snapshot.sourceFonts.join(locale === 'en' ? ', ' : '、')}</p></details>
  </div>
}
