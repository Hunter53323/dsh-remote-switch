/**
 * Peer list client: reads a remote DSH's session list and workspace baseline.
 *
 * Two calls only, both read-only (the §6 red line):
 *
 *   `POST /api/session/list`      — one unary Remote call, double envelope.
 *   `WS   /api/remote.mux`        — open `workspace/follow`, read the first
 *                                   frame (the complete baseline), then
 *                                   `cancel`. Opening and cancelling before the
 *                                   iterator is exhausted is safe: the gateway
 *                                   aborts the generator, and only the
 *                                   `$events` stream carries an answer
 *                                   obligation this plugin must never take on.
 *
 * Both calls go through a carrier chosen by the peer's channel: a `direct-tcpip`
 * channel over SSH, or a plain connection to the remote origin. The peer's
 * credential kind decides the path: an official browser cookie on `/api`, or
 * the paired-device credential on the gated `/remote/api` mirror.
 *
 * @module dsh-remote-switch/federation/client
 */

import http from 'node:http'
import https from 'node:https'

import wsModule from 'ws'

import {
  API_CHANNEL,
  GATED_STREAM_MUX_PATH,
  REMOTE_CHANNEL,
  SESSION_LIST_ENDPOINT,
  STREAM_MUX_PATH,
  WORKSPACE_FOLLOW_ENDPOINT,
  decodeResponse,
  emptyListArgs,
  encodeRequest,
  isRecord,
  unwrap,
} from './wire.js'
import { archivedFromBaseline, displayTitleOf, groupByCwd, projectSessions } from './visible.js'
import { STATIC_LIMITS, readStaticSessions } from './static.js'
import { TransportError } from './ssh.js'

/**
 * `ws` publishes the WebSocket class *as* its module export and hangs the
 * helpers off it, so under ESM the default import IS the constructor on some
 * builds and a namespace carrying it on others. Resolving both shapes here is
 * cheaper than a version pin, and a wrong guess fails at import time with
 * "WebSocket is not a constructor" — on the baseline read only, which is the
 * one path that would then look like a benign warning.
 */
const WebSocket = wsModule.WebSocket ?? wsModule

/** Default per-request timeout. */
const REQUEST_TIMEOUT_MS = 12000

/** How long to wait for the stream baseline frame. */
const BASELINE_TIMEOUT_MS = 8000

/** Remote-access plugin's device header (its cookieless credential carrier). */
export const DEVICE_HEADER = 'x-dsh-remote-device'

/**
 * Perform one HTTP request, optionally through an SSH tunnel.
 *
 * `Host` is always the authority actually being addressed — never `0.0.0.0`,
 * never a LAN name for a tunnelled peer — because the harness binds its signed
 * cookie to that value and re-checks it on every request.
 * @param {string} url - absolute URL.
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number, createConnection?: Function }} [options] - request options.
 * @returns {Promise<{ status: number, headers: Record<string, string | string[] | undefined>, text: string, setCookie: string[] }>} the response.
 */
export function httpRequest(url, options = {}) {
  const target = new URL(url)
  const isSecure = target.protocol === 'https:'
  const transport = isSecure ? https : http
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const setCookie = []
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port === '' ? (isSecure ? 443 : 80) : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: options.method ?? 'GET',
      headers: {
        host: target.host,
        ...(options.headers ?? {}),
      },
      ...(options.createConnection === undefined ? {} : { createConnection: options.createConnection }),
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => {
        chunks.push(chunk)
      })
      response.on('end', () => {
        // The Set-Cookie header is read here rather than from a `'set-cookie'`
        // event: that event only exists on a *server* response, so listening for
        // it on a client response added a listener that could never fire (and
        // would have double-pushed if it ever did).
        const raw = response.headers['set-cookie']
        if (Array.isArray(raw)) setCookie.push(...raw)
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: Buffer.concat(chunks).toString('utf8'),
          setCookie,
        })
      })
      response.on('error', reject)
    })
    request.setTimeout(timeoutMs, () => {
      request.destroy(new TransportError('http-timeout', `请求超时（${String(timeoutMs)}ms）：远端实例可能没有运行`))
    })
    request.on('error', (error) => {
      reject(error instanceof TransportError
        ? error
        : new TransportError('http-failed', error instanceof Error ? error.message : String(error)))
    })
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

/**
 * One WebSocket connection to the remote stream mux.
 *
 * The official harness client dials `/api/remote.mux`; a paired-device peer
 * dials the gated mirror `/remote/api/remote.mux` and passes its credential as
 * a cookie header (the browser passes it as a query parameter because a Web API
 * WebSocket cannot set headers; Node can).
 * @param {string} url - `ws(s)://host:port/path`.
 * @param {Record<string, string>} headers - handshake headers.
 * @param {Function} [createConnection] - SSH-bound socket override.
 * @param {number} timeoutMs - handshake timeout.
 * @returns {Promise<any>} the open socket.
 */
function openSocket(url, headers, createConnection, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers,
      handshakeTimeout: timeoutMs,
      ...(createConnection === undefined ? {} : { createConnection }),
    })
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      try {
        socket.terminate()
      } catch {
        /* already gone */
      }
      reject(error instanceof TransportError
        ? error
        : new TransportError('stream-failed', error instanceof Error ? error.message : String(error)))
    }
    // A PERSISTENT error listener, never `once`. Tearing down a socket that
    // failed its handshake emits a further 'error' (the abort of the in-flight
    // request), and `once` has already been consumed by the first one — so the
    // second has no listener and Node turns it into an uncaught exception. In a
    // host process that is a crash, so this must absorb every error for the
    // socket's lifetime, not just the first.
    socket.on('error', fail)
    socket.once('open', () => {
      if (settled) return
      settled = true
      resolve(socket)
    })
    socket.once('unexpected-response', (_request, response) => {
      fail(new TransportError(
        response.statusCode === 401 ? 'unauthorized' : response.statusCode === 403 ? 'forbidden' : 'stream-rejected',
        `开流被拒绝（HTTP ${String(response.statusCode ?? 0)}）：${response.statusCode === 401 ? '凭据无效' : '被远端的访问栅栏拒绝'}`,
      ))
    })
  })
}

/**
 * Read the `archivedSessionIds` baseline from the stream mux.
 *
 * Frames of this stream are `{type:'item', value:{type:'baseline', value:{…}}}`;
 * the first item is always the baseline, so the socket is closed as soon as one
 * arrives. A failure here is never fatal to the list itself — the archive set
 * only *removes* rows, so an empty set degrades to "show everything the other
 * filters allow" rather than to an empty panel.
 * @param {object} peer - the peer row.
 * @param {{ base: string, headers: Record<string, string>, createConnection?: Function, timeoutMs: number }} carrier - the resolved transport.
 * @returns {Promise<{ archived: Set<string>, error?: string }>} the baseline outcome.
 */
async function readBaseline(peer, carrier, timeoutMs) {
  const muxPath = carrier.gated ? GATED_STREAM_MUX_PATH : STREAM_MUX_PATH
  const wsUrl = `${carrier.base.replace(/^http/u, 'ws')}${muxPath}`
  const handshakeTimeoutMs = Math.max(1000, Math.min(timeoutMs, BASELINE_TIMEOUT_MS))
  let socket
  try {
    socket = await openSocket(wsUrl, carrier.headers, carrier.createConnection, handshakeTimeoutMs)
  } catch (error) {
    return { archived: new Set(), error: error instanceof Error ? error.message : String(error) }
  }
  const streamId = `baseline-${Date.now().toString(36)}`
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'cancel', streamId }))
        }
      } catch {
        /* the socket may already be gone */
      }
      socket.terminate()
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      finish({ archived: new Set(), error: `等待工作区基线的首帧超时（${String(handshakeTimeoutMs)}ms）` })
    }, handshakeTimeoutMs)
    timer.unref?.()
    socket.on('message', (data) => {
      let frame
      try {
        frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'))
      } catch {
        return
      }
      if (!isRecord(frame) || frame.streamId !== streamId) return
      if (frame.type === 'error') {
        const error = isRecord(frame.error) ? frame.error : {}
        finish({ archived: new Set(), error: `${String(error.code ?? 'stream-error')}: ${String(error.message ?? '')}` })
        return
      }
      if (frame.type === 'end') {
        finish({ archived: new Set(), error: '流在给出基线前就结束了' })
        return
      }
      if (frame.type === 'item') {
        finish({ archived: archivedFromBaseline(frame.value) })
      }
    })
    socket.on('close', () => {
      finish({ archived: new Set(), error: '连接在收到基线前关闭' })
    })
    try {
      socket.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint: WORKSPACE_FOLLOW_ENDPOINT,
        payload: { args: {} },
      }))
    } catch (error) {
      finish({ archived: new Set(), error: error instanceof Error ? error.message : String(error) })
    }
  })
}

/**
 * Classify a non-2xx status into the §5.4 vocabulary.
 * @param {number} status - the HTTP status.
 * @param {string} text - the response body.
 * @returns {TransportError} the classified failure.
 */
function statusFailure(status, text) {
  const detail = text.trim().slice(0, 200)
  if (status === 401) {
    return new TransportError('unauthorized', '远端返回 401：登录凭据无效或已过期', { status, detail })
  }
  if (status === 403) {
    return new TransportError('forbidden', '远端返回 403：被访问栅栏拒绝（authority 不匹配，或该机器不允许外部访问）', { status, detail })
  }
  if (status === 404) {
    return new TransportError('not-found', '远端返回 404：地址不是 DSH 的 API（端口错了，或没装对应的远端插件）', { status, detail })
  }
  return new TransportError('http-status', `远端返回 HTTP ${String(status)}`, { status, detail })
}

/**
 * Resolve how to reach one peer: base URL, headers, and the socket factory.
 *
 * @param {object} peer - the peer row.
 * @param {{ transport?: import('./ssh.js').SshTransport, auth: import('./auth.js').AuthStore, timeoutMs: number }} deps - runtime dependencies.
 * @returns {Promise<{ base: string, host: string, headers: Record<string, string>, createConnection?: Function, gated: boolean, authHeaders: Record<string, string> }>} the carrier.
 */
async function resolveCarrier(peer, deps) {
  const createConnection = peer.channel === 'ssh' && deps.transport !== undefined
    ? deps.transport.createConnection(peer)
    : undefined
  const request = (url) => httpRequest(url, { createConnection, timeoutMs: deps.timeoutMs })
  const origin = new URL(peer.origin)
  const host = origin.host
  if (peer.auth?.kind === 'device') {
    const credential = deps.auth.deviceCredential(peer.origin)
    if (credential === undefined) {
      throw new TransportError('no-device-credential', '这个 peer 用 device 凭据，但本机没有存它的配对凭据：请先在「实例」面板里配对那台机器')
    }
    return {
      base: peer.origin,
      host,
      headers: { [DEVICE_HEADER]: credential },
      createConnection,
      gated: true,
      authHeaders: {},
    }
  }
  const authHeaders = await deps.auth.headersFor(peer, request)
  return {
    base: peer.origin,
    host,
    headers: authHeaders,
    createConnection,
    gated: false,
    authHeaders,
  }
}

/**
 * Call one unary Remote method on a peer.
 *
 * The endpoint travels in two different spellings and they are NOT
 * interchangeable: the URL is `<channel>/<endpoint>` (leading slash), while the
 * envelope's `method` field is the bare `<ns>/<method>` the connection layer
 * compares against the path-derived endpoint. Sending the slashed form as
 * `method` answers `gateway/bad-request: method "/api/session/list" does not
 * match endpoint "session/list"`.
 *
 * @param {object} peer - the peer row.
 * @param {string} endpoint - bare Remote endpoint, e.g. `session/list`.
 * @param {unknown} args - the arguments object.
 * @param {object} carrier - the resolved carrier.
 * @param {object} deps - runtime dependencies.
 * @returns {Promise<unknown>} the Remote value.
 */
async function callRemote(peer, endpoint, args, carrier, deps) {
  const channel = carrier.gated ? REMOTE_CHANNEL : API_CHANNEL
  const path = `${channel}/${endpoint}`
  const send = (headers) => httpRequest(`${carrier.base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...carrier.headers,
      ...headers,
    },
    body: encodeRequest(endpoint, args),
    timeoutMs: deps.timeoutMs,
    createConnection: carrier.createConnection,
  })
  let response = await send({})
  if (response.status === 401 && peer.auth?.kind === 'token') {
    // §5.4: a 401 clears the cached cookie and re-acquires exactly once.
    const request = (url) => httpRequest(url, { createConnection: carrier.createConnection, timeoutMs: deps.timeoutMs })
    const renewed = await deps.auth.reauthorize(peer, request)
    carrier.headers = renewed
    response = await send({})
  }
  if (response.status !== 200) throw statusFailure(response.status, response.text)
  return unwrap(decodeResponse(response.text))
}

/**
 * Read one peer's sessions, archive set, and grouping.
 *
 * The two calls are independent: the list is the payload and the baseline only
 * refines it, so a failing stream never empties the panel.
 *
 * When the remote's instance cannot be read at all, this falls back to the P3
 * static listing (its session files over SFTP) rather than reporting nothing —
 * an SSH peer whose `dsh web` is simply not running still has its sessions on
 * disk, which is the whole point of that path. The fallback only applies when
 * the failure is *the instance being unreachable*: a 401/403 is a credential or
 * policy answer that a disk read must not paper over.
 *
 * @param {object} peer - the peer row.
 * @param {{ transport?: import('./ssh.js').SshTransport, auth: import('./auth.js').AuthStore, timeoutMs?: number, limit?: number, remoteHome?: string, staticFallback?: boolean, logger?: { warn: (message: string) => void } }} deps - runtime dependencies.
 * @returns {Promise<object>} the snapshot.
 */
export async function readPeer(peer, deps) {
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS
  const limit = deps.limit ?? 100
  const runtime = { ...deps, timeoutMs }
  try {
    // Inside the try on purpose: resolving the carrier can itself touch the
    // network (a token peer with no valid cached cookie redeems it over HTTP
    // right here). Leaving it outside meant a *down* instance failed before the
    // catch and the static fallback — the exact case it exists for — never ran.
    const carrier = await resolveCarrier(peer, runtime)
    const [listValue, baseline] = await Promise.all([
      callRemote(peer, SESSION_LIST_ENDPOINT, emptyListArgs(), carrier, runtime),
      readBaseline(peer, carrier, timeoutMs).catch(error => ({
        archived: new Set(),
        error: error instanceof Error ? error.message : String(error),
      })),
    ])
    const projection = projectSessions(listValue, baseline.archived, limit)
    return {
      peerId: peer.id,
      channel: peer.channel,
      origin: peer.origin,
      authKind: peer.auth?.kind ?? 'none',
      source: 'live',
      items: projection.items,
      groups: groupByCwd(projection.items),
      total: projection.total,
      truncated: projection.truncated,
      limit,
      archivedCount: baseline.archived.size,
      warnings: baseline.error === undefined ? [] : [`工作区基线读取失败（归档会按「未归档」处理）：${baseline.error}`],
      fetchedAt: Date.now(),
    }
  } catch (error) {
    const fallback = await tryStaticFallback(peer, error, runtime, limit)
    if (fallback !== undefined) return fallback
    throw error
  }
}

/**
 * Attempt the static listing after a live read failed.
 *
 * @param {object} peer - the peer row.
 * @param {unknown} error - the failure that triggered this.
 * @param {object} runtime - resolved dependencies.
 * @param {number} limit - row cap.
 * @returns {Promise<object | undefined>} the snapshot, or undefined when the
 *   fallback does not apply or did not work.
 */
async function tryStaticFallback(peer, error, runtime, limit) {
  if (runtime.staticFallback === false) return undefined
  if (peer.channel !== 'ssh' || runtime.transport === undefined) return undefined
  // A credential/policy failure is an answer about *this client*, not evidence
  // that the instance is down — reading the disk would hide a real problem.
  const code = error?.code ?? ''
  if (['unauthorized', 'forbidden', 'no-credential', 'no-device-credential', 'not-found'].includes(code)) return undefined

  const remoteHome = runtime.remoteHome ?? '~/.dsh'
  try {
    // ssh2's SFTP is callback-based; `sftpReader` is what makes the static
    // reader's `await` calls work at all (see its docs).
    const sftp = await runtime.transport.sftpReader(peer)
    const listing = await readStaticSessions({
      sftp,
      sessionsRoot: `${remoteHome.replace(/\/+$/u, '')}/sessions`,
      scanLimit: runtime.staticScanLimit,
      logger: runtime.logger,
    })
    // When the cwd is present the shared grouping gives the same shape as a
    // live read, so the panel needs no separate rendering path.
    const items = listing.rows.map(row => ({
      ...row,
      title: displayTitleOf({ title: undefined, cwd: row.cwd, sessionId: row.sessionId }),
    }))
    return {
      peerId: peer.id,
      channel: peer.channel,
      origin: peer.origin,
      authKind: peer.auth?.kind ?? 'none',
      source: 'static',
      items: items.slice(0, limit),
      groups: groupByCwd(items.slice(0, limit)),
      total: items.length,
      truncated: items.length > limit || listing.truncated,
      limit,
      archivedCount: 0,
      warnings: [
        `远端实例没在运行，下面是**静态清单**（直接读它磁盘上的会话文件）：${error instanceof Error ? error.message : String(error)}`,
        ...STATIC_LIMITS,
        ...(listing.unreadable === 0 ? [] : [`有 ${String(listing.unreadable)} 个会话文件读不出头信息，已跳过`]),
      ],
      skipped: listing.unreadable,
      fetchedAt: Date.now(),
    }
  } catch (fallbackError) {
    runtime.logger?.warn(`federation: static fallback failed for ${peer.id}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`)
    return undefined
  }
}

/**
 * Probe a peer's reachability and credential liveness without listing anything
 * meaningful: a one-row list call proves both.
 * @param {object} peer - the peer row.
 * @param {object} deps - runtime dependencies.
 * @returns {Promise<{ ok: boolean, latencyMs: number, code?: string, detail?: string }>} the outcome.
 */
export async function probePeer(peer, deps) {
  const started = Date.now()
  try {
    await readPeer(peer, { ...deps, limit: 1 })
    return { ok: true, latencyMs: Date.now() - started }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      code: error?.code ?? 'error',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
