"""Stream all source/export ZIP members; never rewrite the user's source."""
import zipfile,hashlib,json,sys,pathlib
out=pathlib.Path('testing/verification-topology-repairs-20261023');run=sys.argv[1];record=json.loads((out/(run+'.json')).read_text());source=pathlib.Path('/Users/Apple/Downloads/拓扑素材.sketch');export=pathlib.Path(record['exportFile'])
def sha(stream):
 h=hashlib.sha256()
 while b:=stream.read(1024*1024):h.update(b)
 return h.hexdigest()
with source.open('rb')as f:before=sha(f)
assert before=='b70f04948a8729d99224d94cd5328ad67673aa20d7c17d11bba3986c151c6c12'
rows=[]
with zipfile.ZipFile(source)as a,zipfile.ZipFile(export)as b:
 assert a.namelist()==b.namelist()
 for name in a.namelist():
  with a.open(name)as x,b.open(name)as y:old,new=sha(x),sha(y)
  rows.append(dict(name=name,sourceSha256=old,exportSha256=new,byteEqual=old==new))
assert len(rows)==64
assert sum(r['byteEqual']for r in rows)==63
# Stronger than archive membership: the only changed member must equal the
# original byte-for-byte after removing exactly the three intended suffixes.
changed=next(r for r in rows if not r['byteEqual']);tokens=[(' · render-check-'+str(i)).encode() for i in range(3)];counts=[0,0,0];h=hashlib.sha256();pending=b''
with zipfile.ZipFile(export)as z,z.open(changed['name'])as stream:
 while block:=stream.read(1024*1024):
  pending+=block
  for i,token in enumerate(tokens):counts[i]+=pending.count(token);pending=pending.replace(token,b'')
  if len(pending)>64:h.update(pending[:-64]);pending=pending[-64:]
 h.update(pending)
assert counts==[1,1,1],counts
assert h.hexdigest()==changed['sourceSha256'], 'Unexpected source changes beyond the three renamed roots'
result=dict(sourceSha256=before,members=64,unchanged=63,changedMemberOnlyThreeNameSuffixes=True,changed=[r['name']for r in rows if not r['byteEqual']],guiReopened=all(r.get('guiReopened')for r in record['cases']),rows=rows)
(out/(run+'-archive.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items()if k!='rows'},ensure_ascii=False))
