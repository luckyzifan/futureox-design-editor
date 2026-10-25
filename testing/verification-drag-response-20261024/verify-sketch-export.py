"""Read-only ZIP member and streaming JSON-event comparison of the actual export."""
import sys,json,hashlib,zipfile,pathlib,itertools,decimal
out=pathlib.Path('testing/verification-drag-response-20261024')
baseline=json.loads((out/'baseline.json').read_text())
sys.path.insert(0,'/var/folders/w8/x8s0mxjd1f38qc493f2g8rpr0000gn/T/fig-import-20261024-53ubdlbl/verification-python')
import ijson
run=sys.argv[1]
record=json.loads((out/(run+'.json')).read_text())
source=pathlib.Path('/Users/Apple/Downloads/拓扑素材.sketch')
export=pathlib.Path(record['exportFile'])
cases={r['id']:r for r in json.loads((out/'sketch-cases.json').read_text())}
def sha(f):
 h=hashlib.sha256()
 while b:=f.read(1024*1024):h.update(b)
 return h.hexdigest()
def events(stream):
 stack=[]
 for event,value in ijson.basic_parse(stream):
  if event=='map_key':stack[-1]['key']=value;continue
  if event.startswith('end_'):
   frame=stack.pop();yield frame['path'],event,None;continue
  if not stack:p=()
  else:
   parent=stack[-1]
   if parent['kind']=='start_array':p=parent['path']+(parent['index'],);parent['index']+=1
   else:p=parent['path']+(parent['key'],)
  yield p,event,value
  if event in ('start_map','start_array'):stack.append({'kind':event,'path':p,'index':0,'key':None})
def semantic_events(stream):
 known={};capture=None;objects=[];root_value=None
 for p,event,value in events(stream):
  if event=='string' and p[-1:]==('do_objectID',) and value in cases:known[p[:-1]]=value
  if capture is None and event=='start_map' and p[-1:]==('style',) and p[:-1] in known:
   capture=p;root_value={};objects=[root_value];continue
  if capture is not None:
   if event.startswith('end_'):
    objects.pop()
    if not objects:yield capture,'style',root_value;capture=None
   else:
    child={} if event=='start_map' else [] if event=='start_array' else value
    parent=objects[-1]
    if isinstance(parent,list):parent.append(child)
    else:parent[p[-1]]=child
    if event in ('start_map','start_array'):objects.append(child)
   continue
  yield p,event,value
with source.open('rb')as f:source_hash=sha(f)
assert source_hash=='b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12'
rows=[];changes=[];owners={};unexpected=[]
with zipfile.ZipFile(source)as a,zipfile.ZipFile(export)as b:
 assert a.namelist()==b.namelist()
 for name in a.namelist():
  with a.open(name)as x,b.open(name)as y:old,new=sha(x),sha(y)
  rows.append({'name':name,'sourceSha256':old,'exportSha256':new,'byteEqual':old==new})
  if old==new:continue
  assert name.endswith('.json')
  with a.open(name)as x,b.open(name)as y:
   for left,right in itertools.zip_longest(semantic_events(x),semantic_events(y)):
    if left==right:
     if left and left[1]=='string' and left[0][-1:] == ('do_objectID',) and left[2] in cases:owners[left[0][:-1]]=left[2]
     continue
    if not left or not right:raise AssertionError('JSON event count changed')
    p,event,v=left;q,event2,w=right
    owner=next((node for path,node in owners.items() if p==path+('name',) or p==path+('style',)),None)
    valid=p==q and event==event2 and owner and p[-1]=='name' and v==cases[owner]['originalName'] and w==cases[owner]['expectedName']
    if p==q and event==event2=='style' and owner:
     import copy
     expected=copy.deepcopy(v)
     if 'contextSettings' not in expected:expected['contextSettings']={'_class':'graphicsContextSettings','blendMode':0,'isProgressive':False}
     expected['contextSettings']['opacity']=decimal.Decimal('0.9')
     valid=expected==w
    change={'member':name,'path':list(p),'before':str(v),'after':str(w),'owner':owner}
    if valid:changes.append(change)
    else:
     unexpected.append({'beforeEvent':str(left),'afterEvent':str(right)})
     if len(unexpected)>=20:break
result={'sourceSha256':source_hash,'members':len(rows),'unchangedMembers':sum(r['byteEqual']for r in rows),'semanticChanges':changes,'unexpected':unexpected,'rows':rows}
(out/(run+'-archive.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2))
assert not unexpected,unexpected[:2]
assert len(rows)==64 and result['unchangedMembers']==63
assert len(changes)==6 and all(sum(c['owner']==owner for c in changes)==2 for owner in cases)
print(json.dumps({k:v for k,v in result.items()if k!='rows'},ensure_ascii=False))
