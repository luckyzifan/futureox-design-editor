import json,subprocess,os,pathlib
out=pathlib.Path('testing/verification-topology-repairs-20261023');m=json.loads((out/'baseline-manifest.json').read_text());fixture=json.loads((out/'source-fixtures.json').read_text())['records'][1];doc=json.load(open(fixture['file']))
binary=str(pathlib.Path(m['privateRuntimeRoot'])/'source-gui-2-runtime/host/dist/bin/design-prepare');font='frontend/design-desktop/dist/fonts/NotoSansSC.ttf'
for n in doc['nodes'].values():
 if not n.get('booleanOperation'):continue
 nodes={}
 def include(i):
  nodes[i]=doc['nodes'][i]
  for c in nodes[i]['children']:include(c)
 include(n['id']);single=dict(doc,nodes=nodes,pages=[dict(doc['pages'][0],children=[n['id']])]);source=json.dumps(single)
 opts=dict(pageId=single['pages'][0]['id'],width=64,height=64,view=dict(x=0,y=0,zoom=.1),transparent=False,grid=False,rasterProfile='figma')
 req=[('warm_resources',[]),('initialize',[False]),('load_document',[source]),('compile_gpu_packet',[json.dumps(opts)])]
 wire=''.join(json.dumps(dict(id=i+1,lane='canvas',method=method,args=args))+'\n' for i,(method,args) in enumerate(req))
 r=subprocess.run([binary,'--font',font],input=wire.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=dict(os.environ,RUST_BACKTRACE='1',CORE_DOCUMENT_MEMORY_BYTES='1219977216'),timeout=30)
 print(n['id'],len(nodes),r.returncode,flush=True)
 if r.returncode:
  file=pathlib.Path(m['privateRuntimeRoot'])/'boolean-panic.json';file.write_text(source);(out/'boolean-panic-isolation.json').write_text(json.dumps(dict(id=n['id'],nodes=len(nodes),file=str(file),stderr=r.stderr.decode(),sourceFixtureSha256=fixture['sha256']),indent=2));break
