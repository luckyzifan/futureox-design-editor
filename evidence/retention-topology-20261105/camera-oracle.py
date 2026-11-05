"""Reuse the existing Electron full-source oracle to compare identical recorded cameras."""
from pathlib import Path
import sys
repo=Path.cwd()
src=(repo/'testing/verification-overview-zoom-20261104/replay.mjs').read_text()
a=src.index("    const label=process.env.OVERVIEW_ORACLE_SEGMENT")
b=src.index('    report.freshReference=',a)
src=src[:a]+'''    for(const [label,shot] of [['dense-cold-view','dense-settled'],['dense-pan','dense-shifted'],['dense-pan-back','dense-return']]){
      const segment=reference.segments.find(row=>row.name===label)
      assert(segment?.ready)
      await record(label,async()=>page.evaluate(v=>{
        const c=document.querySelector('[data-testid="canvas"]');let f=c[Object.keys(c).find(k=>k.startsWith('__reactFiber$'))]
        while(f){const e=f.memoizedProps?.editor;if(e?.state){e.discardPendingView();e.set({view:{x:v[0],y:v[1],zoom:v[2]}});return}f=f.return}
        throw Error('Missing editor')
      },segment.endView))
      assert(report.segments.at(-1).ready)
      await screen(shot,b)
    }
'''+src[b:]
src=src.replace('report.freshReference=label',"report.freshReference='fixed-dense'")
src=src.replace("new URL('../verification-dense-refinement-20261104/probe.mjs',import.meta.url).href",
                repr((repo/'testing/verification-dense-refinement-20261104/probe.mjs').as_uri()))
Path(sys.argv[1]).write_text(src)
