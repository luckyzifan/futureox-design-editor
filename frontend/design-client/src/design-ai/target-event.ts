export const AGENT_TARGET_EVENT = 'futureox-design-agent-target'

export type AgentTargetDetail = {
  pageId: string
  prompt?: string
  /** False prefills the docked composer. Any other value sends the prompt. */
  send?: boolean
}

export function requestAgentTarget(detail: AgentTargetDetail) {
  window.dispatchEvent(new CustomEvent<AgentTargetDetail>(AGENT_TARGET_EVENT, { detail }))
}
