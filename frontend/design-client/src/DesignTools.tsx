import { modalKeyDown } from './modal-keyboard'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Editor } from './engine'
import { uid, defaultTextStyle, type DesignDocument } from './model'
import {
  emptySystem,
  installLibrary,
  publishLibrary,
  verifyLibrary,
  variableValue,
  effectiveNodeVariableModes,
  setEffectiveNodeVariableMode,
  type VariableValue,
} from './design-system'
import { download } from './persistence'
import type { Interaction, PrototypeAction } from './prototype'
import { hasSchemaExtras } from './prototype'
import { PrototypePlayer } from './PrototypePlayer'
import { ImportOwner, importStep } from './import-ownership'

export type DesignToolsTab = 'variables' | 'styles' | 'libraries' | 'prototype'
export function DesignTools({ editor, onClose, initialTab = 'variables', embedded = false }: { editor: Editor; onClose: () => void; initialTab?: DesignToolsTab; embedded?: boolean }) {
  const { doc, selection } = useSyncExternalStore(editor.subscribe, editor.snapshot),
    system = doc.designSystem || emptySystem(),
    n = doc.nodes[selection[0]]
  const [tab, setTab] = useState<DesignToolsTab>(initialTab),
    [name, setName] = useState(''),
    [mode, setMode] = useState(''),
    [version, setVersion] = useState(1),
    [preview, setPreview] = useState(false),
    [error, setError] = useState(''),
    [property, setProperty] = useState('fills.0.color')
  const file = useRef<HTMLInputElement>(null)
  const [imports] = useState(() => new ImportOwner())
  useEffect(() => { imports.activate(); return () => imports.dispose() }, [imports])
  useEffect(() => {
    const input = file.current
    const onCancel = () => imports.invalidate()
    input?.addEventListener('cancel', onCancel)
    return () => input?.removeEventListener('cancel', onCancel)
  })
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (embedded) return
    const previous = document.activeElement
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [embedded])
  const change = (label: string, fn: (s: ReturnType<typeof emptySystem>) => void) => {
    const before = editor.state.doc
    editor.change(label, (d) => {
      fn((d.designSystem ??= emptySystem()))
      // Paint styles carrying strokes/effects are a schema-12 facet.
      if (
        Object.values(d.designSystem?.styles || {}).some(
          (s) => s.kind === 'paint' && ((s.strokes?.length ?? 0) > 0 || (s.effects?.length ?? 0) > 0),
        )
      )
        d.schemaVersion = Math.max(d.schemaVersion, 12) as DesignDocument['schemaVersion']
    })
    setError(
      editor.state.doc === before && editor.state.message !== label ? editor.state.message : '',
    )
  }
  const selectedCollection = Object.keys(system.collections)[0]
  const parse = (kind: string, value: string) =>
    kind === 'number' ? Number(value) : kind === 'boolean' ? value === 'true' : value
  const interaction = (index: number, fn: (e: Interaction) => void) =>
    editor.change('修改交互', (d) => {
      fn(d.prototype!.interactions[n.id][index])
      // Easing curves, overlay placements and recovered action-schema
      // extras are schema-12 facets.
      if (
        Object.values(d.prototype?.interactions || {}).some((events) =>
          events.some((e) =>
            e.actions.some((a) => a.easingCurve || a.overlayPosition || hasSchemaExtras(a)),
          ),
        )
      )
        d.schemaVersion = Math.max(d.schemaVersion, 12) as DesignDocument['schemaVersion']
    })
  const action = (index: number, at: number, fn: (a: PrototypeAction) => void) =>
    interaction(index, (e) => fn(e.actions[at]))
  const setExtra = (a: PrototypeAction, key: keyof PrototypeAction, value: unknown) => {
    if (value === undefined || value === '') delete (a as Record<string, unknown>)[key]
    else (a as Record<string, unknown>)[key] = value
  }
  const accessibility = embedded
    ? { role: 'region' as const, 'aria-label': '原型属性' }
    : { role: 'dialog' as const, 'aria-modal': 'true' as const, 'aria-label': '设计系统与交互' }
  return (
    <>
      <div className={embedded ? 'embedded-design-tools' : 'feature-backdrop'}>
        <div ref={dialog} className="design-tools" {...accessibility} tabIndex={-1} onKeyDown={embedded ? undefined : (event) => modalKeyDown(event, onClose)}>
          {!embedded && <header>
            <strong>设计系统与交互</strong>
            <button type="button" onClick={onClose}>
              关闭
            </button>
          </header>}
          {!embedded && <nav>
            {[
              ['variables', '变量与主题'],
              ['styles', '共享样式'],
              ['libraries', '组件库'],
              ['prototype', '交互原型'],
            ].map(([id, label]) => (
              <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id as DesignToolsTab)}>
                {label}
              </button>
            ))}
          </nav>}
          {error && <p role="alert">{error}</p>}
          {tab === 'variables' && (
            <>
              <div className="feature-row">
                <input
                  aria-label="集合名称"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="集合名称"
                />
                <button
                  type="button"
                  onClick={() =>
                    change('新建变量集合', (s) => {
                      const id = uid()
                      s.collections[id] = {
                        name: name || '主题',
                        modes: ['Light', 'Dark'],
                        defaultMode: 'Light',
                      }
                      s.activeModes[id] = 'Light'
                    })
                  }
                >
                  新建集合
                </button>
              </div>
              {Object.entries(system.collections).map(([cid, c]) => (
                <section key={cid}>
                  <h3>{c.name}</h3>
                  <select
                    aria-label={`${c.name} 当前模式`}
                    value={system.activeModes[cid] ?? c.defaultMode}
                    onChange={(e) =>
                      change('切换主题', (s) => {
                        s.activeModes[cid] = e.target.value
                      })
                    }
                  >
                    {c.modes.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                  <input
                    aria-label="新增模式名称"
                    placeholder="新增模式"
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                  />
                  <button
                    type="button"
                    disabled={!mode || c.modes.includes(mode)}
                    onClick={() =>
                      change('新增变量模式', (s) => {
                        s.collections[cid].modes.push(mode)
                        for (const v of Object.values(s.variables))
                          if (v.collection === cid)
                            v.values[mode] = structuredClone(v.values[c.defaultMode])
                      })
                    }
                  >
                    添加模式
                  </button>
                  {(['color', 'number', 'boolean', 'string'] as const).map((kind) => (
                    <button
                      type="button"
                      key={kind}
                      onClick={() =>
                        change('新建变量', (s) => {
                          s.variables[uid()] = {
                            name: `新${kind}变量`,
                            kind,
                            collection: cid,
                            values: Object.fromEntries(
                              c.modes.map((m) => [
                                m,
                                kind === 'color'
                                  ? '#7755dd'
                                  : kind === 'number'
                                    ? 16
                                    : kind === 'boolean'
                                      ? true
                                      : '文字',
                              ]),
                            ),
                          }
                        })
                      }
                    >
                      + {kind}
                    </button>
                  ))}
                  {Object.entries(system.variables)
                    .filter(([, v]) => v.collection === cid)
                    .map(([id, v]) => (
                      <div key={id} className="variable-row">
                        <input
                          aria-label="变量名称"
                          value={v.name}
                          onChange={(e) =>
                            change('命名变量', (s) => {
                              s.variables[id].name = e.target.value
                            })
                          }
                        />
                        <small>{v.kind}</small>
                        {c.modes.map((m) => {
                          const val = v.values[m]
                          return (
                            <label key={m}>
                              {m}
                              <select
                                aria-label={`${v.name} ${m} 值类型`}
                                value={typeof val === 'object' ? 'alias' : 'literal'}
                                onChange={(e) =>
                                  change('设置变量别名', (s) => {
                                    const other = Object.entries(s.variables).find(
                                      ([key, x]) => key !== id && x.kind === v.kind,
                                    )
                                    s.variables[id].values[m] =
                                      e.target.value === 'alias' && other
                                        ? { alias: other[0] }
                                        : variableValue(s, id)
                                  })
                                }
                              >
                                <option value="literal">值</option>
                                <option
                                  value="alias"
                                  disabled={
                                    !Object.entries(system.variables).some(
                                      ([key, x]) => key !== id && x.kind === v.kind,
                                    )
                                  }
                                >
                                  别名
                                </option>
                              </select>
                              {typeof val === 'object' ? (
                                <select
                                  aria-label={`${v.name} ${m} 别名`}
                                  value={val.alias}
                                  onChange={(e) =>
                                    change('修改别名', (s) => {
                                      s.variables[id].values[m] = { alias: e.target.value }
                                    })
                                  }
                                >
                                  {Object.entries(system.variables)
                                    .filter(([key, x]) => key !== id && x.kind === v.kind)
                                    .map(([key, x]) => (
                                      <option key={key} value={key}>
                                        {x.name}
                                      </option>
                                    ))}
                                </select>
                              ) : (
                                <input
                                  aria-label={`${v.name} ${m}`}
                                  value={String(val)}
                                  onChange={(e) =>
                                    change('修改变量值', (s) => {
                                      s.variables[id].values[m] = parse(v.kind, e.target.value)
                                    })
                                  }
                                />
                              )}
                            </label>
                          )
                        })}
                      </div>
                    ))}
                </section>
              ))}
              {n && (
                <section>
                  <h3>{n.name} 的局部模式</h3>
                  {Object.entries(system.collections).map(([cid, c]) => {
                    const modes = selection.map(
                      (id) => effectiveNodeVariableModes(doc.nodes[id])?.[cid],
                    )
                    const value = modes.every((mode) => mode === modes[0])
                      ? modes[0] === undefined
                        ? 'inherit'
                        : `mode:${modes[0]}`
                      : 'mixed'
                    return (
                      <label key={cid}>
                        {c.name}
                        <select
                          aria-label={`${c.name} 图层局部模式`}
                          value={value}
                          onChange={(event) => {
                            const mode = event.target.value
                            editor.change('设置图层局部模式', (d) => {
                              for (const id of selection)
                                setEffectiveNodeVariableMode(
                                  d,
                                  id,
                                  cid,
                                  mode === 'inherit' ? undefined : mode.slice(5),
                                )
                            })
                          }}
                        >
                          <option value="inherit">
                            {selection.some((id) => {
                              const node = doc.nodes[id]
                              return (
                                node.instance &&
                                !node.instanceOrigin &&
                                Object.hasOwn(node.instance.overrides.$root || {}, 'variableModes')
                              )
                            })
                              ? '继承上级模式'
                              : '继承上级或组件默认模式'}
                          </option>
                          {value === 'mixed' && (
                            <option value="mixed" disabled>
                              多种模式
                            </option>
                          )}
                          {c.modes.map((mode) => (
                            <option key={mode} value={`mode:${mode}`}>
                              {mode}
                            </option>
                          ))}
                        </select>
                      </label>
                    )
                  })}
                  <h3>绑定到 {n.name}</h3>
                  <select
                    aria-label="绑定属性"
                    value={property}
                    onChange={(e) => setProperty(e.target.value)}
                  >
                    {[
                      ['fills.0.color', '填充颜色'],
                      ['fills.0.opacity', '填充透明度'],
                      ['width', '宽度'],
                      ['height', '高度'],
                      ['opacity', '图层透明度'],
                      ['visible', '图层可见性'],
                      ['text', '文字内容'],
                      ['fontSize', '字号'],
                      ['layout.gap', '自动布局间距'],
                      ['textStyle.weight', '字重'],
                    ].map(([p, label]) => (
                      <option key={p} value={p}>{label}</option>
                    ))}
                  </select>
                  <select
                    aria-label="绑定变量"
                    value={n.bindings?.[property] || ''}
                    onChange={(e) =>
                      editor.update(
                        selection,
                        (n) => {
                          n.bindings = { ...n.bindings }
                          if (e.target.value) n.bindings[property] = e.target.value
                          else delete n.bindings[property]
                        },
                        '绑定变量',
                      )
                    }
                  >
                    <option value="">未绑定</option>
                    {Object.entries(system.variables)
                      .filter(
                        ([, v]) =>
                          v.kind ===
                          (property.endsWith('color')
                            ? 'color'
                            : property === 'text'
                              ? 'string'
                              : property === 'visible'
                                ? 'boolean'
                                : 'number'),
                      )
                      .map(([id, v]) => (
                        <option key={id} value={id}>
                          {v.name}
                        </option>
                      ))}
                  </select>
                </section>
              )}
            </>
          )}
          {tab === 'styles' && (
            <section>
              <input
                aria-label="样式名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="样式名称"
              />
              {(['paint', 'text', 'effect'] as const).map((kind) => (
                <button
                  type="button"
                  key={kind}
                  disabled={!n}
                  onClick={() =>
                    change('保存共享样式', (s) => {
                      s.styles[uid()] = {
                        name: name || `${n.name} ${kind}`,
                        kind,
                        // Paint styles archive the node's strokes/effects
                        // too (full Sketch layer style, schema 12).
                        ...(kind === 'paint' && (n.strokes.length || n.effects.length)
                          ? {
                              strokes: structuredClone(n.strokes),
                              effects: structuredClone(n.effects),
                            }
                          : {}),
                        value: structuredClone(
                          kind === 'paint'
                            ? n.fills
                            : kind === 'effect'
                              ? n.effects
                              : n.textStyle || defaultTextStyle(),
                        ),
                      }
                    })
                  }
                >
                  保存 {kind} 样式
                </button>
              ))}
              {Object.entries(system.styles).map(([id, s]) => (
                <div className="feature-row" key={id}>
                  <strong>{s.name}</strong>
                  <small>{s.kind}</small>
                  <button
                    type="button"
                    disabled={!n}
                    onClick={() =>
                      editor.update(
                        selection,
                        (n) => {
                          n.styleRefs = {
                            ...n.styleRefs,
                            [s.kind === 'paint'
                              ? 'fills'
                              : s.kind === 'effect'
                                ? 'effects'
                                : 'textStyle']: id,
                          }
                        },
                        '应用共享样式',
                      )
                    }
                  >
                    应用
                  </button>
                  <button
                    type="button"
                    disabled={!n}
                    onClick={() =>
                      change('更新共享样式', (sys) => {
                        sys.styles[id].value = structuredClone(
                          s.kind === 'paint'
                            ? n.fills
                            : s.kind === 'effect'
                              ? n.effects
                              : n.textStyle || defaultTextStyle(),
                        )
                        if (s.kind === 'paint') {
                          sys.styles[id].strokes = structuredClone(n.strokes)
                          sys.styles[id].effects = structuredClone(n.effects)
                        }
                      })
                    }
                  >
                    用选中图层更新
                  </button>
                </div>
              ))}
            </section>
          )}
          {tab === 'libraries' && (
            <section>
              <p>
                发布当前文档的组件为带版本与摘要的组件库；在其他文件导入，同一组件库的更新保留实例覆盖。
              </p>
              <input
                aria-label="组件库版本"
                type="number"
                min={1}
                value={version}
                onChange={(e) => setVersion(Number(e.target.value))}
              />
              <button
                type="button"
                onClick={async () => {
                  try {
                    const p = await publishLibrary(doc, version)
                    download(
                      `${p.name}-v${version}.fdlib`,
                      new Blob([JSON.stringify(p)], { type: 'application/json' }),
                    )
                    setError('')
                  } catch (e) {
                    setError(String(e))
                  }
                }}
              >
                发布组件库文件
              </button>
              <button type="button" onClick={() => { imports.invalidate(); file.current?.click() }}>
                导入 / 更新组件库
              </button>
              <input
                ref={file}
                hidden
                type="file"
                accept=".fdlib"
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  const request = imports.begin(editor)
                  if (!f) return
                  try {
                    if (f.size > 32 * 1024 * 1024) throw new Error('组件库超过 32 MB')
                    const source = await importStep(request, () => f.text())
                    const p = await importStep(request, () => verifyLibrary(JSON.parse(source)))
                    request.assertCurrent()
                    editor.change('安装组件库', (d) => installLibrary(d, p))
                    setError('')
                  } catch (e) {
                    if (request.isCurrent()) setError(String(e))
                  }
                }}
              />
              {Object.values(system.libraries).map((l) => (
                <p key={l.digest}>
                  {l.name} · v{l.version} · {l.componentIds.length} 个根组件
                </p>
              ))}
            </section>
          )}
          {tab === 'prototype' && (
            <section>
              <button
                type="button"
                disabled={!n}
                onClick={() =>
                  editor.change('设置原型起点', (d) => {
                    d.prototype ??= { interactions: {} }
                    d.prototype.startNode = n.id
                  })
                }
              >
                将选中图层设为起点
              </button>
              <button
                type="button"
                disabled={!doc.pages.some((p) => p.children.length)}
                onClick={() => setPreview(true)}
              >
                播放原型
              </button>
              {n && (
                <>
                  <h3>{n.name} 的交互</h3>
                  <button
                    type="button"
                    onClick={() =>
                      editor.change('添加交互', (d) => {
                        d.prototype ??= { interactions: {} }
                        ;(d.prototype.interactions[n.id] ??= []).push({
                          trigger: 'click',
                          actions: [
                            {
                              kind: 'navigate',
                              target:
                                doc.pages.flatMap((p) => p.children).find((id) => id !== n.id) ||
                                n.id,
                            },
                          ],
                        })
                      })
                    }
                  >
                    添加交互
                  </button>
                  {(doc.prototype?.interactions[n.id] || []).map((e, i) => (
                    <div className="interaction-card" key={i}>
                      <select
                        aria-label="交互触发"
                        value={e.trigger}
                        onChange={(ev) =>
                          interaction(i, (e) => {
                            e.trigger = ev.target.value as Interaction['trigger']
                          })
                        }
                      >
                        {[['click', '点击'], ['hover', '鼠标移入'], ['leave', '鼠标移出'], ['after-delay', '延迟后']].map(([t, label]) => (
                          <option key={t} value={t}>{label}</option>
                        ))}
                      </select>
                      {e.trigger === 'after-delay' && (
                        <input
                          aria-label="延迟毫秒"
                          type="number"
                          min={0}
                          value={e.delayMs || 0}
                          onChange={(ev) =>
                            interaction(i, (e) => {
                              e.delayMs = Number(ev.target.value)
                            })
                          }
                        />
                      )}
                      <label>
                        条件
                        <select
                          aria-label="条件变量"
                          value={e.condition?.variable || ''}
                          onChange={(ev) =>
                            interaction(i, (e) => {
                              e.condition = ev.target.value
                                ? {
                                    variable: ev.target.value,
                                    equals: variableValue(system, ev.target.value),
                                  }
                                : undefined
                            })
                          }
                        >
                          <option value="">始终执行</option>
                          {Object.entries(system.variables).map(([id, v]) => (
                            <option key={id} value={id}>
                              {v.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {e.condition && (
                        <input
                          aria-label="条件等于"
                          value={String(e.condition.equals)}
                          onChange={(ev) =>
                            interaction(i, (e) => {
                              e.condition!.equals = parse(
                                system.variables[e.condition!.variable].kind,
                                ev.target.value,
                              )
                            })
                          }
                        />
                      )}
                      {e.actions.map((a, j) => (
                        <div className="feature-row" key={j}>
                          <select
                            aria-label="交互动作"
                            value={a.kind}
                            onChange={(ev) =>
                              interaction(i, (e) => {
                                e.actions[j] = {
                                  kind: ev.target.value as PrototypeAction['kind'],
                                  target:
                                    ev.target.value === 'set-variable'
                                      ? Object.keys(system.variables)[0]
                                      : n.id,
                                  value:
                                    ev.target.value === 'set-variable' &&
                                    Object.keys(system.variables).length
                                      ? variableValue(system, Object.keys(system.variables)[0])
                                      : undefined,
                                }
                              })
                            }
                          >
                            {[
                              ['navigate', '跳转到'],
                              ['overlay', '打开浮层'],
                              ['back', '返回'],
                              ['close-overlay', '关闭浮层'],
                              ['scroll-to', '滚动到'],
                              ['set-variable', '设置变量'],
                            ].map(([k, label]) => (
                              <option key={k} value={k}>{label}</option>
                            ))}
                          </select>
                          {!['back', 'close-overlay'].includes(a.kind) && (
                            <select
                              aria-label="动作目标"
                              value={a.target || ''}
                              onChange={(ev) =>
                                interaction(i, (e) => {
                                  e.actions[j].target = ev.target.value
                                  if (a.kind === 'set-variable')
                                    e.actions[j].value = variableValue(system, ev.target.value)
                                })
                              }
                            >
                              {a.kind === 'set-variable'
                                ? Object.entries(system.variables).map(([id, v]) => (
                                    <option key={id} value={id}>
                                      {v.name}
                                    </option>
                                  ))
                                : Object.values(doc.nodes)
                                    .filter(
                                      (x) =>
                                        x.kind === 'frame' ||
                                        x.id === n.id ||
                                        a.kind === 'scroll-to',
                                    )
                                    .map((x) => (
                                      <option key={x.id} value={x.id}>
                                        {x.name}
                                      </option>
                                    ))}
                            </select>
                          )}
                          {a.kind === 'set-variable' && a.target && system.variables[a.target] && (
                            <input
                              aria-label="变量新值"
                              value={String(a.value ?? '')}
                              onChange={(ev) =>
                                interaction(i, (e) => {
                                  e.actions[j].value = parse(
                                    system.variables[a.target!].kind,
                                    ev.target.value,
                                  )
                                })
                              }
                            />
                          )}
                          <input
                            aria-label="过渡毫秒"
                            type="number"
                            min={0}
                            max={10000}
                            value={a.durationMs || 0}
                            onChange={(ev) =>
                              interaction(i, (e) => {
                                e.actions[j].durationMs = Number(ev.target.value)
                              })
                            }
                          />
                          <select
                            aria-label="过渡曲线"
                            value={a.easingCurve || ''}
                            onChange={(ev) =>
                              interaction(i, (e) => {
                                e.actions[j].easingCurve =
                                  (ev.target.value || undefined) as PrototypeAction['easingCurve']
                              })
                            }
                          >
                            <option value="">线性</option>
                            <option value="ease-in">缓入</option>
                            <option value="ease-out">缓出</option>
                            <option value="ease-in-out">缓入缓出</option>
                            <option value="spring">弹簧</option>
                          </select>
                          {a.kind === 'overlay' && (
                            <div className="overlay-position-editor">
                              <select
                                aria-label="浮层位置"
                                value={a.overlayPosition?.origin || 'center'}
                                onChange={(ev) =>
                                  interaction(i, (e) => {
                                    const origin = ev.target.value as NonNullable<
                                      NonNullable<PrototypeAction['overlayPosition']>['origin']
                                    >
                                    e.actions[j].overlayPosition = {
                                      origin,
                                      x: origin === 'manual' ? (a.overlayPosition?.x ?? 0) : undefined,
                                      y: origin === 'manual' ? (a.overlayPosition?.y ?? 0) : undefined,
                                      padding: a.overlayPosition?.padding ?? 24,
                                      background: a.overlayPosition?.background ?? true,
                                    }
                                  })
                                }
                              >
                                {[
                                  ['center', '居中'],
                                  ['top-left', '左上'],
                                  ['top-center', '上中'],
                                  ['top-right', '右上'],
                                  ['middle-left', '左中'],
                                  ['middle-right', '右中'],
                                  ['bottom-left', '左下'],
                                  ['bottom-center', '下中'],
                                  ['bottom-right', '右下'],
                                  ['manual', '手动'],
                                ].map(([value, label]) => (
                                  <option key={value} value={value}>
                                    {label}
                                  </option>
                                ))}
                              </select>
                              {a.overlayPosition?.origin === 'manual' && (
                                <>
                                  <input
                                    aria-label="浮层 X 偏移"
                                    type="number"
                                    value={a.overlayPosition.x ?? 0}
                                    onChange={(ev) =>
                                      interaction(i, (e) => {
                                        e.actions[j].overlayPosition!.x = Number(ev.target.value)
                                      })
                                    }
                                  />
                                  <input
                                    aria-label="浮层 Y 偏移"
                                    type="number"
                                    value={a.overlayPosition.y ?? 0}
                                    onChange={(ev) =>
                                      interaction(i, (e) => {
                                        e.actions[j].overlayPosition!.y = Number(ev.target.value)
                                      })
                                    }
                                  />
                                </>
                              )}
                              <label className="check-row">
                                <input
                                  type="checkbox"
                                  aria-label="浮层背景遮罩"
                                  checked={a.overlayPosition?.background ?? true}
                                  onChange={(ev) =>
                                    interaction(i, (e) => {
                                      e.actions[j].overlayPosition ??= {
                                        origin: 'center',
                                        padding: 24,
                                        background: true,
                                      }
                                      e.actions[j].overlayPosition!.background = ev.target.checked
                                    })
                                  }
                                />
                                背景遮罩
                              </label>
                            </div>
                          )}
                          {/* Playback executes the supported transition fields;
                           * media/component reset still report unavailable. */}
                          <details className="action-advanced">
                            <summary>高级</summary>
                            <div className="feature-row">
                              <select
                                aria-label="媒体命令"
                                value={a.mediaAction || ''}
                                onChange={(ev) =>
                                  action(i, j, (x) =>
                                    setExtra(x, 'mediaAction', ev.target.value || undefined),
                                  )
                                }
                              >
                                <option value="">无媒体命令</option>
                                {[
                                  ['play', '播放'],
                                  ['pause', '暂停'],
                                  ['toggle', '播放/暂停'],
                                  ['stop', '停止'],
                                  ['previous', '上一个'],
                                  ['next', '下一个'],
                                  ['forward', '快进'],
                                  ['rewind', '快退'],
                                ].map(([value, label]) => (
                                  <option key={value} value={value}>
                                    {label}
                                  </option>
                                ))}
                              </select>
                              {(
                                [
                                  ['mediaSkipByAmount', '快进退秒数'],
                                  ['mediaSkipToTime', '跳转到秒'],
                                ] as const
                              ).map(([key, label]) => (
                                <input
                                  key={key}
                                  aria-label={label}
                                  type="number"
                                  min={0}
                                  max={1000000}
                                  step={0.1}
                                  placeholder={label}
                                  value={a[key] ?? ''}
                                  onChange={(ev) =>
                                    action(i, j, (x) => {
                                      const v =
                                        ev.target.value === '' ? undefined : Number(ev.target.value)
                                      if (
                                        v === undefined ||
                                        (Number.isFinite(v) && v >= 0 && v <= 1e6)
                                      )
                                        setExtra(x, key, v)
                                    })
                                  }
                                />
                              ))}
                            </div>
                            <div className="feature-row">
                              {(
                                [
                                  ['transitionShouldSmartAnimate', '智能动画'],
                                  ['transitionOverridesEnabled', '启用过渡覆盖'],
                                  ['transitionPreserveScroll', '保留滚动位置'],
                                  ['transitionResetScrollPosition', '重置滚动位置'],
                                  ['transitionResetInteractiveComponents', '重置交互组件'],
                                ] as const
                              ).map(([key, label]) => (
                                <label className="check-row" key={key}>
                                  <input
                                    type="checkbox"
                                    aria-label={label}
                                    checked={a[key] ?? (key === 'transitionShouldSmartAnimate')}
                                    onChange={(ev) =>
                                      action(i, j, (x) =>
                                        setExtra(x, key, key === 'transitionShouldSmartAnimate' ? ev.target.checked : ev.target.checked ? true : undefined),
                                      )
                                    }
                                  />
                                  {label}
                                </label>
                              ))}
                            </div>
                            <div className="feature-row">
                              <select
                                aria-label="过渡时长变量"
                                value={a.transitionDurationVar || ''}
                                onChange={(ev) =>
                                  action(i, j, (x) =>
                                    setExtra(x, 'transitionDurationVar', ev.target.value || undefined),
                                  )
                                }
                              >
                                <option value="">无时长变量</option>
                                {Object.entries(system.variables)
                                  .filter(([, v]) => v.kind === 'number')
                                  .map(([id, v]) => (
                                    <option key={id} value={id}>
                                      {v.name}
                                    </option>
                                  ))}
                              </select>
                              <select
                                aria-label="过渡曲线变量"
                                value={a.transitionEasingVar || ''}
                                onChange={(ev) =>
                                  action(i, j, (x) =>
                                    setExtra(x, 'transitionEasingVar', ev.target.value || undefined),
                                  )
                                }
                              >
                                <option value="">无曲线变量</option>
                                {Object.entries(system.variables).map(([id, v]) => (
                                  <option key={id} value={id}>
                                    {v.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="feature-row">
                              <select
                                aria-label="目标变量"
                                value={a.targetVariable || ''}
                                onChange={(ev) =>
                                  action(i, j, (x) => {
                                    setExtra(x, 'targetVariable', ev.target.value || undefined)
                                    const v = ev.target.value
                                      ? system.variables[ev.target.value]
                                      : undefined
                                    const modes = v
                                      ? system.collections[v.collection]?.modes
                                      : undefined
                                    if (x.targetVariableModeId && !modes?.includes(x.targetVariableModeId))
                                      delete x.targetVariableModeId
                                  })
                                }
                              >
                                <option value="">无目标变量</option>
                                {Object.entries(system.variables).map(([id, v]) => (
                                  <option key={id} value={id}>
                                    {v.name}
                                  </option>
                                ))}
                              </select>
                              {a.targetVariable && system.variables[a.targetVariable] && (
                                <select
                                  aria-label="目标变量模式"
                                  value={a.targetVariableModeId || ''}
                                  onChange={(ev) =>
                                    action(i, j, (x) =>
                                      setExtra(x, 'targetVariableModeId', ev.target.value || undefined),
                                    )
                                  }
                                >
                                  <option value="">默认模式</option>
                                  {(
                                    system.collections[
                                      system.variables[a.targetVariable].collection
                                    ]?.modes || []
                                  ).map((m) => (
                                    <option key={m} value={m}>
                                      {m}
                                    </option>
                                  ))}
                                </select>
                              )}
                              {(
                                [
                                  ['targetVariableSetId', '变量集 ID'],
                                  ['targetVariableSetKey', '变量集键'],
                                ] as const
                              ).map(([key, label]) => (
                                <input
                                  key={key}
                                  aria-label={label}
                                  placeholder={label}
                                  value={a[key] ?? ''}
                                  onChange={(ev) =>
                                    action(i, j, (x) => setExtra(x, key, ev.target.value || undefined))
                                  }
                                />
                              ))}
                            </div>
                            <div className="feature-row">
                              {(
                                [
                                  ['id', '变量数据 id'],
                                  ['modeId', '变量数据 modeId'],
                                ] as const
                              ).map(([field, label]) => (
                                <input
                                  key={field}
                                  aria-label={label}
                                  placeholder={label}
                                  value={String(a.targetVariableData?.[field] ?? '')}
                                  onChange={(ev) =>
                                    action(i, j, (x) => {
                                      const next: Record<string, unknown> = {
                                        ...(x.targetVariableData || {}),
                                      }
                                      if (ev.target.value) next[field] = ev.target.value
                                      else delete next[field]
                                      x.targetVariableData = Object.keys(next).length
                                        ? (next as PrototypeAction['targetVariableData'])
                                        : undefined
                                    })
                                  }
                                />
                              ))}
                            </div>
                          </details>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          interaction(i, (e) => {
                            e.actions.push({ kind: 'back' })
                          })
                        }
                      >
                        添加动作
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          editor.change('删除交互', (d) => {
                            d.prototype!.interactions[n.id].splice(i, 1)
                          })
                        }
                      >
                        删除交互
                      </button>
                    </div>
                  ))}
                </>
              )}
            </section>
          )}
        </div>
      </div>
      {preview && <PrototypePlayer document={doc} onClose={() => setPreview(false)} />}
    </>
  )
}
