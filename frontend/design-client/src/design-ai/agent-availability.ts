export type AgentStatusResult = {
  status: string
  mode?: string
  label?: string
  message?: string
  providers?: Array<{ active?: boolean; kind?: string; name?: string }>
}

export type AgentAvailability = { tone: 'local' | 'configured' | 'error'; text: string }

export const AGENT_CONNECTION_CHANGED = 'futureox-agent-connection-changed'

export function agentAvailability(result: AgentStatusResult): AgentAvailability {
  if (result.status === 'cancelled') return { tone: 'error', text: '已取消' }
  if (result.status !== 'ok') return { tone: 'error', text: result.message || '设计助手不可用' }
  const active = result.providers?.find(item => item.active)
  const local = result.mode === 'local' || active?.kind === 'local'
  if (local) return { tone: 'local', text: '本机模式：不需要外部模型密钥。一键出图由本机规则直接改画布。' }
  const name = result.label || active?.name
  if (name) return { tone: 'configured', text: `当前连接：${name}。下一轮设计对话使用这条连接。` }
  return { tone: 'configured', text: '设计助手已连接。' }
}
