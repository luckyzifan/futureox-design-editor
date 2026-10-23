"""Validate the GUI-produced full Sketch without materializing its large page JSON."""
import argparse,zipfile,hashlib,tempfile,pathlib,shutil,json
parser=argparse.ArgumentParser();parser.add_argument('source',type=pathlib.Path);parser.add_argument('output',type=pathlib.Path);parser.add_argument('--report',default='gui-export-verification.json');args=parser.parse_args();assert pathlib.Path(args.report).name==args.report
part='pages/b5e640b2-e777-404c-b121-8e866696d553.json';object_id='3D2E8E3B-3B43-4978-987E-03D6BB354BA2'
def digest(file):
 h=hashlib.sha256()
 while chunk:=file.read(1024*1024):h.update(chunk)
 return h.hexdigest()
with zipfile.ZipFile(args.source)as before,zipfile.ZipFile(args.output)as after,tempfile.TemporaryDirectory(prefix='futureox-export-check-')as directory:
 assert before.namelist()==after.namelist();unchanged=0
 for name in before.namelist():
  if name==part:continue
  with before.open(name)as a,after.open(name)as b:assert digest(a)==digest(b),name
  unchanged+=1
 paths=[pathlib.Path(directory)/name for name in ['before.json','after.json']]
 for archive,target in zip([before,after],paths):
  with archive.open(part)as source,target.open('wb')as destination:shutil.copyfileobj(source,destination,1024*1024)
 lengths=[p.stat().st_size for p in paths]
 with paths[0].open('rb')as a,paths[1].open('rb')as b:
  prefix=0
  while True:
   x=a.read(65536);y=b.read(65536)
   if x!=y:
    prefix+=next(i for i,(l,r)in enumerate(zip(x,y))if l!=r);break
   assert x,'No GUI edit reached the exported source';prefix+=len(x)
  suffix=0
  while suffix<min(lengths)-prefix:
   count=min(65536,min(lengths)-prefix-suffix)
   a.seek(lengths[0]-suffix-count);b.seek(lengths[1]-suffix-count);x=a.read(count);y=b.read(count)
   if x!=y:
    suffix+=next(i for i,(l,r)in enumerate(zip(reversed(x),reversed(y)))if l!=r);break
   suffix+=count
  begin=max(0,prefix-65536);a.seek(begin);head=a.read(prefix-begin);root_start=begin+head.rfind(b'{');assert root_start>=begin
  values=[];ends=[]
  for stream in [a,b]:
   stream.seek(root_start);text=stream.read(65536).decode('utf8',errors='ignore');value,end=json.JSONDecoder().raw_decode(text)
   assert value['do_objectID']==object_id
   values.append(value);ends.append(root_start+len(text[:end].encode('utf8')))
  assert prefix>=root_start and lengths[0]-suffix<=ends[0] and lengths[1]-suffix<=ends[1]
  original,edited=values
  assert original['name']=='矩形 33' and original['frame']['width']==140
  assert edited['name']=='拓扑-本机JSON校验' and edited['frame']['width']==180
  assert any(p.get('isEnabled')is True for p in edited['style']['fills'])
  assert all(p in edited['style']['fills']for p in original['style']['fills']if p.get('isEnabled')is False)
 result={'members':len(before.namelist()),'unchangedMembersByteIdentical':unchanged,'editedPage':part,'selectedObjectId':object_id,'unchangedPagePrefixBytes':prefix,'unchangedPageSuffixBytes':suffix,'onlySelectedObjectSpanChanged':True,'name':edited['name'],'width':edited['frame']['width'],'disabledOriginalPaintsPreserved':True}
for name,p in [('sourceSha256',args.source),('outputSha256',args.output)]:
 with p.open('rb')as f:result[name]=digest(f)
result['outputBytes']=args.output.stat().st_size
out=pathlib.Path(__file__).resolve().parent/args.report;out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False,indent=2))
