from pathlib import Path
import copy,json,uuid,zipfile
out=Path(__file__).parent
source=out.parent/'verification-sketch-effects-20261026/blur-oracle.sketch'
with zipfile.ZipFile(source) as z: files={n:z.read(n) for n in z.namelist()}
pn=next(n for n in files if n.startswith('pages/') and n.endswith('.json'))
page=json.loads(files[pn]);base=page['layers'][0];layers=[]
for bits in range(8):
 sid=str(uuid.uuid4()).upper();master=copy.deepcopy(base)
 master.update(_class='symbolMaster',do_objectID=sid,symbolID=sid,name=f'master-{bits}',frame={'_class':'rect','x':bits*350,'y':0,'width':100,'height':100},resizesContent=True,hasBackgroundColor=False)
 child=copy.deepcopy(base['layers'][0]);child.update(_class='rectangle',do_objectID=str(uuid.uuid4()).upper(),name=f'child-{bits}',frame={'_class':'rect','x':20,'y':20,'width':30,'height':30},resizingConstraint=bits|(bits<<3),isClosed=True,points=[])
 child.pop('image',None);child['style']['blur']['isEnabled']=False
 master['layers']=[child]
 instance=copy.deepcopy(master);instance.update(_class='symbolInstance',do_objectID=str(uuid.uuid4()).upper(),name=f'instance-{bits}',frame={'_class':'rect','x':bits*350,'y':200,'width':200,'height':200},scale=1,overrideValues=[],resizingConstraint=63)
 del instance['layers'];layers.extend([master,instance])
page['layers']=layers;files[pn]=json.dumps(page).encode()
meta=json.loads(files['meta.json']);meta['version']=136;files['meta.json']=json.dumps(meta).encode()
with zipfile.ZipFile(out/'resize-oracle.sketch','w',zipfile.ZIP_DEFLATED) as z:
 for n,b in files.items():z.writestr(n,b)
(out/'resize-input.json').write_text(json.dumps(page,indent=2))
