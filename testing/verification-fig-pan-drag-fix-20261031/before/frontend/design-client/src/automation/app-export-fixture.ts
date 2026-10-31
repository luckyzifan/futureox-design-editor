import { blank, node, paint, uid, type DesignNode } from '../model'
import type { AppDefinition } from './app-export-schema'

/** Original authored three-page task manager, used by the exported-app evidence.
 * These are real document nodes consumed by Editor/WASM, not a mock renderer. */
export function runnableAppFixture() {
  const document = blank('Offline project notebook')
  document.pages[0].name = 'Overview'
  const pages = [document.pages[0], { ...structuredClone(document.pages[0]), id: uid(), name: 'Tasks', children: [] as string[] }, { ...structuredClone(document.pages[0]), id: uid(), name: 'Edit task', children: [] as string[] }]
  document.pages = pages
  const ids: Record<string, string> = {}
  const add = (name: string, kind: DesignNode['kind'], x: number, y: number, width: number, height: number, parent?: DesignNode, text?: string) => {
    const n = node(kind, x, y, width, height); n.name = name; n.text = text ?? ''; n.fontSize = 20
    n.fills = [paint(kind === 'text' ? '#182135' : '#f7f8fc')]
    if (kind === 'frame') n.clip = false
    ids[name] = n.id; document.nodes[n.id] = n; parent?.children.push(n.id); return n
  }
  const root = (name: string, index: number) => { const n = add(name, 'frame', 0, 0, 760, 620); n.fills = [paint('#ffffff')]; pages[index].children.push(n.id); return n }
  const button = (name: string, label: string, x: number, y: number, parent: DesignNode) => { const n = add(name, 'text', x, y, 180, 42, parent, label); n.fills = [paint('#153ea9')]; return n }
  const home = root('home', 0)
  add('heading', 'text', 32, 32, 620, 50, home, 'Project notebook')
  add('intro', 'text', 32, 104, 620, 70, home, 'Keep tasks on this device. No account or network needed.')
  add('count', 'text', 32, 208, 280, 38, home, 'Tasks: 0')
  add('compactValue', 'text', 32, 256, 400, 38, home, 'Compact view: false')
  button('openTasks', 'View tasks', 32, 336, home); button('toggleCompact', 'Toggle compact', 244, 336, home)
  const tasks = root('tasks', 1)
  add('tasksHeading', 'text', 32, 24, 540, 48, tasks, 'Tasks on this device')
  button('addTask', 'Add task', 32, 88, tasks); button('goHome', 'Overview', 244, 88, tasks)
  add('taskList', 'frame', 32, 156, 696, 424, tasks)
  const edit = root('edit', 2)
  add('editHeading', 'text', 32, 24, 620, 48, edit, 'Create or edit a task')
  const form = add('taskForm', 'frame', 32, 92, 660, 370, edit)
  add('titleLabel', 'text', 16, 12, 200, 28, form, 'Task title')
  add('titleInput', 'rectangle', 16, 46, 620, 44, form)
  add('emailLabel', 'text', 16, 104, 250, 28, form, 'Owner email (local only)')
  add('emailInput', 'rectangle', 16, 138, 620, 44, form)
  add('estimateLabel', 'text', 16, 196, 250, 28, form, 'Estimate in hours')
  add('estimateInput', 'rectangle', 16, 230, 240, 44, form)
  button('saveTask', 'Save task', 16, 300, form)
  button('cancelEdit', 'Cancel', 32, 530, edit)
  const app: AppDefinition = {
    id: 'project-notebook',
    routes: [
      { path: '/overview', nodeId: home.id, title: 'Overview', pageId: pages[0].id },
      { path: '/tasks', nodeId: tasks.id, title: 'Tasks', pageId: pages[1].id },
      { path: '/edit', nodeId: edit.id, title: 'Edit task', pageId: pages[2].id },
    ], initialRoute: '/overview', state: { compact: false },
    collections: [{ id: 'tasks', fields: [{ name: 'title', type: 'string' }, { name: 'email', type: 'string' }, { name: 'estimate', type: 'number' }], records: [] }],
    forms: [{ id: 'taskForm', nodeId: form.id, collection: 'tasks', submitNodeId: ids.saveTask, submitLabel: 'Save task', successRoute: '/tasks', fields: [
      { nodeId: ids.titleInput, name: 'title', label: 'Task title', type: 'text', required: true, minLength: 3, maxLength: 80 },
      { nodeId: ids.emailInput, name: 'email', label: 'Owner email', type: 'email', required: true },
      { nodeId: ids.estimateInput, name: 'estimate', label: 'Estimate in hours', type: 'number', required: true, min: 1, max: 1000 },
    ] }],
    actions: [
      { nodeId: ids.openTasks, label: 'View tasks', steps: [{ kind: 'navigate', to: '/tasks' }] },
      { nodeId: ids.goHome, label: 'Overview', steps: [{ kind: 'navigate', to: '/overview' }] },
      { nodeId: ids.toggleCompact, label: 'Toggle compact', steps: [{ kind: 'state.toggle', key: 'compact' }] },
      { nodeId: ids.addTask, label: 'Add task', steps: [{ kind: 'form.reset', form: 'taskForm' }, { kind: 'navigate', to: '/edit' }] },
      { nodeId: ids.cancelEdit, label: 'Cancel', steps: [{ kind: 'form.reset', form: 'taskForm' }, { kind: 'navigate', to: '/tasks' }] },
    ],
    lists: [{ nodeId: ids.taskList, collection: 'tasks', label: 'Local tasks', columns: [{ field: 'title', label: 'Title' }, { field: 'email', label: 'Owner' }, { field: 'estimate', label: 'Hours' }], editForm: 'taskForm', editRoute: '/edit', allowDelete: true, emptyText: 'No local tasks yet. Add your first task.' }],
    textBindings: [{ nodeId: ids.count, collectionCount: 'tasks', prefix: 'Tasks: ' }, { nodeId: ids.compactValue, state: 'compact', prefix: 'Compact view: ' }],
  }
  return { document, app, ids }
}
