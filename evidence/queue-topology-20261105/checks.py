from pathlib import Path
import sys,re,json,hashlib
w=Path(sys.argv[1]);p=Path(__file__).resolve().parent
def results(f):
 text=(w/f).read_text()
 return [{'passed':int(a),'failed':int(b),'ignored':int(c)} for a,b,c in re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;',text)]
def js(f):
 s=(w/f).read_text()
 n=re.search(r'(?m)^\s*Tests\s+(\d+) passed',s);assert n
 return int(n[1])
def status(file):return [json.loads(l) for l in (w/file).read_text().splitlines()]
kernel=results('kernel-tests.log');effects=results('effects-tests.log');assert len(kernel)==1 and len(effects)==6
prods=json.loads((p/'products.json').read_text())
same=[k for k in prods['E'] if k in prods['G'] and prods['E'][k]==prods['G'][k]]
for name in ['bin/design-prepare','bin/design-render','sidecar/futureox-design-desktop-backend','renderer/kernel/design_kernel_bg.wasm']:assert name in same,name
m=json.loads((w/'product-G/build-manifest.json').read_text())
snap=json.loads((p/'source-sha256.json').read_text())
for name in snap:
 if not name.endswith(('.test.ts','.test.tsx')) and name in m['sources']:assert snap[name]['after']==m['sources'][name],name
v={'nativeUnit':kernel,'nativeEffects':effects,'frontendTests':{'gpuAndNavigation':js('final-vitest.log'),'emptyShadowField':js('zero-tests.log'),'materialScopeAndWorkspace':js('scope-tests.log')},'typecheck':'passed as part of full desktop build','fullDesktopBuild':'Built darwin/arm64' in (w/'scope-build.log').read_text(),'wasm':'rebuilt portable kernel; CPU and WASM golden match','referenceAndFinalNativePixelChecks':'both real per-tile comparisons plus independent fixed desktop camera checks; see linked artifacts','earlierAndFinalIdenticalArtifacts':same,'finalGuiRuns':status('final/desktop-status.ndjson'),'previousGuiRuns':status('shipping/desktop-status.ndjson'),'cpuMatrix':'latest isolated run; four fresh processes (ABBA) per side, one cold and two warm frames each','notes':['Diagnostic runs and readbacks are separate from hardware timing.','An intermediate replay launcher used a symlink as its fake Electron host and failed before loading either product. All those launches were excluded and rerun from the real host directory.','Other platforms, universal latency and commercial release gates not evaluated.']}
assert all(z['code']==0 for z in v['finalGuiRuns']) and len(v['finalGuiRuns'])==8
if (w/'cold-status.ndjson').exists():
 v['additionalColdRuns']=status('cold-status.ndjson')
 assert len(v['additionalColdRuns'])==4 and all(r['code']==0 for r in v['additionalColdRuns'])
(p/'checks.json').write_text(json.dumps(v,indent=2,ensure_ascii=False)+'\n')
