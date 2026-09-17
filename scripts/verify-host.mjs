/**
 * Verification harness for dsh-instance-switcher's host half.
 *
 * Mounts the real route handlers on a plain node:http server with a stubbed
 * cordis context, then exercises the whole stored-credential flow against a
 * live target instance:
 *   1. mint a one-time pairing token on the target (loopback-only route)
 *   2. POST the pasted link  -> the plugin redeems it server-side and stores
 *      the resulting device credential
 *   3. GET  the peer list    -> origin + credential present
 *   4. POST /test            -> reachable AND credentialLive
 *   5. POST /test bad cred   -> credentialLive === false (the dead-credential path)
 *   6. non-loopback POST     -> 403 (the mutation fence)
 *
 * Usage: node scripts/verify-host.mjs [--target http://127.0.0.1:3080] [--port 3099]
 */

import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}
const target = argOf('--target', 'http://127.0.0.1:3080')
const port = Number(argOf('--port', '3099'))
const peersFile = path.join(mkdtempSync(path.join(tmpdir(), 'instance-switcher-')), 'peers.json')

const { apply } = await import('../lib/index.js')

/** Closed-over state the stub context exposes. */
const routes = new Map()
/** Device id the stub pairing service treats as a live session. */
const liveDevice = 'live-device-credential'
const stubCtx = {
  webServer: {
    port,
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  // Only the remote-access plugin's pairing service is consulted by this
  // plugin now; nothing else is reached through `ctx.get`.
  get(name) {
    if (name === 'remoteWebUiPairing') {
      // Stands in for the remote-access plugin's service: answers "is this
      // request a live paired device?" — the credential a LAN page holds.
      return {
        isPairedDevice: request => (request.headers.cookie ?? '').includes(`${liveDeviceCookie}=${liveDevice}`),
      }
    }
    return undefined
  },
}
/** Cookie name the stub pairing service looks for. */
const liveDeviceCookie = 'dsh_pair'

const dispose = apply(stubCtx, { peersFile, requestTimeoutMs: 8000 })

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`).pathname
  const handler = routes.get(pathname)
  if (handler === undefined) {
    res.writeHead(404).end('no route')
    return
  }
  void Promise.resolve(handler(req, res)).catch(error => {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }))
  })
})
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))

const base = `http://127.0.0.1:${String(port)}/api/instance-switcher`
const results = []
/** Raw sockets opened by the Host-forge check, destroyed during teardown. */
const rawSockets = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  — ${detail}` : ''}`)
}
const post = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

/**
 * Send one raw request over a fresh loopback socket so the Host header can be
 * forged (`fetch` normalizes it, which hides the fence from a test).
 * @param {string} raw - the complete request text.
 * @returns {Promise<{ status: number, body: string }>} the parsed response.
 */
const rawRequest = raw => new Promise(resolve => {
  const socket = connect(port, '127.0.0.1', () => { socket.write(raw) })
  let received = ''
  socket.on('data', chunk => { received += chunk.toString('utf8') })
  socket.on('error', () => { resolve({ status: 0, body: '' }) })
  socket.on('close', () => {
    const match = /^HTTP\/1\.1 (\d{3})/.exec(received)
    const split = received.indexOf('\r\n\r\n')
    resolve({
      status: match === null ? 0 : Number(match[1]),
      body: split >= 0 ? received.slice(split + 4) : received,
    })
  })
  rawSockets.push(socket)
})

// 1. mint a real one-time token on the target instance (loopback-only route).
const issue = await post(`${target}/api/pair/issue`, {})
check('mint pairing token on target', issue.status === 200 && typeof issue.body?.token === 'string',
  `status ${String(issue.status)}${issue.body?.token !== undefined ? '' : ` body=${JSON.stringify(issue.body).slice(0, 160)}`}`)

const token = issue.body?.token

// 2. paste the link the target's panel would hand out.
if (typeof token === 'string') {
  const link = `${target}/pair-accept?pair=${encodeURIComponent(token)}`
  const added = await post(`${base}/peers`, { action: 'add', link, label: 'verify-target' })
  check('add peer by redeeming a pasted pairing link', added.status === 200 && added.body?.credentialStored === true,
    `status ${String(added.status)} body=${JSON.stringify(added.body).slice(0, 240)}`)
}

// 3. list
const list = await fetch(`${base}/peers`).then(async response => ({ status: response.status, body: await response.json() }))
const peer = list.body?.peers?.[0]
check('peer list carries origin + credential', list.status === 200 && typeof peer?.origin === 'string' && typeof peer?.credential === 'string',
  `origin=${peer?.origin} credential=${peer?.credential !== undefined ? `${peer.credential.slice(0, 6)}…` : 'MISSING'}`)
check('the state frame lists only stored peers (no synthesized local row)',
  list.body?.local === undefined && list.body?.localDefault === undefined,
  `local=${JSON.stringify(list.body?.local)} localDefault=${JSON.stringify(list.body?.localDefault)}`)

// 4. probe the stored credential against the live target
if (peer !== undefined) {
  const tested = await post(`${base}/test`, { id: peer.id })
  check('probe reports reachable + live credential', tested.body?.reachable === true && tested.body?.credentialLive === true,
    `reachable=${String(tested.body?.reachable)} credentialLive=${String(tested.body?.credentialLive)} status=${String(tested.body?.status)} ${String(tested.body?.latencyMs)}ms`)
  check('probe returns the entry URL used for switching',
    typeof tested.body?.entry === 'string' && tested.body.entry.includes('/pair-app?device='),
    tested.body?.entry)

  // 5. dead-credential path: overwrite with a bogus credential.
  await post(`${base}/peers`, { action: 'add', link: `${target}/pair-app?device=bogus-credential`, label: 'verify-target' })
  const after = await fetch(`${base}/peers`).then(response => response.json())
  const bogus = after.peers?.[0]
  const dead = await post(`${base}/test`, { id: bogus.id })
  check('probe flags a dead credential instead of claiming success',
    dead.body?.reachable === true && dead.body?.credentialLive === false,
    `reachable=${String(dead.body?.reachable)} credentialLive=${String(dead.body?.credentialLive)}`)
  check('same-origin re-add replaces rather than duplicates', after.peers.length === 1, `count=${String(after.peers.length)}`)
}

// 6. mutation fence: forge a non-loopback Host on a real loopback socket.
// `fetch` normalizes Host, so this has to be a raw request to be meaningful.
const forged = await rawRequest(
  `POST /api/instance-switcher/peers HTTP/1.1\r\n` +
  `Host: 192.168.1.50:3080\r\n` +
  `Content-Type: application/json\r\n` +
  `Content-Length: ${String(Buffer.byteLength(JSON.stringify({ action: 'remove', id: 'x' })))}\r\n` +
  `Connection: close\r\n\r\n` +
  JSON.stringify({ action: 'remove', id: 'x' }),
)
check('non-loopback Host cannot mutate the list', forged.status === 403, `status ${String(forged.status)}`)

// 6c. REGRESSION: the peer list carries every credential, and a raw route on
// the web server is reached without the harness's 401. It must not answer an
// unpaired LAN caller — this leaked the whole list in an earlier revision.
const rawList = await rawRequest(
  `GET /api/instance-switcher/peers HTTP/1.1\r\nHost: 192.168.1.50:3080\r\nConnection: close\r\n\r\n`,
)
check('an unpaired LAN caller cannot read the peer list', rawList.status === 403,
  `status ${String(rawList.status)}`)
check('the leak refusal carries no credentials',
  !rawList.body.includes('credential') && !rawList.body.includes('p-'),
  rawList.body.slice(0, 120))

// 6d. …but a live paired-device session (what a paired LAN/tunnel page holds)
// still reads it, so the panel keeps working away from loopback.
const rawListPaired = await rawRequest(
  `GET /api/instance-switcher/peers HTTP/1.1\r\nHost: 192.168.1.50:3080\r\n` +
  `Cookie: ${liveDeviceCookie}=${liveDevice}\r\nConnection: close\r\n\r\n`,
)
check('a live paired-device session can read the peer list', rawListPaired.status === 200,
  `status ${String(rawListPaired.status)} body=${rawListPaired.body.slice(0, 60)}`)

// 7. persistence shape
const saved = JSON.parse(readFileSync(peersFile, 'utf8'))
check('store file is versioned and holds the credential', saved.version === 1 && typeof saved.peers?.[0]?.credential === 'string',
  `${peersFile} -> ${JSON.stringify(saved).slice(0, 200)}`)

// 8. bad link is refused with an actionable hint
const bad = await post(`${base}/peers`, { action: 'add', link: 'not a url' })
check('bad address is refused with a hint', bad.status === 400 && typeof bad.body?.hint === 'string', `status ${String(bad.status)}`)

dispose()
for (const socket of rawSockets) socket.destroy()
server.closeAllConnections()
await new Promise(resolve => { server.close(resolve) })

const failed = results.filter(result => !result.pass)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
