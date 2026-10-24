// Actual CPU geometry/index + Editor/WASM. No renderer/device substitutes here.
import { afterEach, expect, test, vi } from 'vitest'
import { CanvasSceneSnapshots } from './canvas-scene-snapshots'
import { scene, SpatialIndex, unionBounds } from './geometry'
import { Editor } from './engine'
import { blank, node, effect, defaultTextStyle, type DesignDocument } from './model'
import { activateDocumentFonts, kernelPdfVector, pickingGeometryEpoch } from './kernel/picking'
import { componentFixture } from './component-fixtures'
import { fontTestBytes } from './font-test-fixtures'

const work = vi.hoisted(() => ({ scenes: 0, indexes: 0, failScene: false, failIndex: false }))
vi.mock('./geometry', async original => {
  const actual = await original<typeof import('./geometry')>()
  return { ...actual,
    scene: (...args: Parameters<typeof actual.scene>) => {
      work.scenes++; if (work.failScene) throw new Error('scene build failure')
      return actual.scene(...args)
    },
    SpatialIndex: class extends actual.SpatialIndex {
      constructor(entries: ReturnType<typeof actual.scene>) {
        work.indexes++; if (work.failIndex) throw new Error('index build failure')
        super(entries)
      }
    },
  }
})
const actual = await vi.importActual<typeof import('./geometry')>('./geometry')
const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(e => e.dispose()); work.scenes = work.indexes = 0; work.failScene = work.failIndex = false })
function makeEditor(doc: DesignDocument) { const editor = new Editor(doc); editors.push(editor); return editor }
function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen); Object.freeze(value)
  }
  return value
}
function exact(a: unknown, b: unknown) {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { expect(Object.is(a, b)).toBe(true); return }
  expect(Object.keys(a)).toEqual(Object.keys(b))
  for (const key of Object.keys(a)) exact((a as any)[key], (b as any)[key])
}
function fixture() {
  const doc = blank('Scene snapshot CPU'), group = node('group', 2.125, -3.375, 20, 20), nested = node('group', 3.5, 4.25, 10, 10)
  group.transform = [0, -1.125, 2.25, 0, 25.125, -37.75]
  nested.transform = [-1, .125, -.25, 1.5, 3.5, 4.25]
  const a = node('rectangle', -4.125, 7.375, 13.125, 19.75), locked = node('ellipse', 40, 20, 10, 10), hidden = node('rectangle', 800, 900, 30, 40)
  const vector = node('vector', 80.125, 5.5, 30, 40)
  vector.network = { fillRule: 'nonzero', vertices: [{ id:'v1', x:0, y:0 }, { id:'v2', x:30, y:40 }], edges:[{ id:'e1', from:'v1', to:'v2', c1:{x:22.125,y:-4.75}, c2:{x:-3.5,y:45.125} }] }
  locked.locked = true; hidden.visible = false; group.children = [nested.id, locked.id]; nested.children = [a.id, vector.id, hidden.id]
  doc.nodes = Object.fromEntries([group,nested,a,locked,hidden,vector].map(n => [n.id,n])); doc.pages[0].children = [group.id]
  doc.pages.push({ ...doc.pages[0], id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', children:[], name:'Other page' })
  return { doc, a, group, nested, locked, vector }
}
function verify(e: Editor, store: CanvasSceneSnapshots, displayed = e.state.doc) {
  store.begin(e, e.sessionGeneration, e.state.page, true)
  const current = store.currentScene(e.state.doc, e.state.page), shown = store.displayedScene(displayed, e.state.page)!
  for (const [snapshot, doc] of [[current,e.state.doc],[shown,displayed]] as const) {
    const reference = actual.scene(doc,e.state.page), referenceIndex = new actual.SpatialIndex(reference)
    frozen(snapshot.entries); const beforeQueries = JSON.stringify(snapshot.entries)
    exact(snapshot.entries, reference)
    exact(snapshot.overview, unionBounds(reference.filter(e => e.depth === 0).map(e => e.bounds)))
    for (const rect of [{x:-1000,y:-1000,width:2000,height:2000}, {x:0,y:0,width:0,height:0}, {x:20,y:-40,width:250,height:250}, {x:-1e30,y:-1e30,width:2e30,height:2e30}]) {
      exact(snapshot.index.query(rect), referenceIndex.query(rect))
      snapshot.index.query(rect).reverse().sort((a,b) => b.depth-a.depth)
      for (const deep of [false,true]) expect(e.hit(rect,deep,snapshot.index,1,{document:doc,pageId:e.state.page})).toBe(e.hit(rect,deep,referenceIndex,1,{document:doc,pageId:e.state.page}))
      expect(e.hoverHit(rect,snapshot.index,1,{document:doc,pageId:e.state.page})).toBe(e.hoverHit(rect,referenceIndex,1,{document:doc,pageId:e.state.page}))
    }
    expect(JSON.stringify(snapshot.entries)).toBe(beforeQueries)
  }
  exact(store.refineOverview(e.state.doc,e.state.page),current.overview)
}

test('same current/displayed/refine snapshot shares one scene and one lazy index', () => {
  const e = makeEditor(fixture().doc), store = new CanvasSceneSnapshots(); store.begin(e,0,e.state.page,true)
  const a = store.currentScene(e.state.doc,e.state.page)
  expect(work.scenes).toBe(1); expect(work.indexes).toBe(0)
  expect(store.displayedScene(e.state.doc,e.state.page)).toBe(a)
  expect(store.refineOverview(e.state.doc,e.state.page)).toBe(a.overview)
  expect(a.index).toBe(a.index); expect(work.scenes).toBe(1); expect(work.indexes).toBe(1)
  for(let i=0;i<30;i++) { e.set({hover:null,view:{x:i,y:-i,zoom:1}}); store.begin(e,0,e.state.page,true); expect(store.currentScene(e.state.doc,e.state.page)).toBe(a) }
  expect(work.scenes).toBe(1)
})

test('Editor commands borrow Canvas geometry without retaining a third slot or reading a stale edit', () => {
  const {doc,a}=fixture(), e=makeEditor(doc), store=new CanvasSceneSnapshots()
  store.begin(e,e.sessionGeneration,e.state.page,true)
  const first=store.currentScene(e.state.doc,e.state.page)
  const release=e.bindPublishedScene(store.borrowCurrentScene(e.state.doc,e.state.page,e.sessionGeneration))
  const builds=work.scenes
  for(let i=0;i<30;i++) {
    e.set({view:{x:i,y:-i,zoom:1}})
    expect(e.entries()).toEqual(first.entries)
    e.entries().reverse() // Public command callers still own their array.
  }
  expect(work.scenes).toBe(builds)
  e.update([a.id],{width:41.125})
  exact(e.entries(),actual.scene(e.state.doc,e.state.page))
  expect(work.scenes).toBeGreaterThan(builds)
  release()
  const before=work.scenes;e.entries();expect(work.scenes).toBe(before+1)
})

test('50 live previews retain only current/displayed scenes; standalone refine retains no entries or index', () => {
  const {doc,a} = fixture(), e = makeEditor(doc), store = new CanvasSceneSnapshots(), before = frozen(e.state.doc)
  store.begin(e,0,e.state.page,true); const shown = store.currentScene(before,e.state.page); void shown.index
  store.displayedScene(before,e.state.page); store.refineOverview(before,e.state.page)
  e.begin('50 previews')
  for (let i=1;i<=50;i++) {
    expect(e.preview({[a.id]:{transform:[1,0,0,1,i+.125,i-.375]}})).toBe(true)
    expect(e.state.version).toBe(0)
    const current = store.currentScene(e.state.doc,e.state.page); void current.index
    expect(store.displayedScene(before,e.state.page)).toBe(shown)
    expect(store.refineOverview(before,e.state.page)).toBe(shown.overview)
    expect((store as any).current).toBe(current); expect((store as any).displayed).toBe(shown)
  }
  expect(work.scenes).toBe(51); expect(work.indexes).toBe(51)
  const distinctRefine = {...before,nodes:{...before.nodes,[a.id]:{...before.nodes[a.id],width:1.25}}}
  store.refineOverview(distinctRefine,e.state.page); store.refineOverview(distinctRefine,e.state.page)
  expect(work.scenes).toBe(52); expect(work.indexes).toBe(51)
  expect(Object.keys((store as any).refine)).toEqual(['key','overview'])
  expect(store.displayedScene(undefined,undefined)).toBeNull(); expect((store as any).displayed).toBeUndefined()
  e.cancel(); verify(e,store)
})

test('exact geometry, ordered queries, locks and hits survive nested edits, preview cancel, commit, undo/redo and pages', () => {
  const {doc,a,group,nested,locked} = fixture(), e = makeEditor(doc), store = new CanvasSceneSnapshots(), before = frozen(e.state.doc), beforeJSON = JSON.stringify(before)
  verify(e,store); e.select([a.id,locked.id]); e.begin('Nested preview')
  expect(e.preview({[group.id]:{transform:[.125,-1.375,2.5,.25,-100.125,500.375]},[nested.id]:{locked:true}})).toBe(true)
  verify(e,store,before); e.cancel(); expect(e.state.doc).toBe(before); verify(e,store)
  e.update([a.id],{width:27.125,transform:[-1.25,.75,.125,1.5,500.125,-200.75]})
  expect(e.state.doc).not.toBe(before); const committed = frozen(e.state.doc); verify(e,store,before)
  e.undo(); exact(e.state.doc,before); verify(e,store)
  e.redo(); exact(e.state.doc,committed); verify(e,store)
  e.set({page:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',selection:[]}); verify(e,store)
  e.set({page:doc.pages[0].id}); verify(e,store)
  expect(JSON.stringify(before)).toBe(beforeJSON)
})

test('component/layout/override publications preserve old geometry and rebuild new snapshots', () => {
  const {doc,ids} = componentFixture(), e = makeEditor(doc), store = new CanvasSceneSnapshots(), before = frozen(e.state.doc)
  verify(e,store); e.setComponentProperty(ids.a,ids.title,'独立标题'); verify(e,store,before)
  e.update([ids.button],{transform:[.5,.25,-.125,1.125,200.125,350.75]}); verify(e,store,before)
  e.begin('Component preview'); e.preview({[ids.a]:{transform:[-.75,.5,.125,1.25,425.5,125.75]}}); verify(e,store,before)
  e.commit(); verify(e,store); const final = e.state.doc
  e.undo(); verify(e,store); e.redo(); verify(e,store); exact(e.state.doc,final)
})

test('scope, readiness, same-ID reopen, document identity and replacement guards invalidate reuse', () => {
  const {doc} = fixture(), e = makeEditor(doc), store = new CanvasSceneSnapshots(), original=e.state.doc
  store.begin(e,0,e.state.page,false); let previous=store.currentScene(original,e.state.page)
  const check = (owner:object,session:number,page:string,ready:boolean,d=original) => {
    store.begin(owner,session,page,ready); const next=store.currentScene(d,page); expect(next).not.toBe(previous); previous=next
  }
  check(e,0,e.state.page,true); check(e,0,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true); check(e,0,e.state.page,true); check({},0,e.state.page,true)
  e.load(original); expect(e.state.doc.id).toBe(original.id); check(e,e.sessionGeneration,e.state.page,true,e.state.doc)
  check(e,e.sessionGeneration,e.state.page,true,{...e.state.doc})
  const mutable={...original}; check(e,e.sessionGeneration,e.state.page,true,mutable)
  mutable.nodes={...mutable.nodes}; check(e,e.sessionGeneration,e.state.page,true,mutable)
  mutable.pages=[...mutable.pages]; check(e,e.sessionGeneration,e.state.page,true,mutable)
  mutable.fonts={}; check(e,e.sessionGeneration,e.state.page,true,mutable)
})

test('font generations cover alternating editors, same-identity ABA, default restoration, failed loads and PDF installation', () => {
  const {doc} = fixture(), text=node('text',0,0,120,30)
  text.text='A117'; text.textStyle={...defaultTextStyle(),fontId:'subset'}
  text.textPath={network:{fillRule:'nonzero',vertices:[{id:'a',x:0,y:0},{id:'b',x:200,y:40}],edges:[{id:'ab',from:'a',to:'b'}]},offset:0,normal:0,reverse:false}
  doc.schemaVersion=10; doc.nodes[text.id]=text;doc.pages[0].children.push(text.id)
  doc.fonts={subset:{family:'Subset',data:fontTestBytes('noto-latin').toString('base64')}}
  const e=makeEditor(doc), store=new CanvasSceneSnapshots();store.begin(e,0,e.state.page,true)
  activateDocumentFonts(e.state.doc);const a=store.currentScene(e.state.doc,e.state.page), firstEpoch=pickingGeometryEpoch();verify(e,store)
  activateDocumentFonts(e.state.doc);expect(pickingGeometryEpoch()).toBe(firstEpoch)
  const other=makeEditor({...fixture().doc,fonts:{}});expect(pickingGeometryEpoch()).not.toBe(firstEpoch)
  const switched=store.currentScene(e.state.doc,e.state.page);expect(switched).not.toBe(a)
  exact(switched.entries,actual.scene(e.state.doc,e.state.page))
  activateDocumentFonts(e.state.doc);expect(store.currentScene(e.state.doc,e.state.page)).not.toBe(switched);verify(e,store,other.state.doc)
  const epoch=pickingGeometryEpoch(), same=store.currentScene(e.state.doc,e.state.page)
  expect(()=>activateDocumentFonts({...e.state.doc,fonts:{bad:{family:'Bad',data:'broken'}}})).toThrow()
  expect(pickingGeometryEpoch()).toBe(epoch);expect(store.currentScene(e.state.doc,e.state.page)).toBe(same)
  activateDocumentFonts({...e.state.doc,fonts:undefined});expect(pickingGeometryEpoch()).not.toBe(epoch)
  activateDocumentFonts(e.state.doc);const beforePDF=pickingGeometryEpoch()
  const pdf=kernelPdfVector(e.state.doc,e.state.page,400,300,false);expect(new TextDecoder().decode(pdf.subarray(0,4))).toBe('%PDF')
  expect(pickingGeometryEpoch()).not.toBe(beforePDF);verify(e,store)
})

test('failed scene/index construction cannot publish partial reusable results', () => {
  const e=makeEditor(fixture().doc),store=new CanvasSceneSnapshots();store.begin(e,0,e.state.page,true)
  work.failScene=true;expect(()=>store.currentScene(e.state.doc,e.state.page)).toThrow('scene build failure');expect((store as any).current).toBeUndefined()
  work.failScene=false;const snapshot=store.currentScene(e.state.doc,e.state.page)
  work.failIndex=true;expect(()=>snapshot.index).toThrow('index build failure')
  work.failIndex=false;expect(snapshot.index).toBeInstanceOf(actual.SpatialIndex);expect(snapshot.index).toBe(snapshot.index)
  expect(work.scenes).toBe(2);expect(work.indexes).toBe(2)
})

test.each([2,3,4,5,6,7,8,9,10,11,12,13,14] as const)('schema %i preserves exact scene/index arithmetic and publication identities',version=>{
  const {doc,a}=fixture();doc.schemaVersion=version
  const giant=node('rectangle',-10000.125,-10000.375,200000,200000);doc.nodes[giant.id]=giant;doc.pages[0].children.push(giant.id)
  const e=makeEditor(doc),store=new CanvasSceneSnapshots();verify(e,store)
  const before=frozen(e.state.doc);e.begin('Schema preview');expect(e.preview({[a.id]:{transform:[-.5,.125,.25,1.5,10.125,-9.375]}})).toBe(true)
  verify(e,store,before);e.commit();verify(e,store);const committed=e.state.doc
  e.undo();exact(e.state.doc,before);e.redo();exact(e.state.doc,committed);verify(e,store)
})

test('paint/name/opacity/effect edits keep fresh scene snapshots, current nodes and exact history', () => {
  const { doc, a } = fixture(), e = makeEditor(doc), store = new CanvasSceneSnapshots()
  store.begin(e, e.sessionGeneration, e.state.page, true)
  const originalDocument = e.state.doc, original = store.currentScene(originalDocument, e.state.page), index = original.index
  store.displayedScene(originalDocument, e.state.page)
  for (const patch of [{ name: 'Current label' }, { opacity: .375 }, { fills: [{ ...a.fills[0], visible: false }] }, { effects: [effect('blur')] }]) {
    const previousDocument = e.state.doc
    e.update([a.id], patch)
    expect(e.state.doc, e.state.message).not.toBe(previousDocument)
    const current = store.currentScene(e.state.doc, e.state.page)
    expect(current).not.toBe(original)
    expect(current.entries).not.toBe(original.entries); expect(current.index).not.toBe(index)
    expect(current.key.document).toBe(e.state.doc)
    expect(store.displayedScene(originalDocument, e.state.page)!.key.document).toBe(originalDocument)
    verify(e, store, originalDocument)
  }
  const final = e.state.doc
  e.undo(); verify(e, store, originalDocument)
  e.redo(); expect(e.state.doc).toBe(final); verify(e, store, originalDocument)
  expect(originalDocument.nodes[a.id].name).not.toBe('Current label')
})

test('scene rebuild covers geometric, unknown-field and complex-node changes', () => {
  const { doc, a, vector } = fixture(), e = makeEditor(doc)
  for (const [id, patch] of [
    [a.id, { transform: [1, 0, 0, 1, 40, 50] }],
    [a.id, { width: 100 }], [a.id, { visible: false }], [a.id, { locked: true }],
    [a.id, { strokes: [] }], [a.id, { text: 'Changed text dependency' }],
    [a.id, { mask: true }], [a.id, { clip: true }],
    [a.id, { futureGeometry: { scale: 3 } }], [vector.id, { name: 'Complex path renamed' }],
  ] as const) {
    const store = new CanvasSceneSnapshots(); store.begin(e, e.sessionGeneration, e.state.page, true)
    const previous = store.currentScene(e.state.doc, e.state.page); void previous.index
    const document = { ...e.state.doc, nodes: { ...e.state.doc.nodes, [id]: { ...e.state.doc.nodes[id], ...patch } } } as DesignDocument
    const current = store.currentScene(document, e.state.page)
    expect(current.entries).not.toBe(previous.entries); expect(current.index).not.toBe(previous.index)
    exact(current.entries, actual.scene(document, e.state.page))
  }
})

test('changed documents, sessions and top-level resources keep separate lazy scene caches', () => {
  const { doc, a } = fixture(), e = makeEditor(doc), store = new CanvasSceneSnapshots()
  store.begin(e, e.sessionGeneration, e.state.page, true)
  const before = store.currentScene(e.state.doc, e.state.page)
  e.update([a.id], { name: 'Renamed' })
  const after = store.currentScene(e.state.doc, e.state.page)
  expect(after.entries).not.toBe(before.entries); expect(after.index).not.toBe(before.index)
  for (const document of [
    { ...e.state.doc, pages: [...e.state.doc.pages] },
    { ...e.state.doc, fonts: {} },
  ]) {
    expect(store.currentScene(document, e.state.page).entries).not.toBe(after.entries)
  }
  store.begin(e, e.sessionGeneration + 1, e.state.page, true)
  expect(store.currentScene(e.state.doc, e.state.page).entries).not.toBe(after.entries)
})


test('interaction borrow shares existing geometry without builds and stays within the two existing slots', () => {
  const { doc, a } = fixture(), e = makeEditor(doc), store = new CanvasSceneSnapshots(), before = frozen(e.state.doc)
  const epoch = e.sessionGeneration, page = e.state.page
  store.begin(e, epoch, page, true)
  const first = store.currentScene(before, page), borrow = store.borrowCurrentScene(before, page, epoch)!
  expect(work.scenes).toBe(1); expect(work.indexes).toBe(0)
  for (let i = 0; i < 200; i++) {
    expect(borrow.entriesFor(before, page, epoch)).toBe(first.entries)
    expect(borrow.entriesFor({ ...before }, page, epoch)).toBeUndefined()
    expect(borrow.entriesFor(before, page, epoch + 1)).toBeUndefined()
    expect(borrow.entriesFor(before, 'other-page', epoch)).toBeUndefined()
  }
  expect(work.scenes).toBe(1); expect(work.indexes).toBe(0)
  store.displayedScene(before, page)
  e.update([a.id], { width: a.width + 1 })
  const next = store.currentScene(e.state.doc, page)
  expect(next).not.toBe(first)
  expect(borrow.entriesFor(before, page, epoch)).toBe(first.entries)
  expect(borrow.entriesFor(e.state.doc, page, epoch)).toBeUndefined()
  expect(store.borrowCurrentScene(before, page, epoch)).toBeUndefined()
  store.displayedScene(undefined, undefined)
  expect(borrow.entriesFor(before, page, epoch)).toBeUndefined()
  expect(work.scenes).toBe(2); expect(work.indexes).toBe(0)
  const editedDocument = e.state.doc, editedBorrow = store.borrowCurrentScene(editedDocument, page, epoch)!
  e.undo()
  const undone = store.currentScene(e.state.doc, page), undoBorrow = store.borrowCurrentScene(e.state.doc, page, epoch)!
  expect(editedBorrow.entriesFor(e.state.doc, page, epoch)).toBeUndefined()
  exact(undoBorrow.entriesFor(e.state.doc, page, epoch), actual.scene(e.state.doc, page))
  e.redo()
  const redone = store.currentScene(e.state.doc, page), redoBorrow = store.borrowCurrentScene(e.state.doc, page, epoch)!
  expect(undoBorrow.entriesFor(e.state.doc, page, epoch)).toBeUndefined()
  exact(redoBorrow.entriesFor(e.state.doc, page, epoch), actual.scene(e.state.doc, page))
  expect(redone.entries).not.toBe(undone.entries)
})

test('interaction borrows revoke on scope ABA, readiness, changed containers and geometry epochs', () => {
  const { doc } = fixture(), e = makeEditor(doc), store = new CanvasSceneSnapshots(), page = e.state.page
  const epoch = e.sessionGeneration
  const issue = () => {
    store.begin(e, epoch, page, true); store.currentScene(e.state.doc, page)
    return store.borrowCurrentScene(e.state.doc, page, epoch)!
  }
  for (const [owner, session, selectedPage, ready] of [
    [{}, epoch, page, true], [e, epoch + 1, page, true],
    [e, epoch, 'other-page', true], [e, epoch, page, false],
  ] as const) {
    const borrow = issue()
    store.begin(owner, session, selectedPage, ready)
    store.begin(e, epoch, page, true); store.currentScene(e.state.doc, page)
    expect(borrow.entriesFor(e.state.doc, page, epoch)).toBeUndefined()
  }
  const mutableTop = { ...e.state.doc }, borrowFor = (document: DesignDocument) => {
    store.currentScene(document, page); return store.borrowCurrentScene(document, page, epoch)!
  }
  for (const replace of [
    () => { mutableTop.nodes = { ...mutableTop.nodes } },
    () => { mutableTop.pages = [...mutableTop.pages] },
    () => { mutableTop.fonts = {} },
  ]) {
    const borrow = borrowFor(mutableTop); replace()
    expect(borrow.entriesFor(mutableTop, page, epoch)).toBeUndefined()
  }
  // Existing scene caches also require immutable nodes below these containers;
  // this capability deliberately does not claim arbitrary mutable-draft safety.
  const fontDocument = { ...e.state.doc, fonts: { subset: {
    family: 'Subset', data: fontTestBytes('noto-latin').toString('base64'),
  } } }
  activateDocumentFonts(fontDocument)
  const fontBorrow = borrowFor(fontDocument)
  expect(fontBorrow.entriesFor(fontDocument, page, epoch)).toBeDefined()
  activateDocumentFonts({ ...fontDocument, fonts: undefined })
  expect(fontBorrow.entriesFor(fontDocument, page, epoch)).toBeUndefined()
  store.begin(e, epoch, page, false); store.currentScene(e.state.doc, page)
  expect(store.borrowCurrentScene(e.state.doc, page, epoch)).toBeUndefined()
})
