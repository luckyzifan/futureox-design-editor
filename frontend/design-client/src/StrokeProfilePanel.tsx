import type { DesignNode, WidthPoint } from './model'
import { NumberField } from './fields'
import { profilePreset, profileTopology } from './stroke-profile'
import type { Editor } from './engine'
import { useProfessionalDialogText } from './professional-dialog-messages'

export function StrokeProfilePanel({
  n,
  index,
  editor,
  update,
}: {
  n: DesignNode
  index: number
  editor: Editor
  update: (fn: (n: DesignNode) => void, label?: string) => void
}) {
  const { tr } = useProfessionalDialogText()
  const s = n.strokes[index],
    ps = s.widthProfile || [],
    topology = profileTopology(n)
  const replace = (points?: WidthPoint[]) =>
    update((target) => {
      if (!target.strokes[index]) return
      const { closed, branched } = profileTopology(target)
      if (points?.length && (branched || target.kind === 'text'))
        throw new Error('请先将分叉路径拆分，文字转为矢量轮廓后再设置宽度')
      const copy = structuredClone(points)
      if (closed && copy?.length && copy[0].position === 0 && copy.at(-1)!.position === 1) {
        copy[copy.length - 1] = { ...copy[0], position: 1 }
      }
      target.strokes[index].widthProfile = copy
    }, '调整描边宽度轮廓')
  const change = (i: number, patch: Partial<WidthPoint>) => {
    const next = structuredClone(ps)
    next[i] = { ...next[i], ...patch }
    if (topology.closed && i === ps.length - 1 && ps[0].position === 0 && next[i].position === 1)
      next[0] = { ...next[i], position: 0 }
    replace(next)
  }
  const add = () => {
    const next = structuredClone(ps),
      gaps = [0, ...ps.map((p) => p.position), 1]
    let a = 0,
      b = 0
    for (let i = 1; i < gaps.length; i++)
      if (gaps[i] - gaps[i - 1] > b - a) [a, b] = [gaps[i - 1], gaps[i]]
    if (b - a < 0.000002) return
    const left = ps.find((p) => p.position === a),
      right = ps.find((p) => p.position === b)
    next.push({
      position: (a + b) / 2,
      left: ((left?.left ?? right?.left ?? 1) + (right?.left ?? left?.left ?? 1)) / 2,
      right: ((left?.right ?? right?.right ?? 1) + (right?.right ?? left?.right ?? 1)) / 2,
    })
    replace(next.sort((a, b) => a.position - b.position))
  }
  return (
    <div className="stroke-profile">
      <label>
        {tr('宽度轮廓')}
        <select
          aria-label={tr('宽度轮廓')}
          value={ps.length ? 'custom' : 'uniform'}
          disabled={topology.branched || n.kind === 'text'}
          onChange={(e) => replace(profilePreset(e.target.value, topology.closed))}
        >
          <option value="uniform">{tr('等宽')}</option>
          <option value="spindle">{tr('两端收尖')}</option>
          {!topology.closed && (
            <>
              <option value="taper">{tr('末端收尖')}</option>
              <option value="grow">{tr('起点收尖')}</option>
            </>
          )}
          <option value="wave">{tr('起伏')}</option>
          <option value="one-side">{tr('单侧收尖')}</option>
          <option value="custom">{tr('自定义控制点')}</option>
        </select>
      </label>
      {topology.branched && <small>{tr('分叉路径需先拆分为独立路径')}</small>}
      {!!ps.length && (
        <>
          <small>
            {tr('位置沿路径长度计算；两侧宽度为基础粗细的一半 × 倍率。')}
            {topology.closed ? tr('闭合接缝两端联动。') : ''}
          </small>
          <button onClick={() => editor.set({ tool: 'width', widthStroke: index })}>
            {tr('在画布调整宽度')}
          </button>
          {ps.map((p, i) => (
            <div className="profile-point" key={`${i}-${p.position}`}>
              <div className="field-grid">
                <NumberField
                  label={`位置 ${i + 1} (%)`}
                  value={p.position * 100}
                  min={i ? ps[i - 1].position * 100 + 0.001 : 0}
                  max={i + 1 < ps.length ? ps[i + 1].position * 100 - 0.001 : 100}
                  step={0.1}
                  onChange={(v) => change(i, { position: v / 100 })}
                />
                <NumberField
                  label={`左宽 ${i + 1}`}
                  value={p.left}
                  min={0}
                  max={4}
                  step={0.1}
                  onChange={(v) => change(i, { left: v })}
                />
                <NumberField
                  label={`右宽 ${i + 1}`}
                  value={p.right}
                  min={0}
                  max={4}
                  step={0.1}
                  onChange={(v) => change(i, { right: v })}
                />
                <button
                  aria-label={`删除宽度点 ${i + 1}`}
                  onClick={() => replace(ps.filter((_, at) => at !== i))}
                >
                  {tr('删除点')}
                </button>
              </div>
            </div>
          ))}
          <button disabled={ps.length >= 512} onClick={add}>
            {tr('＋ 添加宽度点')}
          </button>
        </>
      )}
    </div>
  )
}
