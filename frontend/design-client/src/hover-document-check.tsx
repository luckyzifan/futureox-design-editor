import { createRoot } from 'react-dom/client'
import { Canvas } from './Canvas'
import { Editor } from './engine'
import { node, type DesignDocument } from './model'
import { scene, apply, inverse, multiply } from './geometry'
import { initializePicking } from './kernel/picking'
import './styles.css'
const output=document.querySelector('#results')!, report:{status:string;stages:unknown[];error?:string}={status:'running',stages:[]}
const publish=async()=>{output.textContent=JSON.stringify(report,null,2);await fetch('/__render_report',{method:'POST',body:JSON.stringify(report)})}
const frame=()=>new Promise(requestAnimationFrame)
try {
 await initializePicking()
 const params=new URLSearchParams(location.search), uiKit=params.has('ui-kit')
 const input=await(await fetch(uiKit?'/__render_fixture':'/__render_fixture_117')).json(),doc:DesignDocument=input.document||input
 const page=doc.pages[0],wrap=node('group',0,0,30000,10000)
 wrap.name='117 wrapper';wrap.children=[...page.children];doc.nodes[wrap.id]=wrap;page.children=[wrap.id]
 const entries=scene(doc,page.id), board=uiKit?entries.find(e=>doc.nodes[e.id].name==='08_E-Mail_Inbox'):undefined
 const target=entries.filter(e=>doc.nodes[e.id].kind==='text'&&(!board||e.ancestors.includes(board.id))).sort((a,b)=>doc.nodes[b.id].fontSize-doc.nodes[a.id].fontSize)[0]
 if(!target)throw Error('Real text target required')
 const text=doc.nodes[target.id],point=apply(target.matrix,{x:text.width/2,y:text.height/2})
 let covering:string|undefined
 if(board){
  // Reproduce a larger, later sibling container claiming the same point;
  // keep the real artwork intact and do not persist this fixture mutation.
  const larger=node('frame',0,0,text.width+20,text.height+20)
  larger.fills=[];larger.clip=false;larger.name='Hover container regression'
  larger.transform=multiply(inverse(board.matrix),multiply(target.matrix,[1,0,0,1,-10,-10]))
  doc.nodes[larger.id]=larger;doc.nodes[board.id].children.push(larger.id);covering=larger.id
 }
 const editor=new Editor(doc)
 if(board)editor.select([board.id])
 editor.set({view:{x:500-point.x,y:360-point.y,zoom:1}})
 createRoot(document.querySelector('#root')!).render(<Canvas editor={editor}/> )
 const started=performance.now()
 while(document.querySelector<HTMLElement>('.kernel-tiles')?.dataset.detailReady!=='true'){
  if(performance.now()-started>90000)throw Error('Real document did not settle')
  await frame()
 }
 const host=document.querySelector<HTMLElement>('#design-canvas-view')!,rect=host.getBoundingClientRect()
 const at=()=>({clientX:rect.left+point.x*editor.state.view.zoom+editor.state.view.x,clientY:rect.top+point.y*editor.state.view.zoom+editor.state.view.y})
 host.dispatchEvent(new PointerEvent('pointermove',{...at(),bubbles:true,pointerId:9,pointerType:'mouse',isPrimary:true}))
 for(let i=0;i<8;i++)await frame()
 const outline=document.querySelector<SVGElement>('[data-testid="canvas-hover-outline"]')
 report.stages.push({name:'hover text without layers panel',nodes:Object.keys(doc.nodes).length,target:target.id,text:text.text,hover:editor.state.hover,outline:!!outline,visible:!!outline&&getComputedStyle(outline).visibility==='visible',selection:[...editor.state.selection]});await publish()
 if(editor.state.hover!==target.id||!outline||getComputedStyle(outline).visibility!=='visible')throw Error('Nested text hover outline missing')
 if(board){
  const front=editor.hit(point,true)
  report.stages.push({name:'small label beats covering container while board remains selected',frontmost:front,covering,hover:editor.state.hover,selected:editor.state.selection})
  if(front!==covering||editor.state.selection[0]!==board.id)throw Error('Missing container-priority regression fixture')
  report.status='passed';await publish()
 }else{
 host.dispatchEvent(new MouseEvent('dblclick',{...at(),bubbles:true,detail:2}))
 for(let i=0;i<8;i++)await frame()
 const editable=host.querySelector('textarea,[contenteditable="true"]')
 report.stages.push({name:'double click text directly',editing:!!editable,selection:[...editor.state.selection]})
 if(!editable||editor.state.selection[0]!==target.id)throw Error('Double click did not enter text editing')
 report.status='passed';await publish()
 }
} catch(error){report.status='failed';report.error=String(error);await publish()}
