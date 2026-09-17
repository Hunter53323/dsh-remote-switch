/**
 * Peer-instance store for dsh-instance-switcher.
 *
 * Pure logic plus one JSON file, deliberately standalone: nothing here reads
 * or writes any file owned by another plugin. A "peer" is just a reachable
 * DSH instance origin plus an optional device credential, so that the browser
 * can be sent straight at `<origin>/pair-app?device=<credential>`.
 *
 * Storage shape (JSON, 0600, atomic replace):
 *   { "version": 1, "peers": [ { id, label, origin, credential?, createdAt, lastUsedAt? } ] }
 *
 * The local instance is NOT stored: it is synthesized per call from the live
 * listening port, so it can never go stale and never needs a credential.
 *
 * @module dsh-instance-switcher/peers
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Legacy id of the synthesized local entry this plugin used to publish. It is
 * never listed any more (the panel belongs to the instance you are already in,
 * so a local row would just point back at the same origin), and this constant
 * survives only to keep an old `peers.json` from smuggling one back in as a
 * real, removable peer.
 */
export const LOCAL_PEER_ID = '__local__'

/** Current store schema version. */
export const PEERS_FILE_VERSION = 1

/**
 * Normalize and validate one user-supplied instance address.
 *
 * Accepts only an absolute http(s) origin. A bare `host:port` is upgraded to
 * `http://host:port` for convenience. Anything carrying a path, query,
 * fragment, or embedded credentials is refused — those are exactly the shapes
 * that would let a typo authorize the wrong authority.
 *
 * @param {unknown} input - the raw address.
 * @returns {string | undefined} the canonical origin, or undefined when unusable.
 */
export function normalizeOrigin(input) {
  if (typeof input !== 'string') return undefined
  const raw = input.trim()
  if (raw === '') return undefined
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  let url
  try {
    url = new URL(candidate)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
  if (url.hostname === '') return undefined
  return url.origin
}

/**
 * Split a pasted pairing link into its origin and secret.
 *
 * The remote-web-ui pairing UI hands out links shaped either
 * `<origin>/pair-accept?pair=<token>` (a one-time token) or
 * `<origin>/pair-app?device=<credential>`. Pasting either one should be
 * enough, so recognize both and report which kind arrived.
 *
 * @param {unknown} input - the pasted text.
 * @returns {{ origin: string, token?: string, credential?: string } | undefined}
 */
export function parsePairingLink(input) {
  if (typeof input !== 'string') return undefined
  const raw = input.trim()
  if (raw === '') return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  const origin = url.origin
  const token = url.searchParams.get('pair')
  const credential = url.searchParams.get('device')
  if (token !== null && token !== '') return { origin, token }
  if (credential !== null && credential !== '') return { origin, credential }
  // A bare origin (no secret) is still a valid "just the address" entry.
  if (url.pathname === '/' || url.pathname === '') return { origin }
  return undefined
}

/** Mint a fresh peer id. @returns {string} */
export function mintPeerId() {
  return `p-${randomBytes(6).toString('hex')}`
}

/**
 * Sanitize a persisted/loaded peer row.
 * @param {unknown} value - one raw row.
 * @returns {object | undefined} a usable peer, or undefined.
 */
function coercePeer(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const row = /** @type {Record<string, unknown>} */ (value)
  if (typeof row.id !== 'string' || row.id === '' || row.id === LOCAL_PEER_ID) return undefined
  const origin = normalizeOrigin(row.origin)
  if (origin === undefined) return undefined
  const label = typeof row.label === 'string' && row.label.trim() !== '' ? row.label.trim() : origin
  const peer = {
    id: row.id,
    label,
    origin,
    createdAt: typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : Date.now(),
  }
  if (typeof row.credential === 'string' && row.credential !== '') peer.credential = row.credential
  if (typeof row.lastUsedAt === 'number' && Number.isFinite(row.lastUsedAt)) peer.lastUsedAt = row.lastUsedAt
  return peer
}

/**
 * Read and validate the store file; never throws (a corrupt file reads as empty).
 * @param {string} file - absolute store path.
 * @returns {{ version: number, peers: object[] }}
 */
export function readPeersFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return { version: PEERS_FILE_VERSION, peers: [] }
    const rows = parsed.peers
    if (!Array.isArray(rows)) return { version: PEERS_FILE_VERSION, peers: [] }
    const peers = []
    for (const row of rows) {
      const peer = coercePeer(row)
      if (peer !== undefined) peers.push(peer)
    }
    return { version: PEERS_FILE_VERSION, peers }
  } catch {
    return { version: PEERS_FILE_VERSION, peers: [] }
  }
}

/**
 * Write the store file atomically (temp file + rename), best-effort 0600.
 * @param {string} file - absolute store path.
 * @param {object[]} peers - rows to persist.
 * @returns {void}
 */
export function writePeersFile(file, peers) {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  const payload = { version: PEERS_FILE_VERSION, peers: peers.map(peer => ({ ...peer })) }
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
 * Build the navigation URL that enters one instance's official GUI.
 *
 * The cookieless landing (`/pair-app?device=`) is the whole trick: it opens
 * the target's official shell without depending on any cookie this browser
 * happens to hold, so a stored credential survives cleared cookies and even a
 * different browser profile.
 *
 * @param {string} origin - the instance origin.
 * @param {string | undefined} credential - its device credential, when known.
 * @returns {string} the URL to assign to `location`.
 */
export function entryUrl(origin, credential) {
  if (credential === undefined || credential === '') return `${origin}/`
  return `${origin}/pair-app?device=${encodeURIComponent(credential)}`
}

/**
 * Whether two origins address the same instance.
 * @param {string} a - first origin.
 * @param {string} b - second origin.
 * @returns {boolean} true when both parse to the same origin.
 */
export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}
