from pathlib import Path
import copy,json,uuid,zipfile,math
out=Path(__file__).parent
with zipfile.ZipFile(out.parent/'verification-sketch-effects-20261026/blur-oracle.sketch') as z: files={n:z.read(n) for n in z.namelist()}
pn=next(n for n in files if n.startswith('pages/') and n.endswith('.json'));page=json.loads(files[pn]);base=page['layers'][0]
def color(r,g,b,a=1):return {'_class':'color','red':r,'green':g,'blue':b,'alpha':a}
def fill(c,blend=0,enabled=True):return {'_class':'fill','isEnabled':enabled,'fillType':0,'color':c,'contextSettings':{'_class':'graphicsContextSettings','blendMode':blend,'opacity':1}}
def shape(name,kind='rectangle',fills=None):
 n=copy.deepcopy(base['layers'][0]);n.pop('image',None)
 n.update(_class=kind,name=name,do_objectID=str(uuid.uuid4()).upper(),isClosed=True,edited=False,points=[],frame={'_class':'rect','x':0,'y':0,'width':64,'height':64},radius=.25,numberOfPoints=5)
 coords=[(0,0),(1,0),(1,1),(0,1)]
 if kind=='star':coords=[(.5+.5*(1 if i%2==0 else .25)*math.cos(i*math.tau/10-math.pi/2),.5+.5*(1 if i%2==0 else .25)*math.sin(i*math.tau/10-math.pi/2)) for i in range(10)]
 n['points']=[{'_class':'curvePoint','point':f'{{{x}, {y}}}','curveMode':1,'cornerRadius':0,'hasCurveFrom':False,'hasCurveTo':False} for x,y in coords]
 n['style'].update(fills=fills or [fill(color(1,0,0))],borders=[],shadows=[],innerShadows=[]);n['style']['blur']['isEnabled']=False
 return n
cases=[]
for radius in [.25,.7]:
 n=shape('star','star');n['radius']=radius;n['points']=[{'_class':'curvePoint','point':f'{{{.5+.5*(1 if i%2==0 else radius)*math.cos(i*math.tau/10-math.pi/2)}, {.5+.5*(1 if i%2==0 else radius)*math.sin(i*math.tau/10-math.pi/2)}}}','curveMode':1,'cornerRadius':0,'hasCurveFrom':False,'hasCurveTo':False} for i in range(10)];cases.append((f'star-{radius}',[n]))
for blend in [16,17]:
 for alpha in [1,.5]:cases.append((f'blend-{blend}-{alpha}',[shape('bottom',fills=[fill(color(.2,.4,.6,alpha))]),shape('top',fills=[fill(color(.7,.3,.5,alpha),blend)])]))
cases.append(('disabled-fill',[shape('disabled',fills=[fill(color(1,0,0)),fill(color(0,0,1),0,False)])]))
boards=[]
for i,(name,children) in enumerate(cases):
 b=copy.deepcopy(base);b.update(name=name,do_objectID=str(uuid.uuid4()).upper(),frame={'_class':'rect','x':i*96,'y':0,'width':64,'height':64},layers=children,hasBackgroundColor=False,includeBackgroundColorInExport=False);boards.append(b)
page['layers']=boards;files[pn]=json.dumps(page).encode()
with zipfile.ZipFile(out/'style-oracle.sketch','w',zipfile.ZIP_DEFLATED) as z:
 for n,b in files.items():z.writestr(n,b)
