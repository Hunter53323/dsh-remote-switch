/**
 * Wire vocabulary of the harness Remote API, as read by the federation half.
 *
 * Every constant and envelope here was pinned against the installed harness
 * (0.1.5-rc.2) rather than guessed:
 *
 *   `dsh-client-connection/lib/index.js` — `clientRequestSchema`
 *     `{ type: 'client-request', rpcId, method, payload }`, and the
 *     `method === endpoint-from-URL-path` agreement check.
 *   `dsh-api-gateway/lib/types/stream-protocol.js` — `REMOTE_STREAM_MUX_PATH`,
 *     the stream client frames (`open` / `cancel`) and server frames
 *     (`item` / `end` / `error`).
 *   `dsh-api-session-controller/lib/typert.host.js` — `session/list` takes one
 *     JSON parameter, reserved and empty, wired as `_request`.
 *   `dsh-api-workspace-controller/lib/typert.host.js` — `workspace/follow` is a
 *     `mode: 'stream'` invocation with no parameters.
 *
 * @module dsh-remote-switch/federation/wire
 */

/** Shared unary RPC channel prefix; a Remote method rides `<channel>/<ns>/<method>`. */
export const API_CHANNEL = '/api'

/** The remote-access plugin's gated mirror of the same channel. */
export const REMOTE_CHANNEL = '/remote/api'

/** Exact WebSocket path carrying every Remote stream, under the plain channel. */
export const STREAM_MUX_PATH = '/api/remote.mux'

/**
 * The same mux path under the gated channel.
 *
 * The mirror is `<REMOTE_PREFIX>/api/remote.mux` — literally the inner path with
 * the `/remote` prefix in front, which is why this is a concatenation and not a
 * second hand-written constant.
 */
export const GATED_STREAM_MUX_PATH = `${REMOTE_CHANNEL}/remote.mux`

/** Remote endpoint reading every visible session row. */
export const SESSION_LIST_ENDPOINT = 'session/list'

/** Remote endpoint streaming the workspace baseline then increments. */
export const WORKSPACE_FOLLOW_ENDPOINT = 'workspace/follow'

/**
 * `session/list` accepts exactly one parameter, reserved for future paging and
 * currently declared empty. Sending `{}` for `args` would fail the strict codec;
 * the reserved key must be present.
 * @returns {{ _request: Record<string, never> }} the request arguments.
 */
export function emptyListArgs() {
  return { _request: {} }
}

/**
 * Whether a value is a plain JSON object (never an array).
 * @param {unknown} value - the candidate.
 * @returns {boolean} true for a plain object.
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build one unary request envelope.
 *
 * `method` must equal the endpoint the URL addresses; the receiving channel
 * rejects the pair otherwise.
 * @param {string} endpoint - canonical Remote endpoint, e.g. `/api/session/list`.
 * @param {unknown} args - the endpoint's arguments object.
 * @returns {string} the serialized envelope.
 */
export function encodeRequest(endpoint, args) {
  return JSON.stringify({
    type: 'client-request',
    rpcId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    method: endpoint,
    payload: { args },
  })
}

/**
 * Parse one unary response envelope.
 *
 * The outer body is always HTTP 200 for an answered call; the business outcome
 * lives in `result.ok`. A transport-level failure (401/403/5xx) is a different
 * class and is handled by the caller before this point.
 * @param {string} text - the response body.
 * @returns {{ ok: true, value: unknown } | { ok: false, error: { code: string, message: string, details?: unknown } }} the outcome.
 * @throws {Error} when the body is not a valid response envelope.
 */
export function decodeResponse(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('远端返回的不是 JSON（疑似地址指到了别的服务）')
  }
  if (!isRecord(parsed) || parsed.type !== 'server-response' || !isRecord(parsed.result)) {
    throw new Error('远端响应信封不符（疑似 DSH 版本不兼容）')
  }
  const result = parsed.result
  if (result.ok === true) return { ok: true, value: result.value }
  const error = isRecord(result.error) ? result.error : {}
  return {
    ok: false,
    error: {
      code: typeof error.code === 'string' ? error.code : 'unknown',
      message: typeof error.message === 'string' ? error.message : '远端未给出原因',
      details: error.details,
    },
  }
}

/**
 * Unwrap a decoded response, turning `ok:false` into a thrown error that keeps
 * the remote code (the panel shows the code verbatim, §5.4).
 * @param {{ ok: boolean, value?: unknown, error?: { code: string, message: string } }} decoded - the decoded outcome.
 * @returns {unknown} the success value.
 * @throws {Error} carrying `code` for the failure branch.
 */
export function unwrap(decoded) {
  if (decoded.ok) return decoded.value
  const error = new Error(decoded.error.message)
  error.code = decoded.error.code
  error.details = decoded.error.details
  throw error
}
