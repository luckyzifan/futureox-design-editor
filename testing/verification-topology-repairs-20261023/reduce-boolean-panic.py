exec(open('testing/verification-topology-repairs-20261023/isolate-boolean-panic.py').read().split('for n in doc')[0])
original=json.load(open(pathlib.Path(m['privateRuntimeRoot'])/'boolean-panic.json'));rid=original['pages'][0]['children'][0];root=original['nodes'][rid];children=root['children']
def fixture(ids):
 keep=['kind','transform','width','height','network','vectorGeometry','booleanOperation']
 nodes={'result':dict({k:v for k,v in root.items() if k in keep},id='result',children=[str(i)for i in ids],fills=[dict(kind='solid',color='#000000')])}
 for i in ids:nodes[str(i)]=dict({k:v for k,v in original['nodes'][children[i]].items() if k in keep},id=str(i),children=[])
 return dict(schemaVersion=16,id='boolean-ray-order',name='Coincident polygon rays',pages=[dict(id='p',name='p',children=['result'],background='#ffffff')],nodes=nodes)
def panic(ids):
 d=fixture(ids);req=[('initialize',[False]),('load_document',[json.dumps(d)]),('compile_gpu_packet',[json.dumps(dict(pageId='p',width=128,height=128,view=dict(x=0,y=0,zoom=1),transparent=False,grid=False,rasterProfile='figma'))])]
 wire=''.join(json.dumps(dict(id=i+1,lane='canvas',method=method,args=args))+'\n' for i,(method,args)in enumerate(req))
 r=subprocess.run([binary,'--font',font],input=wire.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
 return r.returncode==101 and b'total order' in r.stderr
ids=list(range(len(children)));assert panic(ids)
size=len(ids)//2
while size:
 removed=False
 for start in range(0,len(ids),size):
  candidate=ids[:start]+ids[start+size:]
  if candidate and panic(candidate):ids=candidate;removed=True;print('remaining',len(ids),flush=True);break
 if not removed:size//=2
final=fixture(ids);file=out/'boolean-ray-order-regression.json';file.write_text(json.dumps(final,ensure_ascii=False,separators=(',',':'))+'\n');print(str(file),ids,flush=True)
