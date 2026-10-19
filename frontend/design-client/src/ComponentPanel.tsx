import { DraftInput } from './DraftInput'
import { useState } from 'react'
import type { Editor } from './engine'
import type { DesignNode, ComponentProperty } from './model'
import { definitionOwner, instanceOwner, family } from './components'
function ValueInput({
  label,
  kind,
  value,
  onChange,
  components,
}: {
  label: string
  kind: ComponentProperty['kind']
  value: string | boolean
  onChange: (value: string | boolean) => void
  components: DesignNode[]
}) {
  if (kind === 'boolean')
    return (
      <label className="check-row">
        <input
          aria-label={label}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    )
  if (kind === 'instance-swap')
    return (
      <label className="labeled-select">
        {label}
        <select aria-label={label} value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {components.map((c) => (
            <option value={c.id} key={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
    )
  return (
    <label className="component-text">
      {label}
      <DraftInput aria-label={label} value={String(value)} onCommit={onChange} />
    </label>
  )
}
export function ComponentPanel({
  editor,
  node: n,
  ids,
}: {
  editor: Editor
  node: DesignNode
  ids: string[]
}) {
  const d = editor.state.doc,
    masters = Object.values(d.nodes).filter((n) => n.component),
    definition = definitionOwner(d, n.id),
    owner = instanceOwner(d, n.id),
    target = n.instance ? n : d.nodes[owner || ''],
    source = d.nodes[target?.instance?.componentId || ''],
    set = source ? family(d, source.id) : undefined
  const [propertyName, setPropertyName] = useState(''),
    [axisName, setAxisName] = useState('')
  const variants = n.component?.variants || {},
    sourceProps = source?.component?.properties || {}
  if (!n.component && !n.componentSet && !owner && !definition)
    return (
      <section>
        <h3>组件</h3>
        <button className="text-button" onClick={() => editor.createComponent()}>
          ◇ 创建组件
        </button>
        {ids.length > 1 && ids.every((id) => d.nodes[id].component) && (
          <button onClick={() => editor.combineVariants()}>组合为变体</button>
        )}
      </section>
    )
  return (
    <section className="component-panel">
      <h3>
        {n.componentSet ? '组件集' : n.component ? '主组件' : owner ? '组件实例' : '组件图层'}
      </h3>
      {n.component && (
        <>
          <div className="component-actions">
            <button onClick={() => editor.insertComponent(n.id)}>创建实例</button>
            <button onClick={() => editor.addVariant(n.id)}>添加变体</button>
            {ids.length > 1 && ids.every((id) => d.nodes[id].component) && (
              <button onClick={() => editor.combineVariants()}>组合为变体</button>
            )}
          </div>
          {Object.entries(variants).map(([axis, value]) => (
            <label key={axis} className="component-text">
              {axis}
              <DraftInput
                aria-label={`变体值 ${axis}`}
                value={value}
                onCommit={(value) => editor.updateProperties([n.id], (node) => { node.component!.variants[axis] = value }, '修改变体值')}
              />
            </label>
          ))}
          {Object.entries(n.component.properties).map(([id, p]) => (
            <div className="component-property" key={id}>
              <ValueInput
                label={`默认 ${p.name}`}
                kind={p.kind}
                value={p.defaultValue}
                components={masters}
                onChange={(value) =>
                  editor.updateProperties(
                    [n.id],
                    (node) => {
                      node.component!.properties[id].defaultValue = value
                    },
                    '修改组件默认属性',
                  )
                }
              />
              <button
                title={`删除属性 ${p.name}`}
                onClick={() =>
                  editor.updateProperties(
                    [n.id],
                    (node) => {
                      delete node.component!.properties[id]
                    },
                    '删除组件属性',
                  )
                }
              >
                移除属性
              </button>
            </div>
          ))}
          {!Object.keys(n.component.properties).length && (
            <p className="muted">进入组件，选择文字、图层或嵌套实例以定义公开属性。</p>
          )}
        </>
      )}
      {n.componentSet && (
        <>
          <p className="muted">{n.children.length} 个变体</p>
          <div className="component-actions">
            <input
              aria-label="新增变体属性名"
              placeholder="例如：尺寸"
              value={axisName}
              onChange={(e) => setAxisName(e.target.value)}
            />
            <button
              disabled={!axisName.trim()}
              onClick={() => {
                editor.addVariantAxis(n.id, axisName.trim())
                setAxisName('')
              }}
            >
              添加属性
            </button>
          </div>
          {n.children.map((id) => (
            <button className="component-asset" key={id} onClick={() => editor.select([id])}>
              {d.nodes[id].name} · {Object.values(d.nodes[id].component!.variants).join(' / ')}
            </button>
          ))}
        </>
      )}
      {target?.instance && (
        <>
          <p className="component-source">{source?.name || '主组件缺失'}</p>
          <label className="labeled-select">
            替换组件
            <select
              aria-label="替换组件"
              value={target.instance.componentId}
              onChange={(e) => editor.swapInstance(target.id, e.target.value)}
            >
              {masters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {set &&
            Object.keys(source.component!.variants).map((axis) => (
              <label className="labeled-select" key={axis}>
                {axis}
                <select
                  aria-label={`变体 ${axis}`}
                  value={source.component!.variants[axis]}
                  onChange={(e) => editor.switchVariant(target.id, axis, e.target.value)}
                >
                  {[
                    ...new Set(set.children.map((id) => d.nodes[id].component!.variants[axis])),
                  ].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          {Object.entries(sourceProps).map(([id, p]) => (
            <div className="component-property" key={id}>
              <ValueInput
                label={`实例 ${p.name}`}
                kind={p.kind}
                value={target.instance!.propertyValues[id] ?? p.defaultValue}
                components={masters}
                onChange={(value) => editor.setComponentProperty(target.id, id, value)}
              />
            </div>
          ))}
          <div className="component-actions">
            <button onClick={() => editor.goToMain(target.id)}>定位主组件</button>
            <button onClick={() => editor.resetInstance(n.id)}>
              {n.id === owner ? '重置全部覆盖' : '重置当前覆盖'}
            </button>
            <button onClick={() => editor.detachInstance(n.id)}>
              {n.instanceOrigin ? '分离最外层实例' : '分离实例'}
            </button>
          </div>
        </>
      )}
      {definition && definition !== n.id && !n.instanceOrigin && (
        <>
          <h4>公开组件属性</h4>
          <input
            aria-label="组件属性名"
            placeholder={n.name}
            value={propertyName}
            onChange={(e) => setPropertyName(e.target.value)}
          />
          <div className="component-actions">
            {n.kind === 'text' && (
              <button
                onClick={() => editor.exposeComponentProperty(n.id, 'text', propertyName || n.name)}
              >
                公开文本
              </button>
            )}
            <button
              onClick={() =>
                editor.exposeComponentProperty(n.id, 'boolean', propertyName || `显示${n.name}`)
              }
            >
              公开显示开关
            </button>
            {n.instance && (
              <button
                onClick={() =>
                  editor.exposeComponentProperty(
                    n.id,
                    'instance-swap',
                    propertyName || `替换${n.name}`,
                  )
                }
              >
                公开实例替换
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
