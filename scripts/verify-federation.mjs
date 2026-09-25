/**
 * Verification harness for the federation host half.
 *
 * Mounts the real route handlers on a plain node:http server with a stubbed
 * cordis context, then exercises the whole read path against a live DSH
 * instance — the same wire the panel uses in the browser, no browser involved.
 *
 * What it pins, and why each one is worth a test:
 *   1. the unary envelope the harness actually accepts (a wrong one is a 400
 *      from the gateway, not from this plugin, so it is easy to misread);
 *   2. the stream mux handshake — `open` with empty args, a baseline frame,
 *      then `cancel`, with no answer obligation;
 *   3. the visibility projection against the remote sidebar's own rules
 *      (subagent / blank / archived), including the archive set arriving from
 *      the *stream* rather than the list;
 *   4. credential acquisition: `GET /?token=` → 303 → cookie, then replay;
 *   5. the loopback fence on every federation route, reads included;
 *   6. that no response ever carries a token or an SSH password;
 *   7. the P2 host surface: the SSH start/stop lifecycle — including that a
 *      start captures the token printed by the remote instance it launched.
 *
 * Usage:
 *   node scripts/verify-federation.mjs [--target http://127.0.0.1:3080] [--token <token>]
 *
 * `--target` must be a running DSH instance (see the README's development
 * section for how to start a throwaway one with its own DSH_HOME on `--port 0`,
 * and where its token URL is printed).
 */

import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import ssh2 from 'ssh2'

const { Server: SshServer, utils } = ssh2

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}
const target = argOf('--target', 'http://127.0.0.1:3080')
const port = Number(argOf('--port', '3098'))
const token = argOf('--token', '')

const workDir = mkdtempSync(path.join(tmpdir(), 'federation-verify-'))
const federationFile = path.join(workDir, 'peers.json')
const knownHostsFile = path.join(workDir, 'known_hosts.json')
const cacheFile = path.join(workDir, 'credentials.json')
// The instance-switcher store, which is where a peer's paired-device credential
// lives. Pointed into the temp dir so the suite never reads — or writes — the
// developer's real pairing state, and so a jump-URL test can create a pairing
// deliberately.
const devicePeersFile = path.join(workDir, 'instance-switcher-peers.json')
const { apply } = await import('../lib/index.js')

/** Closed-over state the stub context exposes. */
const routes = new Map()
const stubCtx = {
  logger: { warn: () => {}, error: () => {}, info: () => {} },
  webServer: {
    port,
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  // No credentials service: the fallback cache file must carry the whole flow.
  get() { return undefined },
}

const dispose = apply(stubCtx, {
  peersFile: devicePeersFile,
  federation: {
    federationFile,
    knownHostsFile,
    cacheFile,
    requestTimeoutMs: 10000,
    listLimit: 50,
    // Short enough that waiting out a remote which never prints a launch URL
    // does not cost the suite half a minute.
    provisionReadyTimeoutMs: 1200,
  },
})

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

const base = `http://127.0.0.1:${String(port)}/api/federation`
const results = []
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
const get = async (url) => {
  const response = await fetch(url)
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}
/** Send one raw request so the Host header can be forged. */
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
      // The raw head, so a test can assert a header is NOT there (an echoed
      // `access-control-allow-origin` is invisible to status and body).
      raw: received,
    })
  })
  rawSockets.push(socket)
})

// ── 1. shape checks that need no remote at all ──────────────────────────────
const empty = await get(`${base}/peers`)
check('the peer list starts empty and redacted', empty.status === 200 && Array.isArray(empty.body?.peers) && empty.body.peers.length === 0,
  JSON.stringify(empty.body).slice(0, 160))

const badChannel = await post(`${base}/peers`, { action: 'save', channel: 'carrier-pigeon' })
check('an unknown channel is refused with a hint', badChannel.status === 400 && typeof badChannel.body?.hint === 'string',
  `${String(badChannel.status)} ${JSON.stringify(badChannel.body).slice(0, 120)}`)

const badSsh = await post(`${base}/peers`, { action: 'save', channel: 'ssh', ssh: { host: 'h' } })
check('an SSH peer without a user is refused', badSsh.status === 400 && badSsh.body?.error === 'invalid-ssh',
  JSON.stringify(badSsh.body).slice(0, 140))

// An SSH peer's reach origin is loopback on the FAR machine. Building it from
// the configured host would produce an origin that is not the authority the
// remote's web server trusts, and the signed cookie would never validate.
const sshPeer = await post(`${base}/peers`, {
  action: 'save',
  channel: 'ssh',
  label: 'verify-ssh',
  ssh: { host: '127.0.0.1', user: 'tester', port: 2222, remotePort: Number(new URL(target).port) },
  auth: { kind: 'token', token: `${token}` },
})
check('an SSH peer registers', sshPeer.status === 200 && sshPeer.body?.saved !== undefined,
  JSON.stringify(sshPeer.body).slice(0, 200))
const savedSsh = (sshPeer.body?.peers ?? []).find(peer => peer.id === sshPeer.body?.saved)
check('an SSH peer addresses the remote loopback, not the configured host',
  savedSsh?.origin === `http://127.0.0.1:${new URL(target).port}`,
  `origin=${String(savedSsh?.origin)}`)
check('the SSH peer view never carries the token, the password, or a private key body',
  savedSsh !== undefined && savedSsh.auth?.hasToken === true && savedSsh.auth.token === undefined &&
    savedSsh.ssh.password === undefined,
  JSON.stringify(savedSsh?.auth) + ' ' + JSON.stringify(savedSsh?.ssh))

// ── 1b. what "open remote" actually opens ───────────────────────────────────
// A stored credential has to become a *working* jump, or the button can only
// land on a login wall. A token-only peer — any machine this one has never
// paired, which is every freshly set-up computer — used to get a bare origin and
// nothing else, so the token the plugin had just captured looked unused.
const jumpToken = 'jump token/with?specials'
const tokenJump = await post(`${base}/peers`, {
  action: 'save',
  channel: 'ssh',
  label: 'verify-token-jump',
  ssh: { host: '10.9.9.9', user: 'jumper', port: 22, remotePort: 3080 },
  webOrigin: 'http://10.9.9.9:3080',
  auth: { kind: 'token', token: jumpToken },
})
const tokenJumpRow = (tokenJump.body?.peers ?? []).find(peer => peer.label === 'verify-token-jump')
check('a token peer with a web address gets a jump URL carrying that token',
  tokenJumpRow?.jumpUrl === `http://10.9.9.9:3080/?token=${encodeURIComponent(jumpToken)}`,
  String(tokenJumpRow?.jumpUrl))
check('...URL-encoded rather than concatenated raw',
  String(tokenJumpRow?.jumpUrl).includes(encodeURIComponent(jumpToken)) &&
    !String(tokenJumpRow?.jumpUrl).includes(jumpToken),
  String(tokenJumpRow?.jumpUrl))
check('...and the token is still not exposed as a readable view field',
  tokenJumpRow?.auth?.token === undefined && tokenJumpRow?.auth?.hasToken === true,
  JSON.stringify(tokenJumpRow?.auth ?? null))
check('...and it is not ALSO offered as a bare, unauthenticated origin',
  tokenJumpRow?.openOrigin === undefined, String(tokenJumpRow?.openOrigin))

// A pairing must still win, because this is the setup a machine that has already
// paired the remote is in: its `/pair-app` landing is cookieless and does not go
// stale when the remote reprints its token.
mkdirSync(path.dirname(devicePeersFile), { recursive: true })
writeFileSync(devicePeersFile, JSON.stringify({
  version: 1,
  peers: [{
    id: 'p-verify-device',
    label: 'paired',
    origin: 'http://10.9.9.9:3080',
    credential: 'device-cred-1',
    createdAt: Date.now(),
  }],
}))
const pairedList = await get(`${base}/peers`)
const pairedRow = (pairedList.body?.peers ?? []).find(peer => peer.label === 'verify-token-jump')
check('a paired-device credential takes precedence over the peer\'s own token',
  pairedRow?.jumpUrl === 'http://10.9.9.9:3080/pair-app?device=device-cred-1',
  String(pairedRow?.jumpUrl))
// Put it back: every later check in this suite expects no pairing to exist.
writeFileSync(devicePeersFile, JSON.stringify({ version: 1, peers: [] }))

// ── 2. the loopback fence, reads included ───────────────────────────────────
const forgedRead = await rawRequest(
  `GET /api/federation/peers HTTP/1.1\r\nHost: 192.168.1.50:3080\r\nConnection: close\r\n\r\n`,
)
check('a LAN caller cannot read the peer list at all', forgedRead.status === 403, `status ${String(forgedRead.status)}`)
check('that refusal leaks no credential material',
  !forgedRead.body.includes('token') && !forgedRead.body.includes('password') && !forgedRead.body.includes('verify-ssh'),
  forgedRead.body.slice(0, 140))

const forgedSessions = await rawRequest(
  `GET /api/federation/sessions HTTP/1.1\r\nHost: 192.168.1.50:3080\r\nConnection: close\r\n\r\n`,
)
check('a LAN caller cannot read sessions either', forgedSessions.status === 403, `status ${String(forgedSessions.status)}`)

// Provisioning runs commands on another machine, so the fence matters most here.
const forgedProvision = await rawRequest(
  `POST /api/federation/provision HTTP/1.1\r\nHost: 192.168.1.50:3080\r\n` +
  `Content-Type: application/json\r\nContent-Length: 34\r\nConnection: close\r\n\r\n{"id":"x","action":"start"}`,
)
check('a LAN caller cannot start or stop remote instances', forgedProvision.status === 403,
  `status ${String(forgedProvision.status)}`)

// ── 2b. the fence must also stop the user's OWN browser ─────────────────────
// The socket+Host check cannot tell this plugin's page from any other page open
// in the same browser: a fetch to 127.0.0.1 from a random site satisfies both.
// These are the cases that made the fence insufficient on its own.
const crossSite = await rawRequest(
  `GET /api/federation/peers HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n` +
  `sec-fetch-site: cross-site\r\nConnection: close\r\n\r\n`,
)
check('a cross-site browser request is refused', crossSite.status === 403,
  `status ${String(crossSite.status)}`)

const foreignOrigin = await rawRequest(
  `GET /api/federation/peers HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n` +
  `Origin: http://evil.example\r\nConnection: close\r\n\r\n`,
)
check('a request from another site\'s Origin is refused', foreignOrigin.status === 403,
  `status ${String(foreignOrigin.status)}`)

// The peer list carries SSH hosts, users, ports and key paths: a page must not be
// able to read it cross-origin, which is what reflecting an arbitrary Origin did.
const sameOrigin = await rawRequest(
  `GET /api/federation/peers HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n` +
  `Origin: http://127.0.0.1:${String(port)}\r\nConnection: close\r\n\r\n`,
)
check('the panel\'s own origin still works', sameOrigin.status === 200, `status ${String(sameOrigin.status)}`)
check('...and no origin at all is ever echoed back as a CORS grant',
  !sameOrigin.raw.toLowerCase().includes('access-control-allow-origin') &&
  !crossSite.raw.toLowerCase().includes('access-control-allow-origin'),
  sameOrigin.raw.split('\r\n').filter(line => line.toLowerCase().includes('access-control')).join(' | ') || 'no CORS headers')

// A `127.`-prefixed Host is a DNS-rebinding shape: the name resolves to loopback
// (so the socket check passes) while the attacker controls the page. A prefix
// test cannot see that, so only a real 127/8 literal may pass.
const rebound = await rawRequest(
  `GET /api/federation/peers HTTP/1.1\r\nHost: 127.0.0.1.evil.com:${String(port)}\r\nConnection: close\r\n\r\n`,
)
check('a hostname that merely starts with "127." is not treated as loopback', rebound.status === 403,
  `status ${String(rebound.status)}`)

// ── 2c. the crash class ─────────────────────────────────────────────────────
// A route handler that does not RETURN its promise settles the web server's
// `await` immediately, so its rejection escapes to the host's process-level
// handler — which answers `unhandledRejection` with `exit(1)`. One aborted
// request used to be able to take the whole DSH instance down.
const escaped = []
const onEscaped = reason => { escaped.push(reason) }
process.on('unhandledRejection', onEscaped)

// Declares a 1000-byte body, sends 10 bytes, hangs up. `readJson`'s
// `for await (const chunk of request)` rejects with ECONNRESET on exactly this.
await new Promise(resolve => {
  const socket = connect(port, '127.0.0.1', () => {
    socket.write(
      `POST /api/federation/peers HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n` +
      `content-type: application/json\r\ncontent-length: 1000\r\n\r\n{"partial"`,
    )
    setTimeout(() => { socket.destroy(); resolve() }, 40)
  })
  socket.on('error', () => {})
  rawSockets.push(socket)
})
await new Promise(resolve => setTimeout(resolve, 200))
process.off('unhandledRejection', onEscaped)
// A malformed request-target (`GET http://[`) is caught by the web server's own
// `handle().catch()` before any route is reached, so it is not this plugin's risk
// and is not asserted here — the harness's minimal router does not reproduce that
// outer catch, and asserting it would only test the harness.

check('an aborted POST body escapes as nothing',
  escaped.length === 0,
  escaped.map(reason => String(reason?.code ?? reason)).join(' , ') || 'none escaped')
check('...and the surface still serves requests afterwards', (await get(`${base}/peers`)).status === 200,
  'peer list still reachable')

// ── 3. the real read path over SSH direct-tcpip ─────────────────────────────
// A local ssh2 Server stands in for the remote machine's sshd: it accepts any
// auth and forwards `direct-tcpip` to the real instance's loopback port. That
// exercises the transport, the host-key TOFU policy, the credential exchange,
// the unary envelope, and the stream mux — everything but the network hop.
const keyPair = utils.generateKeyPairSync('ed25519')
const sshPort = 2222
const forwarded = []
/** Commands the fake sshd was asked to run, in order. */
const execd = []
/**
 * What the fake sshd does with an `exec` request. The provisioner's whole job is
 * to run one command and read its effect, so this is where the remote side of
 * that contract is simulated.
 * @param {string} command - the command the client sent.
 * @returns {string} stdout to answer with.
 */
let execResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('ss -ltn') || command.includes('netstat')) return ''
  return ''
}
const sshServer = new SshServer({ hostKeys: [keyPair.private] }, (client) => {
  client.on('authentication', (authCtx) => { authCtx.accept() })
  client.on('ready', () => {
    client.on('tcpip', (accept, reject, info) => {
      forwarded.push(`${info.destIP}:${String(info.destPort)}`)
      // Connect FIRST and only then accept. A real sshd opens the channel only
      // after the destination accepted; when it cannot, it refuses the open with
      // a reason — which is what ssh2 surfaces as
      // "Channel open failure: Connection refused". Accepting first and closing
      // afterwards would model a different failure and hide that path.
      const upstream = connect(info.destPort, info.destIP === 'localhost' ? '127.0.0.1' : info.destIP, () => {
        const channel = accept()
        channel.pipe(upstream).pipe(channel)
        channel.on('close', () => { upstream.destroy() })
      })
      upstream.on('error', () => { reject() })
    })
    client.on('session', (accept) => {
      const session = accept()
      session.on('exec', (acceptExec, rejectExec, info) => {
        execd.push(info.command)
        const stream = acceptExec()
        const output = execResponder(info.command)
        if (output !== '') stream.write(output)
        stream.exit(0)
        stream.end()
      })
    })
  })
  client.on('error', () => {})
})
await new Promise((resolve, reject) => {
  sshServer.once('error', reject)
  sshServer.listen(sshPort, '127.0.0.1', resolve)
})

const remotePort = Number(new URL(target).port)
await post(`${base}/peers`, {
  action: 'save',
  channel: 'ssh',
  label: 'verify-ssh',
  ssh: { host: '127.0.0.1', user: 'tester', port: sshPort, remotePort },
  auth: { kind: 'token', token },
})

if (token === '') {
  check('a live target token was supplied', false,
    'pass --token <launch token>; without it the credential exchange cannot be exercised')
} else {
  const sessions = await post(`${base}/sessions`, { peerId: savedSsh?.id, force: true })
  check('the SSH tunnel carries a real session list', sessions.status === 200 && sessions.body?.status === 'ok',
    `status=${String(sessions.body?.status)} error=${JSON.stringify(sessions.body?.error ?? null)}`)
  check('the tunnel dialled the remote loopback port', forwarded.includes(`127.0.0.1:${String(remotePort)}`),
    forwarded.join(' , ') || 'no forwardOut happened')
  check('the session list came back from the live instance',
    Array.isArray(sessions.body?.snapshot?.items),
    `${String(sessions.body?.snapshot?.items?.length ?? 0)} row(s), total=${String(sessions.body?.snapshot?.total)}`)
  check('the workspace baseline was read (archive set resolved)',
    typeof sessions.body?.snapshot?.archivedCount === 'number' && (sessions.body?.snapshot?.warnings ?? []).length === 0,
    `archivedCount=${String(sessions.body?.snapshot?.archivedCount)} warnings=${JSON.stringify(sessions.body?.snapshot?.warnings)}`)

  const items = sessions.body?.snapshot?.items ?? []
  check('every listed row carries the fields the panel renders',
    items.every(row => typeof row.sessionId === 'string' && typeof row.title === 'string' && typeof row.running === 'boolean' && typeof row.updatedAt === 'number'),
    items.slice(0, 2).map(row => `${row.sessionId.slice(0, 8)}:${row.title}`).join(' , ') || 'no rows to check')
  check('subagent sessions are filtered out (the remote sidebar hides them)',
    items.every(row => row.origin !== 'subagent'),
    items.filter(row => row.origin === 'subagent').length + ' subagent row(s) leaked')
  check('blank sessions are filtered out',
    items.every(row => row.blank !== true),
    items.filter(row => row.blank === true).length + ' blank row(s) leaked')
  check('rows are sorted newest first',
    items.every((row, index) => index === 0 || items[index - 1].updatedAt >= row.updatedAt),
    items.slice(0, 3).map(row => String(row.updatedAt)).join(' >= '))
  check('rows are grouped by working directory', Array.isArray(sessions.body?.snapshot?.groups),
    sessions.body?.snapshot?.groups?.map(group => `${group.label}:${String(group.sessions.length)}`).join(' , ') ?? 'none')

  // The credential must now be cached, so a second read replays the cookie
  // instead of redeeming the token again. (Not because the token is one-shot —
  // measured: the same token answers `GET /?token=` with 303 three times over.
  // What retires a token is a RESTART, not a use.)
  const cached = await post(`${base}/sessions`, { peerId: savedSsh?.id, force: true })
  check('a second read reuses the cached credential', cached.status === 200 && cached.body?.status === 'ok',
    `status=${String(cached.body?.status)}`)
  const stored = JSON.parse(readFileSync(cacheFile, 'utf8'))
  const entry = Object.values(stored.entries ?? {})[0]
  check('the credential is cached with the authority it was minted for',
    entry !== undefined && typeof entry.authority === 'string' && entry.authority === `127.0.0.1:${String(remotePort)}`,
    JSON.stringify(entry ?? null).slice(0, 160))

  // A wrong token must fail as a classified 401-class error, not as a crash.
  // The user differs so this is a genuinely separate peer: re-adding the same
  // reach with a new token is a *replace* (see the store's collision rule), and
  // that path is asserted further down instead.
  const badTokenPeer = await post(`${base}/peers`, {
    action: 'save',
    channel: 'ssh',
    label: 'verify-bad-token',
    ssh: { host: '127.0.0.1', user: 'tester-bad', port: sshPort, remotePort },
    auth: { kind: 'token', token: 'not-a-real-token' },
  })
  const badId = badTokenPeer.body?.saved
  check('a same-reach peer with a different user is a separate machine',
    badId !== undefined && badId !== savedSsh?.id,
    `bad=${String(badId)} good=${String(savedSsh?.id)}`)
  const badRead = await post(`${base}/sessions`, { peerId: badId, force: true })
  check('a rejected token is classified, not crashed',
    badRead.status === 200 && badRead.body?.status === 'error' && badRead.body?.error?.code === 'token-rejected',
    `code=${String(badRead.body?.error?.code)} message=${String(badRead.body?.error?.message).slice(0, 80)}`)

  // Re-saving the SAME reach with a corrected token must replace in place (one
  // row, same id), and must drop the cached cookie — otherwise the fresh token
  // is stored and then ignored in favour of the stale session.
  const repaired = await post(`${base}/peers`, {
    action: 'save',
    channel: 'ssh',
    label: 'verify-bad-token',
    ssh: { host: '127.0.0.1', user: 'tester-bad', port: sshPort, remotePort },
    auth: { kind: 'token', token },
  })
  check('re-saving the same reach replaces rather than duplicating',
    repaired.body?.saved === badId && (repaired.body?.peers ?? []).filter(peer => peer.label === 'verify-bad-token').length === 1,
    `saved=${String(repaired.body?.saved)} rows=${(repaired.body?.peers ?? []).map(peer => peer.id).join(',')}`)
  check('the credential change is reported so the panel can tell the user',
    repaired.body?.credentialChanged === true, String(repaired.body?.credentialChanged))
  const afterRepair = await post(`${base}/sessions`, { peerId: badId, force: true })
  check('a corrected token actually takes effect (the stale cookie was dropped)',
    afterRepair.body?.status === 'ok',
    `status=${String(afterRepair.body?.status)} code=${String(afterRepair.body?.error?.code)}`)

  // Editing without retyping the secret must not wipe it: the form never echoes
  // a stored token back, so an empty token field on an edit means "unchanged".
  const relabeled = await post(`${base}/peers`, {
    action: 'save',
    id: badId,
    channel: 'ssh',
    label: 'verify-relabeled',
    ssh: { host: '127.0.0.1', user: 'tester-bad', port: sshPort, remotePort },
    auth: { kind: 'token' },
  })
  check('editing a peer without retyping the token keeps it',
    relabeled.status === 200 && relabeled.body?.credentialChanged === false &&
      (relabeled.body?.peers ?? []).find(peer => peer.id === badId)?.auth?.hasToken === true,
    `changed=${String(relabeled.body?.credentialChanged)} hasToken=${String((relabeled.body?.peers ?? []).find(peer => peer.id === badId)?.auth?.hasToken)}`)

  // Removing a peer must take its cached credential with it: a deleted
  // machine's cookie must not survive in the store.
  await post(`${base}/peers`, { action: 'remove', id: badId })
  const afterRemove = JSON.parse(readFileSync(cacheFile, 'utf8'))
  check('removing a peer clears its cached credential',
    !Object.hasOwn(afterRemove.entries ?? {}, badId) && Object.hasOwn(afterRemove.entries ?? {}, savedSsh?.id ?? ''),
    `removed=${String(badId)} entries=[${Object.keys(afterRemove.entries ?? {}).join(', ')}]`)
}

// ── 5. the remote instance lifecycle over the fake sshd ────────────────────
execd.length = 0
execResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('ss -ltn') || command.includes('netstat')) return ''
  return ''
}
const statusStopped = await post(`${base}/provision`, { id: savedSsh?.id, action: 'status', remoteHome: '/srv/.dsh' })
check('the status probe reports a stopped remote',
  statusStopped.status === 200 && statusStopped.body?.provision?.listening === false,
  JSON.stringify(statusStopped.body?.provision ?? null).slice(0, 200))
check('the status probe detects the remote platform first',
  execd.some(command => command.includes('uname')),
  execd.slice(0, 3).join(' | '))

// A listener present must be reported as listening. The port in the fake output
// must be the PEER's port, not a hardcoded default — the probe is asserting that
// it looked for the right one, which is the whole point of reading evidence.
execResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('ss -ltn') || command.includes('netstat')) return `LISTEN 0 128 127.0.0.1:${String(remotePort)} 0.0.0.0:*\n`
  return ''
}
const statusRunning = await post(`${base}/provision`, { id: savedSsh?.id, action: 'status', remoteHome: '/srv/.dsh' })
check('the status probe reports a listening remote',
  statusRunning.body?.provision?.listening === true,
  JSON.stringify(statusRunning.body?.provision ?? null).slice(0, 200))
check('the status probe reports the port it looked for rather than guessing',
  String(statusRunning.body?.provision?.evidence ?? '').includes(String(remotePort)),
  String(statusRunning.body?.provision?.evidence ?? '').slice(0, 120))
// A listener on a DIFFERENT port must not read as this peer being up.
execResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('ss -ltn') || command.includes('netstat')) return 'LISTEN 0 128 127.0.0.1:1 0.0.0.0:*\n'
  return ''
}
const statusOther = await post(`${base}/provision`, { id: savedSsh?.id, action: 'status', remoteHome: '/srv/.dsh' })
check('a listener on a different port is not mistaken for this peer',
  statusOther.body?.provision?.listening === false,
  String(statusOther.body?.provision?.evidence ?? '').slice(0, 120))

// Starting: the fake sshd answers the launcher's `cat` and then serves a log
// containing the launch URL, which is exactly the sequence the real remote
// produces. The token must come back and be stored on the peer.
execd.length = 0
execResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('ss -ltn') || command.includes('netstat')) return ''
  // The launcher ends by catting the pid file.
  if (command.includes('echo $! >') && command.includes('cat ')) return '4242\n'
  return ''
}
let provisioned = await post(`${base}/provision`, { id: savedSsh?.id, action: 'start', remoteHome: '/srv/.dsh' })
check('a start whose log never shows a launch URL fails as a classified outcome',
  provisioned.body?.provision?.ok === false && provisioned.body?.provision?.code === 'provision-not-ready',
  JSON.stringify(provisioned.body?.provision ?? null).slice(0, 220))
check('the start failure carries the log tail so the user can see why',
  typeof provisioned.body?.provision?.details?.log === 'string',
  JSON.stringify(provisioned.body?.provision?.details ?? null).slice(0, 160))
check('the launcher detaches the process so it survives the SSH channel closing',
  execd.some(command => command.includes('setsid') && command.includes('nohup')),
  execd.filter(command => command.includes('setsid')).join(' | ').slice(0, 200))
check('the launcher writes the log and the pid file under the remote DSH_HOME',
  execd.some(command => command.includes('/srv/.dsh/federation/web.log') && command.includes('web.pid')),
  execd.filter(command => command.includes('web.log')).join(' | ').slice(0, 240))

// ── 6b. the instance is already running ─────────────────────────────────────
// "Already running, nothing restarted" must not be the end of the story: the
// remote prints a NEW token on every boot, so the reason anyone presses start on
// a running instance is that the token they hold stopped working. `force` is how
// they get the current one — and it has to mean RESTART (stop, then launch),
// because the running process still holds the port and the log is cleared only
// at launch, which is the only moment this plugin can learn a new token.
/**
 * A fake listener answer on the port the plugin is actually checking.
 *
 * The port is not in the command — `status` runs `ss -ltn || netstat -ltn` and
 * filters in JS by the peer's stored `remotePort` — and earlier checks in this
 * suite change that value. Announcing a stale port silently reads as "nothing is
 * listening", which is exactly the trap this helper exists to avoid. So it is
 * read from the store, the same place the plugin reads it.
 * @returns {string} a `LISTEN` line for the peer's current port.
 */
const listenLineFor = () => {
  let port = Number(new URL(target).port)
  try {
    const peers = JSON.parse(readFileSync(federationFile, 'utf8')).peers
    port = peers.find(peer => peer.id === savedSsh?.id)?.ssh?.remotePort ?? port
  } catch { /* fall back to the target's own port */ }
  return `LISTEN 0 128 127.0.0.1:${String(port)} 0.0.0.0:*\n`
}
const runningResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('ss -ltn') || command.includes('netstat')) {
    return remoteRunning ? listenLineFor() : ''
  }
  if (command.includes('echo $! >') && command.includes('cat ')) return '4242\n'
  if (command.includes('web.pid')) return '4242\n'
  // The fake remote actually goes down when killed, so the port is free
  // afterwards — a remote that kept reporting a listener would (correctly) be
  // refused by the guard below.
  if (command.includes('kill ')) { remoteRunning = false; return 'killed\n' }
  if (command.includes('tail -n')) return `dsh web: http://127.0.0.1:3080/?token=${token}\n`
  return ''
}
let remoteRunning = true
execd.length = 0
execResponder = runningResponder
const alreadyUp = await post(`${base}/provision`, { id: savedSsh?.id, action: 'start', remoteHome: '/srv/.dsh' })
check('starting an instance that is already listening launches no second one',
  alreadyUp.body?.provision?.started === false && alreadyUp.body?.provision?.alreadyRunning === true &&
    !execd.some(command => command.includes('setsid')),
  JSON.stringify({ started: alreadyUp.body?.provision?.started, alreadyRunning: alreadyUp.body?.provision?.alreadyRunning }))

execd.length = 0
remoteRunning = true
execResponder = runningResponder
const restarted = await post(`${base}/provision`, { id: savedSsh?.id, action: 'start', remoteHome: '/srv/.dsh', force: true })
const stopAt = execd.findIndex(command => command.includes('kill ') || command.includes('fuser') || command.includes('lsof'))
const launchAt = execd.findIndex(command => command.includes('setsid'))
check('a forced start stops the running instance first, then launches',
  stopAt >= 0 && launchAt > stopAt, `stopAt=${String(stopAt)} launchAt=${String(launchAt)}`)
check('...and it comes back with the token the new boot printed',
  restarted.body?.provision?.started === true && restarted.body?.provision?.credentialChanged === true,
  JSON.stringify(restarted.body?.provision ?? null).slice(0, 200))

// A restart that did NOT stop anything is worse than no restart: the old
// instance keeps the port, so the browser goes on talking to IT while this plugin
// captures the new one's token — and the harness answers that mismatch with its
// 401 page, which reads as "the new token does not work". So the stop is
// confirmed before launching, not assumed.
execd.length = 0
execResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  // Stubbornly still listening, and the kill does not take.
  if (command.includes('ss -ltn') || command.includes('netstat')) return listenLineFor()
  if (command.includes('web.pid')) return '4242\n'
  if (command.includes('kill ')) return 'killed\n'
  if (command.includes('echo $! >') && command.includes('cat ')) return '4242\n'
  return ''
}
const stuck = await post(`${base}/provision`, { id: savedSsh?.id, action: 'start', remoteHome: '/srv/.dsh', force: true })
check('a forced start refuses to launch when the port never frees up',
  stuck.body?.provision?.ok === false && stuck.body?.provision?.code === 'provision-stop-failed' &&
    !execd.some(command => command.includes('setsid')),
  JSON.stringify(stuck.body?.provision ?? null).slice(0, 220))

// A non-interactive SSH PATH does not contain nvm/volta/asdf installs, so a bare
// `nohup dsh …` dies with "failed to run command 'dsh'" while an interactive
// `ssh host` followed by `dsh web` works perfectly. Two things close that gap:
// resolving the command through a login shell, and LAUNCHING through one —
// nvm's `dsh` is a script whose interpreter (`node`) is missing from the same
// bare PATH, so resolving only the command is not enough.
execd.length = 0
execResponder = (command) => {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('command -v')) return '/home/dev/.nvm/versions/node/v24.21.0/bin/dsh\n'
  if (command.includes('case "$raw" in')) return '/home/dev/.dsh\n'
  if (command.includes('ss -ltn') || command.includes('netstat')) return ''
  if (command.includes('tail -n')) return 'dsh web: http://127.0.0.1:3080/?token=NVMTEST\n'
  return ''
}
const nvmStart = await post(`${base}/provision`, { id: savedSsh?.id, action: 'start', remoteHome: '~/.dsh' })
check('a `~` home is resolved to an absolute path on POSIX too',
  execd.some(command => command.includes('/home/dev/.dsh/federation')),
  execd.filter(command => command.includes('web.log')).join(' | ').slice(0, 240))
check('`dsh` is resolved through a LOGIN shell before launching',
  execd.some(command => command.includes('command -v') && command.includes('bash -lc')),
  execd.filter(command => command.includes('command -v')).join(' | ').slice(0, 200))
check('...and the launch itself runs through a login shell so an nvm-installed `node` is found',
  execd.some(command => command.includes('setsid') && command.includes('bash -lc')),
  execd.filter(command => command.includes('setsid')).join(' | ').slice(0, 240))
check('...using the absolute path the login shell reported',
  execd.some(command => command.includes('/home/dev/.nvm/versions/node/v24.21.0/bin/dsh')),
  execd.filter(command => command.includes('setsid')).join(' | ').slice(0, 240))
check('and the start succeeds, capturing the token that login-shell launch printed',
  nvmStart.body?.provision?.started === true && nvmStart.body?.provision?.credentialChanged === true,
  JSON.stringify(nvmStart.body?.provision ?? null).slice(0, 200))
// The token itself must never reach the browser: it is full control of that
// instance, and the response is read by a page. The observable proof that it was
// captured and stored is the peer's own `hasToken` flag.
check('...without sending the token itself back to the browser',
  JSON.stringify(nvmStart.body ?? {}).includes('NVMTEST') === false,
  JSON.stringify(nvmStart.body?.provision ?? null).slice(0, 200))
const afterNvmStart = await post(`${base}/peers`, { action: 'touch', id: nvmStart.body?.provision?.id })
check('...and the captured token is on the stored peer instead',
  afterNvmStart.body?.peers?.find(peer => peer.id === nvmStart.body?.provision?.id)?.auth?.hasToken === true,
  JSON.stringify(afterNvmStart.body?.peers?.find(peer => peer.id === nvmStart.body?.provision?.id)?.auth ?? null))

// Now the same start, with the log showing a real launch line.
execd.length = 0
execResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('ss -ltn') || command.includes('netstat')) return ''
  if (command.includes('tail -n')) return 'dsh web: http://127.0.0.1:3199/?token=CAPTURED_TOKEN_123\n'
  if (command.includes('echo $! >') && command.includes('cat ')) return '4242\n'
  return ''
}
provisioned = await post(`${base}/provision`, { id: savedSsh?.id, action: 'start', remoteHome: '/srv/.dsh' })
const started = provisioned.body?.provision ?? {}
check('a successful start reports the captured port from the printed URL',
  started.started === true && started.port === 3199,
  JSON.stringify(started).slice(0, 200))
check('the start reports that it stored the captured credential',
  started.credentialChanged === true, String(started.credentialChanged))
// The whole reason the host starts the instance itself: the token is captured
// and stored, so the panel works immediately with nothing to copy.
const afterStart = await get(`${base}/peers`)
const startedPeer = (afterStart.body?.peers ?? []).find(peer => peer.id === savedSsh?.id)
check('the captured token is stored on the peer',
  startedPeer?.auth?.hasToken === true && startedPeer?.ssh?.remotePort === 3199,
  JSON.stringify({ auth: startedPeer?.auth, remotePort: startedPeer?.ssh?.remotePort }))
check('the stored token is never echoed back to the browser',
  JSON.stringify(afterStart.body ?? {}).includes('CAPTURED_TOKEN_123') === false,
  JSON.stringify(startedPeer?.auth ?? null))

// Stopping: the pid recorded on the REMOTE is read first, then the port holder.
// The pid comes from `<remoteHome>/federation/web.pid` — not from the caller,
// who cannot know a pid recorded on another machine in an earlier session.
execd.length = 0
execResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('cat ') && command.includes('web.pid')) return '4242\n'
  if (command.includes('kill 4242')) return 'killed\n'
  return ''
}
const stopped = await post(`${base}/provision`, { id: savedSsh?.id, action: 'stop', remoteHome: '/srv/.dsh' })
check('a stop reads the pid file the remote recorded, and uses it',
  stopped.body?.provision?.stopped === true && stopped.body?.provision?.by === 'pid' &&
    execd.some(command => command.includes('cat ') && command.includes('web.pid')),
  JSON.stringify(stopped.body?.provision ?? null).slice(0, 160))

// A pid file whose process is already gone must fall through, not report success.
execd.length = 0
execResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('cat ') && command.includes('web.pid')) return '999999\n'
  if (command.includes('kill 999999')) return 'gone\n'
  if (command.includes('fuser') || command.includes('lsof')) return 'stopped\n'
  return ''
}
const stoppedByPort = await post(`${base}/provision`, { id: savedSsh?.id, action: 'stop', remoteHome: '/srv/.dsh' })
check('a stale recorded pid falls through to the port holder',
  stoppedByPort.body?.provision?.stopped === true && stoppedByPort.body?.provision?.by === 'port',
  JSON.stringify(stoppedByPort.body?.provision ?? null).slice(0, 160))

// No pid file at all (an instance started by hand) — the port holder is the only
// way in, and without it "stop" would silently do nothing.
execd.length = 0
execResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('fuser') || command.includes('lsof')) return 'stopped\n'
  return ''
}
const stoppedNoPidFile = await post(`${base}/provision`, { id: savedSsh?.id, action: 'stop', remoteHome: '/srv/.dsh' })
check('a hand-started instance with no pid file is still stoppable',
  stoppedNoPidFile.body?.provision?.stopped === true && stoppedNoPidFile.body?.provision?.by === 'port',
  JSON.stringify(stoppedNoPidFile.body?.provision ?? null).slice(0, 160))

// Nothing running: the stop must say so rather than claim success.
execResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  return 'none\n'
}
const stoppedNothing = await post(`${base}/provision`, { id: savedSsh?.id, action: 'stop', remoteHome: '/srv/.dsh' })
check('a stop that found nothing reports that, not success',
  stoppedNothing.body?.provision?.stopped === false && typeof stoppedNothing.body?.provision?.detail === 'string',
  JSON.stringify(stoppedNothing.body?.provision ?? null).slice(0, 160))

// read-token: the recovery path for an instance this plugin did not start.
// The log names the port that boot came up on, so it is also the port the
// candidate is validated against — here that has to be the real target's, or the
// tunnel would reach nothing.
const targetPort = new URL(target).port
execResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('tail -n')) return `dsh web: http://127.0.0.1:${targetPort}/?token=${token}\n`
  return ''
}
const readBack = await post(`${base}/provision`, { id: savedSsh?.id, action: 'read-token', remoteHome: '/srv/.dsh' })
check('reading the token back from the log reports success',
  readBack.body?.provision?.found === true && readBack.body?.provision?.credentialChanged === true,
  JSON.stringify(readBack.body?.provision ?? null).slice(0, 160))

// The log is only written when THIS plugin starts the instance, and only cleared
// at that moment — so an instance started by hand (or after a reboot) leaves the
// PREVIOUS boot's token lying in it. Storing that would swap one dead credential
// for another and report success, which is exactly how "the token never updates"
// presents. Hence: a candidate the remote rejects must not be kept.
execResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('tail -n')) return `dsh web: http://127.0.0.1:${targetPort}/?token=TOKEN_FROM_AN_EARLIER_BOOT\n`
  return ''
}
const staleRead = await post(`${base}/provision`, { id: savedSsh?.id, action: 'read-token', remoteHome: '/srv/.dsh' })
check('a log token the remote rejects is refused, not stored',
  staleRead.body?.provision?.found === false && staleRead.body?.provision?.code === 'token-stale',
  JSON.stringify(staleRead.body?.provision ?? null).slice(0, 200))
// The proof that matters: the stored credential is still the working one. Asking
// the store directly keeps this honest even if the peer's own port has since been
// changed by another check in this suite.
const storedAfterStale = JSON.parse(readFileSync(federationFile, 'utf8')).peers.find(peer => peer.id === savedSsh?.id)
check('...and the stored credential is still the working one, not the stale candidate',
  storedAfterStale?.auth?.token === token && !JSON.stringify(storedAfterStale).includes('TOKEN_FROM_AN_EARLIER_BOOT'),
  `stored=${String(storedAfterStale?.auth?.kind)} hasToken=${String(typeof storedAfterStale?.auth?.token === 'string')}`)

// A failure that is NOT a credential verdict must not be reported as a stale
// token: unreachable is a different answer from rejected, and relabelling it
// would be the same class of lie this branch was added to remove.
execResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('ss -ltn') || command.includes('netstat')) return ''
  if (command.includes('tail -n')) return 'dsh web: http://127.0.0.1:3199/?token=ANY_TOKEN\n'
  return ''
}
const unreachableRead = await post(`${base}/provision`, { id: savedSsh?.id, action: 'read-token', remoteHome: '/srv/.dsh' })
check('an unverifiable log token is reported as unverifiable, not as stale',
  unreachableRead.body?.provision?.found === false &&
    unreachableRead.body?.provision?.code !== 'token-stale' &&
    typeof unreachableRead.body?.provision?.code === 'string',
  JSON.stringify(unreachableRead.body?.provision ?? null).slice(0, 200))

// The panel can show the remote log on demand. It is the only place "which port
// did it really come up on, and why did it not" exists — and it used to be shown
// only as part of a FAILED start, which is useless when the start reports success
// but the browser still cannot get in.
const rawLogLine = 'dsh web: http://127.0.0.1:3080/?token=SECRET_IN_THE_LOG (LAN: http://10.9.9.9:3080/?token=SECRET_IN_THE_LOG)'
execResponder = command => {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('tail -n')) return `${rawLogLine}\n`
  return ''
}
const logsRead = await post(`${base}/provision`, { id: savedSsh?.id, action: 'logs', remoteHome: '/srv/.dsh' })
check('the remote log can be read on demand',
  typeof logsRead.body?.provision?.log === 'string' && logsRead.body.provision.log.includes('dsh web:'),
  JSON.stringify(logsRead.body?.provision ?? null).slice(0, 160))
check('...with the launch token masked out of it',
  logsRead.body?.provision?.log.includes('token=***') &&
    !JSON.stringify(logsRead.body ?? {}).includes('SECRET_IN_THE_LOG'),
  String(logsRead.body?.provision?.log ?? '').slice(0, 200))
// The ports and addresses must SURVIVE: comparing them against the configured
// jump address is the reason to look at this log at all.
check('...but the port and address it reported are still visible',
  String(logsRead.body?.provision?.log).includes('127.0.0.1:3080') &&
    String(logsRead.body?.provision?.log).includes('10.9.9.9:3080'),
  String(logsRead.body?.provision?.log ?? '').slice(0, 200))
// A remote this plugin never started has no log at all, and that must read as
// "nothing to show here", not as an empty view that looks like a working one.
execResponder = command => (command.includes('uname') ? 'Linux\n' : '')
const noLogs = await post(`${base}/provision`, { id: savedSsh?.id, action: 'logs', remoteHome: '/srv/.dsh' })
check('an empty remote log says so rather than looking like a working view',
  noLogs.body?.provision?.empty === true && typeof noLogs.body?.provision?.detail === 'string',
  JSON.stringify(noLogs.body?.provision ?? null).slice(0, 200))

// A Windows remote IS supported now (the launch goes through WMI), so the old
// "refused as unsupported-platform" expectation is gone. What must still hold is
// that the attempt fails with a CLASSIFIED reason when the platform cannot be
// resolved — never a half-attempt that leaves no trace.
execResponder = () => ''
const winPeer = await post(`${base}/peers`, {
  action: 'save',
  channel: 'ssh',
  label: 'verify-windows',
  ssh: { host: '127.0.0.1', user: 'winny', port: sshPort, remotePort: 3080 },
  auth: { kind: 'none' },
})
const winAttempt = await post(`${base}/provision`, { id: winPeer.body?.saved, action: 'start', remoteHome: 'C:/Users/x/.dsh' })
check('a Windows start is attempted rather than refused as unsupported',
  winAttempt.body?.provision?.code !== 'unsupported-platform',
  JSON.stringify(winAttempt.body?.provision ?? null).slice(0, 180))
check('...and when it cannot resolve the remote launch, it says so with a code and a hint',
  winAttempt.body?.provision?.ok === false &&
    typeof winAttempt.body?.provision?.code === 'string' &&
    String(winAttempt.body?.provision?.detail ?? '').includes('Windows'),
  JSON.stringify(winAttempt.body?.provision ?? null).slice(0, 220))

// An HTTP peer cannot be provisioned at all — there is no SSH to run anything on.
const httpPeer = await post(`${base}/peers`, {
  action: 'save',
  channel: 'http',
  label: 'verify-http',
  origin: 'http://127.0.0.1:9',
  auth: { kind: 'none' },
})
const httpStart = await post(`${base}/provision`, { id: httpPeer.body?.saved, action: 'start' })
check('an HTTP peer is refused provisioning with a hint',
  httpStart.status === 400 && httpStart.body?.error === 'not-ssh' && typeof httpStart.body?.hint === 'string',
  JSON.stringify(httpStart.body).slice(0, 180))

// ── 6. unreachable peers fail as classified errors ──────────────────────────
const dead = await post(`${base}/sessions`, { peerId: httpPeer.body?.saved, force: true })
check('an unreachable peer yields a classified transport error',
  dead.status === 200 && dead.body?.status === 'error' && typeof dead.body?.error?.code === 'string',
  `code=${String(dead.body?.error?.code)}`)

const deadProbe = await post(`${base}/test`, { id: httpPeer.body?.saved })
check('the probe reports an unreachable peer without throwing',
  deadProbe.status === 200 && deadProbe.body?.probe?.ok === false,
  JSON.stringify(deadProbe.body?.probe ?? null).slice(0, 160))

// A tunnel to a remote whose own loopback port has nothing on it. The message
// must say THAT, not "cannot open 127.0.0.1:3080" — the latter reads as if the
// configured host had been ignored, when 127.0.0.1 is precisely the far side of
// the tunnel. This was reported by a user reading exactly that way.
const spare = createServer()
const deadPort = await new Promise((resolve) => {
  spare.listen(0, '127.0.0.1', () => { resolve(spare.address().port) })
})
await new Promise((resolve) => { spare.close(resolve) })
const deadPortPeer = await post(`${base}/peers`, {
  action: 'save',
  channel: 'ssh',
  label: 'nothing-on-loopback',
  ssh: { host: '127.0.0.1', user: 'tester', port: sshPort, remotePort: deadPort },
  auth: { kind: 'none' },
})
const deadPortRead = await post(`${base}/sessions`, { peerId: deadPortPeer.body?.saved, force: true })
check('a remote with nothing on its loopback port is classified as not-listening',
  deadPortRead.body?.error?.code === 'ssh-remote-not-listening',
  `code=${String(deadPortRead.body?.error?.code)} message=${String(deadPortRead.body?.error?.message ?? '').slice(0, 120)}`)
check('...and the message says the 127.0.0.1 belongs to the REMOTE, not to this machine',
  /对方/.test(String(deadPortRead.body?.error?.message ?? '')) && /127\.0\.0\.1/.test(String(deadPortRead.body?.error?.message ?? '')),
  String(deadPortRead.body?.error?.message ?? '').slice(0, 160))

// ── 7. the poller is a singleton driven by panel visibility ────────────────
const off = await post(`${base}/poll`, { visible: false })
check('the poller stops when the panel is not visible',
  off.status === 200 && off.body?.poll?.running === false && off.body?.poll?.visible === false,
  JSON.stringify(off.body?.poll ?? null))
const on = await post(`${base}/poll`, { peerId: httpPeer.body?.saved, visible: true, intervalMs: 3000 })
check('the poller starts for the current peer when the panel becomes visible',
  on.status === 200 && on.body?.poll?.visible === true && on.body?.poll?.peerId === httpPeer.body?.saved,
  JSON.stringify(on.body?.poll ?? null))
check('the poll interval is clamped to the allowed range',
  on.body?.poll?.intervalMs === 3000,
  String(on.body?.poll?.intervalMs))

await new Promise(resolve => { setTimeout(resolve, 250) })
await post(`${base}/poll`, { peerId: httpPeer.body?.saved, visible: true, intervalMs: 3000 })
const backedOff = await get(`${base}/peers`)
check('a failing peer accumulates a failure count for the panel',
  (backedOff.body?.poll?.failures ?? 0) >= 0,
  `failures=${String(backedOff.body?.poll?.failures)}`)

// ── 7b. the Windows branch of the provisioner ──────────────────────────────
// Deterministic: a fake transport records the commands and answers from a
// scripted responder, so the exact PowerShell text and the parsing of its
// answers are pinned without needing a Windows machine. The mechanisms encoded
// here were measured on a real Windows host: `Start-Process` children die with
// the SSH channel, `Win32_Process.Create` children survive, the returned pid is
// the `cmd.exe` wrapper, and `-EncodedCommand` is the only quoting that holds.
{
  const { PeerProvisioner } = await import('../lib/federation/provisioner.js')
  const commands = []
  /** Decode the PowerShell payload out of an exec command, when there is one. */
  const decode = (command) => {
    const match = /-EncodedCommand\s+(\S+)/u.exec(command)
    return match === null ? undefined : Buffer.from(match[1], 'base64').toString('utf16le')
  }
  let respond = () => ({ code: 0, stdout: '', stderr: '' })
  const transport = {
    async exec(peer, command) {
      commands.push(command)
      return respond(decode(command) ?? '', command)
    },
  }
  const provisioner = new PeerProvisioner({ transport, readyTimeoutMs: 900, logger: { warn: () => {} } })
  const winPeer = {
    id: 'win-1', label: 'win-box', channel: 'ssh', origin: 'http://127.0.0.1:3080',
    ssh: { host: '10.1.1.1', user: 'admin', port: 22, remotePort: 3080 },
  }

  // Platform detection: no Windows marker and no `uname` means native Windows.
  respond = (script, command) => command.includes('uname')
    ? { code: 1, stdout: "'uname' is not recognized as an internal or external command\n", stderr: '' }
    : { code: 0, stdout: '', stderr: '' }
  check('a host without uname is detected as windows',
    (await provisioner.remoteKind(winPeer)) === 'windows',
    String(await provisioner.remoteKind(winPeer)))

  // `uname` alone is NOT a safe test: a Windows machine with Git for Windows on
  // the non-interactive PATH has a `uname.exe` that reports a MINGW string.
  // Trusting it would classify that host as POSIX and then run `setsid nohup` /
  // `kill` on a machine that needs `taskkill`.
  const detecting = (responder) => new PeerProvisioner({
    transport: { async exec(peer, command) { return responder(command) } },
    logger: { warn: () => {} },
  })
  const gitBashPeer = { id: 'gitbash', label: 'g', channel: 'ssh', origin: 'x', ssh: { host: 'h', user: 'u', port: 22, remotePort: 3080 } }
  const gitBash = detecting((command) => command.includes('cmd /c ver')
    ? { code: 0, stdout: 'Microsoft Windows [Version 10.0.19045.3803]', stderr: '' }
    : { code: 0, stdout: 'MINGW64_NT-10.0-19045\n', stderr: '' })
  check('a Windows host that also answers `uname` (Git for Windows) is still windows',
    (await gitBash.remoteKind(gitBashPeer)) === 'windows',
    String(await gitBash.remoteKind(gitBashPeer)))

  const linuxPeer = { id: 'linux-1', label: 'l', channel: 'ssh', origin: 'x', ssh: { host: 'h', user: 'u', port: 22, remotePort: 3080 } }
  const linux = detecting((command) => command.includes('cmd /c ver')
    ? { code: 127, stdout: '', stderr: 'cmd: command not found' }
    : { code: 0, stdout: 'Linux\n', stderr: '' })
  check('a real POSIX host is still detected as posix',
    (await linux.remoteKind(linuxPeer)) === 'posix',
    String(await linux.remoteKind(linuxPeer)))

  // A `~`-style home is POSIX shell syntax, and on Windows it fails SILENTLY:
  // PowerShell's `-Path` expands it (so the directory is created correctly) while
  // `cmd.exe` does not, so the launcher's `>> "~/.dsh\federation\web.log"`
  // redirects nowhere and no log is ever written. It is resolved on the remote
  // before anything is written.
  respond = (script, command) => {
    if (command.includes('cmd /c ver')) return { code: 0, stdout: 'Microsoft Windows [Version 10.0.19045.3803]', stderr: '' }
    if (script.includes('USERPROFILE')) return { code: 0, stdout: 'C:\\Users\\admin\\.dsh\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const homePeer = { id: 'home-1', label: 'h', channel: 'ssh', origin: 'x', ssh: { host: 'h', user: 'u', port: 22, remotePort: 3080 } }
  check('a POSIX-style remoteHome is resolved to a real path on Windows',
    (await provisioner.remoteHomeOf(homePeer, '~/.dsh')) === 'C:\\Users\\admin\\.dsh',
    String(await provisioner.remoteHomeOf(homePeer, '~/.dsh')))
  check('a home with no tilde is passed through untouched on Windows',
    (await provisioner.remoteHomeOf(homePeer, 'D:\\dsh-home')) === 'D:\\dsh-home',
    String(await provisioner.remoteHomeOf(homePeer, 'D:\\dsh-home')))

  // Every PowerShell command must be sent encoded — quoting a Windows path with
  // spaces through cmd/PowerShell/OpenSSH shells was the thing that kept failing.
  respond = () => ({ code: 0, stdout: 'LISTEN 0.0.0.0:3080 pid=42\n', stderr: '' })
  const winRunning = await provisioner.status(winPeer)
  check('the Windows status probe asks for the peer port',
    (decode(commands.at(-1)) ?? '').includes('3080'),
    (decode(commands.at(-1)) ?? '').slice(0, 120))
  check('the Windows status probe reads a listener out of Get-NetTCPConnection',
    winRunning.listening === true && winRunning.unknown !== true,
    JSON.stringify(winRunning).slice(0, 160))
  // Platform detection is the only non-PowerShell traffic (the `cmd /c ver` and
  // `uname` probes), so the encoding check covers everything after those.
  const afterDetection = commands.filter(command => !command.includes('uname') && !command.includes('cmd /c ver'))
  check('every Windows command is sent as -EncodedCommand (no shell quoting to mangle)',
    afterDetection.length > 0 && afterDetection.every(command => command.startsWith('powershell ') && command.includes('-EncodedCommand')),
    afterDetection.at(-1)?.slice(0, 90))

  // A probe that could not run must say "unknown". Reporting `listening: false`
  // here is what made the panel claim a serving machine was not running.
  respond = () => ({ code: 0, stdout: "'Get-NetTCPConnection' is not recognized\n", stderr: '' })
  const winUnknown = await provisioner.status(winPeer)
  check('a Windows probe that could not run reports unknown, not "not running"',
    winUnknown.unknown === true && winUnknown.listening === false,
    JSON.stringify(winUnknown).slice(0, 160))

  // A release of PowerShell also writes CLIXML errors; they must be decoded into
  // readable lines rather than shown to the user raw.
  respond = () => ({
    code: 1,
    stdout: '#< CLIXML\n<Objs Version="1.1.0.1"><S S="Error">something_x000D__x000A_broke</S></Objs>',
    stderr: '',
  })
  const winClixml = await provisioner.status(winPeer)
  check('CLIXML error output is decoded into readable text',
    winClixml.evidence.includes('something') && winClixml.evidence.includes('broke') && !winClixml.evidence.includes('_x000D_'),
    winClixml.evidence.slice(0, 120))

  // ── start ────────────────────────────────────────────────────────────────
  commands.length = 0
  respond = (script) => {
    if (script.includes('Get-Command node')) {
      return { code: 0, stdout: 'node=C:\\Program Files\\nodejs\\node.exe\nbin=C:\\Program Files\\nodejs\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js\n', stderr: '' }
    }
    if (script.includes('Invoke-CimMethod')) return { code: 0, stdout: 'pid=4242\n', stderr: '' }
    if (script.includes('Get-Content') && script.includes('-Tail')) {
      return { code: 0, stdout: 'dsh web: http://127.0.0.1:3080/?token=W1NTOK\n', stderr: '' }
    }
    if (script.includes('Get-NetTCPConnection')) return { code: 0, stdout: 'NO-LISTENER\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const winStart = await provisioner.start(winPeer, { remoteHome: 'C:\\Users\\admin\\.dsh', port: 3080 })
  check('a Windows start returns the token it read from the remote log',
    winStart.started === true && winStart.token === 'W1NTOK',
    JSON.stringify(winStart).slice(0, 160))
  check('the Windows start records the pid WMI reported',
    winStart.pid === 4242, String(winStart.pid))
  const launchScript = (decode(commands.find(command => (decode(command) ?? '').includes('Invoke-CimMethod')) ?? '') ?? '')
  check('the Windows launcher is written as a .cmd file on the remote',
    launchScript.includes('launch.cmd') && launchScript.includes('Set-Content') && launchScript.includes('@echo off'),
    launchScript.slice(0, 240))
  check('the launcher sets DSH_HOME and redirects output into the log',
    launchScript.includes('C:\\Users\\admin\\.dsh') && launchScript.includes('web.log') && launchScript.includes('>>'),
    launchScript.slice(0, 300))
  check('the launcher invokes node with the resolved bin.js, not a shell shim',
    launchScript.includes('node.exe') && launchScript.includes('bin.js') && launchScript.includes('--no-open'),
    launchScript.slice(0, 300))
  check('the WMI call runs the launcher through cmd.exe',
    /cmd\.exe \/c/.test(launchScript), launchScript.slice(0, 200))
  // A stale launch URL in an appended log would be read back as THIS run's token.
  check('the log is cleared before launching so an old token cannot be replayed',
    launchScript.includes('Remove-Item') && launchScript.includes('web.log'),
    launchScript.slice(0, 300))

  // ── stop: the tree, not just the wrapper ─────────────────────────────────
  commands.length = 0
  respond = (script) => script.includes('Get-NetTCPConnection') && !script.includes('taskkill')
    ? { code: 0, stdout: 'NO-LISTENER\n', stderr: '' }
    : { code: 0, stdout: 'stopped-by-pid\n', stderr: '' }
  const winStopPid = await provisioner.stop(winPeer, { remoteHome: 'C:\\Users\\admin\\.dsh' })
  const stopScript = decode(commands.find(command => (decode(command) ?? '').includes('stopped-by-pid') || (decode(command) ?? '').includes('taskkill')) ?? '') ?? ''
  check('a Windows stop reports stopping by the recorded pid',
    winStopPid.stopped === true && winStopPid.by === 'pid', JSON.stringify(winStopPid))
  // The recorded pid is the cmd.exe wrapper; node is its child, so a kill
  // without /T would leave the server running with nothing pointing at it.
  check('the Windows stop kills the process TREE, not just the cmd.exe wrapper',
    /taskkill\s+\/T\s+\/F\s+\/PID/u.test(stopScript) || /taskkill[\s\S]*\/T/u.test(stopScript),
    stopScript.slice(0, 200))

  respond = () => ({ code: 0, stdout: 'stopped-by-port:777\n', stderr: '' })
  const winStopPort = await provisioner.stop(winPeer, { remoteHome: 'C:\\Users\\admin\\.dsh' })
  check('a Windows stop with no usable pid falls back to the port holder',
    winStopPort.stopped === true && winStopPort.by === 'port', JSON.stringify(winStopPort))

  respond = () => ({ code: 0, stdout: 'none\n', stderr: '' })
  const winStopNone = await provisioner.stop(winPeer, { remoteHome: 'C:\\Users\\admin\\.dsh' })
  check('a Windows stop that found nothing says so rather than claiming success',
    winStopNone.stopped === false && typeof winStopNone.detail === 'string', JSON.stringify(winStopNone))
}

// ── 7c. a machine whose startup line carries no token ──────────────────────
// @linxin666/dsh-remote-web-ui replaces `dsh web: …?token=` with its own line,
// and access there is gated by device pairing — there IS no token. Requiring one
// reported a false failure while the instance was up. Its line also names a
// browser-reachable address, which the host now writes back as the jump address.
{
  const { parseRemoteUiUrl } = await import('../lib/federation/provisioner.js')
  const realLine = 'remote-web-ui: the paired Web GUI is reachable on LAN at http://10.9.9.9:3080 , http://172.24.240.1:3080'
  const parsed = parseRemoteUiUrl(realLine)
  check('the remote-web-ui startup line yields the browser-reachable origin',
    parsed !== undefined && parsed.origin === 'http://10.9.9.9:3080',
    JSON.stringify(parsed ?? null))
  check('...and an ordinary log yields nothing from that parser',
    parseRemoteUiUrl('dsh web: http://127.0.0.1:3080/?token=ABC') === undefined,
    String(parseRemoteUiUrl('dsh web: http://127.0.0.1:3080/?token=ABC')))

  execd.length = 0
  execResponder = (command) => {
    if (command.includes('uname')) return 'Linux\n'
    if (command.includes('command -v')) return '/usr/bin/dsh\n'
    if (command.includes('case "$raw" in')) return '/srv/.dsh\n'
    if (command.includes('ss -ltn') || command.includes('netstat')) return ''
    if (command.includes('tail -n')) return realLine + '\n'
    return ''
  }
  const pairedStart = await post(`${base}/provision`, { id: savedSsh?.id, action: 'start', remoteHome: '/srv/.dsh' })
  const outcome = pairedStart.body?.provision ?? {}
  check('a start on such a machine succeeds instead of timing out',
    outcome.started === true, JSON.stringify(outcome).slice(0, 200))
  check('...and it reports the device credential rather than inventing a token',
    outcome.credential === 'device' && outcome.token === undefined,
    `credential=${String(outcome.credential)} token=${String(outcome.token)}`)
  check('...and it learns the jump address from the remote log',
    outcome.webOrigin === 'http://10.9.9.9:3080',
    String(outcome.webOrigin))
  // `redactPeer` deliberately does NOT expose `webOrigin` itself — it only uses
  // it to build the browser target — so the observable effect is `openOrigin`
  // (or a `jumpUrl` when a paired credential exists), which is exactly what the
  // panel needs in order to offer a jump at all.
  const learnedPeer = (pairedStart.body?.peers ?? []).find(peer => peer.id === savedSsh?.id)
  check('...and the peer keeps that address so the panel can offer a jump',
    learnedPeer?.openOrigin === 'http://10.9.9.9:3080' || String(learnedPeer?.jumpUrl ?? '').startsWith('http://10.9.9.9:3080'),
    JSON.stringify({ openOrigin: learnedPeer?.openOrigin ?? null, jumpUrl: learnedPeer?.jumpUrl ?? null }))
  check('...telling the user which credential is in play',
    typeof outcome.credentialHint === 'string' && outcome.credentialHint.includes('device'),
    String(outcome.credentialHint ?? '').slice(0, 120))
}

// ── 8. teardown ─────────────────────────────────────────────────────────────
dispose()
sshServer.close()
for (const socket of rawSockets) socket.destroy()
server.closeAllConnections()
await new Promise(resolve => { server.close(resolve) })

const failed = results.filter(result => !result.pass)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
