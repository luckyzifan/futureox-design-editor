import type { AppDefinition, AppForm, AppValue } from './app-export-schema'

export type AppRuntimeConfig = { version: 1; app: AppDefinition; nodeIdMap: Record<string, { elementId: string; selector: string }>; storageKey: string; storageSchema: string; title: string }

/** This function is emitted as a standalone classic script. Keep every runtime
 * dependency inside it: exported apps do not fetch code, data, or packages. */
export function startExportedApp(config: AppRuntimeConfig) {
  'use strict'
  const { app } = config
  const maxRecords = 500, maxString = 4096, maxStorage = 2 * 1024 * 1024
  const element = (id: string) => document.getElementById(config.nodeIdMap[id].elementId)!
  const status = document.getElementById('app-status')!
  let storageAvailable = true, storageWarning = ''
  let state = JSON.parse(JSON.stringify(app.state)) as Record<string, AppValue>
  let collections = Object.fromEntries(app.collections.map(c => [c.id, JSON.parse(JSON.stringify(c.records ?? []))])) as Record<string, ({ id: string } & Record<string, AppValue>)[]>
  const editing = new Map<string, string>()
  const announce = (message: string) => { status.textContent = [message, storageWarning].filter(Boolean).join(' ') }
  const plain = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => !['__proto__', 'constructor', 'prototype'].includes(k))
  const scalar = (value: unknown) => value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= maxString || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12
  function validStored(value: unknown): value is { version: number; schema: string; state: typeof state; collections: typeof collections } {
    if (!plain(value) || value.version !== 1 || value.schema !== config.storageSchema || !plain(value.state) || !plain(value.collections)) return false
    if (Object.keys(value).some(k => !['version', 'schema', 'state', 'collections'].includes(k)) || Object.keys(value.state).length !== Object.keys(app.state).length || Object.keys(value.collections).length !== app.collections.length) return false
    for (const [key, initial] of Object.entries(app.state)) if (!Object.hasOwn(value.state, key) || !scalar(value.state[key]) || typeof value.state[key] !== typeof initial) return false
    for (const c of app.collections) {
      if (!Object.hasOwn(value.collections, c.id)) return false
      const records = value.collections[c.id]
      if (!Array.isArray(records) || records.length > maxRecords) return false
      const ids = new Set<string>()
      for (const row of records) {
        if (!plain(row) || typeof row.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(row.id) || ids.has(row.id) || Object.keys(row).length !== c.fields.length + 1) return false
        ids.add(row.id)
        for (const field of c.fields) if (!Object.hasOwn(row, field.name) || !scalar(row[field.name]) || row[field.name] !== null && typeof row[field.name] !== field.type) return false
      }
    }
    return true
  }
  try {
    const encoded = window.localStorage.getItem(config.storageKey)
    if (encoded !== null) {
      if (new Blob([encoded]).size > maxStorage) throw new Error('Stored data exceeds the limit')
      const saved = JSON.parse(encoded)
      if (!validStored(saved)) throw new Error('Stored data does not match this app schema')
      state = saved.state; collections = saved.collections
    }
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof Error && /Stored data/.test(error.message)) storageWarning = 'Saved data could not be loaded. Initial data is shown; the next successful change will replace the invalid saved data.'
    else { storageAvailable = false; storageWarning = 'Browser storage is unavailable. Changes last for this tab only.' }
  }
  function persist() {
    if (!storageAvailable) return
    try {
      const encoded = JSON.stringify({ version: 1, schema: config.storageSchema, state, collections })
      if (new Blob([encoded]).size > maxStorage) throw new Error('Storage budget exceeded')
      window.localStorage.setItem(config.storageKey, encoded)
      storageWarning = ''
    } catch { storageWarning = 'Changes are active in this tab but could not be saved. Browser storage may be disabled or full.' }
  }
  function renderRoute(focus = false) {
    const requested = window.location.hash.slice(1)
    const route = app.routes.find(r => r.path === requested) ?? app.routes.find(r => r.path === app.initialRoute)!
    for (const r of app.routes) {
      const container = element(r.nodeId).parentElement!
      container.hidden = r !== route
      container.setAttribute('aria-hidden', String(r !== route))
    }
    document.title = `${route.title} · ${config.title}`
    document.documentElement.dataset.appRoute = route.path
    if (focus) element(route.nodeId).parentElement!.focus()
    if (requested && requested !== route.path) announce('Unknown route. The start page is shown.')
  }
  function navigate(path: string) {
    if (window.location.hash.slice(1) !== path) window.location.hash = path
    renderRoute(true)
  }
  function clearErrors(form: AppForm) {
    const message = document.getElementById(`${config.nodeIdMap[form.nodeId].elementId}-errors`)!
    message.textContent = ''
    for (const field of form.fields) element(field.nodeId).removeAttribute('aria-invalid')
  }
  function resetForm(form: AppForm) {
    ;(element(form.nodeId) as HTMLFormElement).reset()
    editing.delete(form.id); clearErrors(form)
    element(form.submitNodeId).setAttribute('aria-label', form.submitLabel)
  }
  function renderBindings() {
    for (const binding of app.textBindings) element(binding.nodeId).textContent = (binding.prefix ?? '') + String(binding.state !== undefined ? state[binding.state] : collections[binding.collectionCount!].length)
  }
  function renderLists() {
    for (const spec of app.lists) {
      const host = element(spec.nodeId), rows = collections[spec.collection]
      host.replaceChildren()
      if (!rows.length) { const p = document.createElement('p'); p.textContent = spec.emptyText ?? 'No records yet.'; host.append(p); continue }
      const list = document.createElement('ul'); list.className = 'app-records'
      rows.forEach((row, index) => {
        const item = document.createElement('li'); item.dataset.recordId = row.id
        const values = document.createElement('dl')
        for (const column of spec.columns) {
          const dt = document.createElement('dt'), dd = document.createElement('dd')
          dt.textContent = column.label; dd.textContent = String(row[column.field] ?? '')
          values.append(dt, dd)
        }
        item.append(values)
        const rowName = spec.columns.map(column => String(row[column.field] ?? '')).filter(Boolean).join(', ').slice(0, 160) || `record ${index + 1}`
        if (spec.editForm) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Edit'; button.setAttribute('aria-label', `Edit ${rowName}`); button.dataset.appCommand = 'edit'; button.dataset.sourceNodeId = spec.nodeId
          button.addEventListener('click', () => {
            const form = app.forms.find(f => f.id === spec.editForm)!
            resetForm(form); editing.set(form.id, row.id)
            for (const field of form.fields) {
              const input = element(field.nodeId) as HTMLInputElement
              if (field.type === 'checkbox') input.checked = row[field.name] === true
              else input.value = String(row[field.name] ?? '')
            }
            navigate(spec.editRoute!); element(form.fields[0].nodeId).focus(); announce(`Editing ${rowName}.`)
          })
          item.append(button)
        }
        if (spec.allowDelete) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Delete'; button.setAttribute('aria-label', `Delete ${rowName}`); button.dataset.appCommand = 'delete'; button.dataset.sourceNodeId = spec.nodeId
          button.addEventListener('click', () => {
            collections[spec.collection] = collections[spec.collection].filter(r => r.id !== row.id)
            for (const form of app.forms) if (form.collection === spec.collection && editing.get(form.id) === row.id) resetForm(form)
            persist(); renderLists(); renderBindings(); announce(`Deleted ${rowName}.`); host.focus()
          })
          item.append(button)
        }
        list.append(item)
      })
      host.append(list)
    }
  }
  for (const form of app.forms) {
    const host = element(form.nodeId) as HTMLFormElement
    host.addEventListener('submit', event => {
      event.preventDefault(); clearErrors(form)
      const values: Record<string, AppValue> = {}, errors: string[] = []
      let firstInvalid: HTMLInputElement | undefined
      for (const field of form.fields) {
        const input = element(field.nodeId) as HTMLInputElement
        const raw = input.value.trim(), value = field.type === 'checkbox' ? input.checked : field.type === 'number' ? raw === '' ? null : Number(raw) : raw
        let invalid = field.required && (value === '' || value === null || field.type === 'checkbox' && !value)
        if (typeof value === 'string') invalid ||= value.length > (field.maxLength ?? maxString) || value.length > 0 && value.length < (field.minLength ?? 0) || field.type === 'email' && value.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
        if (field.type === 'number' && value !== null) invalid ||= typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12 || field.min !== undefined && value < field.min || field.max !== undefined && value > field.max
        if (invalid) { input.setAttribute('aria-invalid', 'true'); firstInvalid ??= input; errors.push(`${field.label}: enter a valid value${field.required ? ' (required)' : ''}.`) }
        values[field.name] = value
      }
      const message = document.getElementById(`${config.nodeIdMap[form.nodeId].elementId}-errors`)!
      if (errors.length) { message.textContent = errors.join(' '); firstInvalid!.focus(); announce('Please correct the highlighted fields.'); return }
      const records = collections[form.collection], currentId = editing.get(form.id)
      if (!currentId && records.length >= maxRecords) { message.textContent = 'This collection has reached its 500-record limit.'; announce(message.textContent); return }
      if (currentId && !records.some(row => row.id === currentId)) { message.textContent = 'This record no longer exists. Reset the form before creating a new record.'; announce(message.textContent); return }
      let id = currentId
      if (!id) { let next = 1; do { id = `record_${next++}` } while (records.some(row => row.id === id)) }
      const row = { id, ...values }
      const updated = currentId ? records.map(old => old.id === currentId ? row : old) : [...records, row]
      const nextCollections = { ...collections, [form.collection]: updated }
      if (new Blob([JSON.stringify({ version: 1, schema: config.storageSchema, state, collections: nextCollections })]).size > maxStorage) {
        message.textContent = 'This app has reached its 2 MiB local-data limit. Shorten a value or delete a record before saving.'
        announce(message.textContent); return
      }
      collections = nextCollections
      persist(); resetForm(form); renderLists(); renderBindings(); announce(currentId ? 'Record updated.' : 'Record created.')
      if (form.successRoute) navigate(form.successRoute)
    })
  }
  for (const action of app.actions) element(action.nodeId).addEventListener('click', event => {
    event.preventDefault()
    let changed = false
    for (const step of action.steps) {
      if (step.kind === 'navigate') navigate(step.to)
      else if (step.kind === 'form.reset') resetForm(app.forms.find(f => f.id === step.form)!)
      else if (step.kind === 'state.set') { state[step.key] = step.value; changed = true }
      else if (step.kind === 'state.toggle') { state[step.key] = !state[step.key]; changed = true }
    }
    if (changed) persist()
    renderBindings(); announce('')
  })
  window.addEventListener('hashchange', () => renderRoute(true))
  renderLists(); renderBindings(); renderRoute(); announce('')
  document.documentElement.dataset.appReady = 'true'
}
