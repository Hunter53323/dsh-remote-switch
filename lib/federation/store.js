/**
 * Peer registry for the federation half.
 *
 * Deliberately a *separate* file from `instance-switcher/peers.json`: that one
 * stores a `dsh_pair` device credential per origin, which is a full-control
 * credential for the remote-access channel. A federation peer is a different
 * record — it describes *how to reach* a machine (an SSH hop, a direct origin)
 * and *which credential kind* to redeem there. Linking the two by origin keeps
 * one credential from being silently reinterpreted as the other.
 *
 * Storage shape (JSON, 0600, atomic replace):
 *   { "version": 1, "peers": [ {
 *       id, label, channel: 'ssh' | 'http',
 *       origin,                     // http channel: the base origin to talk to
 *       ssh?: { host, port?, user, privateKeyPath? | password?, remotePort } ,
 *       auth: { kind: 'token' | 'device' | 'none', token? },
 *       createdAt, lastUsedAt?, lastProbe?
 *   } ] }
 *
 * @module dsh-remote-switch/federation/store
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { normalizeOrigin } from '../peers.js'
import { isRecord } from './wire.js'

/** Current store schema version. */
export const FEDERATION_FILE_VERSION = 1

/** How a peer may be reached. */
export const CHANNELS = ['ssh', 'http']

/** How the peer authenticates a Remote call. */
export const AUTH_KINDS = ['token', 'device', 'none']

/** Mint a fresh peer id. @returns {string} */
export function mintFederationPeerId() {
  return `f-${randomBytes(6).toString('hex')}`
}

/**
 * Sanitize one SSH hop description.
 * @param {unknown} value - the raw `ssh` object.
 * @returns {object | undefined} the usable hop, or undefined.
 */
function coerceSsh(value) {
  if (!isRecord(value)) return undefined
  const host = typeof value.host === 'string' && value.host.trim() !== '' ? value.host.trim() : undefined
  const user = typeof value.user === 'string' && value.user.trim() !== '' ? value.user.trim() : undefined
  if (host === undefined || user === undefined) return undefined
  const port = Number(value.port)
  const remotePort = Number(value.remotePort)
  const hop = {
    host,
    user,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
    remotePort: Number.isInteger(remotePort) && remotePort > 0 && remotePort <= 65535 ? remotePort : 3080,
  }
  if (typeof value.privateKeyPath === 'string' && value.privateKeyPath.trim() !== '') {
    hop.privateKeyPath = value.privateKeyPath.trim()
  }
  if (typeof value.password === 'string' && value.password !== '') hop.password = value.password
  return hop
}

/**
 * Sanitize one credential description. The token is held as text; `device`
 * credential kind means "reuse the paired device credential this plugin already
 * stores for that origin", so no secret is duplicated here.
 * @param {unknown} value - the raw `auth` object.
 * @returns {{ kind: string, token?: string }} the usable description.
 */
function coerceAuth(value) {
  const kind = isRecord(value) && typeof value.kind === 'string' && AUTH_KINDS.includes(value.kind)
    ? value.kind
    : 'none'
  const auth = { kind }
  if (kind === 'token' && isRecord(value) && typeof value.token === 'string' && value.token !== '') {
    auth.token = value.token
  }
  return auth
}

/**
 * Sanitize a persisted peer row.
 * @param {unknown} value - one raw row.
 * @returns {object | undefined} a usable peer, or undefined.
 */
function coercePeer(value) {
  if (!isRecord(value)) return undefined
  const id = typeof value.id === 'string' && value.id !== '' ? value.id : undefined
  if (id === undefined) return undefined
  const channel = typeof value.channel === 'string' && CHANNELS.includes(value.channel) ? value.channel : undefined
  if (channel === undefined) return undefined
  const peer = {
    id,
    channel,
    label: typeof value.label === 'string' && value.label.trim() !== '' ? value.label.trim() : id,
    auth: coerceAuth(value.auth),
    createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
  }
  if (channel === 'ssh') {
    const ssh = coerceSsh(value.ssh)
    if (ssh === undefined) return undefined
    peer.ssh = ssh
    // The origin of an SSH peer is the authority the tunnel presents to the
    // remote's own web server — loopback *at the far end*, never a LAN name.
    peer.origin = normalizeOrigin(`http://127.0.0.1:${String(ssh.remotePort)}`) ?? `http://127.0.0.1:${String(ssh.remotePort)}`
    // …which means it is unreachable from this machine's browser. Jumping to
    // that machine's GUI needs the address the *browser* can reach, so it is a
    // separate optional field; without it the panel still lists sessions but
    // cannot open them, and says so.
    const webOrigin = normalizeOrigin(value.webOrigin)
    if (webOrigin !== undefined) peer.webOrigin = webOrigin
  } else {
    const origin = normalizeOrigin(value.origin)
    if (origin === undefined) return undefined
    peer.origin = origin
  }
  if (typeof value.lastUsedAt === 'number' && Number.isFinite(value.lastUsedAt)) peer.lastUsedAt = value.lastUsedAt
  if (isRecord(value.lastProbe)) peer.lastProbe = value.lastProbe
  // The remote's DSH_HOME, when the user set it per-machine. Both the
  // provisioner (where to write the launch log) and the static fallback (where
  // to find `sessions/`) need it, and neither has a sensible way to guess.
  const remoteHome = typeof value.remoteHome === 'string' && value.remoteHome.trim() !== '' ? value.remoteHome.trim() : undefined
  if (remoteHome !== undefined) peer.remoteHome = remoteHome
  return peer
}

/**
 * Read and validate the store file; never throws (a corrupt file reads empty).
 * @param {string} file - absolute store path.
 * @returns {{ version: number, peers: object[] }} the parsed store.
 */
export function readFederationFile(file) {
  const empty = { version: FEDERATION_FILE_VERSION, peers: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!isRecord(parsed) || !Array.isArray(parsed.peers)) return empty
    const peers = []
    for (const row of parsed.peers) {
      const peer = coercePeer(row)
      if (peer !== undefined) peers.push(peer)
    }
    return { version: FEDERATION_FILE_VERSION, peers }
  } catch {
    return empty
  }
}

/**
 * Write the store file atomically (temp file + rename), best-effort 0600.
 * @param {string} file - absolute store path.
 * @param {object[]} peers - rows to persist.
 * @returns {void}
 */
export function writeFederationFile(file, peers) {
  mkdirSync(path.dirname(file), { recursive: true })
  const payload = { version: FEDERATION_FILE_VERSION, peers: peers.map(peer => ({ ...peer })) }
  const temp = `${file}.${String(process.pid)}.${Date.now().toString(36)}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      /* the temp file may never have been created */
    }
    throw error
  }
}

/**
 * The default federation store location.
 * @param {string} home - the harness home directory.
 * @returns {string} the absolute store path.
 */
export function defaultFederationFile(home) {
  return path.join(home, 'federation', 'peers.json')
}

/**
 * The origin a *browser on this machine* can open for one peer, when any.
 *
 * This is deliberately NOT `peer.origin`: an SSH peer's origin is
 * `127.0.0.1:<remotePort>` *on the far machine*, which on this machine is a
 * different, possibly live, service. Opening it would be a bug the user could
 * not diagnose.
 * @param {object} peer - the peer row.
 * @returns {string | undefined} the browser origin, or undefined when the peer
 *   is reachable only through the tunnel and has not been given a web address.
 */
export function browserOriginOf(peer) {
  return peer.channel === 'http' ? peer.origin : peer.webOrigin
}

/**
 * Build a peer row from one `add` request, preserving identity on replace.
 *
 * Replace is keyed by *reach* — the same SSH host+user, or the same origin —
 * because adding the same machine twice under two labels is a mistake whose
 * only visible symptom is two rows showing identical sessions.
 * @param {object[]} peers - existing rows.
 * @param {Record<string, unknown>} body - the request body.
 * @param {string} [id] - the row to replace, when the caller named one.
 * @returns {{ row: object } | { error: string, hint?: string }} the outcome.
 */
export function buildPeer(peers, body, id) {
  const channel = typeof body.channel === 'string' ? body.channel : 'http'
  if (!CHANNELS.includes(channel)) return { error: 'invalid-channel', hint: '通道只能是 ssh 或 http' }

  const existing = id === undefined ? undefined : peers.find(peer => peer.id === id)
  let ssh
  let origin
  let webOrigin
  if (channel === 'ssh') {
    ssh = coerceSsh(body.ssh)
    if (ssh === undefined) {
      return { error: 'invalid-ssh', hint: 'SSH 通道需要主机、用户名；端口默认 22，远端 dsh web 端口默认 3080' }
    }
    origin = `http://127.0.0.1:${String(ssh.remotePort)}`
    // Optional, and independent of the tunnel: the address *this browser* can
    // open the remote GUI at. Absent = list-only peer (the panel says so).
    const rawWeb = typeof body.webOrigin === 'string' ? body.webOrigin.trim() : ''
    if (rawWeb !== '') {
      webOrigin = normalizeOrigin(rawWeb)
      if (webOrigin === undefined) {
        return { error: 'invalid-web-origin', hint: '「跳转地址」要填 http(s)://主机:端口（不带路径），或留空表示只列清单' }
      }
    } else if (existing?.webOrigin !== undefined) {
      webOrigin = existing.webOrigin
    }
  } else {
    origin = normalizeOrigin(body.origin)
    if (origin === undefined) {
      return { error: 'invalid-address', hint: '请填 http(s)://主机:端口，或粘贴对方开头的链接' }
    }
  }

  const label = typeof body.label === 'string' && body.label.trim() !== ''
    ? body.label.trim()
    : channel === 'ssh' ? `${ssh.user}@${ssh.host}` : origin

  // A blank secret field on an EDIT means "leave it alone", not "clear it": the
  // settings form never echoes a stored token or password back, so treating an
  // empty field as a new value would silently wipe the credential every time
  // the user changed a label.
  const auth = coerceAuth(body.auth)
  if (auth.kind === 'token' && auth.token === undefined && typeof existing?.auth?.token !== 'string') {
    return { error: 'missing-token', hint: '凭据类型选了官方 token，但没有填 token' }
  }
  if (auth.kind === 'token' && auth.token === undefined && existing?.auth?.kind === 'token') {
    auth.token = existing.auth.token
  }
  if (ssh !== undefined && ssh.password === undefined && typeof existing?.ssh?.password === 'string') {
    ssh.password = existing.ssh.password
  }

  const sameReach = peer => channel === 'ssh'
    ? peer.channel === 'ssh' && peer.ssh.host === ssh.host && peer.ssh.user === ssh.user && peer.ssh.port === ssh.port && peer.ssh.remotePort === ssh.remotePort
    : peer.channel === 'http' && peer.origin === origin
  const collision = existing === undefined ? peers.find(sameReach) : undefined

  const row = {
    id: existing?.id ?? collision?.id ?? mintFederationPeerId(),
    channel,
    label,
    origin,
    auth,
    createdAt: existing?.createdAt ?? collision?.createdAt ?? Date.now(),
  }
  if (ssh !== undefined) row.ssh = ssh
  if (webOrigin !== undefined) row.webOrigin = webOrigin
  // Like the token: a blank field on an edit means "unchanged", not "clear".
  // `body.remoteHome` is often present-but-empty (the form always sends it), so
  // this must test the trimmed value rather than the key's presence. The
  // carry-over reads `existing ?? collision` because re-adding the same reach is
  // also an update, and it must not silently drop a setting the user made.
  const previousRemoteHome = existing?.remoteHome ?? collision?.remoteHome
  const rawRemoteHome = typeof body.remoteHome === 'string' ? body.remoteHome.trim() : ''
  if (rawRemoteHome !== '') row.remoteHome = rawRemoteHome
  else if (previousRemoteHome !== undefined) row.remoteHome = previousRemoteHome
  if (existing?.lastUsedAt !== undefined) row.lastUsedAt = existing.lastUsedAt
  return { row }}
