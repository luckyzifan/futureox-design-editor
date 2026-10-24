import{readFileSync,writeFileSync}from'node:fs'
import path from'node:path'
import{NativePreparation}from'../../frontend/design-desktop/src/preparation.mjs'
const out=path.resolve('testing/verification-render-smooth-color-20261024'),old=JSON.parse(readFileSync('testing/verification-topology-repairs-20261023/baseline-manifest.json','utf8'))
const doc=JSON.parse(readFileSync(path.join(old.privateRuntimeRoot,'source-fixtures/1-5.json'),'utf8')),root='07F03595-9FF3-4E4C-B469-482E0F559564',nodes={};function include(id){nodes[id]=doc.nodes[id];for(const child of nodes[id].children)include(child)}include(root)
doc.nodes=nodes;doc.pages=doc.pages.slice(0,1);doc.pages[0].children=[root];writeFileSync(path.join(out,'icon-scene.json'),JSON.stringify(doc))
const client=new NativePreparation(path.resolve('frontend/design-desktop/dist/bin/design-prepare'),path.resolve('frontend/design-desktop/dist/fonts/NotoSansSC.ttf'))
const options=JSON.stringify({pageId:doc.pages[0].id,width:140,height:140,view:{x:-120,y:-80,zoom:1},grid:false,transparent:false,rasterProfile:'figma'})
try{for(const [method,args]of [['initialize',[false]],['load_document',[JSON.stringify(doc)]],['render_color_png',[options,JSON.stringify({space:'srgb',toneMap:'clip'})]]]){const at=performance.now(),r=await client.request({lane:'canvas',method,args});if(r.error)throw Error(r.error);if(method==='render_color_png')writeFileSync(path.join(out,'icon-cpu.png'),r.value);console.log(method,performance.now()-at)}}finally{await client.close()}
