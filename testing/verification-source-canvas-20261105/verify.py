"""Check isolated desktop captures of the complete topology source. No source artwork is copied."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

p = argparse.ArgumentParser()
for name in ("hover", "run", "fresh_zoom", "fresh_return", "out"):
    p.add_argument("--" + name.replace("_", "-"), type=Path, required=True)
for name in ("before", "before_fresh_return", "dense", "manifest","detour","detour_oracle"):
    p.add_argument("--" + name.replace("_", "-"), type=Path)
args = p.parse_args()
read = lambda directory: json.loads((directory / "report.json").read_text())
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
def compare(a, b, box=None):
    x, y = (np.asarray(Image.open(f).convert("RGBA")).astype(np.int16) for f in (a, b))
    assert x.shape == y.shape
    if box is not None:
        x=x[box[1]:box[3],box[0]:box[2]];y=y[box[1]:box[3],box[0]:box[2]]
    dif = np.abs(x - y)
    return dict(width=x.shape[1], height=x.shape[0], changedPixels=int(np.any(dif,axis=-1).sum()), maxChannelDelta=int(dif.max()))
def seg(report, name):
    return next(s for s in report["segments"] if s["name"] == name)
def elapsed(segment):
    return round(segment["end"] - segment["up"], 1)
h, run = read(args.hover), read(args.run)
source_hash = "498098eb5e390e7088245c267a01896b1b832ad61098faddb1fba35f5ac8da86"
assert h["fileHash"] == run["fileHash"] == source_hash and h["materialClicks"] == run["materialClicks"] == 0
assert len(h["hover"]) == 3 and [e["receipt"]["visible"] for e in h["hover"]] == [True, True, False]
assert h["hover"][0]["point"]["id"] != h["hover"][1]["point"]["id"]
expected = ["CA6F308B-D86A-4671-8428-2D58B63CB8F8", "2F47F0D2-F75E-42E1-A5F4-886C51530760", "CA6F308B-D86A-4671-8428-2D58B63CB8F8"]
names = ["hover-group", "hover-text", "hover-group-restored"]
assert [h[n]["node"] for n in names] == expected and len({h[n]["remoteSubmission"] for n in names}) == 1
changed = compare(args.hover/"hover-group.png", args.hover/"hover-text.png")
restored = compare(args.hover/"hover-group.png", args.hover/"hover-group-restored.png")
# Status overlays/the bottom toolbar can animate outside the two outline bounds.
# Define the artwork region from the layout receipts, before examining pixels.
from math import floor, ceil
v=h['viewport'];dpr=restored['width']/v['width'];rects=[h[n]['rect'] for n in names]
box=[max(0,floor((min(r['x'] for r in rects)-v['x']-3)*dpr)),max(0,floor((min(r['y'] for r in rects)-v['y']-3)*dpr)),
     min(restored['width'],ceil((max(r['x']+r['w'] for r in rects)-v['x']+3)*dpr)),min(restored['height'],ceil((max(r['y']+r['h'] for r in rects)-v['y']+3)*dpr))]
art = compare(args.hover/"hover-group.png",args.hover/"hover-text.png",box)
back = compare(args.hover/"hover-group.png",args.hover/"hover-group-restored.png",box)
assert art['changedPixels']>0 and back['changedPixels']==0
out = dict(sourceSHA256=source_hash, sourceBytes=119392711, totalMaterials=306, materialListClicks=0,
           initialFit=run["initialFit"], viewport=run["viewport"], focalPoint=run["highFocus"],
           hover=dict(overview=[dict(id=e["point"]["id"], visible=e["receipt"]["visible"]) for e in h["hover"]],
                      native=[dict(node=h[n]["node"], submission=h[n]["remoteSubmission"]) for n in names],
                      changeOnCommand=changed, restoreOnKeyUp=restored, artworkBox=box, artworkOnCommand=art, artworkOnKeyUp=back),
           highZoom={}, timingsAfterGestureMs={})
for name, oracle in [("high-3200", args.fresh_zoom), ("high-cross-return", args.fresh_return)]:
    fresh = read(oracle)
    assert fresh["freshReference"] == name and fresh["fileHash"] == source_hash
    a, b = seg(run, name), seg(fresh, name)
    assert a["endView"] == b["endView"] and a["ready"] and b["ready"]
    captures = {}
    for kind, suffix in [("native","-native.png"), ("window",".png")]:
        result = compare(args.run/(name+suffix), oracle/(name+suffix))
        captures[kind] = result
        assert result["changedPixels"] == 0, (name, kind, result)
        if name == "high-cross-return" and (args.run/("high-cross-held"+suffix)).exists():
            held = compare(args.run/("high-cross-held"+suffix), oracle/(name+suffix))
            captures["held_"+kind] = held
            assert held["changedPixels"] == 0, (name, kind, held)
    out["highZoom"][name] = dict(pose=a["endView"], **captures)
for s in run["segments"]:
    if s.get("ready"): out["timingsAfterGestureMs"][s["name"]] = elapsed(s)
if args.before and args.before_fresh_return:
    prior = read(args.before)
    assert prior["fileHash"] == source_hash and prior["highFocus"]["point"] == run["highFocus"]["point"]
    name = 'high-cross-return'
    out["oldCrossReturn"] = compare(args.before/(name+'-native.png'), args.before_fresh_return/(name+'-native.png'))
    assert out["oldCrossReturn"]["changedPixels"] > 0
if args.dense:
    old_layout = read(args.dense);s=seg(old_layout,'dense-cold-view')
    assert old_layout['fileHash']==source_hash and s['ready'] and len(s['visible'])==62
    peaks = []
    for line in (args.dense/'render.log').open():
        if not line.startswith('[render-diag] '):continue
        ev=json.loads(line.removeprefix('[render-diag] '))
        if ev.get('event')=='tile' and s['begin']<=ev['at']<=s['end']:peaks.append(ev.get('peakTextureBytes',0))
    out["earlier62MaterialLayout"] = dict(visible=len(s["visible"]), firstCompleteBoardMs=round(old_layout["regional"]["at"]-s["up"],1),wholeMs=elapsed(s),peakTrackedTextureBytes=max(peaks))
if args.detour and args.detour_oracle:
    detour,oracle=read(args.detour),read(args.detour_oracle)
    home=seg(detour,'high-cross-return')
    assert detour['fileHash']==oracle['fileHash']==source_hash and detour['materialClicks']==0 and home['ready'] and detour['visitedFar']
    assert home['endView']==seg(oracle,'high-cross-return')['endView'] and detour['visitedFar']['view']!=home['endView']
    checks={}
    for name in ('high-cross-return','high-cross-held'):
        for kind,suffix in [('native','-native.png'),('window','.png')]:
            result=compare(args.detour/(name+suffix),args.detour_oracle/('high-cross-return'+suffix))
            assert result['changedPixels']==0,(name,kind,result)
            checks[name+'/'+kind]=result
    out['afterSettledRemoteVisit']=dict(remote=detour['visitedFar'],returnMs=elapsed(home),pixels=checks)
if args.manifest:out["installed"]=json.loads(args.manifest.read_text())
args.out.write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
