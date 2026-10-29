from pathlib import Path
import copy,io,json,uuid,zipfile
from PIL import Image
out=Path(__file__).parent
source=out.parent/'verification-sketch-canvas-support-20261026/canvas-bitmap-oracle.sketch'
with zipfile.ZipFile(source) as z:files={n:z.read(n) for n in z.namelist()}
page_name=next(n for n in files if n.startswith('pages/'))
page=json.loads(files[page_name]);base=page['layers'][0];boards=[]
images={}
for name in ['box','stripe','point']:
 im=Image.new('RGBA',(64,64),(0,0,0,0))
 if name=='box':im.paste((255,255,255,255),(0,0,64,64))
 elif name=='stripe':im.paste((255,255,255,255),(32,0,33,64))
 else:im.putpixel((48,32),(255,255,255,255))
 b=io.BytesIO();im.save(b,format='PNG');images['images/'+name+'.png']=b.getvalue()
cases=[]
for kind in [0,1,2]:
 for radius in [1,5,10,20]:cases.append((kind,radius,0,'{0.5, 0.5}','box'))
for angle in [0,30,90]:
 cases.append((1,10,angle,'{0.5, 0.5}','stripe'))
for radius in [10,40]:
 cases.append((2,radius,0,'{0.5, 0.5}','point'))
 cases.append((2,radius,0,'{0.25, 0.75}','box'))
for i,(kind,radius,angle,center,image) in enumerate(cases):
 name=f't{kind}-r{radius}-a{angle}-{image}'+('-offset' if center!='{0.5, 0.5}' else '')
 b=copy.deepcopy(base);b.update(do_objectID=str(uuid.uuid4()).upper(),name=name,frame={'_class':'rect','x':320*i,'y':0,'width':256,'height':192},hasBackgroundColor=False,includeBackgroundColorInExport=False)
 n=b['layers'][0];n.update(do_objectID=str(uuid.uuid4()).upper(),name=name+'-source',frame={'_class':'rect','x':96,'y':64,'width':64,'height':64})
 n['image']['_ref']='images/'+image+'.png';n['style'].pop('colorControls',None)
 n['style']['blur']={'_class':'blur','isEnabled':True,'type':kind,'radius':radius,'motionAngle':angle,'center':center,'saturation':1}
 boards.append(b)
page['layers']=boards;files[page_name]=json.dumps(page,separators=(',',':')).encode()
for k in list(files):
 if k.startswith('images/'):del files[k]
files.update(images)
with zipfile.ZipFile(out/'blur-oracle.sketch','w',zipfile.ZIP_DEFLATED) as z:
 for name,data in files.items():z.writestr(name,data)
(out/'oracle-cases.json').write_text(json.dumps(cases,indent=2)+'\n')
print(len(cases),'native effect cases')
