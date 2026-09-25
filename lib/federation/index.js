/**
 * Federation half: the remote-session panel's host side.
 *
 * Sits beside the existing `instance-switcher` surface in the same plugin and
 * shares its style, its atomic-store idiom, and nothing else. Everything here
 * is read-only against the remote (§6 red line): `session/list` and the first
 * frame of `workspace/follow`, no more.
 *
 * Routes are registered as **bare** routes on the web server, which means the
 * harness's own `/api` authentication never runs for them. Every one of them
 * therefore self-fences on {@link isLoopbackRequest} — reads included, because
 * a peer record holds SSH credentials and a launch token. The list response
 * additionally never carries a secret value out.
 *
 * @module dsh-remote-switch/federation
 */

import path from 'node:path'

import { readPeersFile } from '../peers.js'
import { entryUrl } from '../peers.js'
import {
  isCrossSiteRequest,
  isLoopbackRequest,
  readJson,
  sendJson,
  text,
} from '../http.js'
import { AuthStore } from './auth.js'
import { probePeer, readPeer, verifyToken } from './client.js'
import { PeerProvisioner, parseLaunchUrl } from './provisioner.js'
import { SshTransport } from './ssh.js'
import {
  browserOriginOf,
  buildPeer,
  defaultFederationFile,
  readFederationFile,
  writeFederationFile,
} from './store.js'

/** Route family prefix for the federation surface. */
export const FEDERATION_BASE = '/api/federation'

/** Default poll interval while the panel is visible. */
const DEFAULT_POLL_INTERVAL_MS = 15000

/** Bounds on the configurable poll interval. */
const MIN_POLL_INTERVAL_MS = 3000
const MAX_POLL_INTERVAL_MS = 300000

/**
 * Hold a requested poll interval inside its bounds.
 *
 * One clamp for both entry points on purpose: the configured interval and the
 * one the panel sends come from different places, and if only one of them were
 * clamped the tightest bound would depend on who asked last.
 * @param {number} value - the requested interval in milliseconds.
 * @returns {number} the clamped interval.
 */
function clampInterval(value) {
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, value))
}

/**
 * The same origin, on a different port.
 *
 * `read-token` learns the port from the remote's own launch line, which can
 * differ from the stored one (a remote that came up on `--port 0`, or one whose
 * port was changed). Validating against the stored port would then fail and look
 * like a dead token.
 * @param {string} origin - the stored origin, e.g. `http://127.0.0.1:3080`.
 * @param {number} port - the port the launch line named.
 * @returns {string} the origin with that port.
 */
function originWithPort(origin, port) {
  try {
    const url = new URL(origin)
    url.port = String(port)
    return url.origin
  } catch {
    return origin
  }
}

/** Consecutive failures before the poller starts backing off. */
const BACKOFF_AFTER_FAILURES = 2

/** Largest backoff multiplier applied to the poll interval. */
const MAX_BACKOFF_FACTOR = 8

/**
 * Strip every secret out of one peer row for transport to the browser.
 *
 * The token is the remote's launch credential and the password is the SSH
 * account's; both are replaced by presence flags. The private-key *path* is
 * kept because the settings card must be able to show and edit it, and a path
 * on this machine is not the key itself.
 *
 * `jumpUrl` is built here rather than in the browser for one reason: the
 * credential that makes a jump work never leaves this process as readable data.
 * The browser receives a ready URL and cannot read the secret out of it any more
 * than it could read any other URL it is handed. Two credentials can become that
 * URL, in order of preference:
 *
 *   1. the paired-device credential, whose `/pair-app?device=…` landing page is
 *      cookieless (and survives the remote reprinting its token);
 *   2. failing that, the peer's own token, as `/?token=…` — which is DSH's own
 *      browser-login flow, the exact URL the remote prints at startup.
 *
 * A peer with neither gets `openOrigin` instead: the address is still shown and
 * selectable, but no button pretends it will authenticate.
 *
 * @param {object} peer - the stored row.
 * @param {(origin: string) => string | undefined} deviceCredentialOf - lookup for the paired-device credential.
 * @returns {object} the redacted view.
 */
export function redactPeer(peer, deviceCredentialOf) {
  const view = {
    id: peer.id,
    label: peer.label,
    channel: peer.channel,
    origin: peer.origin,
    auth: { kind: peer.auth?.kind ?? 'none', hasToken: typeof peer.auth?.token === 'string' },
    createdAt: peer.createdAt,
  }
  if (peer.lastUsedAt !== undefined) view.lastUsedAt = peer.lastUsedAt
  if (peer.lastProbe !== undefined) view.lastProbe = peer.lastProbe
  if (peer.ssh !== undefined) {
    view.ssh = {
      host: peer.ssh.host,
      user: peer.ssh.user,
      port: peer.ssh.port,
      remotePort: peer.ssh.remotePort,
      hasPassword: typeof peer.ssh.password === 'string',
    }
    if (peer.ssh.privateKeyPath !== undefined) view.ssh.privateKeyPath = peer.ssh.privateKeyPath
  }
  if (peer.remoteHome !== undefined) view.remoteHome = peer.remoteHome
  // An SSH peer's `origin` is loopback *on the far machine*, so it is not a
  // browser target. Only an explicit webOrigin (or a direct-http peer's own
  // origin) can be opened — and only when there is a credential to open it with.
  const browserOrigin = browserOriginOf(peer)
  if (browserOrigin !== undefined) {
    const credential = deviceCredentialOf(browserOrigin)
    if (credential !== undefined) {
      // Pairing wins where it exists: its landing page is cookieless and does not
      // go stale when the remote restarts with a freshly printed token.
      view.jumpUrl = entryUrl(browserOrigin, credential)
    } else if (typeof peer.auth?.token === 'string' && peer.auth.token !== '') {
      // No pairing, but this peer holds the instance's own token — and the token
      // URL *is* DSH's browser-login flow: the remote prints exactly
      // `http://host:port/?token=…` at startup for a human to open. Without this
      // branch a token-only peer (any machine this one has never paired) was
      // offered an "open remote" that could only ever land on a login wall,
      // which made the freshly captured token look unused.
      //
      // Still built here rather than in the browser, so the response carries a
      // ready URL and never a readable token field — the same contract the
      // device-credential jump above already relies on.
      view.jumpUrl = `${browserOrigin}/?token=${encodeURIComponent(peer.auth.token)}`
    } else {
      view.openOrigin = browserOrigin
    }
  }
  return view
}

/**
 * Register the federation host surface and its single poller.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context (needs `webServer`).
 * @param {{
 *   federationFile?: string,
 *   knownHostsFile?: string,
 *   cacheFile?: string,
 *   peersFile?: string,
 *   hostKeyPolicy?: string,
 *   pollIntervalMs?: number,
 *   requestTimeoutMs?: number,
 *   listLimit?: number,
 *   remoteHome?: string,
 *   provisionReadyTimeoutMs?: number,
 *   staticFallback?: boolean,
 *   staticScanLimit?: number,
 * }} config - resolved configuration.
 * @returns {() => void} a disposer removing the routes and stopping the poller.
 */
export function applyFederation(ctx, config) {
  const home = config.home
  const federationFile = config.federationFile ?? defaultFederationFile(home)
  const knownHostsFile = config.knownHostsFile ?? path.join(home, 'federation', 'known_hosts.json')
  const cacheFile = config.cacheFile ?? path.join(home, 'federation', 'credentials.json')
  const devicePeersFile = config.peersFile ?? path.join(home, 'instance-switcher', 'peers.json')
  const timeoutMs = config.requestTimeoutMs ?? 12000
  const listLimit = config.listLimit ?? 100
  const pollIntervalMs = clampInterval(
    typeof config.pollIntervalMs === 'number' ? config.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS,
  )

  const transport = new SshTransport({
    hostKeyPolicy: config.hostKeyPolicy ?? 'accept-new',
    knownHostsFile,
    logger: { warn: message => ctx.logger?.warn?.(message) },
  })

  const provisioner = new PeerProvisioner({
    transport,
    timeoutMs,
    readyTimeoutMs: config.provisionReadyTimeoutMs,
    logger: { warn: message => ctx.logger?.warn?.(message) },
  })

  /**
   * The paired-device credential this same plugin already stores for one
   * origin — the exact value `instance-switcher` switches with. Reusing it is
   * what lets a peer with no launch token still be reached, and it is also what
   * makes the jump URL cookieless.
   * @param {string} origin - the origin to look up.
   * @returns {string | undefined} the credential, or undefined when unpaired.
   */
  const deviceCredentialOf = (origin) => {
    for (const peer of readPeersFile(devicePeersFile).peers) {
      if (peer.origin === origin && typeof peer.credential === 'string') return peer.credential
    }
    return undefined
  }

  // The credentials service is optional: without it the cache file is the only
  // store, and everything still works.
  let credentials
  try {
    credentials = ctx.get('credentials')
  } catch {
    credentials = undefined
  }

  const auth = new AuthStore({
    credentials: typeof credentials?.readRecord === 'function' ? credentials : undefined,
    cacheFile,
    deviceCredentialOf,
    logger: { warn: message => ctx.logger?.warn?.(message) },
  })

  /** @returns {object[]} the persisted peers. */
  const load = () => readFederationFile(federationFile).peers

  /**
   * Persist the peer list, answering the request when the write fails.
   *
   * A store write is a real I/O operation (ENOSPC, a read-only `$DSH_HOME`, an
   * indexer holding the temp file) and this route is reached from the panel, so
   * a failure has to become a message the user can act on rather than a throw
   * that travels up through the route.
   * @param {object[]} next - the rows to write.
   * @param {import('node:http').ServerResponse} res - the response to answer on failure.
   * @returns {boolean} true when the write succeeded.
   */
  const persist = (next, res) => {
    try {
      writeFederationFile(federationFile, next)
      return true
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: 'store-write-failed',
        hint: `无法写入 ${federationFile}：${error instanceof Error ? error.message : String(error)}`,
      })
      return false
    }
  }

  /**
   * Snapshot cache, one entry per peer.
   * @type {Map<string, { status: string, snapshot?: object, error?: object, fetchedAt: number, failures: number }>}
   */
  const snapshots = new Map()

  /** The single poller: only the current peer is ever polled (§6 rule 8). */
  const poller = {
    peerId: undefined,
    visible: false,
    intervalMs: pollIntervalMs,
    timer: undefined,
    failures: 0,
    inflight: undefined,
  }

  /**
   * Whether a peer is still in the store.
   *
   * A read can take seconds, and the peer may be deleted or re-created while it
   * runs. Without this check the completing read would re-insert an entry for a
   * peer that no longer exists (a permanent map leak) or stamp a freshly-edited
   * peer with data fetched using the *old* credentials.
   * @param {string} id - the peer id.
   * @returns {boolean} true when the peer is still stored.
   */
  const peerExists = id => load().some(candidate => candidate.id === id)

  /**
   * Read one peer and record the outcome in the snapshot cache.
   * @param {object} peer - the peer row.
   * @returns {Promise<object>} the snapshot entry.
   */
  const fetchSnapshot = async (peer) => {
    try {
      const snapshot = await readPeer(peer, {
        transport,
        auth,
        timeoutMs,
        limit: listLimit,
        // The peer's own DSH_HOME wins: it is the only value that is right for
        // a machine whose home differs from the default.
        remoteHome: peer.remoteHome ?? text(config.remoteHome) ?? '~/.dsh',
        staticFallback: config.staticFallback !== false,
        staticScanLimit: config.staticScanLimit,
        logger: { warn: message => ctx.logger?.warn?.(message) },
      })
      const entry = { status: 'ok', snapshot, fetchedAt: snapshot.fetchedAt, failures: 0 }
      if (peerExists(peer.id)) snapshots.set(peer.id, entry)
      return entry
    } catch (error) {
      const previous = snapshots.get(peer.id)
      const entry = {
        status: 'error',
        error: {
          code: error?.code ?? 'error',
          message: error instanceof Error ? error.message : String(error),
          details: error?.details,
        },
        snapshot: previous?.snapshot,
        fetchedAt: Date.now(),
        failures: (previous?.failures ?? 0) + 1,
      }
      if (peerExists(peer.id)) snapshots.set(peer.id, entry)
      return entry
    }
  }

  /**
   * Read one peer, sharing an in-flight request with any concurrent caller.
   * @param {object} peer - the peer row.
   * @returns {Promise<object>} the snapshot entry.
   */
  const readOnce = (peer) => {
    const shared = poller.inflight?.get(peer.id)
    if (shared !== undefined) return shared
    if (poller.inflight === undefined) poller.inflight = new Map()
    const promise = fetchSnapshot(peer).finally(() => {
      poller.inflight?.delete(peer.id)
    })
    poller.inflight.set(peer.id, promise)
    return promise
  }

  /**
   * The peer's snapshot, refreshed only when it has gone stale.
   *
   * Both the panel's poll and the background timer go through here, and the
   * in-flight map makes a collision between them free: two callers asking at
   * the same moment produce exactly one remote call. That is what keeps the
   * poller a genuine singleton without the browser having to know about it.
   * @param {object} peer - the peer row.
   * @param {number} maxAgeMs - how old a snapshot may be before a refresh.
   * @returns {Promise<object>} the snapshot entry.
   */
  const ensureFresh = (peer, maxAgeMs) => {
    const cached = snapshots.get(peer.id)
    if (cached !== undefined && Date.now() - cached.fetchedAt < maxAgeMs) return Promise.resolve(cached)
    return readOnce(peer)
  }

  /** Stop the poll timer without forgetting which peer is current. */
  const stopTimer = () => {
    if (poller.timer !== undefined) {
      clearTimeout(poller.timer)
      poller.timer = undefined
    }
  }

  /**
   * Arm the next poll, backing off while the peer keeps failing.
   *
   * A timeout rather than an interval on purpose: a slow remote must not have
   * requests pile up behind it, and the delay is recomputed after every attempt.
   * @returns {void}
   */
  const scheduleNext = () => {
    stopTimer()
    if (!poller.visible || poller.peerId === undefined) return
    const factor = poller.failures >= BACKOFF_AFTER_FAILURES
      ? Math.min(MAX_BACKOFF_FACTOR, 2 ** (poller.failures - BACKOFF_AFTER_FAILURES + 1))
      : 1
    const delay = Math.min(MAX_POLL_INTERVAL_MS, poller.intervalMs * factor)
    poller.timer = setTimeout(() => {
      poller.timer = undefined
      void tick()
    }, delay)
    // Never hold the process open on account of a poll.
    poller.timer.unref?.()
  }

  /**
   * One poll attempt for the current peer.
   * @returns {Promise<object | undefined>} the resulting snapshot entry, when one was taken.
   */
  const tick = async () => {
    const peerId = poller.peerId
    if (!poller.visible || peerId === undefined) return undefined
    const peer = load().find(candidate => candidate.id === peerId)
    if (peer === undefined) {
      poller.peerId = undefined
      stopTimer()
      return undefined
    }
    const entry = await readOnce(peer)
    poller.failures = entry.status === 'ok' ? 0 : (poller.failures + 1)
    scheduleNext()
    return entry
  }

  /**
   * Point the single poller at one peer, or stop it.
   *
   * Switching peers clears the failure count and fetches at once, so the panel
   * never shows the previous machine's rows while waiting a full interval.
   * @param {{ peerId?: string, visible?: boolean, intervalMs?: number }} next - the requested state.
   * @returns {Promise<object | undefined>} the entry from an immediate fetch, when one ran.
   */
  const steerPoller = async (next) => {
    const switched = next.peerId !== undefined && next.peerId !== poller.peerId
    if (next.peerId !== undefined) poller.peerId = next.peerId
    if (next.visible !== undefined) poller.visible = next.visible
    if (next.intervalMs !== undefined) {
      poller.intervalMs = clampInterval(next.intervalMs)
    }
    if (switched) poller.failures = 0
    if (!poller.visible) {
      stopTimer()
      return undefined
    }
    if (switched || poller.timer === undefined) return tick()
    scheduleNext()
    return undefined
  }

  /**
   * The frame the browser half renders.
   * @returns {{ ok: true, peers: object[], poll: object, snapshots: object[] }} the state.
   */
  const state = () => {
    const peers = load()
    return {
      ok: true,
      peers: peers.map(peer => redactPeer(peer, deviceCredentialOf)),
      poll: {
        peerId: poller.peerId,
        visible: poller.visible,
        intervalMs: poller.intervalMs,
        failures: poller.failures,
        // `inflight` is a lazily-created Map, so its mere presence says nothing;
        // only a non-empty map means a read is actually running.
        running: poller.timer !== undefined || (poller.inflight?.size ?? 0) > 0,
      },
      snapshots: peers.map((peer) => {
        const entry = snapshots.get(peer.id)
        if (entry === undefined) return { peerId: peer.id, status: 'idle', fetchedAt: 0 }
        return {
          peerId: peer.id,
          status: entry.status,
          fetchedAt: entry.fetchedAt,
          failures: entry.failures,
          ...(entry.error === undefined ? {} : { error: entry.error }),
          ...(entry.snapshot === undefined ? {} : { snapshot: entry.snapshot }),
        }
      }),
    }
  }

  /**
   * One request gate: this surface is local-only, reads included.
   *
   * A peer record holds SSH credentials and a remote launch token, and unlike
   * the instance-switcher list there is no paired-device story that would make
   * a LAN caller legitimate here.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {boolean} true when the caller may proceed.
   */
  const gate = (req, res) => {
    // Deliberately NO `applyCors` here. The panel is same-origin with the server
    // that serves it, so it needs no cross-origin grant — and reflecting an
    // arbitrary Origin on a surface that carries SSH credentials and a launch
    // token is exactly how a random page the user visits would get to read them
    // (its fetch to 127.0.0.1 satisfies the loopback socket+Host fence).
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return false
    }
    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, {
        ok: false,
        error: 'loopback-only',
        hint: '远端会话面板只在本机（127.0.0.1）页面上可用：这台机器的凭据不下发到局域网或隧道页面',
      })
      return false
    }
    // The fence above cannot distinguish this plugin's own page from any other
    // page in the same browser; the browser's own site label can.
    if (isCrossSiteRequest(req)) {
      sendJson(res, 403, {
        ok: false,
        error: 'cross-site',
        hint: '这个请求来自另一个站点。远端会话面板的接口只接受本页面自己发出的请求',
      })
      return false
    }
    return true
  }

  /**
   * GET/POST `/peers` — read the redacted list, or mutate it.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>}
   */
  const handlePeers = async (req, res) => {
    if (!gate(req, res)) return
    if (req.method === 'GET' || req.method === 'HEAD') {
      sendJson(res, 200, state())
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const body = await readJson(req)
    if (body === undefined) {
      sendJson(res, 400, { ok: false, error: 'invalid-json' })
      return
    }
    const action = text(body.action)
    const peers = load()

    if (action === 'save') {
      const id = text(body.id)
      const built = buildPeer(peers, body, id)
      if ('error' in built) {
        sendJson(res, 400, { ok: false, error: built.error, hint: built.hint })
        return
      }
      const at = peers.findIndex(peer => peer.id === built.row.id)
      const previous = at >= 0 ? peers[at] : undefined
      // A changed credential must invalidate the cached session cookie. The
      // cache is keyed by peer, not by credential, so without this a corrected
      // token would be stored and then ignored in favour of the stale cookie —
      // the user would paste a fresh token and keep seeing the old 401.
      const credentialChanged = previous !== undefined && (
        (previous.auth?.kind ?? 'none') !== built.row.auth.kind ||
        previous.auth?.token !== built.row.auth.token ||
        previous.ssh?.password !== built.row.ssh?.password
      )
      if (at >= 0) peers[at] = { ...previous, ...built.row }
      else peers.push(built.row)
      if (!persist(peers, res)) return
      // The connection and provisioning caches are keyed by peer id but describe
      // a machine, so an edit that moves the peer must not leave them behind:
      // the next read would still come from the old host.
      const reachChanged = previous !== undefined && (
        previous.channel !== built.row.channel ||
        previous.origin !== built.row.origin ||
        previous.webOrigin !== built.row.webOrigin ||
        previous.ssh?.host !== built.row.ssh?.host ||
        previous.ssh?.user !== built.row.ssh?.user ||
        previous.ssh?.port !== built.row.ssh?.port ||
        previous.ssh?.remotePort !== built.row.ssh?.remotePort ||
        previous.ssh?.privateKeyPath !== built.row.ssh?.privateKeyPath
      )
      if (reachChanged) {
        transport.close(built.row.id)
        provisioner.forget(built.row.id)
      }
      if (credentialChanged) await auth.forget(built.row.id)
      snapshots.delete(built.row.id)
      sendJson(res, 200, { ...state(), saved: built.row.id, replaced: at >= 0, credentialChanged })
      return
    }

    if (action === 'remove') {
      const id = text(body.id)
      if (id === undefined) {
        sendJson(res, 400, { ok: false, error: 'invalid-id' })
        return
      }
      const next = peers.filter(peer => peer.id !== id)
      if (!persist(next, res)) return
      snapshots.delete(id)
      await auth.forget(id)
      transport.close(id)
      provisioner.forget(id)
      if (poller.peerId === id) {
        poller.peerId = undefined
        stopTimer()
      }
      sendJson(res, 200, { ...state(), removed: next.length !== peers.length })
      return
    }

    if (action === 'forget-credential') {
      const id = text(body.id)
      const peer = peers.find(candidate => candidate.id === id)
      if (peer === undefined) {
        sendJson(res, 404, { ok: false, error: 'not-found' })
        return
      }
      await auth.forget(peer.id)
      // Unlike save/remove this path used to keep the snapshot, so the panel went
      // on showing the previous list (or the previous 401) as if it were fresh
      // for up to one poll interval after the credential was cleared.
      snapshots.delete(peer.id)
      sendJson(res, 200, state())
      return
    }

    if (action === 'touch') {
      const id = text(body.id)
      const at = peers.findIndex(peer => peer.id === id)
      if (at < 0) {
        sendJson(res, 404, { ok: false, error: 'not-found' })
        return
      }
      peers[at] = { ...peers[at], lastUsedAt: Date.now() }
      if (!persist(peers, res)) return
      sendJson(res, 200, state())
      return
    }

    sendJson(res, 400, { ok: false, error: 'unknown-action' })
  }

  /**
   * POST `/sessions` — the current peer's cached list, or a forced refresh.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>}
   */
  const handleSessions = async (req, res) => {
    if (!gate(req, res)) return
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const body = req.method === 'POST' ? await readJson(req) : undefined
    if (req.method === 'POST' && body === undefined) {
      sendJson(res, 400, { ok: false, error: 'invalid-json' })
      return
    }
    const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
    // Nothing is current yet on a freshly booted host, and answering "no peer"
    // left the panel permanently empty — no count, a disabled refresh, and rows
    // that could not be opened. The first saved machine is the only sensible
    // default, and the panel adopts it from the reply.
    const peerId = text(body?.peerId) ?? text(query.get('peer')) ?? poller.peerId ?? load()[0]?.id
    if (peerId === undefined) {
      sendJson(res, 200, { ...state(), peerId: undefined, snapshot: undefined, status: 'idle' })
      return
    }
    const peer = load().find(candidate => candidate.id === peerId)
    if (peer === undefined) {
      sendJson(res, 404, { ok: false, error: 'not-found', hint: '没有这个 peer' })
      return
    }
    const force = body?.force === true || query.get('force') === '1'
    const visible = typeof body?.visible === 'boolean' ? body.visible : undefined
    const intervalMs = typeof body?.intervalMs === 'number' ? body.intervalMs : undefined
    await steerPoller({
      peerId,
      ...(visible === undefined ? {} : { visible }),
      ...(intervalMs === undefined ? {} : { intervalMs }),
    })
    // The host owns the cadence, not the browser: `ensureFresh` answers from
    // cache while the snapshot is younger than one interval, so the panel may
    // ask as often as it likes — including twice in a row — and the remote
    // still sees exactly one call per interval per peer.
    const entry = force ? await readOnce(peer) : await ensureFresh(peer, poller.intervalMs)
    sendJson(res, 200, {
      ...state(),
      peerId: peer.id,
      snapshot: entry.snapshot,
      status: entry.status,
      ...(entry.error === undefined ? {} : { error: entry.error }),
      refreshed: force,
    })
  }

  /**
   * POST `/poll` — tell the poller whether the panel is on screen.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>}
   */
  const handlePoll = async (req, res) => {
    if (!gate(req, res)) return
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const body = await readJson(req)
    if (body === undefined) {
      sendJson(res, 400, { ok: false, error: 'invalid-json' })
      return
    }
    await steerPoller({
      ...(text(body.peerId) === undefined ? {} : { peerId: text(body.peerId) }),
      ...(typeof body.visible === 'boolean' ? { visible: body.visible } : {}),
      ...(typeof body.intervalMs === 'number' ? { intervalMs: body.intervalMs } : {}),
    })
    sendJson(res, 200, state())
  }

  /**
   * POST `/test` — probe one peer's reachability and credential liveness.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>}
   */
  const handleTest = async (req, res) => {
    if (!gate(req, res)) return
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const body = await readJson(req)
    if (body === undefined) {
      sendJson(res, 400, { ok: false, error: 'invalid-json' })
      return
    }
    const id = text(body.id)
    const peers = load()
    const peer = peers.find(candidate => candidate.id === id)
    if (peer === undefined) {
      sendJson(res, 404, { ok: false, error: 'not-found' })
      return
    }
    // Live path only: "test connection" exists to answer whether the instance is
    // reachable. Letting the SFTP disk fallback answer it would report success
    // for a machine whose `dsh web` is down (and never exercise the token).
    const outcome = await probePeer(peer, { transport, auth, timeoutMs, staticFallback: false })
    // Re-read and re-find: the probe can take seconds, and writing back the array
    // loaded before it would silently revert a concurrent edit and resurrect a
    // peer that was deleted meanwhile.
    const fresh = load()
    const at = fresh.findIndex(candidate => candidate.id === peer.id)
    if (at >= 0) {
      fresh[at] = {
        ...fresh[at],
        lastProbe: { at: Date.now(), ...outcome, ...(outcome.detail === undefined ? {} : { detail: outcome.detail.slice(0, 300) }) },
      }
      try {
        writeFederationFile(federationFile, fresh)
      } catch {
        /* the probe result is not worth failing the request over */
      }
    }
    sendJson(res, 200, { ...state(), probe: { id: peer.id, ...outcome } })
  }

  /**
   * Apply one edit to the *current* peer list and persist it.
   *
   * Provisioning waits on the remote for seconds to tens of seconds, so a row
   * captured before the await may already have been edited or deleted from
   * another tab. Re-reading and re-finding by id is what keeps a slow start from
   * reverting someone else's save (or resurrecting a deleted peer, complete with
   * the SSH password it was deleted to remove).
   * @param {string} id - the peer to update.
   * @param {(peer: object) => object} edit - produces the replacement row.
   * @returns {boolean} true when the peer still existed and the write succeeded.
   */
  const updatePeer = (id, edit) => {
    const fresh = load()
    const at = fresh.findIndex(candidate => candidate.id === id)
    if (at < 0) return false
    fresh[at] = edit(fresh[at])
    try {
      writeFederationFile(federationFile, fresh)
      return true
    } catch {
      /* provisioning already succeeded; a failed bookkeeping write is not fatal */
      return false
    }
  }

  /**
   * Hide a launch token inside a log tail before it leaves this process.
   *
   * The remote's log is where `dsh web` prints its token exactly once, and the
   * log tail is genuinely the most useful diagnostic we have (the plugin shows
   * it on a failed start). Both are true at once, so the tail is shipped with
   * the token masked rather than withheld: a token in the browser is full
   * control of that instance, and the design puts it in the same class as the
   * SSH password.
   * @param {unknown} value - a log tail, or anything else.
   * @returns {unknown} the same value with `token=` values masked.
   */
  const maskToken = value => typeof value === 'string'
    ? value.replace(/([?&]token=)[^\s&"'`)]+/gu, '$1***')
    : value

  /**
   * The subset of a provisioner result that may be sent to the browser.
   *
   * An allow-list rather than a spread: `start()` also returns the captured
   * launch token, and a spread would hand the whole secret to the page.
   * @param {object} result - the provisioner's return value.
   * @returns {object} the redacted fields the panel actually reads.
   */
  const publicResult = result => {
    const keep = ['started', 'alreadyRunning', 'stopped', 'found', 'by', 'port', 'pid', 'logFile', 'listening', 'unknown', 'evidence', 'credential', 'webOrigin']
    const out = {}
    for (const key of keep) {
      if (result?.[key] !== undefined) out[key] = result[key]
    }
    // `detail` is the human-readable explanation and is genuinely useful, but it
    // is free text derived from remote output, so it goes through the mask too.
    if (result?.detail !== undefined) out.detail = maskToken(result.detail)
    return out
  }

  /**
   * POST `/provision` — start or stop the remote's own `dsh web` over SSH.
   *
   * Starting captures the printed token and stores it on the peer, so the panel
   * works immediately afterwards with nothing to copy.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>}
   */
  const handleProvision = async (req, res) => {
    if (!gate(req, res)) return
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const body = await readJson(req)
    if (body === undefined) {
      sendJson(res, 400, { ok: false, error: 'invalid-json' })
      return
    }
    const action = text(body.action)
    const id = text(body.id)
    const peers = load()
    const at = peers.findIndex(peer => peer.id === id)
    const peer = at >= 0 ? peers[at] : undefined
    if (peer === undefined) {
      sendJson(res, 404, { ok: false, error: 'not-found' })
      return
    }
    if (peer.channel !== 'ssh') {
      sendJson(res, 400, {
        ok: false,
        error: 'not-ssh',
        hint: '拉起/关闭需要 SSH 通道：HTTP 直连的 peer 没法在本机替它启停进程',
      })
      return
    }
    const remoteHome = text(body.remoteHome) ?? peer.remoteHome ?? text(config.remoteHome) ?? '~/.dsh'
    try {
      if (action === 'start') {
        const result = await provisioner.start(peer, {
          remoteHome,
          ...(text(body.remoteDsh) === undefined ? {} : { remoteDsh: text(body.remoteDsh) }),
          ...(text(body.remoteDir) === undefined ? {} : { remoteDir: text(body.remoteDir) }),
          ...(typeof body.port === 'number' ? { port: body.port } : {}),
          force: body.force === true,
        })
        // A fresh start hands us the token that makes this peer usable; store it
        // so the user does not have to go and copy it.
        let credentialChanged = false
        let credential = result.credential ?? 'token'
        if (result.started && typeof result.token === 'string' && result.token !== '') {
          updatePeer(peer.id, current => ({
            ...current,
            ssh: { ...current.ssh, remotePort: result.port },
            auth: { kind: 'token', token: result.token },
          }))
          credentialChanged = true
          await auth.forget(peer.id)
          snapshots.delete(peer.id)
        } else if (result.started) {
          // No token. Either the machine runs dsh-remote-web-ui (pairing-gated, so
          // a token does not exist there) or the log simply did not say. Both
          // cases still tell us something worth keeping:
          //
          //  - the origin that plugin reported is a browser-reachable address, so
          //    it is written back as the peer's jump address instead of asking the
          //    user to type it;
          //  - if this machine is already paired (the instance-switcher store),
          //    the credential kind is switched to `device` automatically, which is
          //    what makes "start" leave the peer immediately usable.
          const learned = typeof result.webOrigin === 'string' && result.webOrigin !== ''
            ? result.webOrigin.replace(/\/+$/u, '')
            : undefined
          const paired = learned !== undefined && deviceCredentialOf(learned) !== undefined
          const nextAuth = paired ? { kind: 'device' } : peer.auth
          if (paired) credential = 'device'
          if (learned !== undefined || paired) {
            updatePeer(peer.id, current => ({
              ...current,
              ssh: { ...current.ssh, remotePort: result.port },
              ...(learned === undefined ? {} : { webOrigin: learned }),
              auth: nextAuth,
            }))
            const switched = paired && peer.auth?.kind !== 'device'
            credentialChanged = switched
            if (switched) {
              await auth.forget(peer.id)
              snapshots.delete(peer.id)
            }
          }
        }
        sendJson(res, 200, {
          ...state(),
          provision: {
            id: peer.id,
            action,
            ...publicResult(result),
            credential,
            credentialChanged,
            // Say what the user has to do next, rather than leaving a token-less
            // start looking half-done.
            ...(result.started && credential === 'token' ? {} : {
              credentialHint: credential === 'device'
                ? '已启动，并已改用 device 配对凭据（这台机器没有启动 token）'
                : '已启动，但没有拿到启动 token：这台机器可能需要 device 配对凭据，请先在「实例」面板配对同一地址，或手动填 token',
            }),
          },
        })
        return
      }
      if (action === 'stop') {
        // No pid is passed in: the provisioner reads the one recorded on the
        // remote when it started the instance. Accepting a caller-supplied pid
        // would only ever be a value this host cannot know.
        const result = await provisioner.stop(peer, { remoteHome })
        snapshots.delete(peer.id)
        sendJson(res, 200, { ...state(), provision: { id: peer.id, action, ...publicResult(result) } })
        return
      }
      if (action === 'status') {
        const status = await provisioner.status(peer)
        // The log tail is deliberately NOT sent: the panel does not render it on
        // this path, and it is the file that holds the launch token.
        sendJson(res, 200, { ...state(), provision: { id: peer.id, action, ...status } })
        return
      }
      if (action === 'read-token') {
        // A remote that is already running prints nothing new, so this reads the
        // tail of the log it was started with — the recovery path for "it is
        // running but I never saved the token".
        const log = await provisioner.tailLog(peer, remoteHome, 200)
        const launch = parseLaunchUrl(log)
        if (launch === undefined) {
          sendJson(res, 200, {
            ...state(),
            provision: {
              id: peer.id,
              action,
              found: false,
              detail: '日志里没有启动 URL：那台实例可能不是本插件拉起的（日志不在这里），或日志已被清空',
            },
          })
          return
        }
        // A token in the log is NOT proof of a usable token: the log is written
        // only when THIS plugin starts the instance and cleared only at that
        // moment, so an instance started by hand (or after a reboot) leaves the
        // previous boot's token sitting there. Storing that would replace one
        // dead credential with another and report success — measured, this is
        // exactly how "the token never updates" presents. So the candidate has
        // to authenticate before it is kept.
        //
        // Redeemed against the port the log names, not the stored one: the log is
        // what tells us which port this boot came up on, and the success path
        // below stores that same port.
        const candidate = launch.port === undefined ? peer : {
          ...peer,
          ssh: { ...peer.ssh, remotePort: launch.port },
          origin: originWithPort(peer.origin, launch.port),
        }
        const verdict = await verifyToken(candidate, launch.token, { transport, auth, timeoutMs })
        if (!verdict.ok) {
          snapshots.delete(peer.id)
          // Only a credential verdict means the token is dead. A connectivity
          // failure means we could not ask — that is a different answer, and
          // saying "the token was rejected" for it would be a lie of exactly the
          // kind this branch exists to remove.
          const rejected = ['token-rejected', 'no-cookie', 'unauthorized', 'forbidden'].includes(verdict.code)
          sendJson(res, 200, {
            ...state(),
            provision: {
              id: peer.id,
              action,
              found: false,
              code: rejected ? 'token-stale' : verdict.code,
              detail: rejected
                ? `日志里的 token 已被远端拒绝（${verdict.detail}）——这份日志是更早一次启动留下的：远端每次启动都会换 token，本插件的日志只有在它自己拉起时才更新。请用「重启并重新捕获 token」，或先「关闭远程实例」再「拉起远程实例」`
                : `没法验证日志里的 token（${verdict.detail}）——没验证过就不存，免得再把一个用不了的凭据写进去`,
            },
          })
          return
        }
        updatePeer(peer.id, current => ({
          ...current,
          ssh: { ...current.ssh, ...(launch.port === undefined ? {} : { remotePort: launch.port }) },
          auth: { kind: 'token', token: launch.token },
        }))
        // No `auth.forget` here: `verifyToken` has just minted and cached this
        // token's cookie, so forgetting would throw away the working one.
        snapshots.delete(peer.id)
        sendJson(res, 200, { ...state(), provision: { id: peer.id, action, found: true, credentialChanged: true } })
        return
      }
      sendJson(res, 400, { ok: false, error: 'unknown-action', hint: 'action 只能是 start / stop / status / read-token' })
    } catch (error) {
      sendJson(res, 200, {
        ...state(),
        provision: {
          id: peer.id,
          action,
          ok: false,
          code: error?.code ?? 'provision-failed',
          detail: error instanceof Error ? error.message : String(error),
          ...(error?.details === undefined ? {} : { details: { ...error.details, log: maskToken(error.details.log) } }),
        },
      })
    }
  }

  /**
   * Wrap one async route handler so its rejection cannot escape.
   *
   * The web server awaits whatever the handler returns and logs a rejection — so
   * a handler MUST return its promise. Returning `undefined` (the shape a bare
   * `void handle()` produces) settles the server's await immediately and leaves
   * the real rejection unobserved, which this host answers with a process-level
   * `unhandledRejection` → `exit(1)`: one aborted request would take the whole
   * DSH instance down. Wrapping also turns a genuine failure into a 500 the user
   * can see, instead of a request that never answers.
   * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler - the handler.
   * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} the guarded handler.
   */
  const guard = handler => async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      ctx.logger?.warn?.(`federation: ${req.method ?? '?'} ${req.url ?? '?'} failed: ${error instanceof Error ? error.message : String(error)}`)
      try {
        if (res.headersSent) res.destroy()
        else sendJson(res, 500, { ok: false, error: error?.code ?? 'internal' })
      } catch {
        /* the socket is already gone; nothing left to answer */
      }
    }
  }

  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: `${FEDERATION_BASE}/peers`,
      handler: guard(handlePeers),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${FEDERATION_BASE}/sessions`,
      handler: guard(handleSessions),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${FEDERATION_BASE}/poll`,
      handler: guard(handlePoll),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${FEDERATION_BASE}/test`,
      handler: guard(handleTest),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${FEDERATION_BASE}/provision`,
      handler: guard(handleProvision),
    }),
  ]

  return () => {
    stopTimer()
    transport.close()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* a route may already be gone during teardown */
      }
    }
  }
}
