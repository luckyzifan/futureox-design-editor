from pathlib import Path
import copy,json,zipfile,uuid
out=Path(__file__).parent
source=out.parent/'verification-sketch-canvas-support-20261026/canvas-bitmap-oracle.sketch'
with zipfile.ZipFile(source) as z:files={n:z.read(n) for n in z.namelist()}
pn=next(n for n in files if n.startswith('pages/'));page=json.loads(files[pn]);base=page['layers'][0];boards=[]
cases=[(0,0,1.,0),(0,3,.5,0)]+[(t,i,a,0) for t in [4,5] for i in [0,1,2,3] for a in [.25,1.]]+[(5,0,1.,m) for m in [1,2]]
for order,(t,index,intensity,mode) in enumerate(cases):
 b=copy.deepcopy(base);b['name']=f't{t}-i{index}-a{intensity}-m{mode}';b['do_objectID']=str(uuid.uuid4()).upper();b['frame']={'_class':'rect','x':order*160,'y':0,'width':128,'height':128};b['hasBackgroundColor']=False;b['includeBackgroundColorInExport']=False
 n=b['layers'][0];n['_class']='rectangle';n.pop('image',None);n['do_objectID']=str(uuid.uuid4()).upper();n['name']=b['name']+'-source';n['frame']={'_class':'rect','x':16,'y':16,'width':96,'height':96}
 n['isClosed']=True;n['edited']=False;n['fixedRadius']=0
 n['points']=[{'_class':'curvePoint','point':pt,'curveMode':1,'cornerRadius':0,'hasCurveFrom':False,'hasCurveTo':False} for pt in ['{0,0}','{1,0}','{1,1}','{0,1}']]
 n['style']={'_class':'style','fills':[{'_class':'fill','isEnabled':True,'fillType':t,'noiseIndex':index,'noiseIntensity':intensity,'noiseFillType':mode,'color':{'_class':'color','red':.2,'green':.4,'blue':.7,'alpha':1},'contextSettings':{'_class':'graphicsContextSettings','opacity':1,'blendMode':0}}],'borders':[],'shadows':[],'innerShadows':[],'contextSettings':{'_class':'graphicsContextSettings','opacity':1,'blendMode':0}}
 boards.append(b)
page['layers']=boards;files[pn]=json.dumps(page).encode()
with zipfile.ZipFile(out/'noise-oracle.sketch','w',zipfile.ZIP_DEFLATED) as z:
 for n,v in files.items():
  if not n.startswith('images/'):z.writestr(n,v)
(out/'noise-cases.json').write_text(json.dumps(cases))
