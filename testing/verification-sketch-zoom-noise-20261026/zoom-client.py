from pathlib import Path
p=Path('frontend/design-client/src/model.ts');s=p.read_text();a=s.index('export function hasSchema18Features');b=s.index('export type Effect',a);new=s[a:b].replace('hasSchema18Features','hasSchema19Features').replace("['gaussian-blur','motion-blur']","['zoom-blur']");s=s[:b]+new+s[b:]
s=s.replace('export type Effect = {','''export type ZoomBlur = {amount:number;center:[number,number]}
export function validZoomBlur(value:unknown):value is ZoomBlur {
  if(!value || typeof value!=='object' || Array.isArray(value))return false
  const z=value as ZoomBlur
  return Object.keys(value).every(k=>['amount','center'].includes(k)) && Number.isFinite(z.amount) && z.amount>=0 && z.amount<=1000 &&
    Array.isArray(z.center) && z.center.length===2 && z.center.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e6)
}
export type Effect = {
  zoomBlur?: ZoomBlur''',1)
s=s.replace("| 'motion-blur'\n","| 'motion-blur' | 'zoom-blur'\n",1).replace('| 17 | 18\n','| 17 | 18 | 19\n',1)
s=s.replace("  ...(kind === 'motion-blur'", "  ...(kind === 'zoom-blur' ? {zoomBlur:{amount:10,center:[0.5,0.5] as [number,number]},radius:0,amount:0,opacity:1} : {}),\n  ...(kind === 'motion-blur'",1)
s=s.replace('  if (d.schemaVersion < 18','  if (d.schemaVersion < 19 && hasSchema19Features(d)) throw new Error(\'缩放模糊需要设计文件版本 19\')\n  if (d.schemaVersion < 18',1)
s=s.replace("            'motion-blur',","            'motion-blur', 'zoom-blur',",1)
s=s.replace('          (e.motionAngle === undefined','          (e.zoomBlur == null ? e.kind!==\'zoom-blur\' : (e.kind===\'zoom-blur\' && validZoomBlur(e.zoomBlur) && e.radius===0 && !e.colorControls && !e.glass && !e.texture && !e.gradientBlur)) &&\n          (e.motionAngle === undefined',1)
# The document version gate uses a range rather than a union in some versions.
s=s.replace('d.schemaVersion > 18','d.schemaVersion > 19').replace('finite(d.schemaVersion, 1, 18)','finite(d.schemaVersion, 1, 19)')
p.write_text(s)
p=Path('frontend/design-client/src/engine.ts');s=p.read_text().replace('  hasSchema18Features,','  hasSchema18Features,\n  hasSchema19Features,');s=s.replace('if(draft.schemaVersion < 18 && hasSchema18Features(authored))draft.schemaVersion=18','if(draft.schemaVersion < 18 && hasSchema18Features(authored))draft.schemaVersion=18\n        if(draft.schemaVersion < 19 && hasSchema19Features(authored))draft.schemaVersion=19');s=s.replace('if(candidate.schemaVersion < 18 && hasSchema18Features(candidate))candidate.schemaVersion=18','if(candidate.schemaVersion < 18 && hasSchema18Features(candidate))candidate.schemaVersion=18;if(candidate.schemaVersion < 19 && hasSchema19Features(candidate))candidate.schemaVersion=19');p.write_text(s)
for name in ['Inspector.tsx','MultiStylePanel.tsx']:
 p=Path('frontend/design-client/src')/name;s=p.read_text().replace("'motion-blur': '运动模糊',","'motion-blur': '运动模糊', 'zoom-blur':'缩放模糊',").replace("'motion-blur':'运动模糊',","'motion-blur':'运动模糊', 'zoom-blur':'缩放模糊',");p.write_text(s)
p=Path('frontend/design-client/src/Inspector.tsx');s=p.read_text().replace("fx.kind === 'color-controls' ? false", "['color-controls','zoom-blur'].includes(fx.kind) ? false",1)
needle="              {fx.kind === 'motion-blur' &&"
s=s.replace(needle,'''              {fx.zoomBlur && <div className="field-grid">
                <NumberField label={tr('缩放模糊强度')} historyLabel="缩放模糊强度" unit="number" diagnosticFamily={2} min={0} max={1000} value={fx.zoomBlur.amount} onChange={v=>update(n=>{n.effects[i].zoomBlur!.amount=v})}/>
                {([0,1] as const).map(axis=><NumberField key={axis} label={tr(axis===0?'焦点 X %':'焦点 Y %')} historyLabel="缩放模糊焦点" unit="number" diagnosticFamily={2} min={-1e8} max={1e8} value={fx.zoomBlur!.center[axis]*100} onChange={v=>update(n=>{n.effects[i].zoomBlur!.center[axis]=v/100})}/>)}
              </div>}
'''+needle,1);p.write_text(s)
p=Path('frontend/design-client/src/automation/node-input-descriptors.ts');s=p.read_text().replace('const effect = obj({ colorControls,','const effect = obj({ zoomBlur: describe(obj({amount:num(0,1000),center:tuple(num(-1e6,1e6),2)}, [\'amount\',\'center\']), \'Zoom-blur only: dimensionless amount, normalized node-local focal point; radius must be zero.\'), colorControls,',1).replace("'gaussian-blur', 'motion-blur')","'gaussian-blur', 'motion-blur', 'zoom-blur')",1);p.write_text(s)
p=Path('frontend/design-client/src/export.tsx');s=p.read_text().replace("e.visible&&e.kind==='motion-blur'","e.visible&&['motion-blur','zoom-blur'].includes(e.kind)").replace('运动模糊需要保留视觉效果的 SVG','运动/缩放模糊需要保留视觉效果的 SVG');p.write_text(s)
