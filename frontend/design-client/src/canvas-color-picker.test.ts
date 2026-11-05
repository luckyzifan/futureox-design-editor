import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { requestCanvasColor, hasCanvasColorPicker, cancelCanvasColorPicker, acceptCanvasColor, pickSelectionColor } from './canvas-color-picker'
import { kernelTextLayout } from './kernel/picking'
import {sampleColorLabel} from './canvas-color-picker'
import { rememberPaintChannel } from './eyedropper-target'
import { stroke } from './model'

test('cancelled or superseded color requests cannot cancel a newer picker or mutate the document',async()=>{
 const editor=new Editor(blank()),document=editor.state.doc,version=editor.state.version
 const firstOwner=new AbortController(),first=requestCanvasColor(editor,firstOwner.signal)
 const firstCancelled=expect(first).rejects.toMatchObject({name:'AbortError'})
 const secondOwner=new AbortController(),second=requestCanvasColor(editor,secondOwner.signal)
 const secondCancelled=expect(second).rejects.toMatchObject({name:'AbortError'})
 await firstCancelled;firstOwner.abort()
 expect(hasCanvasColorPicker(editor)).toBe(true);expect(editor.state.tool).toBe('eyedropper')
 secondOwner.abort();await secondCancelled
 expect(hasCanvasColorPicker(editor)).toBe(false);expect(editor.state.tool).toBe('select')
 expect(editor.state.version).toBe(version);expect(editor.state.doc).toBe(document)
 cancelCanvasColorPicker(editor);editor.dispose()
})
test('sample readouts retain exact RGB and handle achromatic HSL/HSB boundaries',()=>{
 expect(sampleColorLabel('#ff0000','HEX')).toBe('#FF0000')
 expect(sampleColorLabel('#123456','RGB')).toBe('rgb(18, 52, 86)')
 expect(sampleColorLabel('#00ff00','HSL')).toBe('hsl(120, 100%, 50%)')
 expect(sampleColorLabel('#0000ff','HSB')).toBe('hsb(240, 100%, 100%)')
 expect(sampleColorLabel('#ffffff','HSL')).toBe('hsl(0, 0%, 100%)')
 expect(sampleColorLabel('#000000','HSB')).toBe('hsb(0, 0%, 0%)')
})
test('a completed color is delivered before restoring the tool aborts the consumer signal',async()=>{
 const editor=new Editor(blank()),controller=new AbortController()
 const result=requestCanvasColor(editor,controller.signal).then(value=>{expect(controller.signal.aborted).toBe(false);return value})
 const unsubscribe=editor.subscribe(()=>{if(editor.state.tool!=='eyedropper')controller.abort()})
 acceptCanvasColor(editor,'#123456');expect(await result).toEqual({sRGBHex:'#123456'})
 expect(editor.state.tool).toBe('select');unsubscribe();editor.dispose()
})

test('whole-layer canvas sampling replaces imported run colors while retaining rich text and exact history',async()=>{
 const document=blank(),text=node('text',20,20,120,40)
 text.text='Test';text.textRuns=[{start:0,end:4,color:'#ffffff',fontId:'default',fontSize:20,weight:700,underline:true,strikethrough:true,link:'https://example.com'}]
 document.nodes[text.id]=text;document.pages[0].children=[text.id]
 const editor=new Editor(document);editor.select([text.id]);const before=editor.state.doc
 try{
  const picked=pickSelectionColor(editor);acceptCanvasColor(editor,'#ff3366');await picked
  const changed=editor.state.doc.nodes[text.id]
  expect(changed.fills[0].color).toBe('#ff3366')
  expect(changed.textRuns).toEqual([{start:0,end:4,fontId:'default',fontSize:20,weight:700,underline:true,strikethrough:true,link:'https://example.com'}])
  expect(kernelTextLayout(changed).spans.every(span=>span.color==null)).toBe(true)
  const after=editor.state.doc
  editor.undo();expect(editor.state.doc.nodes).toEqual(before.nodes)
  editor.redo();expect(editor.state.doc.nodes).toEqual(after.nodes)
 }finally{editor.dispose()}
})

test('the active stroke receives the sample and the fill stays put', async () => {
  const document = blank(), shape = node('rectangle', 0, 0, 40, 40)
  shape.fills[0].color = '#112233'
  shape.strokes = [stroke('#445566')]
  document.nodes[shape.id] = shape
  document.pages[0].children = [shape.id]
  const editor = new Editor(document)
  editor.select([shape.id])
  rememberPaintChannel(editor, 'stroke')
  try {
    const picked = pickSelectionColor(editor)
    acceptCanvasColor(editor, '#00ff00')
    await picked
    expect(editor.state.doc.nodes[shape.id].strokes[0].paint.color).toBe('#00ff00')
    expect(editor.state.doc.nodes[shape.id].strokes[0].paint.kind).toBe('solid')
    expect(editor.state.doc.nodes[shape.id].fills[0].color).toBe('#112233')
    editor.undo()
    expect(editor.state.doc.nodes[shape.id].strokes[0].paint.color).toBe('#445566')
  } finally { editor.dispose() }
})

