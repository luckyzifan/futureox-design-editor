"""Make deterministic inputs. Pass the directory containing 117.json from the probe."""
import json, random, sys
from pathlib import Path

folder = Path(sys.argv[1])
def write(name, value):
    (folder/(name+'.json')).write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')))
def node(id, kind, x, y, w, h, color, **fields):
    return dict(id=id, kind=kind, transform=[1,0,0,1,x,y], width=w, height=h,
                fills=[dict(kind='solid',color=color)] if color else [], **fields)
def document(nodes, roots):
    return dict(schemaVersion=19, id='cpu-frame', name='CPU frame', pages=[dict(id='p',name='p',children=roots,background='#203040')],
                colorManagement=dict(documentSpace='srgb',referenceWhiteNits=203,peakLuminanceNits=1000),
                nodes={n['id']:n for n in nodes})
def opts(page, w, h, x=0.25, y=-0.375, profile='figmaSubpixel'):
    return dict(pageId=page,width=w,height=h,view=dict(x=x,y=y,zoom=1),rasterProfile=profile)

rng = random.Random(20261105)
nodes = [node(f'r{i:04}', 'rectangle' if i%3 else 'ellipse', rng.randrange(8192), rng.randrange(8192),
              9+i%19, 7+i%17, '#9966ff') for i in range(3000)]
write('sparse', document(nodes,[n['id'] for n in nodes]))
real = json.loads((folder/'117.json').read_text())
for side in [512,1024,2048]:
    write(f'sparse-{side}',opts('p',side,side))
    write(f'117-{side}',opts(real['pages'][0]['id'],side,side,-1024.25,-256.5))
    view=opts(real['pages'][0]['id'],side,side,225.25,-160.375)
    view['view']['zoom']=0.5
    write(f'117-overview-{side}',view)

for mode in ['blur','backdrop','mask','zoom','hdr']:
    b = 256 if mode=='hdr' else 512
    size = (b+57,b+29)
    write(mode+'-view',opts('p',*size,profile='figma' if mode=='hdr' else 'figmaSubpixel'))
    for enabled in [False,True]:
        nodes = []
        roots = []
        def root(n):
            nodes.append(n); roots.append(n['id'])
        if mode in ['blur','zoom','hdr']:
            root(node('cross','ellipse',b-20.25,b-19.125,45.5,39.25,
                      'color(srgb-linear 3 -0.1 1.5)' if mode=='hdr' and enabled else '#fa9020',
                      effects=([dict(kind='blur',radius=6,color='#000000')] if mode=='blur'
                          else [dict(kind='zoom-blur',radius=0,color='#000000',zoomBlur=dict(amount=35,center=[0.15,0.9]))])
                          if mode!='hdr' and enabled else []))
        if mode=='backdrop':
            root(node('stripe','rectangle',b-2,b-42,5,81,'#ff8800'))
            root(node('lens','rectangle',b-30,b-28,65,62,'#8899aa',
                      effects=[dict(kind='background-blur',radius=7,color='#000000')] if enabled else []))
            nodes[-1]['fills'][0]['opacity']=0.15
        if mode=='mask':
            root(node('g','group',0,0,*size,None,children=['mask','a','b']))
            nodes += [node('mask','ellipse',b-20.3,b-24.5,45,46,'#ffffff',mask=True,opacity=0.45 if enabled else 1.),
                      node('a','rectangle',b-26,b-39,63,77,'#f05020'),node('b','rectangle',b-11,b-29,37,60,'#0066df')]
        write(mode+('' if enabled else '-off'), document(nodes,roots))
