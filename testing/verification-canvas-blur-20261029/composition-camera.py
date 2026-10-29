"""An archived native model is used only to locate a real source contour.
The measured packet is subsequently compiled from the current full source."""
from pathlib import Path
import ijson,json
inventory=json.loads(Path('/tmp/futureox-topology-blur-inputs-20261029/inventory.json').read_text())
root=next(r for r in inventory['roots'] if r['id']=='B4F79D9D-73A9-4CFA-A0C2-BA3610CC6105')
raw=json.loads((Path('/tmp/futureox-topology-blur-inputs-20261029')/root['fixture']).read_text())
ids=set();stack=[raw]
while stack:
 n=stack.pop();ids.add(n['do_objectID']);stack+=n.get('layers',[])
nodes={}
with open('/tmp/topology-single-canvas-native-20261027-v1.json','rb') as stream:
 for key,value in ijson.kvitems(stream,'nodes',use_float=True):
  if key in ids:nodes[key]=value
assert len(nodes)==len(ids)
top=nodes[root['id']];assert top['transform'][:4]==[1,0,0,1]
top['transform'][4:]=[raw['frame']['x'],raw['frame']['y']]
def mul(a,b):return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]]
found=[];stack=[(root['id'],[1,0,0,1,0,0],True)]
while stack:
 id,parent,visible=stack.pop();n=nodes[id];m=mul(parent,n['transform']);visible=visible and n['visible']
 stack += [(child,m,visible) for child in n['children']]
 effects=[f for f in n['effects'] if f['visible'] and f['kind'] in ['blur','gaussian-blur'] and f['radius']>0]
 if visible and effects and n['width']>5 and n['height']>5:
  vertices=(n.get('network') or {}).get('vertices',[])
  px,py=(vertices[0]['x'],vertices[0]['y']) if vertices else (n['width']/2,0)
  found.append({'nodeId':id,'name':n['name'],'radius':max(f['radius'] for f in effects),
   'point':[m[4]+m[0]*px+m[2]*py,m[5]+m[1]*px+m[3]*py]})
assert found
target=max(found,key=lambda n:n['radius'])
Path('testing/verification-canvas-blur-20261029/composition-camera.json').write_text(json.dumps({'scope':'Camera hint only; no old model pixels used','root':root,'target':target},ensure_ascii=False,indent=2))
print(json.dumps(target,ensure_ascii=False))
