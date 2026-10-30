import { TextInput } from './TextEditor'
import type { Editor } from './engine'
import type { DesignNode } from './model'
import { NumberField } from './fields'
import { resizeTable } from './board-tools'
export function BoardPanel({ editor, node }: { editor: Editor; node: DesignNode }) {
  const board = node.board
  if (!board) return null
  const text = node.children.map((id) => editor.state.doc.nodes[id]).find((n) => n.kind === 'text')
  return (
    <section aria-label="白板内容">
      <h3>{node.name}</h3>
      {board.kind === 'table' && (
        <div className="field-grid">
          <NumberField
            label="表格行数"
            value={board.rows || 3}
            min={1}
            max={50}
            onChange={(v) => {
              try {
                resizeTable(editor, node.id, v, board.columns || 3)
              } catch (e) {
                editor.notify(String(e))
              }
            }}
          />
          <NumberField
            label="表格列数"
            value={board.columns || 3}
            min={1}
            max={30}
            onChange={(v) => {
              try {
                resizeTable(editor, node.id, board.rows || 3, v)
              } catch (e) {
                editor.notify(String(e))
              }
            }}
          />
        </div>
      )}
      {board.kind==='code-block'&&<label>代码语言<select aria-label="代码语言" value={board.language||'plain'} onChange={event=>editor.updateProperties([node.id],n=>{n.board!.language=event.target.value},'设置代码语言')}>
        {['plain','javascript','typescript','rust','python','json'].map(l=><option key={l} value={l}>{l}</option>)}
      </select></label>}
      {text && <TextInput key={text.id} node={text} editor={editor} />}
    </section>
  )
}
