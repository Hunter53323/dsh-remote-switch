/**
 * Shared HTTP plumbing for both halves of this plugin's host surface.
 *
 * Extracted from the instance-switcher half so the federation routes use the
 * exact same fence rather than a second, subtly different one. The fence is the
 * load-bearing part: a route registered straight on the web server is answered
 * *before* the harness's own `/api` authentication, so anything registered this
 * way has to prove the caller is local (or hold a live paired-device session)
 * by itself.
 *
 * @module dsh-remote-switch/http
 */

import path from 'node:path'

/** Hostnames that address this machine. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** A dotted-quad IPv4 in 127.0.0.0/8, e.g. `127.0.0.1`. */
const LOOPBACK_IPV4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u

/**
 * Whether a Host header's hostname addresses this machine.
 *
 * A prefix test is not enough: `127.0.0.1.evil.com` starts with `127.` and would
 * pass, while the socket check passes too because such a name can be pointed at
 * the loopback address by whoever controls its DNS. Only a real 127/8 literal
 * (or a name that can only mean this machine) counts.
 * @param {string} hostname - the parsed hostname.
 * @returns {boolean} true when it can only be this machine.
 */
function isLoopbackHostname(hostname) {
  if (LOOPBACK_HOSTS.has(hostname)) return true
  const match = LOOPBACK_IPV4.exec(hostname)
  if (match === null) return false
  return match.slice(1).every(octet => Number(octet) <= 255)
}

/** Bound on any request body this plugin reads; its forms are all tiny. */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * Harness home resolution: honors DSH_HOME, else ~/.dsh.
 * @returns {string} the harness home directory.
 */
export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  return path.join(home, '.dsh')
}

/**
 * Whether a request arrived from this machine (loopback socket AND loopback Host).
 *
 * Both halves matter: the socket check alone would accept a request proxied in
 * from a LAN address, and the Host check alone would accept a forged header.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {boolean} true for a local client.
 */
export function isLoopbackRequest(request) {
  const host = request.headers.host
  if (typeof host !== 'string' || host === '') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostname)) return false
  const remote = request.socket?.remoteAddress ?? ''
  return remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.')
}

/**
 * Whether a request came from a *different site* in a browser.
 *
 * The loopback fence cannot tell "the page this plugin is mounted in" from "a
 * random page that happens to be open in the same browser", because both reach
 * `127.0.0.1` over a loopback socket. Browsers label the difference for us:
 * `sec-fetch-site: cross-site` is sent by every modern one, and an `Origin` that
 * disagrees with `Host` is the same signal for the ones that omit it.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {boolean} true when a browser made this request from another site.
 */
export function isCrossSiteRequest(request) {
  const site = request.headers['sec-fetch-site']
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return true
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '') return false
  const host = request.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    if (new URL(origin).host !== host) return true
  } catch {
    return true
  }
  return false
}

/**
 * Best-effort CORS so this plugin's own page can ask from a LAN origin.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @returns {void}
 */
export function applyCors(request, res) {
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin !== '') res.setHeader('access-control-allow-origin', origin)
  res.setHeader('vary', 'origin')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
}

/**
 * Read one JSON request body.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {number} [maxBytes] - body bound.
 * @returns {Promise<Record<string, unknown> | undefined>} parsed object, or undefined.
 */
export async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let total = 0
  try {
    for await (const chunk of request) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      total += buffer.length
      if (total > maxBytes) return undefined
      chunks.push(buffer)
    }
  } catch {
    // A client that disconnects mid-body makes this iterator REJECT (ECONNRESET
    // on an aborted POST). That is a client-side event, not a plugin failure: it
    // must be reported as a bad request, never left to escape as a rejection
    // from a route handler.
    return undefined
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
export function sendJson(res, status, body) {
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
export function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Read one cookie value out of a Cookie header.
 * @param {string} header - the raw header.
 * @param {string} name - the cookie name.
 * @returns {string | undefined} the value, or undefined when absent.
 */
export function readCookieValue(header, name) {
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    if (part.slice(0, at).trim() !== name) continue
    const value = part.slice(at + 1).trim()
    if (value !== '') return value
  }
  return undefined
}
