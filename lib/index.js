/**
 * dsh-instance-switcher — host half.
 *
 * Owns one small job: a local list of DSH instance origins (plus an optional
 * device credential each) and an HTTP surface the browser half reads and
 * mutates. It deliberately depends on NOTHING from
 * `@linxin666/dsh-remote-web-ui`: the credential it stores is obtained by
 * redeeming a pairing token over plain HTTP from the Node side, where the
 * same-origin policy that blocks a browser does not apply.
 *
 * Access model:
 *   GET  /api/instance-switcher/peers   readable from any origin the host is
 *                                       already serving (a paired remote
 *                                       desktop is already a full-control
 *                                       credential for this host)
 *   POST /api/instance-switcher/peers   loopback only — mutations never run
 *                                       from a LAN/tunnel page
 *   POST /api/instance-switcher/test    loopback only
 *
 * @module dsh-instance-switcher
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  entryUrl,
  mintPeerId,
  normalizeOrigin,
  parsePairingLink,
  readPeersFile,
  sameOrigin,
  writePeersFile,
} from './peers.js'

export * from './peers.js'

/** Services required from the surrounding composition. */
export const inject = ['webServer']

/** Route family prefix (all routes below are exact paths under it). */
const BASE = '/api/instance-switcher'

/** Bound on a request body; the forms here are tiny. */
const MAX_BODY_BYTES = 16 * 1024

/**
 * Default device-cookie name of the remote-access plugin
 * (`@linxin666/dsh-remote-web-ui` ships `dsh_pair`; the name is configurable
 * there, hence the `targetCookieName` override). Used only by the probe.
 */
const DEFAULT_TARGET_COOKIE = 'dsh_pair'

/**
 * The storage key the target's shell-capture script writes. It is the wire
 * constant shared by that plugin's `/pair-app` capture script and its boot
 * patch, so its presence in a `/pair-app` response is a version-stable signal
 * that the credential was accepted — independent of the cookie name.
 */
const CAPTURE_MARKER = 'dsh-remote-device'

/**
 * Default device cookie name of the remote-access plugin (see
 * {@link DEFAULT_TARGET_COOKIE}); read here so a paired LAN/tunnel page can
 * prove it holds a live session before this plugin hands over the peer list.
 */
const DEVICE_COOKIE_NAME = 'dsh_pair'

/** Idle window the pairing plugin applies to a device session (its own default). */
const DEFAULT_IDLE_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Read one cookie value out of a Cookie header.
 * @param {string} header - the raw header.
 * @param {string} name - the cookie name.
 * @returns {string | undefined} the value, or undefined when absent.
 */
function readCookieValue(header, name) {
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    if (part.slice(0, at).trim() !== name) continue
    const value = part.slice(at + 1).trim()
    if (value !== '') return value
  }
  return undefined
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Harness home resolution: honors DSH_HOME, else ~/.dsh.
 * @returns {string} the harness home directory.
 */
function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  return path.join(home, '.dsh')
}

/** Default store location. @returns {string} */
function defaultPeersFile() {
  return path.join(dshHome(), 'instance-switcher', 'peers.json')
}

/**
 * Whether a request arrived from this machine (loopback socket AND loopback Host).
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {boolean} true for a local client.
 */
function isLoopbackRequest(request) {
  const host = request.headers.host
  if (typeof host !== 'string' || host === '') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (!(LOOPBACK_HOSTS.has(hostname) || hostname.startsWith('127.'))) return false
  const remote = request.socket?.remoteAddress ?? ''
  return remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.')
}

/**
 * Best-effort CORS so a sibling plugin can ask from a LAN origin.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @returns {void}
 */
function applyCors(request, res) {
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin !== '') res.setHeader('access-control-allow-origin', origin)
  res.setHeader('vary', 'origin')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
}

/**
 * Read one JSON request body.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {Promise<Record<string, unknown> | undefined>} parsed object, or undefined.
 */
async function readJson(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (total === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 * @returns {void}
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

/**
 * Whether a value is a usable non-empty string field.
 * @param {unknown} value - the candidate.
 * @returns {string | undefined} the trimmed value.
 */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Probe one peer from the Node side.
 *
 * The cookieless landing `/pair-app?device=<credential>` is the one path that
 * needs no harness browser cookie — it was built so a phone with cookies fully
 * blocked can still open the GUI. That makes it the right reachability probe
 * for a peer whose credential we hold. The two outcomes are deliberately both
 * HTTP 200, so the discriminator is the response itself, not the status:
 *   a live credential  → 200 + the shell carrying the capture script + a
 *                        `Set-Cookie` for the device cookie
 *   a dead credential  → 200 + the pairing-failure page, neither of those
 *
 * @param {string} origin - the instance origin.
 * @param {string | undefined} credential - its device credential, when known.
 * @param {number} timeoutMs - request timeout.
 * @param {string} cookieName - the target's device cookie name.
 * @returns {Promise<{ reachable: boolean, credentialLive?: boolean, status?: number, latencyMs: number, detail?: string }>}
 */
async function probePeer(origin, credential, timeoutMs, cookieName) {
  const hasCredential = credential !== undefined && credential !== ''
  const target = hasCredential ? `${origin}/pair-app?device=${encodeURIComponent(credential)}` : `${origin}/`
  const started = Date.now()
  try {
    const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    const latencyMs = Date.now() - started
    if (!hasCredential) {
      return { reachable: true, status: response.status, latencyMs }
    }
    const body = await response.text().catch(() => '')
    const setCookie = response.headers.get('set-cookie') ?? ''
    const accepted = response.status === 200 &&
      (body.includes(CAPTURE_MARKER) || setCookie.includes(cookieName))
    return { reachable: true, credentialLive: accepted, status: response.status, latencyMs }
  } catch (error) {
    return {
      reachable: false,
      latencyMs: Date.now() - started,
      detail: error instanceof Error ? error.message : 'request failed',
    }
  }
}

/**
 * Redeem a one-time pairing token against a target instance.
 *
 * The target's `/api/pair/accept` is exempt from its own pairing gate, so a
 * Node-side caller carrying no browser markers passes the transport fence. The
 * response shape is the plugin's own contract: `{ ok: true, deviceId }`.
 *
 * @param {string} origin - the target instance origin.
 * @param {string} token - the one-time `pair` token.
 * @param {number} timeoutMs - request timeout.
 * @returns {Promise<{ ok: true, deviceId: string } | { ok: false, detail: string }>}
 */
async function redeemPairingToken(origin, token, timeoutMs) {
  try {
    const response = await fetch(`${origin}/api/pair/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const raw = await response.text()
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    const deviceId = parsed !== null && typeof parsed === 'object' ? text(parsed.deviceId) : undefined
    if (response.ok && parsed?.ok === true && deviceId !== undefined) return { ok: true, deviceId }
    const code = parsed !== null && typeof parsed === 'object' ? (text(parsed.code) ?? `HTTP ${String(response.status)}`) : `HTTP ${String(response.status)}`
    return { ok: false, detail: code }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'request failed' }
  }
}

/**
 * Register the instance-switcher host surface.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context (needs `webServer`).
 * @param {{ peersFile?: string, requestTimeoutMs?: number, targetCookieName?: string }} [config] - optional overrides.
 * @returns {() => void} a disposer removing the routes.
 */
export function apply(ctx, config = {}) {
  const peersFile = text(config.peersFile) ?? defaultPeersFile()
  const timeoutMs = typeof config.requestTimeoutMs === 'number' && config.requestTimeoutMs > 0
    ? config.requestTimeoutMs
    : 6000
  const targetCookie = text(config.targetCookieName) ?? DEFAULT_TARGET_COOKIE

  /** @returns {object[]} the persisted peers. */
  const load = () => readPeersFile(peersFile).peers

  /**
   * Whether a request may read the peer list.
   *
   * The list carries every peer's device credential, so it is as sensitive as
   * the mutations — and unlike `/api/*` handlers behind the harness's auth
   * cookie (which answer 401), a raw route registered on the web server is
   * reached directly. An earlier revision served it to anyone; a probe from a
   * real LAN origin proved that leaked the credentials without any credential.
   *
   * Allowed: a loopback client (this machine's own page), or a request holding
   * a live paired-device session. The session check prefers the pairing
   * plugin's own service (exact staleness rules, no `ctx.get` hard dependency
   * so this plugin still loads without it) and falls back to reading the same
   * device table directly.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @returns {boolean} true when the caller may see the list.
   */
  const canReadPeers = (req) => {
    if (isLoopbackRequest(req)) return true
    try {
      const pairing = ctx.get('remoteWebUiPairing')
      if (typeof pairing?.isPairedDevice === 'function') return pairing.isPairedDevice(req) === true
    } catch {
      /* the service is absent — fall through to the table check */
    }
    const raw = req.headers.cookie
    if (typeof raw !== 'string' || raw === '') return false
    for (const name of [text(config.deviceCookieName) ?? DEVICE_COOKIE_NAME, text(config.targetCookieName) ?? DEFAULT_TARGET_COOKIE]) {
      const value = readCookieValue(raw, name)
      if (value !== undefined && deviceIsLive(value)) return true
    }
    return false
  }

  /**
   * Fallback liveness check straight off the pairing plugin's device table.
   * Used only when its `remoteWebUiPairing` service is not mounted.
   * @param {string} deviceId - the cookie value.
   * @returns {boolean} true for a session that is neither revoked nor idle-expired.
   */
  const deviceIsLive = (deviceId) => {
    try {
      const file = text(config.devicesFile) ?? path.join(dshHome(), 'remote-web-ui-devices.json')
      const table = JSON.parse(readFileSync(file, 'utf8'))
      const row = table?.[deviceId]
      if (row === null || typeof row !== 'object') return false
      const idle = Number(row.idleExpireMs) > 0 ? Number(row.idleExpireMs) : DEFAULT_IDLE_EXPIRE_MS
      const seen = Number(row.lastSeenAt)
      return Number.isFinite(seen) && Date.now() - seen < idle
    } catch {
      return false
    }
  }

  /** @returns {object} the state frame the browser half renders. */
  const state = () => ({
    ok: true,
    peers: load(),
    peersFile,
  })

  /**
   * GET/HEAD the peer list (loopback or a live paired device).
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {void}
   */
  const handleList = (req, res) => {
    applyCors(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (!canReadPeers(req)) {
      sendJson(res, 403, {
        ok: false,
        error: 'unpaired',
        hint: '实例清单含凭据，只发给本机页面或已配对的设备会话',
      })
      return
    }
    sendJson(res, 200, state())
  }

  /**
   * POST a mutation (add / remove / touch). Loopback only.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>}
   */
  const handleMutate = async (req, res) => {
    applyCors(req, res)
    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'loopback-only', hint: '实例清单只能在本机（127.0.0.1）修改' })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const body = await readJson(req)
    if (body === undefined) {
      sendJson(res, 400, { ok: false, error: 'invalid json body' })
      return
    }
    const action = text(body.action)
    const peers = load()
    if (action === 'add') {
      const parsed = parsePairingLink(text(body.link) ?? text(body.origin))
      if (parsed === undefined) {
        sendJson(res, 400, {
          ok: false,
          error: 'invalid-address',
          hint: '请填 http(s)://主机:端口，或粘贴对方实例的配对链接',
        })
        return
      }
      let credential = parsed.credential ?? text(body.credential)
      if (parsed.token !== undefined) {
        const redeemed = await redeemPairingToken(parsed.origin, parsed.token, timeoutMs)
        if (!redeemed.ok) {
          sendJson(res, 502, {
            ok: false,
            error: 'pair-redeem-failed',
            detail: redeemed.detail,
            hint: '对方实例没有接受这枚令牌：可能已过期、已被用过，或那台实例没在跑远程访问插件。请在对方「远程访问」面板重新生成链接。',
          })
          return
        }
        credential = redeemed.deviceId
      }
      let defaultLabel = parsed.origin
      try {
        defaultLabel = new URL(parsed.origin).hostname
      } catch {
        /* keep the origin as the label */
      }
      const label = text(body.label) ?? defaultLabel
      const existingIndex = peers.findIndex(peer => sameOrigin(peer.origin, parsed.origin))
      const existing = existingIndex >= 0 ? peers[existingIndex] : undefined
      const row = {
        id: existing?.id ?? mintPeerId(),
        label,
        origin: parsed.origin,
        createdAt: existing?.createdAt ?? Date.now(),
        ...(credential !== undefined ? { credential } : {}),
      }
      if (existingIndex >= 0) peers[existingIndex] = row
      else peers.push(row)
      writePeersFile(peersFile, peers)
      sendJson(res, 200, {
        ...state(),
        added: row.id,
        replaced: existingIndex >= 0,
        credentialStored: credential !== undefined,
      })
      return
    }
    if (action === 'remove') {
      const id = text(body.id)
      if (id === undefined) {
        sendJson(res, 400, { ok: false, error: 'invalid-id' })
        return
      }
      const next = peers.filter(peer => peer.id !== id)
      writePeersFile(peersFile, next)
      sendJson(res, 200, { ...state(), removed: next.length !== peers.length })
      return
    }
    if (action === 'touch') {
      const id = text(body.id)
      const index = peers.findIndex(peer => peer.id === id)
      const row = index >= 0 ? peers[index] : undefined
      if (row === undefined) {
        sendJson(res, 404, { ok: false, error: 'not-found' })
        return
      }
      peers[index] = { ...row, lastUsedAt: Date.now() }
      writePeersFile(peersFile, peers)
      sendJson(res, 200, state())
      return
    }
    sendJson(res, 400, { ok: false, error: 'unknown-action' })
  }

  /**
   * POST a reachability probe. Loopback only.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>}
   */
  const handleTest = async (req, res) => {
    applyCors(req, res)
    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'loopback-only' })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const body = await readJson(req)
    if (body === undefined) {
      sendJson(res, 400, { ok: false, error: 'invalid json body' })
      return
    }
    const id = text(body.id)
    const peers = load()
    const peer = peers.find(candidate => candidate.id === id)
    const origin = peer?.origin ?? normalizeOrigin(body.origin)
    if (origin === undefined) {
      sendJson(res, 400, { ok: false, error: 'not-found' })
      return
    }
    const credential = peer?.credential ?? text(body.credential)
    const outcome = await probePeer(origin, credential, timeoutMs, targetCookie)
    sendJson(res, 200, { ok: true, ...outcome, entry: entryUrl(origin, credential) })
  }

  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/peers`,
      handler: (req, res) => (req.method === 'POST' ? handleMutate(req, res) : handleList(req, res)),
    }),
    ctx.webServer.register({ kind: 'exact', path: `${BASE}/test`, handler: handleTest }),
  ]

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* a route may already be gone during teardown */
      }
    }
  }
}
