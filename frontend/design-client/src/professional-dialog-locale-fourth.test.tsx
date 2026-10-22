// Real mounted dialogs and Editor; does not certify native GUI layout.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, test, expect, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { interfacePreference } from './interface-preference'
import { ShapeBuilderDialog } from './ShapeBuilderDialog'
import { FramePresetPanel } from './FramePresetPanel'
import { SystemFontPicker } from './SystemFontPicker'
import { framePresets } from './frame-presets'
const bootstrap = await vi.hoisted(async () => {
  // @ts-expect-error jsdom runtime dependency
  const { JSDOM } = await import('jsdom')
  const d = new JSDOM('<html><body></body></html>')
  for (const k of ['window','document','navigator']) vi.stubGlobal(k,k === 'window' ? d.window : d.window[k])
  return d
})
bootstrap.window.close()
let dom:any, root:Root, editor:Editor, close:ReturnType<typeof vi.fn<() => void>>
beforeEach(() => {
  dom = new JSDOM('<html><body><button id="trigger">Open</button><div id="mount"></div></body></html>',{url:'https://design.invalid/'})
  for(const k of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLSelectElement','Node','Event','MouseEvent','KeyboardEvent','localStorage']) vi.stubGlobal(k,k === 'window' ? dom.window : dom.window[k])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  interfacePreference.reset(); editor=new Editor(blank('作者文档')); close=vi.fn<() => void>()
  root=createRoot(document.getElementById('mount')!); document.getElementById('trigger')!.focus()
})
afterEach(async()=>{await act(async()=>root.unmount());editor.dispose();dom.window.close();vi.restoreAllMocks();vi.unstubAllGlobals()})
const locale=(v:'en'|'zh-CN')=>act(async()=>{interfacePreference.set({locale:v})})
const field=(label:string)=>document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
async function type(el:HTMLInputElement,value:string){await act(async()=>{el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))})}
async function click(el:Element){await act(async()=>el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})))}
function shapes(){const d=blank('作者形状'),a=node('rectangle',0,0,100,100),b=node('rectangle',50,0,100,100);a.name='形状构建器';b.name='作者 B';d.nodes[a.id]=a;d.nodes[b.id]=b;d.pages[0].children=[a.id,b.id];editor.dispose();editor=new Editor(d);editor.select([a.id,b.id])}
async function selectRegion(){const p=document.querySelector<SVGElement>('[data-region-id]')!;expect(p).not.toBeNull();await act(async()=>{p.focus();p.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}))});return p}

test('shape locale switch preserves selected region DOM, focus, geometry and mode then one undo',async()=>{
  shapes();const before=editor.state.doc;await act(async()=>root.render(<ShapeBuilderDialog editor={editor} onClose={close}/>));
  const p=await selectRegion(), d=p.getAttribute('d'), id=p.getAttribute('data-region-id'), select=document.querySelector('select')!;
  expect(document.getElementById('shape-builder-title')!.textContent).toBe('形状构建器');
  await locale('en');expect(document.getElementById('shape-builder-title')!.textContent).toBe('Shape builder');
  expect(document.querySelector('[data-region-id]')).toBe(p);expect(document.activeElement).toBe(p);expect(p.getAttribute('aria-label')).toBe(`Region ${id}`);expect(p.getAttribute('aria-pressed')).toBe('true');expect(p.getAttribute('d')).toBe(d);expect(select.value).toBe('merge');expect(editor.state.doc).toBe(before);
  const apply=[...document.querySelectorAll('button')].find(b=>b.textContent==='Apply')!;expect(apply).toBeDefined();await click(apply);expect(close).toHaveBeenCalledTimes(1);expect(editor.canUndo).toBe(true);await act(async()=>editor.undo());expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false);
})

test('shape stale-preview error relabels without repreview or document writes',async()=>{
  shapes();await act(async()=>root.render(<ShapeBuilderDialog editor={editor} onClose={close}/>));await selectRegion();
  await act(async()=>editor.update(editor.state.selection,{name:'用户改名'},'作者历史'));const changed=editor.state.doc;
  await click([...document.querySelectorAll('button')].find(b=>b.textContent==='应用')!);
  expect(document.querySelector('[role="alert"]')!.textContent).toBe('文档已变化，请关闭后重新打开');
  await locale('en');expect(document.querySelector('[role="alert"]')!.textContent).toBe('The document changed. Close and reopen this dialog.');expect(editor.state.doc).toBe(changed);expect(close).not.toHaveBeenCalled();
})

test('preset drafts and authored name survive locale while exact custom dimensions create and undo',async()=>{
  const before=editor.state.doc;await act(async()=>root.render(<FramePresetPanel editor={editor} onClose={close}/>));
  const name=field('自定义画板名称')!,w=field('自定义画板宽')!;expect(name).not.toBeNull();await type(name,'设备与尺寸画板: 作者');await type(w,'123');
  await locale('en');expect(field('Custom frame width')).toBe(w);expect(document.activeElement).toBe(w);expect(w.value).toBe('123');expect(field('Custom frame name')).toBe(name);expect(name.value).toBe('设备与尺寸画板: 作者');expect(editor.state.doc).toBe(before);
  await act(async()=>document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(close).toHaveBeenCalledTimes(1);const n=editor.state.doc.nodes[editor.state.selection[0]];expect(n).toMatchObject({name:'设备与尺寸画板: 作者',width:123,height:844});await act(async()=>editor.undo());expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false);
})

test('preset search/category/orientation preserve catalogue identities and create original device spec',async()=>{
  const catalogue=JSON.stringify(framePresets);await act(async()=>root.render(<FramePresetPanel editor={editor} onClose={close}/>));
  const search=field('搜索画板预设')!;await type(search,'iPhone 13 / 13 Pro');const select=document.querySelector('select')!;
  await act(async()=>{select.value='phone';select.dispatchEvent(new Event('change',{bubbles:true}))});await click(document.querySelector('input[type="checkbox"]')!);search.focus();
  await locale('en');expect(field('Search frame presets')).toBe(search);expect(document.activeElement).toBe(search);expect(search.value).toBe('iPhone 13 / 13 Pro');expect(select.value).toBe('phone');expect(select.selectedOptions[0].textContent).toBe('Phone');expect(JSON.stringify(framePresets)).toBe(catalogue);
  const preset=[...document.querySelectorAll('.frame-preset-list button')].find(b=>b.querySelector('span')!.textContent==='iPhone 13 / 13 Pro')!;expect(preset).toBeDefined();await click(preset);expect(editor.state.doc.nodes[editor.state.selection[0]]).toMatchObject({name:'iPhone 13 / 13 Pro',width:844,height:390});
})

test('preset validation error switches presentation but never creates or clears drafts',async()=>{
  await act(async()=>root.render(<FramePresetPanel editor={editor} onClose={close}/>));const w=field('自定义画板宽')!;await type(w,'0');const before=editor.state.doc;
  await act(async()=>document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(document.querySelector('[role="alert"]')!.textContent).toMatch(/1.*100000/);await locale('en');expect(document.querySelector('[role="alert"]')!.textContent).toBe('Width and height must be integers from 1 to 100000.');expect(field('Custom frame width')).toBe(w);expect(w.value).toBe('0');expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false);expect(close).not.toHaveBeenCalled();
})

test('preset default authored name stays unchanged and close restores external focus across locale',async()=>{
  await act(async()=>root.render(<FramePresetPanel editor={editor} onClose={close}/>));const name=field('自定义画板名称')!;await locale('en');expect(field('Custom frame name')).toBe(name);expect(name.value).toBe('自定义画板');await locale('zh-CN');expect(field('自定义画板名称')).toBe(name);await act(async()=>root.render(null));expect(document.activeElement).toBe(document.getElementById('trigger'));expect(document.getElementById('mount')!.hasAttribute('inert')).toBe(false);
})


for (const diagnostic of ['constructor', 'toString', '__proto__']) {
  test(`shape unknown diagnostic ${diagnostic} stays a literal string across locale`, async () => {
    shapes(); await act(async () => root.render(<ShapeBuilderDialog editor={editor} onClose={close} />)); await selectRegion()
    const before = editor.state.doc
    vi.spyOn(editor, 'change').mockReturnValue({ status: 'rejected', revision: editor.state.version, message: diagnostic })
    await click([...document.querySelectorAll('button')].find(b => b.textContent === '应用')!)
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(diagnostic)
    await locale('en'); expect(document.querySelector('[role="alert"]')!.textContent).toBe(diagnostic)
    await locale('zh-CN'); expect(document.querySelector('[role="alert"]')!.textContent).toBe(diagnostic)
    expect(editor.state.doc).toBe(before); expect(close).not.toHaveBeenCalled(); expect(editor.canUndo).toBe(false)
  })
  test(`native font failure ${diagnostic} remains the original Error string across locale`, async () => {
    const list = vi.fn(async () => ({status: 'error', message: diagnostic})), read = vi.fn()
    ;(window as any).coreDesktop = {version: 1, fonts: {list, read}}
    const before = editor.state.doc
    await act(async () => root.render(<SystemFontPicker editor={editor} ids={[]} />))
    await click([...document.querySelectorAll('button')].find(b => b.textContent === '选择本机字体')!)
    expect(document.querySelector('[role="status"]')!.textContent).toBe(`Error: ${diagnostic}`)
    await locale('en'); expect(document.querySelector('[role="status"]')!.textContent).toBe(`Error: ${diagnostic}`)
    await locale('zh-CN'); expect(document.querySelector('[role="status"]')!.textContent).toBe(`Error: ${diagnostic}`)
    expect(list).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled(); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
  })
}
