# Local operation permission boundary (v1)

## Scope and trust

This is a local application authorization seam, not cloud accounts, collaboration,
OS permissions, authentication, or a persistent credential grant. Permissions are
supplied only by trusted host code to `createEditorDesignAutomation(editor, policy)`
or the final argument of `createDesignAutomation`. They are never loaded from FD
content, extension metadata, request parameters, MCP arguments, or a model reply.

Omitting the policy explicitly retains the trusted local application's existing
full operation authority. Supplying `{ grants: [] }` denies every operation.
This change does **not** automatically restrict every UI entry point or the desktop
bridge. The desktop bridge retains its existing native opt-in, read/write scope,
document/session fence, cancellation, and separate workspace/settings grants.
A host embedding the restricted API must select its policy itself. Preview and
workspace host adapters are separate boundaries and are not covered by this seam.

## Contract

A grant contains an exact document ID and editor session generation, explicit
operation names, and `read` or `write` access. Wildcards are rejected. A read grant
never enables a mutating operation. A write grant enables only its listed methods.
An operation must also be registered: a permission name cannot install code.
The closed-shape policy is compiled into collision-safe document/session maps and
operation sets at construction, giving O(1) dispatch checks. Limits are 256 grants,
1,024 operation names per grant, and 128 characters per ID/name. Caller mutation
cannot widen it. Replacing
or reopening the editor document invalidates its resource grant; construct a fresh
API with a newly authorized policy rather than carrying authority across sessions.

Resources are whole document sessions. No page/node ACL is implied: operations can
read their document snapshot, and structural operations may affect descendants,
parents, component instances, or resources. Finer scopes require explicit operation
read/write footprint modeling before they can be safely advertised.

## Enforcement

`DesignAutomationApi.execute` validates JSON and operation schema, then checks the
operation grant against the current document session before reads, undo/redo,
mutation receipt replay, or any extension callback. Batches require both the batch
method and **every** contained operation; all members are authorized before staging.
Preflight also requires the included operation grants; it is not a write-authority
bypass. Unknown methods fail closed. Capability method lists and granular/preflight
method lists are filtered by the same policy. Discovery never grants access.

Existing revision/document/session fences, busy/pending input checks, locked-node
checks, structural/model validators, isolated staging, and the one `Editor.change`
commit/history boundary remain authoritative. UI and automation still use the same
editor commit invariants; they are not claimed to share a complete ACL system.
Extensions remain trusted, synchronous application code, not sandboxed third-party
plugins. They must not perform side effects outside the supplied isolated draft.

## Validation

`src/automation/permissions.test.ts` exercises the real dispatcher: empty policy,
positive scoped reads/writes, denied history and deletes, read-only write rejection,
unknown methods, filtered capabilities, denied mixed batches with zero callbacks,
atomic allowed batches, locked-node enforcement, host policy mutation isolation,
and actual document replacement revoking access. Existing core, bridge, granular
and MCP tests cover the unchanged outer authorization and editor machinery.
