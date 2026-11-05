"""In a disposable source tree only: log cache ownership and per-tile timings; no pixel or scheduling changes."""
from pathlib import Path
import sys
root=Path.cwd();target=Path(sys.argv[1]);assert target.resolve()!=root.resolve()
base=Path('frontend/design-client/src/kernel')
p=base/'NativeSourceSurface.tsx';src=(root/p).read_text()
def insert(old,new):
 global src
 assert src.count(old)==1,old
 src=src.replace(old,new)
insert('    const recentNative=new Map<number,Set<string>>()','''    const detail=(event:string,v:object)=>{
      const w=window as any; (w.__tailTrace??=[]).push({t:performance.timeOrigin+performance.now(),event,...v})
    }
    const recentNative=new Map<number,Set<string>>()''')
insert('          cache.delete(tile.key);retire(tile)','''          detail('js-drop',{key:tile.key,id:tile.gpuTile,keep,size:cache.size,recent:recent(tile.key),moving})
          cache.delete(tile.key);retire(tile)''')
insert("        for(const[key,tile]of cache)if(missing.has(tile.gpuTile)){cache.delete(key);retire(tile)}","        for(const[key,tile]of cache)if(missing.has(tile.gpuTile)){detail('gpu-drop',{key,id:tile.gpuTile});cache.delete(key);retire(tile)}")
insert('          const work=workQueue.begin(batch,limit)','''          detail('choose',{keys:tiles.map(t=>t.key),missing:missing.map(t=>t.key),batch:batch.map(t=>t.key),moving,optional,view:p.view,size:cache.size,recent:[...recentNative].map(([scale,keys])=>[scale,[...keys]])})
          const work=workQueue.begin(batch,limit)''')
insert('      const {key,x,y,width,height,zoom,phaseX,phaseY,gutter,gpuTile}=tile',"      detail('receive',{key:tile.key,id:tile.gpuTile,old:cache.get(tile.key)?.gpuTile})\n      const {key,x,y,width,height,zoom,phaseX,phaseY,gutter,gpuTile}=tile")
insert('          recentNative.set(scale,new Set(shownTiles.map(t=>t.key)))',"          recentNative.set(scale,new Set(shownTiles.map(t=>t.key)));detail('ready',{scale,view:actual.view,keys:shownTiles.map(t=>t.key),cache:cache.size})")
(target/p).write_text(src)
p=base/'render-worker.ts';s=(root/p).read_text()
at="              terminalDiagnostics.record('tile',"
if at not in s:
 import re
 at=re.search(r'^.*terminalDiagnostics\.record\(\x27tile\x27,.*',s,re.M)[0]
else:at=next(l for l in s.splitlines() if at in l and 'tile.key' in '\n'.join(s.splitlines()[max(0,s[:s.find(l)].count('\n')-50):s[:s.find(l)].count('\n')+5])) if False else at
# Only the actual raster-tile emission branch.
i=s.index("              undelivered = { ...result, bitmap }")
s=s[:i]+"""              console.warn('TAIL_TILE '+JSON.stringify({at:performance.timeOrigin+performance.now(),request:request.id,key:tile.key,
                  cached:!!cached,compile:result.compileMs,graph:result.graphMs,checkpoint:result.checkpointMs,finish:result.finishMs,
                  draws:result.drawCalls,bytes:result.peakTextureBytes,submissions:result.commandSubmissions}))
"""+s[i:]
(target/p).write_text(s)
