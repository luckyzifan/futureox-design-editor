/** Figma Weave, session, and branch names for the Figma-shaped facade.
 *
 * These names exist on the connected Figma MCP server. Futureox hosts none of
 * the remote services behind them: Weave runs recipes and models on a Figma
 * account with credits, and cloud branches are a hosted file feature. The
 * facade lists the names anyway so a client that already speaks Figma can
 * discover the boundary from tools/list instead of failing on an unknown tool,
 * and every call answers with an explicit typed result.
 *
 * Weave tool inputs follow the capability summary in
 * docs/DESIGN_AUTOMATION_PARITY.zh-CN.md section 3.7. The connected server's
 * exact published schemas were not available while this module was written, so
 * arguments are advertised for client planning and are not interpreted here.
 *
 * create_session is the one supported mapping: it returns the active local
 * automation transport session, which is exactly the value the facade accepts
 * as sessionId. It does not create a Figma cloud file session and does not
 * contact Figma. create_branch stays unsupported because Futureox has no
 * branch or merge model; open_document opens a saved local copy instead. */

import { isRecord } from './framing.mjs'

export const UNSUPPORTED_REMOTE_CAPABILITY = 'unsupported_remote_capability'
export const FIGMA_COMPATIBILITY_DOC = 'docs/FIGMA_MCP_FACADE.md#weave-sessions-and-branches'

const WEAVE_BOUNDARY = 'Weave runs recipes and models on a Figma account with credits. Futureox is local-first, and this document session exposes no Weave account, credit ledger, hosted recipe catalog, upload store, or hosted prediction service; this call contacted no remote service.'

const SESSION_ASSERTION = {
  type: 'string', minLength: 1, maxLength: 256,
  description: 'Optional Futureox session assertion. Use the sessionId returned by create_session, the current HTTP Mcp-Session-Id, or the packaged Figma stdio desktop grant session.',
}
const FILE_KEY = {
  type: 'string', minLength: 1, maxLength: 512,
  description: 'Accepted and ignored. This server is bound to the enabled local document.',
}

const tool = (name, description, properties = {}, required = [], options = {}) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    // Connected-server-only names have no published schema. Accept unknown
    // arguments so a discovery client is not rejected over a guessed field.
    additionalProperties: options.additionalProperties ?? false,
    properties: { ...properties, ...(options.sessionAssertion === false ? {} : { sessionId: SESSION_ASSERTION }) },
    required,
  },
  annotations: {
    // No name here changes local state: supported create_session only reads
    // identity and unsupported names return before any Design API call. Keep
    // readOnlyHint so read-only catalogs and their contracts stay coherent.
    readOnlyHint: true, destructiveHint: false, idempotentHint: true,
    openWorldHint: options.openWorldHint ?? true,
  },
})

export const FIGMA_COMPATIBILITY_TOOLS = Object.freeze([
  tool('weave_list_tools', 'Compatibility name for the Figma Weave workflow catalog. Futureox has no Weave account or hosted recipe catalog, so the call returns unsupported_remote_capability and makes no remote request. Read the local document with get_metadata instead.', {
    search: { type: 'string', maxLength: 512, description: 'Catalog search text. Advertised for the Figma name; not interpreted.' },
  }),
  tool('weave_get_tool_inputs', 'Compatibility name for one Figma Weave recipe input contract. Futureox has no Weave recipe catalog, so the call returns unsupported_remote_capability. The local editing schema is advertised on use_figma.', {
    recipeId: { type: 'string', minLength: 1, maxLength: 256 },
    version: { type: 'string', minLength: 1, maxLength: 128, description: 'Recipe version, normally a 40-character commit SHA. Not interpreted.' },
  }, ['recipeId']),
  tool('weave_upload_asset', 'Compatibility name for a Figma Weave asset upload ticket. Futureox has no remote asset store, so the call returns unsupported_remote_capability and issues no upload URL or token. Import local images or SVG in the app; the design_* catalog also exposes svg.import.', {}),
  tool('weave_run_tool', 'Compatibility name for a paid Figma Weave recipe run. Futureox has no run queue or credit ledger, so the call returns unsupported_remote_capability and queues nothing. Use use_figma for local edits.', {
    recipeId: { type: 'string', minLength: 1, maxLength: 256 },
    version: { type: 'string', minLength: 1, maxLength: 128 },
    inputs: {
      type: 'array', maxItems: 100,
      items: { type: 'object', additionalProperties: false, properties: { nodeId: { type: 'string', minLength: 1, maxLength: 256 }, value: {} }, required: ['nodeId', 'value'] },
    },
    numberOfRuns: { type: 'integer', minimum: 1, maximum: 100 },
    acknowledgedCost: { description: 'Cost acknowledgement from a Weave quote. Type is not published; not interpreted.' },
  }, ['recipeId']),
  tool('weave_get_tool_run_output', 'Compatibility name for Figma Weave recipe run status and outputs. Futureox has no local Weave run queue, so the call returns unsupported_remote_capability instead of inventing run states.', {
    recipeId: { type: 'string', minLength: 1, maxLength: 256 },
    runIds: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 256 }, description: 'Omit to ask for the most recent runs. Not interpreted.' },
  }, ['recipeId']),
  tool('weave_cancel_tool_run', 'Compatibility name for cancelling Figma Weave recipe runs. Futureox has no local Weave run queue, so the call returns unsupported_remote_capability and cancels nothing.', {
    recipeId: { type: 'string', minLength: 1, maxLength: 256 },
    runIds: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 256 } },
  }, ['recipeId']),
  tool('weave_find_model', 'Compatibility name for the Figma Weave model catalog. This document session exposes no Weave-compatible model catalog, pricing, or credits, so the call returns unsupported_remote_capability with no candidates.', {
    query: { type: 'string', minLength: 1, maxLength: 512 },
  }, ['query']),
  tool('weave_run_model', 'Compatibility name for a direct paid Figma Weave model prediction. This document session exposes no Weave-compatible model gateway, so the call returns unsupported_remote_capability and starts no prediction. Use use_figma for local edits.', {
    id: { type: 'string', minLength: 1, maxLength: 256 },
    input: { description: 'Model input. Type is not published; not interpreted.' },
    acknowledgedCost: { description: 'Cost acknowledgement from a Weave quote. Type is not published; not interpreted.' },
  }, ['id', 'input']),
  tool('weave_get_model_run_output', 'Compatibility name for Figma Weave model prediction status and outputs. Futureox has no local prediction queue, so the call returns unsupported_remote_capability instead of inventing outputs.', {
    predictionIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 256 } },
  }, ['predictionIds']),
  tool('weave_request_report', 'Compatibility name that appears on the connected Figma MCP server but not in the public tools-and-prompts index. Futureox has no report pipeline or account, so the call returns unsupported_remote_capability. Unknown arguments are accepted because the connected schema is not published.', {}, [], { additionalProperties: true }),
  tool('create_session', 'Issue the active Futureox local automation session for this connection. The returned sessionId is the value other facade tools accept as sessionId. This is not a Figma cloud file session and does not contact Figma; fileKey is accepted and ignored.', { fileKey: FILE_KEY }, [], { sessionAssertion: false, openWorldHint: false }),
  tool('create_branch', 'Compatibility name that appears on the connected Figma MCP server but not in the public tools-and-prompts index. Futureox has no cloud branch or merge model, so the call returns unsupported_remote_capability and creates nothing. Save a copy of the design and open it with open_document. Unknown arguments are accepted because the connected schema is not published.', { fileKey: FILE_KEY }, [], { additionalProperties: true }),
])

export const FIGMA_WEAVE_TOOL_NAMES = Object.freeze(FIGMA_COMPATIBILITY_TOOLS
  .map(entry => entry.name)
  .filter(name => name.startsWith('weave_') && name !== 'weave_request_report'))

export const FIGMA_COMPATIBILITY_GAPS = Object.freeze([
  {
    id: 'weave_recipes', tool: 'weave_list_tools, weave_get_tool_inputs, weave_run_tool, weave_get_tool_run_output, weave_cancel_tool_run, weave_upload_asset', status: 'unsupported',
    detail: 'Listed by name for Figma clients. Every call returns unsupported_remote_capability and contacts no service. This document session exposes no Weave account, credits, hosted recipes, upload tickets, or job state.',
  },
  {
    id: 'weave_models', tool: 'weave_find_model, weave_run_model, weave_get_model_run_output', status: 'unsupported',
    detail: 'Listed by name for Figma clients. Every call returns unsupported_remote_capability. This document session exposes no Weave-compatible model catalog, pricing, or prediction service.',
  },
  {
    id: 'weave_request_report', tool: 'weave_request_report', status: 'unsupported',
    detail: 'Connected Figma server only; the public tools-and-prompts index does not list it. Registered for comparison and returns unsupported_remote_capability. No report pipeline or account exists.',
  },
  {
    id: 'create_session', tool: 'create_session', status: 'partial',
    detail: 'Returns the active local automation transport session, which other facade tools accept as sessionId. No Figma cloud file session is created and Figma is not contacted.',
  },
  {
    id: 'create_branch', tool: 'create_branch', status: 'unsupported',
    detail: 'Connected Figma server only; the public tools-and-prompts index does not list it. No cloud branch or merge model. Returns unsupported_remote_capability; save a copy and open_document instead.',
  },
])

const UNSUPPORTED = {
  weave_list_tools: { capability: 'figma.weave.catalog', hint: 'Read the local document with get_metadata and get_variable_defs.' },
  weave_get_tool_inputs: { capability: 'figma.weave.catalog', hint: 'The local editing schema is advertised on use_figma.' },
  weave_upload_asset: { capability: 'figma.weave.assets', hint: 'Import images or SVG in the app, or use svg.import on the design_* catalog; use_figma creates local nodes.' },
  weave_run_tool: { capability: 'figma.weave.recipes', hint: 'Nothing was queued. Use use_figma for local edits.' },
  weave_get_tool_run_output: { capability: 'figma.weave.recipes', hint: 'This session has no Weave run to report on.' },
  weave_cancel_tool_run: { capability: 'figma.weave.recipes', hint: 'This session has no Weave run to cancel.' },
  weave_find_model: { capability: 'figma.weave.models', hint: 'This session exposes no Weave model catalog or pricing.' },
  weave_run_model: { capability: 'figma.weave.models', hint: 'No prediction was started. Use use_figma for local edits.' },
  weave_get_model_run_output: { capability: 'figma.weave.models', hint: 'This session has no Weave prediction to read.' },
  weave_request_report: { capability: 'figma.weave.report', hint: 'There is no local report pipeline or account.' },
  create_branch: { capability: 'figma.branch', hint: 'No branch was created. Save a copy of the design and open it with open_document.' },
}

const COMPATIBILITY = new Map(FIGMA_COMPATIBILITY_TOOLS.map(entry => [entry.name, entry]))

export function isCompatibilityTool(name) {
  return COMPATIBILITY.has(name)
}

const failure = (method, code, message, details) => ({
  ok: false, method, documentId: '', session: 0, revision: 0,
  error: { code, message, ...(details === undefined ? {} : { details }) },
})

async function createSession(args, sessionId, call) {
  if (!isRecord(args)) return failure('create_session', 'invalid_params', 'Tool arguments must be an object')
  const extra = Object.keys(args).filter(key => key !== 'fileKey')
  if (extra.length) return failure('create_session', 'invalid_params', `Unknown arguments: ${extra.join(', ')}. create_session issues the local session; it does not accept a sessionId assertion.`)
  if (typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 256) {
    return failure('create_session', 'session_unavailable', 'This transport does not bind a local session assertion, so there is no sessionId to issue. Omit sessionId on facade calls, or connect through the desktop automation grant or HTTP listener, which supply one.', { docs: FIGMA_COMPATIBILITY_DOC })
  }
  const read = await call('document.get', {})
  if (!isRecord(read) || typeof read.ok !== 'boolean') return failure('create_session', 'invalid_backend', 'Design API returned an invalid response')
  if (!read.ok) return { ...read, method: 'create_session' }
  return {
    ok: true, method: 'create_session', documentId: read.documentId, session: read.session, revision: read.revision,
    result: {
      sessionId, documentId: read.documentId, revision: read.revision, fileKeyIgnored: args.fileKey !== undefined,
      note: 'Active local automation session, not a Figma cloud file session. Other facade tools accept this value as sessionId. It ends when this MCP connection or the desktop grant ends.',
    },
  }
}

/** Resolve one compatibility name. Unsupported names answer with a typed error
 * before any Design API read, so a client never mistakes an empty or invented
 * result for a real Weave, model, report, or branch outcome. */
export async function callCompatibilityTool({ name, args = {}, sessionId, call }) {
  if (!isCompatibilityTool(name)) return failure(name, 'unknown_tool', `Unknown Figma-shaped tool ${name}`)
  if (name === 'create_session') return createSession(args, sessionId, call)
  const boundary = UNSUPPORTED[name]
  return failure(name, UNSUPPORTED_REMOTE_CAPABILITY, `${name} was not executed. ${WEAVE_BOUNDARY} ${boundary.hint}`, {
    capability: boundary.capability, docs: FIGMA_COMPATIBILITY_DOC,
  })
}