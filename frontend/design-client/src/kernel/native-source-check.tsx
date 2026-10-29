import React,{useEffect,useRef,useState}from'react'
import{createRoot}from'react-dom/client'
import{desktopBridge,type SourceCanvasSnapshot,type LargeDocumentStatus}from'../desktop'
import{NativeSourceSurface,type NativeSourceStatus}from'./NativeSourceSurface'
import{initializeKernelModule}from'./module'

function Check(){
 const [source,setSource]=useState<SourceCanvasSnapshot>(),[opened,setOpened]=useState<LargeDocumentStatus>(),[ready,setReady]=useState(false)
 const[view,setView]=useState({x:0,y:0,zoom:1}),[size,setSize]=useState({width:1000,height:700}),[status,setStatus]=useState<NativeSourceStatus>(),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const host=useRef<HTMLDivElement>(null),drag=useRef<{x:number;y:number;view:typeof view}|undefined>(undefined)
 useEffect(()=>{void initializeKernelModule().then(()=>setReady(true),error=>setError(String(error)))},[])
 useEffect(()=>{const observer=new ResizeObserver(entries=>{const rect=entries[0].contentRect;setSize({width:rect.width,height:rect.height})});if(host.current)observer.observe(host.current);return()=>observer.disconnect()},[])
 const fit=(s=source)=>{if(!s)return;const zoom=Math.min((size.width-64)/s.bounds.width,(size.height-64)/s.bounds.height);setView({zoom,x:(size.width-s.bounds.width*zoom)/2-s.bounds.x*zoom,y:(size.height-s.bounds.height*zoom)/2-s.bounds.y*zoom})}
 const zoom=(scale:number,x=size.width/2,y=size.height/2)=>setView(old=>({zoom:scale,x:x-(x-old.x)/old.zoom*scale,y:y-(y-old.y)/old.zoom*scale}))
 const open=async()=>{
  const bridge=desktopBridge()?.largeDocument;if(!bridge){setError('需要本机桌面宿主');return}
  setBusy(true);setError('')
  try{
   if(opened){const closed=await bridge.close({owner:opened.owner,expectedRevision:opened.revision});if(closed.status!=='ok')throw Error(closed.status==='error'?closed.message:'取消');setOpened(undefined);setSource(undefined)}
   const selected=await bridge.open();if(selected.status==='cancelled')return;if(selected.status!=='ok')throw Error(selected.message)
   setOpened(selected);const snapshot=await bridge.canvasSnapshot({owner:selected.owner,expectedRevision:selected.revision})
   if(snapshot.status!=='ok')throw Error(snapshot.status==='error'?snapshot.message:'取消')
   setSource(snapshot);fit(snapshot)
  }catch(error){setError(String(error))}finally{setBusy(false)}
 }
 return <main style={{fontFamily:'system-ui',height:'100vh',display:'flex',flexDirection:'column',background:'#f5f6f8',color:'#242933'}}>
  <header style={{display:'flex',gap:16,alignItems:'center',padding:'12px 20px',background:'white',borderBottom:'1px solid #ddd'}}>
   <strong>全源单画板 · 原生渲染验证</strong><button onClick={()=>void open()} disabled={!ready||busy}>打开拓扑 Sketch</button>
   <button onClick={()=>fit()} disabled={!source}>适合画板</button><button onClick={()=>zoom(view.zoom/2)} disabled={!source}>缩小</button><button onClick={()=>zoom(view.zoom*2)} disabled={!source}>放大</button>
   <button onClick={()=>setView({zoom:32,x:size.width/2-878*32,y:size.height/2-278*32})} disabled={!source} title="固定拓扑参考视口：世界中心 (878,278)，完整源场景">入库图标 · 3200%</button>
   <label>缩放 <input aria-label="缩放百分比" type="number" value={Number((view.zoom*100).toFixed(3))} onChange={event=>{const value=Number(event.target.value)/100;if(value>0&&Number.isFinite(value))zoom(value)}} style={{width:90}}/> %</label>
  </header>
  <div role="status" style={{padding:'8px 20px',background:'white'}}>{busy?'正在构建完整源画板…':source?`${source.roots} 个素材 · ${source.nodes.toLocaleString()} 个节点 · ${status?.phase==='ready'?'WebGPU · 清晰':status?.phase==='error'?'绘制失败':`正在绘制 ${status?.done??0}/${status?.total??0}`}`:'选择源文件。此页面只验证完整场景渲染。'}</div>
  {(error||status?.error)&&<pre role="alert" style={{whiteSpace:'pre-wrap',color:'#b21f35',margin:0,padding:'12px 20px'}}>{error||status?.error}</pre>}
  <div ref={host} style={{position:'relative',flex:1,minHeight:0,overflow:'hidden',touchAction:'none',cursor:'grab'}}
   onWheel={event=>{event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();if(event.ctrlKey||event.metaKey)zoom(view.zoom*Math.exp(-event.deltaY*.01),event.clientX-rect.left,event.clientY-rect.top);else setView(old=>({...old,x:old.x-event.deltaX,y:old.y-event.deltaY}))}}
   onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);drag.current={x:event.clientX,y:event.clientY,view}}}
   onPointerMove={event=>{const start=drag.current;if(start)setView({...start.view,x:start.view.x+event.clientX-start.x,y:start.view.y+event.clientY-start.y})}}
   onPointerUp={()=>{drag.current=undefined}} onPointerCancel={()=>{drag.current=undefined}}>
   {source&&ready&&<NativeSourceSurface source={source} view={view} {...size} onStatus={setStatus}/>}
  </div>
 </main>
}
createRoot(document.getElementById('root')!).render(<Check/> )
