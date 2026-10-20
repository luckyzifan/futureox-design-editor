import type { AutomationMethod } from './types'

/** Local, trusted-host supplied narrowing policy. This is not authentication,
 * an account role, or an OS permission. Never accept it from request.params.
 * Omitting a grant denies it; there are deliberately no wildcard operations.
 * Resources are whole document sessions: node/page ACLs are not implied. */
export interface AutomationPermissionGrant {
  resource: { documentId: string; session: number }
  operations: readonly string[]
  access: 'read' | 'write'
}
export interface AutomationPermissionPolicy {
  grants: readonly AutomationPermissionGrant[]
}
export type AutomationResource = { documentId: string; session: number }

/** Closed, bounded configuration copied into collision-safe exact resource maps.
 * Later caller mutation cannot widen authority; dispatch checks are O(1). */
export class LocalAutomationPermissions {
  private readonly resources = new Map<string, Map<number, { read: Set<string>; write: Set<string> }>>()
  constructor(policy: AutomationPermissionPolicy) {
    const keys = (value: unknown, allowed: string[]): boolean => !!value && typeof value === 'object'
      && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key))
    if (!keys(policy, ['grants']) || !Array.isArray(policy.grants) || policy.grants.length > 256)
      throw new Error('Invalid automation permission policy')
    for (const grant of policy.grants as readonly AutomationPermissionGrant[]) {
      if (!keys(grant, ['resource', 'operations', 'access']) || !keys(grant.resource, ['documentId', 'session'])
        || typeof grant.resource.documentId !== 'string' || !grant.resource.documentId.trim() || grant.resource.documentId.length > 128
        || !Number.isSafeInteger(grant.resource.session) || grant.resource.session < 0
        || !['read', 'write'].includes(grant.access) || !Array.isArray(grant.operations) || grant.operations.length > 1024
        || grant.operations.some((name: unknown) => typeof name !== 'string' || name.length > 128 || !/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/.test(name)))
        throw new Error('Invalid automation permission grant')
      let sessions = this.resources.get(grant.resource.documentId)
      if (!sessions) { sessions = new Map(); this.resources.set(grant.resource.documentId, sessions) }
      let operations = sessions.get(grant.resource.session)
      if (!operations) { operations = { read: new Set(), write: new Set() }; sessions.set(grant.resource.session, operations) }
      for (const name of grant.operations) {
        operations.read.add(name)
        if (grant.access === 'write') operations.write.add(name)
      }
    }
  }
  allows(method: AutomationMethod | undefined, resource: AutomationResource): boolean {
    if (!method) return false
    const operations = this.resources.get(resource.documentId)?.get(resource.session)
    return operations?.[method.mutates ? 'write' : 'read'].has(method.name) ?? false
  }
}
