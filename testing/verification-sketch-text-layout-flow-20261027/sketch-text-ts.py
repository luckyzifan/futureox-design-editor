exec(open('/tmp/sketch-text-impl.py').read().split("p='design-studio")[0])
for rel in ['design-studio/crates/design-kernel/src/fig.rs','design-studio/crates/design-kernel/src/sketch/preview/display.rs']:
 edit(rel,lambda s:s.replace('TextRun {\n','TextRun {\n                        paragraph: None,\n'))
def model(s):
 s=s.replace('export type TextStyle = {','export type TextStyle = {\n  verticalAlign?: \'top\' | \'center\' | \'bottom\'',1)
 s=s.replace('export type TextRun = {','''export type TextParagraph = { align: 'start'|'center'|'end'|'justify'; minimumLineHeight: number; maximumLineHeight: number; spacing: number; indent: number }
export function validTextParagraph(p: TextParagraph): boolean {
  return !!p && ['start','center','end','justify'].includes(p.align)
    && [p.minimumLineHeight,p.maximumLineHeight,p.spacing].every(v=>Number.isFinite(v)&&v>=0&&v<=10000)
    && Number.isFinite(p.indent)&&Math.abs(p.indent)<=10000
    && (p.maximumLineHeight===0||p.maximumLineHeight>=p.minimumLineHeight)
}
export type TextRun = {
  paragraph?: TextParagraph''',1)
 s=s.replace(' | 18 | 19\n',' | 18 | 19 | 20\n',1).replace('16, 17, 18, 19].includes','16, 17, 18, 19, 20].includes')
 at=s.index('export function hasSchema19Features')
 s=s[:at]+'''export function hasSchema20Features(d: DesignDocument): boolean {
  const style = (s: any) => s?.verticalAlign !== undefined && s.verticalAlign !== 'top'
  const runs = (r: any) => Array.isArray(r) && r.some(r=>r?.paragraph != null)
  return Object.values(d.nodes).some(n=>style(n.textStyle)||runs(n.textRuns)||Object.values(n.instance?.overrides||{}).some(o=>style(o.textStyle)||runs(o.textRuns)))
    || Object.values(d.designSystem?.styles||{}).some(s=>s.kind==='text'&&style(s.value))
}
'''+s[at:]
 s=s.replace('  if (d.schemaVersion < 19',"  if (d.schemaVersion < 20 && hasSchema20Features(d)) throw new Error('段落和文本垂直对齐需要设计文件版本 20')\n  if (d.schemaVersion < 19",1)
 s=s.replace("!['start', 'center', 'end', 'justify'].includes(style.align) ||","!['start', 'center', 'end', 'justify'].includes(style.align) ||\n        !['top','center','bottom'].includes(style.verticalAlign ?? 'top') ||",1)
 s=s.replace('run.start < end ||','run.start < end ||\n          (run.paragraph !== undefined && !validTextParagraph(run.paragraph)) ||',1)
 return s
edit('frontend/design-client/src/model.ts',model)
edit('frontend/design-client/src/engine.ts',lambda s:s.replace('  hasSchema19Features,','  hasSchema19Features,\n  hasSchema20Features,',1).replace('if(draft.schemaVersion < 19', 'if(draft.schemaVersion < 20 && hasSchema20Features(authored))draft.schemaVersion=20\n        if(draft.schemaVersion < 19',1).replace('if(candidate.schemaVersion < 19', 'if(candidate.schemaVersion < 20 && hasSchema20Features(candidate))candidate.schemaVersion=20;if(candidate.schemaVersion < 19'))
edit('frontend/design-client/src/automation/node-input-descriptors.ts',lambda s:s.replace('const textStyle = obj({',"const textParagraph = obj({ align: en('start','center','end','justify'), minimumLineHeight: num(0,10000), maximumLineHeight: num(0,10000), spacing: num(0,10000), indent: num(-10000,10000) }, ['align','minimumLineHeight','maximumLineHeight','spacing','indent'])\nconst textStyle = obj({ verticalAlign: en('top','center','bottom'),",1).replace('fontSize: num(1, 4096), weight: num(1, 1000), color,','fontSize: num(1, 4096), weight: num(1, 1000), paragraph: textParagraph, color,',1))
edit('frontend/design-client/src/text.ts',lambda s:s.replace('if (patch.weight !== undefined) delete run.weight','''if (patch.weight !== undefined) delete run.weight
    if (run.paragraph) {
      if (patch.align !== undefined) run.paragraph.align = patch.align
      if (patch.paragraphSpacing !== undefined) run.paragraph.spacing = patch.paragraphSpacing
      if (patch.paragraphIndent !== undefined) run.paragraph.indent = patch.paragraphIndent
      if (patch.lineHeight !== undefined) run.paragraph.minimumLineHeight = run.paragraph.maximumLineHeight = patch.lineHeight * (run.fontSize ?? node.fontSize)
    }''',1))
edit('frontend/design-client/src/TextStylePanel.tsx',lambda s:s.replace('      <label>{tr("方向")}<select','''      <label>{locale === 'en' ? 'Vertical alignment' : '垂直对齐'}<select
        aria-label="文本垂直对齐" value={style.verticalAlign ?? 'top'}
        onChange={e=>update({verticalAlign:e.target.value as TextStyle['verticalAlign']})}>
        <option value="top">{locale === 'en' ? 'Top' : '顶部'}</option>
        <option value="center">{locale === 'en' ? 'Center' : '居中'}</option>
        <option value="bottom">{locale === 'en' ? 'Bottom' : '底部'}</option>
      </select></label>
      <label>{tr("方向")}<select''',1))
