// Host-owned semantic policy only. This is not a renderer or a claim of v2 support.
// No document text, coordinates, network, timers or canvas dependencies.
const cues = Object.freeze({
  edit: { action: 'work', text: '慢慢来，每一笔都在让想法更清楚。' },
  move: { action: 'nod', text: '换个位置看看，找到你喜欢的节奏。' },
  zoom: { action: 'think', text: '看细节，也记得看看整体。' },
  idle: { action: null, text: '我在这里。想休息一会儿也没关系。' },
  click: { action: 'hello', text: '在呢，陪你一起做。' },
  pet: { action: 'nod', text: '收到你的摸摸啦，谢谢你。' },
  save: { action: 'nod', text: '这一步保存好了。' },
  error: { action: 'puzzled', text: '遇到问题也没关系，先看看提示再继续。' },
})
export function createCompanionPolicy({ now = () => performance.now() } = {}) {
  let mode = 'off', visible = true, disposed = false, last = -Infinity, lastActivity = now(), sequence = 0
  return {
    configure(value) {
      if (!['off', 'quiet', 'active'].includes(value)) throw new TypeError('Invalid mode')
      if (disposed) return
      mode = value; lastActivity = now()
    },
    visibility(value) { visible = value === true; lastActivity = now() },
    cue(event) {
      if (typeof event !== 'string' || !Object.hasOwn(cues, event)) return null
      const time = now(), idleFor = time - lastActivity
      if (event !== 'idle') lastActivity = time
      if (disposed || !visible || mode !== 'active' || time - last < 12000 || (event === 'idle' && idleFor < 90000)) return null
      last = time
      return Object.freeze({ ...cues[event], id: ++sequence, expiresAt: time + 8000 })
    },
    dispose() { disposed = true; mode = 'off' },
  }
}
