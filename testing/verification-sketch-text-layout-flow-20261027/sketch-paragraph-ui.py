exec(open('/tmp/sketch-text-impl.py').read().split("p='design-studio")[0])
def panel(s):
 s=s.replace('type TextStyle }','type TextStyle, type TextParagraph }',1).replace("import { applyWholeTextStyle }", "import { applyWholeTextStyle, styleTextRange }")
 at=s.index('  const { locale, tr } =')
 s=s[:at]+'''  const [paragraphIndex, setParagraphIndex] = useState(0)
  const paragraphs = Array.from(node.text.matchAll(/[^\\r\\n\\u2028\\u2029]*(?:\\r\\n|[\\r\\n\\u2028\\u2029]|$)/g))
    .filter(m=>m[0].length).map(m=>({start:m.index!,end:m.index!+m[0].length,text:m[0]}))
  const paragraphRange = paragraphs[Math.min(paragraphIndex, paragraphs.length-1)]
  const paragraph: TextParagraph = paragraphRange && node.textRuns?.find(r=>r.start<=paragraphRange.start&&paragraphRange.start<r.end)?.paragraph
    || {align:node.textStyle?.align??'start',minimumLineHeight:0,maximumLineHeight:0,spacing:node.textStyle?.paragraphSpacing??0,indent:node.textStyle?.paragraphIndent??0}
  const updateParagraph = (patch: Partial<TextParagraph>) => {
    if (!paragraphRange) return
    editor.change('修改段落样式',d=>{ const n=d.nodes[node.id]; if(n?.text===node.text) styleTextRange(n,paragraphRange.start,paragraphRange.end,{paragraph:{...paragraph,...patch}}) })
  }
'''+s[at:]
 at=s.index('      <label>{locale === \'en\' ? \'Vertical alignment\'')
 s=s[:at]+'''      {paragraphs.length > 0 && <details><summary>{locale === 'en' ? 'Paragraph styles' : '分段样式'}</summary>
        <label>段落<select aria-label="选择段落" value={Math.min(paragraphIndex,paragraphs.length-1)} onChange={e=>setParagraphIndex(Number(e.target.value))}>
          {paragraphs.map((p,i)=><option key={p.start} value={i}>{i+1} · {p.text.trim().slice(0,24) || '空段落'}</option>)}
        </select></label>
        <label>对齐<select aria-label="段落对齐" value={paragraph.align} onChange={e=>updateParagraph({align:e.target.value as TextParagraph['align']})}>
          <option value="start">起始</option><option value="center">居中</option><option value="end">末尾</option><option value="justify">两端对齐</option>
        </select></label>
        <NumberField label="段落最小行高" value={paragraph.minimumLineHeight} min={0} max={paragraph.maximumLineHeight || 10000} onChange={minimumLineHeight=>updateParagraph({minimumLineHeight})}/>
        <NumberField label="段落最大行高" value={paragraph.maximumLineHeight} min={0} max={10000} onChange={maximumLineHeight=>updateParagraph({maximumLineHeight})}/>
        <small>行高为文档单位，0 表示不限制。</small>
        <NumberField label="本段段后间距" value={paragraph.spacing} min={0} max={10000} onChange={spacing=>updateParagraph({spacing})}/>
        <NumberField label="本段首行缩进" value={paragraph.indent} min={-10000} max={10000} onChange={indent=>updateParagraph({indent})}/>
      </details>}
'''+s[at:]
 return s
edit('frontend/design-client/src/TextStylePanel.tsx',panel)
