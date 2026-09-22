/**
 * Credential acquisition and replay for federation peers.
 *
 * The harness has its own browser-session scheme, and it has no loopback
 * exemption:
 *
 *   `dsh-client-connection/lib/index.js`, `BrowserAuth`
 *     * `GET /?token=<launchToken>` → 303 to `/` + `Set-Cookie:
 *       dsh-auth-<base64url(sha256(authority))>=v1.<payload>.<sig>`
 *     * the cookie is signed over the *authority* it was minted for, so a
 *       cookie obtained for `127.0.0.1:51987` is presented as-is over the SSH
 *       tunnel and never re-scoped;
 *     * `Max-Age` defaults to 30 days and the signing key lives in the remote
 *       `.credentials.yaml`, so the cookie survives a remote restart.
 *
 * Node has no cookie jar, so this module captures the `Set-Cookie` from the
 * 303 by hand and replays it as a `Cookie` header. `fetch` with
 * `redirect: 'manual'` is what makes the 303 observable at all.
 *
 * A peer whose credential kind is `device` instead reuses the paired-device
 * credential this plugin already stores for that origin, and rides the
 * remote-access plugin's gated channel (`/remote/api/*`) rather than `/api`.
 * That channel exists only where that plugin is installed.
 *
 * @module dsh-remote-switch/federation/auth
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { isRecord } from './wire.js'

/** Credential-record scope: the registered plugin name owning the record. */
const CREDENTIAL_SCOPE = 'dsh-remote-switch'

/** Fallback cookie-cache schema version. */
const CACHE_VERSION = 1

/**
 * The exact cookie name the harness mints for one authority.
 *
 * Mirrors `cookieName(authority)` in `dsh-client-connection`: the authority as
 * it appears in the `Host` header, hashed with SHA-256 and base64url-encoded.
 * @param {string} authority - the `Host` value, e.g. `127.0.0.1:3080`.
 * @returns {string} the cookie name.
 */
export function authCookieName(authority) {
  const hash = createHash('sha256').update(authority).digest('base64')
  return `dsh-auth-${hash.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`
}

/**
 * Extract one cookie's value from a `Set-Cookie` header list.
 * @param {string[]} setCookies - the header values.
 * @param {string} name - the cookie name.
 * @returns {{ value: string, expiresAt: number, maxAgeSeconds: number } | undefined} the cookie, or undefined.
 */
export function pickSetCookie(setCookies, name) {
  for (const raw of setCookies) {
    const segments = raw.split(';')
    const first = segments[0] ?? ''
    const at = first.indexOf('=')
    if (at < 0) continue
    if (first.slice(0, at).trim() !== name) continue
    const value = first.slice(at + 1).trim()
    if (value === '') continue
    let maxAgeSeconds = 0
    let expiresAt = 0
    for (const attribute of segments.slice(1)) {
      const [key, ...rest] = attribute.split('=')
      const attributeValue = rest.join('=')
      const normalized = key.trim().toLowerCase()
      if (normalized === 'max-age') maxAgeSeconds = Number(attributeValue.trim()) || 0
      if (normalized === 'expires') {
        const parsed = Date.parse(attributeValue.trim())
        if (Number.isFinite(parsed)) expiresAt = parsed
      }
    }
    if (expiresAt === 0 && maxAgeSeconds > 0) expiresAt = Date.now() + maxAgeSeconds * 1000
    return { value, expiresAt, maxAgeSeconds }
  }
  return undefined
}

/**
 * A cached credential for one authority.
 */
class CachedCookie {
  /**
   * @param {string} authority - the authority it was minted for.
   * @param {string} value - the cookie value.
   * @param {number} expiresAt - ms epoch, or 0 when unknown.
   */
  constructor(authority, value, expiresAt) {
    this.authority = authority
    this.cookieName = authCookieName(authority)
    this.value = value
    this.expiresAt = expiresAt
  }

  /** @returns {boolean} whether the cookie is past its expiry. */
  get expired() {
    return this.expiresAt > 0 && Date.now() >= this.expiresAt - 60000
  }

  /** @returns {string} the `Cookie` header value. */
  get header() {
    return `${this.cookieName}=${this.value}`
  }

  /** @returns {object} the persistable shape. */
  toJSON() {
    return {
      version: CACHE_VERSION,
      authority: this.authority,
      cookieName: this.cookieName,
      value: this.value,
      expiresAt: this.expiresAt,
    }
  }
}

/**
 * Revive a cached cookie from persisted JSON.
 * @param {unknown} value - the stored record payload.
 * @returns {CachedCookie | undefined} the cookie, or undefined when unusable.
 */
function reviveCookie(value) {
  if (!isRecord(value) || value.version !== CACHE_VERSION) return undefined
  if (typeof value.authority !== 'string' || typeof value.value !== 'string' || value.value === '') return undefined
  const expiresAt = typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? value.expiresAt : 0
  return new CachedCookie(value.authority, value.value, expiresAt)
}

/**
 * Read the fallback cookie-cache file.
 * @param {string} file - absolute path.
 * @returns {Record<string, object>} peer id → stored payload.
 */
function readCacheFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!isRecord(parsed) || !isRecord(parsed.entries)) return {}
    return parsed.entries
  } catch {
    return {}
  }
}

/**
 * Write the fallback cookie-cache file atomically at 0600.
 * @param {string} file - absolute path.
 * @param {Record<string, object>} entries - peer id → payload.
 * @returns {void}
 */
function writeCacheFile(file, entries) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${String(process.pid)}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify({ version: CACHE_VERSION, entries }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
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
 * Owns the per-peer credential: acquiring it, caching it, replaying it, and
 * re-acquiring it exactly once when the remote answers 401.
 */
export class AuthStore {
  /**
   * @param {{
   *   credentials?: { readRecord: Function, modifyRecord: Function, deleteRecord: Function },
   *   cacheFile: string,
   *   deviceCredentialOf?: (origin: string) => string | undefined,
   *   logger?: { warn: (message: string) => void },
   * }} options - store options.
   */
  constructor(options) {
    this.credentials = options.credentials
    this.cacheFile = options.cacheFile
    this.deviceCredentialOf = options.deviceCredentialOf
    this.logger = options.logger
    /** @type {Map<string, CachedCookie>} peer id → live cookie. */
    this.cookies = new Map()
    this.loaded = false
  }

  /**
   * Lazily load the persisted cache once per activation.
   * @returns {Promise<void>}
   */
  async ensureLoaded() {
    if (this.loaded) return
    this.loaded = true
    for (const [peerId, payload] of Object.entries(readCacheFile(this.cacheFile))) {
      const cookie = reviveCookie(payload)
      if (cookie !== undefined && !cookie.expired) this.cookies.set(peerId, cookie)
    }
    if (this.credentials === undefined) return
    try {
      const records = await this.credentials.listRecords()
      for (const entry of records) {
        const key = typeof entry?.key === 'string' ? entry.key : undefined
        if (key === undefined || !key.startsWith(`${CREDENTIAL_SCOPE}/`)) continue
        const peerId = key.slice(CREDENTIAL_SCOPE.length + 1)
        if (this.cookies.has(peerId)) continue
        const record = await this.credentials.readRecord(key)
        const cookie = reviveCookie(isRecord(record) ? record.payload : undefined)
        if (cookie !== undefined && !cookie.expired) this.cookies.set(peerId, cookie)
      }
    } catch (error) {
      this.logger?.warn(`federation: could not read credentials service records: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Persist one peer's cookie, preferring the credentials service.
   * @param {string} peerId - the peer id.
   * @param {CachedCookie} cookie - the cookie to store.
   * @returns {Promise<void>}
   */
  async persist(peerId, cookie) {
    const payload = cookie.toJSON()
    const entries = readCacheFile(this.cacheFile)
    entries[peerId] = payload
    try {
      writeCacheFile(this.cacheFile, entries)
    } catch (error) {
      this.logger?.warn(`federation: could not write the credential cache file: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (this.credentials === undefined) return
    try {
      await this.credentials.modifyRecord(`${CREDENTIAL_SCOPE}/${peerId}`, () => Promise.resolve({ kind: 'grant', payload }))
    } catch (error) {
      this.logger?.warn(`federation: could not store the credential through the credentials service: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Forget one peer's credential everywhere.
   * @param {string} peerId - the peer id.
   * @returns {Promise<void>}
   */
  async forget(peerId) {
    this.cookies.delete(peerId)
    const entries = readCacheFile(this.cacheFile)
    if (Object.hasOwn(entries, peerId)) {
      delete entries[peerId]
      try {
        writeCacheFile(this.cacheFile, entries)
      } catch {
        /* best effort: the in-memory cache is already cleared */
      }
    }
    if (this.credentials !== undefined) {
      try {
        await this.credentials.deleteRecord(`${CREDENTIAL_SCOPE}/${peerId}`)
      } catch {
        /* the record may never have existed */
      }
    }
  }

  /**
   * The device credential this plugin already stores for one origin, if any.
   * @param {string} origin - the peer's origin.
   * @returns {string | undefined} the credential.
   */
  deviceCredential(origin) {
    return this.deviceCredentialOf?.(origin)
  }

  /**
   * Exchange one peer's launch token for a browser cookie.
   *
   * The exchange must be made against the *same authority* the cookie will be
   * replayed at, because the harness signs the authority into the cookie and
   * verifies it on every later request.
   * @param {object} peer - the peer row.
   * @param {(url: string) => Promise<{ status: number, setCookie: string[] }>} request - transport-bound GET.
   * @returns {Promise<CachedCookie>} the minted cookie.
   * @throws {Error} carrying `code` when the exchange did not yield a cookie.
   */
  async redeem(peer, request) {
    const token = peer.auth?.token
    if (typeof token !== 'string' || token === '') {
      const error = new Error('这个 peer 没有可用的凭据：请在设置里粘贴它启动时打印的 token，或改用已配对的 device 凭据')
      error.code = 'no-credential'
      throw error
    }
    const authority = new URL(peer.origin).host
    const url = `${peer.origin}/?token=${encodeURIComponent(token)}`
    const response = await request(url)
    if (response.status === 401 || response.status === 403) {
      const error = new Error('远端拒绝了这枚 token（可能已过期，或该实例重启过）——请在远端重新取一次启动 URL')
      error.code = 'token-rejected'
      throw error
    }
    const name = authCookieName(authority)
    const picked = pickSetCookie(response.setCookie, name)
    if (picked === undefined) {
      const error = new Error(`远端没有下发登录 cookie（HTTP ${String(response.status)}）：token 无效，或地址不是那台 DSH 实例`)
      error.code = 'no-cookie'
      throw error
    }
    const cookie = new CachedCookie(authority, picked.value, picked.expiresAt)
    this.cookies.set(peer.id, cookie)
    await this.persist(peer.id, cookie)
    return cookie
  }

  /**
   * The credential headers to send for one peer, acquiring a cookie when needed.
   *
   * A `device`-kind peer sends no cookie: its credential rides the gated
   * channel's own header, which the caller adds.
   * @param {object} peer - the peer row.
   * @param {(url: string) => Promise<{ status: number, setCookie: string[] }>} request - transport-bound GET.
   * @returns {Promise<Record<string, string>>} headers to merge into the request.
   */
  async headersFor(peer, request) {
    if (peer.auth?.kind === 'device') return {}
    if (peer.auth?.kind === 'none') return {}
    await this.ensureLoaded()
    const cached = this.cookies.get(peer.id)
    if (cached !== undefined && !cached.expired) return { cookie: cached.header }
    const cookie = await this.redeem(peer, request)
    return { cookie: cookie.header }
  }

  /**
   * Handle a 401 by dropping the cached cookie and minting one replacement.
   * Called at most once per request, so a genuinely unauthorized peer cannot
   * turn into an exchange loop.
   * @param {object} peer - the peer row.
   * @param {(url: string) => Promise<{ status: number, setCookie: string[] }>} request - transport-bound GET.
   * @returns {Promise<Record<string, string>>} headers for the retry.
   */
  async reauthorize(peer, request) {
    await this.forget(peer.id)
    return this.headersFor(peer, request)
  }
}
