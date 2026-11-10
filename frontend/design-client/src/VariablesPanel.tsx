import { memo, useMemo, useState, useSyncExternalStore } from 'react'
import type { Editor } from './engine'
import type { DesignDocument } from './model'
import { DraftInput } from './DraftInput'
import type { InterfaceLocale } from './interface-preference'
import { bindingHeading, collectionModeLabel, copyModeOption, deleteModeLabel, deleteVariableLabel, layerModeLabel, modeCapacity, modePageStatus, removalMore, removalReferences, removalTitle, renameModeLabel, translateProfessional, useProfessionalDialogText, variableCountStatus, variablePageStatus, variableQualifiedLabel } from './professional-dialog-messages'
import { commitPendingEdits } from './pending-edits'
import { emptySystem, effectiveNodeVariableModes, setEffectiveNodeVariableMode, setVariableMode } from './design-system'
import {
  MODE_PAGE_SIZE, VARIABLE_PAGE_SIZE, addVariableMode, collectionReferences, createVariable,
  createVariableCollection, deleteVariable, deleteVariableCollection, deleteVariableMode,
  materializeVariableCell, modeReferences, parseVariableLiteral, renameVariable, renameVariableCollection,
  renameVariableMode, setVariableCell, setVariableDefaultMode, validVariableName, variableGroup,
  variableIndex, variableKinds, variableReferences, type Variable, type VariableKind,
} from './variable-editing'
import './VariablesPanel.css'

type Change = (label: string, edit: (doc: DesignDocument) => void) => boolean
type Removal = { kind: 'variable' | 'collection' | 'mode'; id: string; mode?: string }
const EMPTY = emptySystem()
const kindNames = { color: '颜色', number: '数值', boolean: '布尔', string: '文字' }

const VariableCell = memo(function VariableCell({ editor, id, variable, mode, candidates, managed, change, run, locale }: {
  editor: Editor; id: string; variable: Variable; mode: string; candidates: [string, Variable][];
  managed: boolean; change: Change; run: Change; locale: InterfaceLocale
}) {
  const tr = (source: string) => translateProfessional(source, locale)
  const value = variable.values[mode], alias = typeof value === 'object' ? value.alias : undefined
  const [choosing, setChoosing] = useState(false), [query, setQuery] = useState('')
  const matches = useMemo(() => alias || choosing ? candidates.filter(([key, v]) => key !== id && v.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : [], [candidates, id, query, alias, choosing])
  const options = matches.slice(0, 60)
  if (alias && !options.some(([key]) => key === alias)) {
    const selected = candidates.find(([key]) => key === alias)
    if (selected) options.unshift(selected)
  }
  const literalValid = (text: string) => { try { parseVariableLiteral(variable.kind, text, managed); return true } catch { return false } }
  return <div className="variables-cell">
    <select aria-label={variableQualifiedLabel(variable.name, mode, '值类型', locale)} value={alias || choosing ? 'alias' : 'literal'} onChange={e => {
      if (!commitPendingEdits(editor)) return
      if (e.target.value === 'literal') {
        if (!alias || change('将变量别名转为值', doc => materializeVariableCell(doc, id, mode))) setChoosing(false)
      } else setChoosing(true)
    }}>
      <option value="literal">{tr('值')}</option><option value="alias" disabled={!candidates.some(([key]) => key !== id)}>{tr('别名')}</option>
    </select>
    {alias || choosing ? <>
      <input aria-label={variableQualifiedLabel(variable.name, mode, '搜索别名', locale)} placeholder={tr('搜索同类型变量')} value={query} onChange={e => setQuery(e.target.value)} />
      <select aria-label={variableQualifiedLabel(variable.name, mode, '别名', locale)} value={alias || ''} onChange={e => {
        if (e.target.value && run('设置变量别名', doc => setVariableCell(doc, id, mode, { alias: e.target.value }))) setChoosing(false)
      }}>
        {!alias && <option value="">{tr('选择同类型变量…')}</option>}
        {options.map(([key, v]) => <option key={key} value={key}>{v.name}</option>)}
      </select>
      {matches.length > 60 && <small>{tr('显示前 60 项，请搜索缩小范围')}</small>}
    </> : variable.kind === 'boolean' ?
      <select aria-label={`${variable.name} ${mode}`} value={String(value)} onChange={e => run('修改变量值', doc => setVariableCell(doc, id, mode, e.target.value === 'true'))}>
        <option value="true">true</option><option value="false">false</option>
      </select> : <DraftInput editor={editor} aria-label={`${variable.name} ${mode}`} value={String(value)} validate={literalValid}
        normalize={text => { if (variable.kind !== 'number') return text; try { return String(parseVariableLiteral('number', text)) } catch { return text } }}
        title={tr(variable.kind === 'number' ? '支持有限小数与科学计数法；Enter 或失焦保存，Esc 取消' : variable.kind === 'color' ? '#RRGGBB 或受支持的 color()；Enter 或失焦保存，Esc 取消' : 'Enter 或失焦保存，Esc 取消')}
        onCommit={text => change('修改变量值', doc => setVariableCell(doc, id, mode, parseVariableLiteral(variable.kind, text, managed)))} />}
  </div>
})

export function VariablesPanel({ editor }: { editor: Editor }) {
  const { locale, tr } = useProfessionalDialogText()
  const { doc, selection } = useSyncExternalStore(editor.subscribe, editor.panelSnapshot), system = doc.designSystem || EMPTY
  const index = useMemo(() => variableIndex(system), [system])
  const [selected, setSelected] = useState(''), [newName, setNewName] = useState(''), [newMode, setNewMode] = useState('')
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all'), [rowPage, setRowPage] = useState(0), [modePage, setModePage] = useState(0)
  const [copyFrom, setCopyFrom] = useState<string | null>(null), [error, setError] = useState(''), [removal, setRemoval] = useState<Removal | null>(null)
  const [property, setProperty] = useState('fills.0.color'), [bindingQuery, setBindingQuery] = useState('')
  const collectionId = Object.hasOwn(system.collections, selected) ? selected : Object.keys(system.collections)[0]
  const collection = system.collections[collectionId], variables = index.byCollection.get(collectionId) || []
  const filtered = useMemo(() => variables.filter(([, v]) => (kind === 'all' || v.kind === kind) && v.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [variables, kind, query])
  const page = Math.min(rowPage, Math.max(0, Math.ceil(filtered.length / VARIABLE_PAGE_SIZE) - 1))
  const columnPage = Math.min(modePage, Math.max(0, Math.ceil((collection?.modes.length || 0) / MODE_PAGE_SIZE) - 1))
  const visible = filtered.slice(page * VARIABLE_PAGE_SIZE, (page + 1) * VARIABLE_PAGE_SIZE)
  const modes = collection?.modes.slice(columnPage * MODE_PAGE_SIZE, (columnPage + 1) * MODE_PAGE_SIZE) || []
  const groups = new Map<string, [string, Variable][]>()
  for (const entry of visible) { const group = variableGroup(entry[1].name); const entries = groups.get(group) || []; entries.push(entry); groups.set(group, entries) }
  const change: Change = (label, edit) => {
    const before = editor.state.doc
    editor.change(label, edit)
    const failed = editor.state.doc === before && editor.state.message !== label
    setError(failed ? editor.state.message : '')
    return !failed
  }
  const run: Change = (label, edit) => commitPendingEdits(editor) && change(label, edit)
  const navigate = (next: () => void) => { if (commitPendingEdits(editor)) { setError(''); setRemoval(null); next() } else setError(editor.state.message) }
  const requestRemoval = (value: Removal) => navigate(() => setRemoval(value))
  const removalExists = removal && (removal.kind === 'variable' ? !!system.variables[removal.id] : !!system.collections[removal.id] && (removal.kind !== 'mode' || system.collections[removal.id].modes.includes(removal.mode!)))
  const references = useMemo(() => !removal || !removalExists ? [] : removal.kind === 'variable' ? variableReferences(doc, removal.id) : removal.kind === 'collection' ? collectionReferences(doc, removal.id) : modeReferences(doc, removal.id, removal.mode!), [doc, removal, removalExists])
  const removalName = removal && removalExists ? removal.kind === 'variable' ? system.variables[removal.id].name : removal.kind === 'mode' ? removal.mode : system.collections[removal.id].name : ''
  const n = doc.nodes[selection[0]], bindingKind: VariableKind = property.endsWith('color') ? 'color' : property === 'text' ? 'string' : property === 'visible' ? 'boolean' : 'number'
  const selectedBindings = selection.map(id => doc.nodes[id]?.bindings?.[property] || '')
  const binding = selectedBindings.every(value => value === selectedBindings[0]) ? selectedBindings[0] || '' : '__mixed__'
  const bindingMatches = useMemo(() => (index.byKind.get(bindingKind) || []).filter(([, v]) => v.name.toLocaleLowerCase().includes(bindingQuery.toLocaleLowerCase())), [index, bindingKind, bindingQuery])
  const bindingOptions = bindingMatches.slice(0, 100)
  if (binding && binding !== '__mixed__' && !bindingOptions.some(([id]) => id === binding)) {
    const selected = system.variables[binding]
    if (selected) bindingOptions.unshift([binding, selected])
  }
  const pageShown = filtered.length ? `${page * VARIABLE_PAGE_SIZE + 1}–${Math.min((page + 1) * VARIABLE_PAGE_SIZE, filtered.length)}` : '0'
  return <div className="variables-panel" onKeyDown={event => { if (event.key === 'Escape' && event.defaultPrevented) event.stopPropagation() }}>
    <div className="variables-toolbar">
      <div><strong>{tr('本地变量')}</strong><p>{tr('每次修改均可撤销，并随文档保存。名称使用 / 自动分组。')}</p></div>
      <div className="variables-history"><button type="button" disabled={!editor.canUndo} onClick={() => navigate(() => editor.undo())}>{tr('撤销')}</button><button type="button" disabled={!editor.canRedo} onClick={() => navigate(() => editor.redo())}>{tr('重做')}</button></div>
    </div>
    {error && <p className="variables-error" role="alert">{tr(error)}</p>}
    <div className="variables-layout">
      <aside aria-label={tr('变量集合')}>
        <div className="variables-create"><input aria-label={tr('集合名称')} placeholder={tr('集合名称')} value={newName} onChange={e => setNewName(e.target.value)} />
          <button type="button" disabled={!!newName && !validVariableName(newName.trim())} onClick={() => {
            let id = ''
            if (run('新建变量集合', d => { id = createVariableCollection(d, newName) })) { setSelected(id); setNewName(''); setQuery(''); setRowPage(0); setModePage(0); setRemoval(null) }
          }}>{tr('新建集合')}</button></div>
        <div className="variables-collections">{Object.entries(system.collections).map(([id, c]) =>
          <button type="button" key={id} aria-pressed={id === collectionId} onClick={() => navigate(() => { setSelected(id); setRowPage(0); setModePage(0); setCopyFrom(null); setNewMode('') })}>
            <span>{c.name}</span><small>{index.byCollection.get(id)?.length || 0}</small>
          </button>)}</div>
      </aside>
      <div className="variables-main">
        {!collection ? <div className="variables-empty"><strong>{tr('用变量统一颜色、尺寸与文案')}</strong><p>{tr('新建集合后，可为不同模式设置值，并绑定到图层。')}</p></div> : <>
          <div className="variables-collection-title"><DraftInput key={collectionId} editor={editor} aria-label={tr('重命名集合')} value={collection.name} normalize={value => value.trim()} validate={validVariableName} onCommit={value => change('重命名变量集合', d => renameVariableCollection(d, collectionId, value))} />
            <button type="button" onClick={() => requestRemoval({ kind: 'collection', id: collectionId })}>{tr('删除集合')}</button></div>
          <div className="variables-mode-settings">
            <label>{tr('当前模式')}<select aria-label={collectionModeLabel(collection.name, '当前模式', locale)} value={system.activeModes[collectionId] ?? collection.defaultMode} onChange={e => run('切换主题', d => setVariableMode(d, collectionId, e.target.value))}>{collection.modes.map(mode => <option key={mode}>{mode}</option>)}</select></label>
            <label>{tr('默认模式')}<select aria-label={collectionModeLabel(collection.name, '默认模式', locale)} value={collection.defaultMode} onChange={e => run('设置默认变量模式', d => setVariableDefaultMode(d, collectionId, e.target.value))}>{collection.modes.map(mode => <option key={mode}>{mode}</option>)}</select></label>
            <small>{tr('未指定当前模式时使用默认模式；图层局部模式优先。')}</small>
          </div>
          <div className="variables-add-mode"><input aria-label={tr('新增模式名称')} placeholder={tr('新增模式')} value={newMode} onChange={e => setNewMode(e.target.value)} />
            <select aria-label={tr('复制模式值来源')} value={copyFrom !== null && collection.modes.includes(copyFrom) ? copyFrom : collection.defaultMode} onChange={e => setCopyFrom(e.target.value)}>{collection.modes.map(mode => <option key={mode} value={mode}>{copyModeOption(mode, locale)}</option>)}</select>
            <button type="button" disabled={!validVariableName(newMode.trim()) || collection.modes.includes(newMode.trim()) || collection.modes.length >= 32} onClick={() => {
              if (run('新增变量模式', d => addVariableMode(d, collectionId, newMode, copyFrom !== null && collection.modes.includes(copyFrom) ? copyFrom : collection.defaultMode))) { setNewMode(''); setModePage(Math.floor(collection.modes.length / MODE_PAGE_SIZE)) }
            }}>{tr('添加模式')}</button><small>{modeCapacity(collection.modes.length, locale)}</small></div>
          <div className="variables-search"><input type="search" aria-label={tr('搜索变量')} placeholder={tr('搜索变量名称或分组')} value={query} onChange={e => navigate(() => { setQuery(e.target.value); setRowPage(0) })} />
            <select aria-label={tr('变量类型筛选')} value={kind} onChange={e => navigate(() => { setKind(e.target.value); setRowPage(0) })}><option value="all">{tr('全部类型')}</option>{variableKinds.map(kind => <option key={kind} value={kind}>{tr(kindNames[kind])}</option>)}</select>
            <span role="status">{variableCountStatus(filtered.length, variables.length, locale)}</span></div>
          <div className="variables-add">{variableKinds.map(kind => <button type="button" key={kind} onClick={() => {
            if (run('新建变量', d => { createVariable(d, collectionId, kind) })) { setQuery(''); setKind('all'); setRowPage(0) }
          }}>+ {kind}</button>)}</div>
          <div className="variables-pager"><span>{modePageStatus(columnPage * MODE_PAGE_SIZE + 1, Math.min((columnPage + 1) * MODE_PAGE_SIZE, collection.modes.length), collection.modes.length, locale)}</span>
            <button type="button" aria-label={tr('上一组模式')} disabled={columnPage === 0} onClick={() => navigate(() => setModePage(columnPage - 1))}>←</button>
            <button type="button" aria-label={tr('下一组模式')} disabled={(columnPage + 1) * MODE_PAGE_SIZE >= collection.modes.length} onClick={() => navigate(() => setModePage(columnPage + 1))}>→</button></div>
          <div className="variables-table-scroll"><table className="variables-table"><thead><tr><th>{tr('名称 / 类型')}</th>{modes.map(mode => <th key={mode}>
            <DraftInput editor={editor} aria-label={renameModeLabel(mode, locale)} value={mode} normalize={value => value.trim()} validate={value => validVariableName(value) && (value === mode || !collection.modes.includes(value))} onCommit={value => change('重命名变量模式', d => renameVariableMode(d, collectionId, mode, value))} />
            <button type="button" aria-label={deleteModeLabel(mode, locale)} onClick={() => requestRemoval({ kind: 'mode', id: collectionId, mode })}>{tr('删除模式')}</button>
          </th>)}<th>{tr('管理')}</th></tr></thead>
          {[...groups].map(([group, entries]) => <tbody key={group}><tr className="variables-group"><th colSpan={modes.length + 2}>{group === '未分组' ? tr('未分组') : group}</th></tr>{entries.map(([id, v]) => <tr key={id} data-variable-id={id}>
            <td><DraftInput editor={editor} aria-label={tr('变量名称')} value={v.name} normalize={value => value.trim()} validate={validVariableName} onCommit={value => change('命名变量', d => renameVariable(d, id, value))} /><small>{tr(kindNames[v.kind])}</small></td>
            {modes.map(mode => <td key={mode}><VariableCell editor={editor} id={id} variable={v} mode={mode} candidates={index.byKind.get(v.kind) || []} managed={!!doc.colorManagement} change={change} run={run} locale={locale} /></td>)}
            <td><button type="button" aria-label={deleteVariableLabel(v.name, locale)} onClick={() => requestRemoval({ kind: 'variable', id })}>{tr('删除')}</button></td>
          </tr>)}</tbody>)}</table></div>
          {!filtered.length && <p className="variables-empty">{variables.length ? tr('没有匹配的变量，请调整搜索或类型筛选。') : tr('集合还没有变量。选择上方类型开始添加。')}</p>}
          <div className="variables-pager"><span>{variablePageStatus(pageShown, filtered.length, locale)}</span>
            <button type="button" aria-label={tr('上一页变量')} disabled={page === 0} onClick={() => navigate(() => setRowPage(page - 1))}>{tr('上一页')}</button>
            <button type="button" aria-label={tr('下一页变量')} disabled={(page + 1) * VARIABLE_PAGE_SIZE >= filtered.length} onClick={() => navigate(() => setRowPage(page + 1))}>{tr('下一页')}</button></div>
        </>}
      </div>
    </div>
    {removal && removalExists && <section className="variables-removal" aria-label={tr('删除检查')}>
      <strong>{removalTitle(references.length > 0, removalName || '', locale)}</strong>
      {references.length ? <><p>{removalReferences(references.length, locale)}</p><ul>{references.slice(0, 30).map((ref, i) => <li key={i}>{ref}</li>)}</ul>{references.length > 30 && <p>{removalMore(references.length - 30, locale)}</p>}</> : <p>{removal.kind === 'mode' ? tr('此模式的所有变量值也会移除。') : tr('此资源当前没有引用。')}{locale === 'en' ? ' ' : ''}{tr('删除后可使用撤销恢复。')}</p>}
      <button type="button" onClick={() => setRemoval(null)}>{tr('取消删除')}</button>
      <button type="button" disabled={references.length > 0} onClick={() => {
        if (run('删除变量资源', d => { if (removal.kind === 'variable') deleteVariable(d, removal.id); else if (removal.kind === 'collection') deleteVariableCollection(d, removal.id); else deleteVariableMode(d, removal.id, removal.mode!) })) setRemoval(null)
      }}>{tr('确认删除')}</button>
    </section>}
    {n && <section className="variables-bindings"><h3>{bindingHeading(selection.length, n.name, locale)}</h3>
      <div className="variables-local-modes">{Object.entries(system.collections).map(([cid, c]) => {
        const localModes = selection.map(id => effectiveNodeVariableModes(doc.nodes[id])?.[cid])
        const value = localModes.every(mode => mode === localModes[0]) ? localModes[0] === undefined ? 'inherit' : `mode:${localModes[0]}` : 'mixed'
        return <label key={cid}>{c.name}<select aria-label={layerModeLabel(c.name, locale)} value={value} onChange={e => run('设置图层局部模式', d => {
          for (const id of selection) setEffectiveNodeVariableMode(d, id, cid, e.target.value === 'inherit' ? undefined : e.target.value.slice(5))
        })}><option value="inherit">{selection.some(id => {
          const selected = doc.nodes[id]
          return selected.instance && !selected.instanceOrigin && Object.hasOwn(selected.instance.overrides.$root || {}, 'variableModes')
        }) ? tr('继承上级模式') : tr('继承上级或组件默认模式')}</option>{value === 'mixed' && <option value="mixed" disabled>{tr('多种模式')}</option>}{c.modes.map(mode => <option key={mode} value={`mode:${mode}`}>{mode}</option>)}</select></label>
      })}</div>
      <div className="variables-binding-controls"><select aria-label={tr('绑定属性')} value={property} onChange={e => navigate(() => setProperty(e.target.value))}>
        {[
          ['fills.0.color', '填充颜色'], ['fills.0.opacity', '填充透明度'], ['width', '宽度'], ['height', '高度'], ['opacity', '图层透明度'],
          ['visible', '图层可见性'], ['text', '文字内容'], ['fontSize', '字号'], ['layout.gap', '自动布局间距'], ['textStyle.weight', '字重'],
        ].map(([path, label]) => <option key={path} value={path}>{tr(label)}</option>)}
      </select><input aria-label={tr('搜索绑定变量')} placeholder={tr('搜索绑定变量')} value={bindingQuery} onChange={e => setBindingQuery(e.target.value)} /><select aria-label={tr('绑定变量')} value={binding} onChange={e => {
        if (!commitPendingEdits(editor)) return
        const before = editor.state.doc
        editor.updateProperties(selection, n => { n.bindings = { ...n.bindings }; if (e.target.value) n.bindings[property] = e.target.value; else delete n.bindings[property] }, '绑定变量')
        setError(editor.state.doc === before && editor.state.message !== '绑定变量' ? editor.state.message : '')
      }}><option value="">{tr('未绑定')}</option>{binding === '__mixed__' && <option value="__mixed__" disabled>{tr('多种绑定')}</option>}{bindingOptions.map(([id, v]) => <option key={id} value={id}>{system.collections[v.collection]?.name} / {v.name}</option>)}</select>{bindingMatches.length > 100 && <small>{tr('显示前 100 项，请搜索缩小范围')}</small>}</div>
    </section>}
  </div>
}
