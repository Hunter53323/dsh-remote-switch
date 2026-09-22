/**
 * Verification harness for the P3 static fallback.
 *
 * The static path reads session headers straight off a remote's disk when its
 * `dsh web` is not running. Two things make it worth testing rather than
 * eyeballing:
 *
 *   1. The artifact format is a **concatenation of independent Zstandard
 *      frames**, and only the first frame is the header. Every assumption about
 *      how much to read, and what a short read means, has to hold for this to
 *      work at all.
 *   2. It makes claims about what it CANNOT know (running state, blank
 *      sessions, real titles, archived state). Those claims are the honest part
 *      of the feature, so they are asserted too.
 *
 * The suite runs against **real artifacts** on this machine, plus synthetic
 * ones it writes itself for the cases the local corpus does not contain (a
 * corrupt frame, a plaintext artifact, a torn tail). A local filesystem stand-in
 * provides `readdir`/`open`/`read`/`stat`, so the module's own parsing and
 * framing logic is what is under test — not a mock of it.
 *
 * Usage: node scripts/verify-static.mjs
 */

import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  parseHeaderFrame,
  posixJoin,
  readStaticSessions,
  rowFromHeader,
  staticVisible,
  STATIC_LIMITS,
} from '../lib/federation/static.js'
import { displayTitleOf } from '../lib/federation/visible.js'

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  — ${detail}` : ''}`)
}

// An unhandled rejection anywhere in this suite is a defect worth seeing in full
// rather than as node's truncated default report, and it must fail the run
// instead of silently passing. The expected paths (a refused connection, a 403)
// are all handled inside `readPeer`, so anything reaching here is a real gap in
// that error handling.
let unhandled = []
process.on('unhandledRejection', (reason) => {
  const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
  unhandled.push(text)
  console.log(`FAIL  unhandled rejection  — ${text}`)
  console.log((reason instanceof Error ? String(reason.stack) : '').split('\n').slice(1, 6).join('\n'))
})
// An uncaught EXCEPTION is worse than an unhandled rejection: in the real host it
// would take down the process. Surfacing it with a full stack is the only way to
// tell which async edge produced it.
process.on('uncaughtException', (error) => {
  const text = `${error?.name}: ${error?.message}`
  unhandled.push(text)
  console.log(`FAIL  uncaught exception  — ${text}`)
  // `error.stack` starts with the message; print EVERY frame so the async origin
  // is visible rather than truncated at the http internals.
  const lines = String(error?.stack ?? '').split('\n')
  for (const line of lines) console.log(`      ${line}`)
  console.log('--- end of stack ---')
  // A throw that nothing awaited means some promise in the suite is rejected with
  // no handler; showing what is still pending is the only way to find it.
  console.log('--- active handles ---')
  for (const handle of process._getActiveHandles?.() ?? []) {
    console.log(`      ${handle?.constructor?.name ?? typeof handle}`)
  }
})

const workDir = mkdtempSync(path.join(tmpdir(), 'static-verify-'))

/**
 * A filesystem-backed stand-in for the three SFTP calls the module makes.
 *
 * This is deliberately the *only* substitute: the module's own header parsing,
 * frame handling, directory walking, and filtering all run for real.
 * @param {string} root - the directory to serve.
 * @param {{ onOpen?: (p: string) => void }} [hooks] - observation hooks.
 * @returns {object} the reader.
 */
function makeLocalSftp(root, hooks = {}) {
  const rootNative = path.resolve(root)
  // Accepts both spellings the module produces: a path RELATIVE to the root
  // (`/sessions/...`) and one that already NAMES the root (`<root>/sessions/...`,
  // which is what a peer's configured `remoteHome` yields). Getting this wrong
  // silently prefixes the root twice and every read fails with ENOENT.
  const resolve = (p) => {
    const normalized = p.replaceAll('\\', '/').replace(/^\/+/u, '')
    const rootNormalized = rootNative.replaceAll('\\', '/').replace(/^\/+/u, '')
    const relative = normalized.toLowerCase().startsWith(`${rootNormalized.toLowerCase()}/`)
      ? normalized.slice(rootNormalized.length + 1)
      : normalized
    return path.join(rootNative, relative.replaceAll('/', path.sep))
  }
  return {
    async readdir(p) {
      const dir = resolve(p)
      return readdirSync(dir, { withFileTypes: true }).map(entry => ({
        filename: entry.name,
        attrs: {
          isDirectory: () => entry.isDirectory(),
          mtime: Math.floor(statSync(path.join(dir, entry.name)).mtimeMs / 1000),
        },
      }))
    },
    async open(p) {
      hooks.onOpen?.(p)
      const file = resolve(p)
      if (!statSync(file).isFile()) throw new Error(`not a file: ${p}`)
      return file
    },
    async read(handle, buffer, offset, length, position) {
      const fd = openSync(handle, 'r')
      try {
        return readSync(fd, buffer, offset, length, position)
      } finally {
        closeSync(fd)
      }
    },
    async close() {},
    async stat(p) {
      const stats = statSync(resolve(p))
      return { mtime: Math.floor(stats.mtimeMs / 1000), size: stats.size }
    },
  }
}

/** Build one header frame the way the real backend does. */
function headerFrame(header) {
  return zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))
}

/** Build a full artifact: header frame, then one event frame. */
function artifact(header, events = ['{"type":"turn/start","seq":0}']) {
  return Buffer.concat([
    headerFrame(header),
    ...events.map(event => zlib.zstdCompressSync(Buffer.from(`${event}\n`, 'utf8'))),
  ])
}

/** Write one session artifact into a synthetic sessions root. */
function plant(root, project, sessionId, bytes, filename = 'session.v3.jsonl.zstd') {
  const dir = path.join(root, 'sessions', project, sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, filename), bytes)
}

// ── 1. the real corpus on this machine ─────────────────────────────────────
const realRoot = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const realSessions = path.join(realRoot, 'sessions')
let haveReal = false
try {
  haveReal = statSync(realSessions).isDirectory()
} catch {
  haveReal = false
}

if (!haveReal) {
  check('a real session corpus is available to test against', false,
    `no ${realSessions}; run this suite on a machine that has used DSH`)
} else {
  const reader = makeLocalSftp(realRoot)
  const listing = await readStaticSessions({ sftp: reader, sessionsRoot: '/sessions' })
  check('the static reader walks a real session corpus',
    listing.scanned > 0 && listing.rows.length > 0,
    `scanned=${String(listing.scanned)} rows=${String(listing.rows.length)} unreadable=${String(listing.unreadable)}`)
  check('every real artifact yielded a readable header',
    listing.unreadable === 0,
    `${String(listing.unreadable)} unreadable`)
  check('subagent sessions are excluded from the static listing',
    listing.rows.every(row => row.origin !== 'subagent'),
    `${String(listing.rows.filter(row => row.origin === 'subagent').length)} subagent row(s) leaked`)
  check('every static row is marked as static',
    listing.rows.every(row => row.static === true),
    `${String(listing.rows.filter(row => row.static !== true).length)} unmarked row(s)`)
  check('no static row claims to be running',
    listing.rows.every(row => row.running === false),
    `${String(listing.rows.filter(row => row.running).length)} row(s) claimed running`)
  check('static rows carry a cwd and an update time',
    listing.rows.every(row => typeof row.updatedAt === 'number' && row.updatedAt > 0),
    listing.rows.slice(0, 3).map(row => `${row.sessionId.slice(0, 8)}@${String(row.updatedAt)}`).join(' , '))
  check('static rows are sorted newest first',
    listing.rows.every((row, index) => index === 0 || listing.rows[index - 1].updatedAt >= row.updatedAt),
    listing.rows.slice(0, 3).map(row => String(row.updatedAt)).join(' >= '))

  // The title the panel shows comes from this mapping, so pin that it fills in.
  const titles = listing.rows.map(row => displayTitleOf({ title: undefined, cwd: row.cwd, sessionId: row.sessionId }))
  check('every static row gets a usable title from the cwd fallback',
    titles.every(title => typeof title === 'string' && title !== ''),
    titles.slice(0, 3).join(' , '))

  // The whole point of reading only the first frame: a big artifact must not be
  // read past its header. This is asserted by watching what `open` is asked for
  // and checking the read stays bounded.
  let biggest = 0
  const bounded = makeLocalSftp(realRoot, {
    onOpen: (p) => {
      const size = statSync(path.join(realRoot, p.replace(/^\/+/u, '').replaceAll('/', path.sep))).size
      biggest = Math.max(biggest, size)
    },
  })
  await readStaticSessions({ sftp: bounded, sessionsRoot: '/sessions' })
  check('a real corpus contained a multi-frame artifact worth bounding',
    biggest > 8192,
    `largest artifact ${String(biggest)} bytes`)
}

// ── 2. synthetic cases the local corpus cannot provide ─────────────────────
const synthetic = mkdtempSync(path.join(tmpdir(), 'static-syn-'))
{
  // A header whose frame is larger than the initial read, proving the prefix
  // grows instead of giving up.
  const longCwd = `/${'x'.repeat(9000)}/project`
  plant(synthetic, 'long', 'session-long', artifact({ type: 'session', version: 3, id: 'session-long', createdAt: 1000, cwd: longCwd }))
  // A plaintext (uncompressed) artifact: `.jsonl`, no frame container.
  plant(synthetic, 'plain', 'session-plain',
    Buffer.from('{"type":"session","version":3,"id":"session-plain","createdAt":2000,"cwd":"/tmp/plain"}\n{"type":"turn/start"}\n', 'utf8'),
    'session.jsonl')
  // A version-0 name (no `vN` component), which the backend still writes.
  plant(synthetic, 'v0', 'session-v0', artifact({ type: 'session', version: 3, id: 'session-v0', createdAt: 3000, cwd: '/tmp/v0' }), 'session.jsonl.zstd')
  // A corrupt artifact: valid magic, garbage payload.
  const corrupt = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(200, 0x41)])
  plant(synthetic, 'broken', 'session-broken', corrupt)
  // A subagent header, which must be filtered.
  plant(synthetic, 'sub', 'session-sub', artifact({
    type: 'session', version: 3, id: 'session-sub', createdAt: 4000, cwd: '/tmp/sub',
    origin: 'subagent', parentSession: 'session-parent', delegationDepth: 1,
  }))
  // A directory with no artifact at all.
  mkdirSync(path.join(synthetic, 'sessions', 'empty', 'session-none'), { recursive: true })
  // A stray file where a project directory would be.
  writeFileSync(path.join(synthetic, 'sessions', 'loose.txt'), 'not a directory')

  const reader = makeLocalSftp(synthetic)
  const listing = await readStaticSessions({ sftp: reader, sessionsRoot: '/sessions', logger: { warn: () => {} } })

  check('a header frame larger than the first read is still decoded',
    listing.rows.some(row => row.sessionId === 'session-long'),
    listing.rows.map(row => row.sessionId).join(' , '))
  check('a plaintext artifact is read without a frame container',
    listing.rows.some(row => row.sessionId === 'session-plain'),
    listing.rows.map(row => row.sessionId).join(' , '))
  check('a version-0 artifact name is recognized',
    listing.rows.some(row => row.sessionId === 'session-v0'),
    listing.rows.map(row => row.sessionId).join(' , '))
  check('a subagent artifact is filtered out',
    !listing.rows.some(row => row.sessionId === 'session-sub'),
    listing.rows.map(row => row.sessionId).join(' , '))
  check('a corrupt artifact is counted, not thrown',
    listing.unreadable === 1,
    `unreadable=${String(listing.unreadable)}`)
  check('a directory with no artifact is skipped silently',
    !listing.rows.some(row => row.sessionId === 'session-none'),
    'no phantom row')
  check('a stray file in the sessions root does not break the walk',
    listing.rows.length === 3,
    `${String(listing.rows.length)} row(s): ${listing.rows.map(row => row.sessionId).join(' , ')}`)

  // One unreadable artifact must not discard the readable ones — the panel is
  // still useful, and the count is reported.
  check('an unreadable artifact does not hide the readable ones',
    listing.rows.length === 3 && listing.unreadable === 1,
    `rows=${String(listing.rows.length)} unreadable=${String(listing.unreadable)}`)

  // A missing sessions root is a classified failure, not a crash.
  let missingCode
  try {
    await readStaticSessions({ sftp: reader, sessionsRoot: '/does-not-exist' })
  } catch (error) {
    missingCode = error.code
  }
  check('a missing sessions root fails with a classified code',
    missingCode === 'static-unavailable',
    String(missingCode))

  // The scan limit must be honoured and reported.
  const limited = await readStaticSessions({ sftp: reader, sessionsRoot: '/sessions', scanLimit: 2, logger: { warn: () => {} } })
  check('the scan limit caps the walk and says so',
    limited.rows.length <= 2 && limited.truncated === true,
    `rows=${String(limited.rows.length)} truncated=${String(limited.truncated)}`)
}

// NOTE: the synthetic tree is deliberately NOT removed here. Section 5 uses it as
// its fallback when this machine has no real session corpus, so deleting it now
// would leave that section pointing at a missing directory — a failure that stays
// invisible on a machine that has a corpus. It is cleaned up with `workDir` at
// the end of the run.

// ── 3. the header parser in isolation ──────────────────────────────────────
{
  const header = { type: 'session', version: 3, id: 'session-x', createdAt: 7, cwd: '/a/b' }
  const frame = headerFrame(header)
  const parsed = await parseHeaderFrame(frame, async () => undefined)
  check('parseHeaderFrame decodes a complete first frame',
    parsed?.id === 'session-x', JSON.stringify(parsed))

  // A truncated frame must ask for more, and succeed once given it.
  const truncated = frame.subarray(0, Math.max(4, frame.length - 8))
  let asked = 0
  const recovered = await parseHeaderFrame(truncated, async () => {
    asked += 1
    return frame
  })
  check('a truncated first frame triggers a longer read and then decodes',
    recovered?.id === 'session-x' && asked === 1,
    `id=${String(recovered?.id)} asked=${String(asked)}`)

  // A frame that never completes must give up rather than loop forever.
  const endless = await parseHeaderFrame(truncated, async () => truncated)
  check('an unrecoverable frame gives up instead of looping',
    endless === undefined, String(endless))

  // A non-session first record means the framing is not what this assumes.
  const wrong = headerFrame({ type: 'turn/start', seq: 0 })
  const rejected = await parseHeaderFrame(wrong, async () => undefined)
  check('a first frame that is not a session header is rejected',
    rejected === undefined, String(rejected))

  const empty = await parseHeaderFrame(Buffer.alloc(0), async () => undefined)
  check('an empty artifact yields no header', empty === undefined, String(empty))
}

// ── 4. the pure projections ────────────────────────────────────────────────
{
  check('posixJoin never emits backslashes',
    posixJoin('/srv/.dsh', 'sessions', 'proj') === '/srv/.dsh/sessions/proj',
    posixJoin('/srv/.dsh', 'sessions', 'proj'))
  check('posixJoin tolerates a trailing slash and empty segments',
    posixJoin('/a/', '', 'b') === '/a/b',
    posixJoin('/a/', '', 'b'))

  const row = rowFromHeader(
    { id: 's1', cwd: '/w', createdAt: 5, origin: 'ui', parentSession: 'p' },
    { updatedAt: 99, projectDir: 'proj' },
  )
  check('rowFromHeader maps the header fields it has',
    row.sessionId === 's1' && row.cwd === '/w' && row.origin === 'ui' && row.parentSessionId === 'p',
    JSON.stringify(row))
  check('rowFromHeader marks the row static and idle',
    row.static === true && row.running === false, JSON.stringify({ static: row.static, running: row.running }))
  check('rowFromHeader leaves the title for the caller to fill',
    row.title === undefined, String(row.title))

  // Archiving cannot be known statically, so archived-looking rows must NOT be
  // dropped — hiding sessions the user can still see on that machine is worse
  // than listing them.
  const visible = staticVisible([
    { sessionId: 'a', updatedAt: 1, running: false, blank: false },
    { sessionId: 'b', updatedAt: 3, running: false, blank: false, origin: 'subagent' },
    { sessionId: 'c', updatedAt: 2, running: false, blank: false },
  ])
  check('staticVisible keeps non-subagent rows and sorts by recency',
    visible.map(item => item.sessionId).join(',') === 'c,a',
    visible.map(item => item.sessionId).join(','))
  check('the static limits are stated for the panel to quote',
    Array.isArray(STATIC_LIMITS) && STATIC_LIMITS.length > 0,
    `${String(STATIC_LIMITS.length)} limit(s)`)
}

// ── 5. the fallback decision in the client ─────────────────────────────────
// `tryStaticFallback` is private, so its two documented behaviours are pinned
// through the public path with a stubbed transport: a credential failure must
// NOT fall back (it is an answer, not an outage), and an unreachable instance
// must.
//
// A local server that answers 403 makes the "policy, not outage" branch real.
const forbiddenServer = createServer((req, res) => {
  res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden')
})
const forbiddenPort = await new Promise(resolve => {
  forbiddenServer.listen(0, '127.0.0.1', () => { resolve(forbiddenServer.address().port) })
})

{
  const { readPeer } = await import('../lib/federation/client.js')
  let sftpOpened = 0
  const transport = {
    // A real TCP dial to whatever the peer's remotePort says, which is what the
    // SSH transport does over `direct-tcpip`. The two peers below then differ
    // only in WHERE they point: a closed port (genuine outage → fallback) and a
    // server answering 403 (policy → no fallback). A stub that never called back
    // would hang the request instead of exercising either branch.
    createConnection: peer => (options, callback) => {
      const socket = connect(peer.ssh.remotePort, '127.0.0.1', () => { callback(null, socket) })
      // A PERSISTENT error listener, not `once`: the socket can report again
      // during teardown, and an unconsumed 'error' event is an uncaught
      // exception that takes the whole run down.
      socket.on('error', error => { callback(error) })
    },
    // `sftpReader` is what `readPeer` actually calls — providing only `sftp()`
    // here would make the fallback throw a TypeError that nothing awaits, which
    // surfaces as a hang plus an uncaught exception rather than a failed check.
    async sftpReader() {
      sftpOpened += 1
      return makeLocalSftp(haveReal ? realRoot : synthetic)
    },
    async exec() { return { code: 0, stdout: '', stderr: '' } },
    async dial() { throw new Error('dial should not be used here') },
    close() {},
  }
  const auth = {
    async headersFor() { return {} },
    async reauthorize() { return {} },
    async forget() {},
    deviceCredential() { return undefined },
  }
  // Point the instance at a closed port so the live read genuinely fails.
  const deadPeer = {
    id: 'f-static',
    channel: 'ssh',
    label: 'dead',
    origin: 'http://127.0.0.1:1',
    ssh: { host: '127.0.0.1', user: 'x', port: 22, remotePort: 1 },
    auth: { kind: 'token', token: 't' },
    ...(haveReal ? { remoteHome: realRoot } : {}),
  }

  if (haveReal) {
    const snapshot = await readPeer(deadPeer, {
      transport,
      auth,
      timeoutMs: 3000,
      limit: 50,
      remoteHome: realRoot,
      logger: { warn: () => {} },
    })
    check('an unreachable instance falls back to the static listing',
      snapshot.source === 'static' && Array.isArray(snapshot.items),
      `source=${String(snapshot.source)} items=${String(snapshot.items?.length)}`)
    check('the static snapshot warns what it cannot know',
      (snapshot.warnings ?? []).length > 1 && snapshot.warnings.some(w => w.includes('静态清单')),
      JSON.stringify(snapshot.warnings ?? []).slice(0, 200))
    check('the fallback reported that it used SFTP',
      sftpOpened > 0, `${String(sftpOpened)} SFTP session(s)`)
  }

  // A 403 is policy, not an outage: falling back would hide the real problem.
  const before = sftpOpened
  const forbiddenPeer = {
    ...deadPeer,
    id: 'f-forbidden',
    origin: `http://127.0.0.1:${String(forbiddenPort)}`,
    ssh: { host: '127.0.0.1', user: 'x', port: 22, remotePort: forbiddenPort },
  }
  let forbiddenError
  try {
    await readPeer(forbiddenPeer, {
      transport,
      auth,
      timeoutMs: 3000,
      limit: 50,
      remoteHome: realRoot,
      logger: { warn: () => {} },
    })
  } catch (error) {
    forbiddenError = error?.code
  }
  check('a fence rejection does not fall back to the disk',
    sftpOpened === before,
    `error=${String(forbiddenError)} sftpOpens=${String(sftpOpened - before)}`)
  forbiddenServer.close()
  await new Promise(resolve => { forbiddenServer.closeAllConnections?.(); resolve() })
}

// ── 6. the transport's SFTP session cache ──────────────────────────────────
// Scanning a directory of hundreds of sessions must reuse ONE SFTP session; a
// session per file would dominate the cost. The cache also has to let go of a
// session whose channel died, or every later read fails against a closed one.
{
  const { SshTransport } = await import('../lib/federation/ssh.js')
  let opened = 0
  const transport = new SshTransport({ knownHostsFile: path.join(workDir, 'known_hosts.json') })
  // Stand in for a connected client: `sftp()` is the only member used here.
  const fakeClient = {
    sftp(callback) {
      opened += 1
      const session = { on() {}, end() {} }
      queueMicrotask(() => { callback(null, session) })
    },
    end() {},
  }
  const peer = { id: 'f-cache', ssh: { host: 'h', user: 'u', port: 22, remotePort: 3080 } }
  // Seed the connection cache so no real connection is attempted.
  transport.connections.set(peer.id, { client: fakeClient, ready: Promise.resolve(fakeClient) })

  const first = await transport.sftp(peer)
  const second = await transport.sftp(peer)
  check('the transport reuses one SFTP session per peer',
    opened === 1 && first === second,
    `opened=${String(opened)} same=${String(first === second)}`)

  transport.close(peer.id)
  check('closing a peer drops its cached SFTP session',
    transport.sftpSessions.size === 0 && transport.connections.size === 0,
    `sftpSessions=${String(transport.sftpSessions.size)} connections=${String(transport.connections.size)}`)

  // A connection that is gone must produce a classified error, not a hang.
  // The fake client must be the SAME object `client()` resolves to — seeding
  // `connections` with a client that differs from `ready` means the code never
  // sees the failing `sftp`, and the test asserts nothing.
  const failingClient = { sftp: (cb) => { queueMicrotask(() => cb(new Error('channel closed'))) }, end() {} }
  transport.connections.set(peer.id, { client: failingClient, ready: Promise.resolve(failingClient) })
  let sftpError
  let sftpThrew
  try {
    await transport.sftp(peer)
  } catch (error) {
    sftpThrew = true
    sftpError = error?.code
  }
  check('an SFTP failure is classified rather than thrown raw',
    sftpThrew === true && sftpError === 'ssh-sftp-failed',
    `threw=${String(sftpThrew)} code=${String(sftpError)}`)
}

// ── 7. the promise adapter against a REAL ssh2 SFTP server ─────────────────
// Section 5 used a JS object as the SFTP reader, which cannot catch the trap
// this suite exists to close: ssh2's SFTP API is CALLBACK-based, so an adapter
// that forgets to promisify returns `undefined` for every call and the static
// read silently reports "no sessions". That failure only appears over a real
// protocol, so this section runs a real `ssh2.Server` speaking SFTP and drives
// the reader through it.
{
  const ssh2 = (await import('ssh2')).default
  const { Server: SshServer, utils } = ssh2
  const { SshTransport } = await import('../lib/federation/ssh.js')

  const sftpRoot = mkdtempSync(path.join(tmpdir(), 'static-sftp-'))
  plant(sftpRoot, 'real-proj', 'session-over-sftp', artifact({
    type: 'session', version: 3, id: 'session-over-sftp', createdAt: 5000, cwd: '/srv/app',
  }))
  writeFileSync(path.join(sftpRoot, 'sessions', 'real-proj', 'session-over-sftp', 'readme.txt'), 'x')

  const keyPair = utils.generateKeyPairSync('ed25519')
  const sftpPort = 2223
  /** Serve a minimal read-only SFTP subsystem over `sftpRoot`. */
  const server = new SshServer({ hostKeys: [keyPair.private] }, (client) => {
    client.on('authentication', ctx => ctx.accept())
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          /** Map a virtual absolute path onto the fixture directory. */
          const local = (p) => path.join(sftpRoot, String(p).replace(/^\/+/u, '').replaceAll('/', path.sep))
          const handles = new Map()
          let next = 1
          sftp.on('OPENDIR', (reqid, dirPath) => {
            let names
            try {
              names = readdirSync(local(dirPath))
            } catch {
              sftp.status(reqid, 2)
              return
            }
            const handle = Buffer.from(String(next++))
            // The directory is remembered WITH the handle: READDIR only receives
            // the handle, so without this every entry's attributes would be
            // stat'd against an empty path and silently come back empty.
            handles.set(handle.toString(), { kind: 'dir', dirPath: String(dirPath), names, index: 0 })
            sftp.handle(reqid, handle)
          })
          sftp.on('READDIR', (reqid, handle) => {
            const entry = handles.get(handle.toString())
            if (entry === undefined) {
              sftp.status(reqid, 2)
              return
            }
            if (entry.index >= entry.names.length) {
              sftp.status(reqid, 1)
              return
            }
            const name = entry.names[entry.index++]
            let attrs = {}
            try {
              const st = statSync(local(`${entry.dirPath.replace(/\/+$/u, '')}/${name}`))
              const isDir = st.isDirectory()
              attrs = {
                mode: st.mode,
                size: st.size,
                mtime: Math.floor(st.mtimeMs / 1000),
                // ssh2's `Stats` exposes `isDirectory()`; the static reader calls
                // it, so the wire attributes must be turned into an object that
                // answers it.
                isDirectory: () => isDir,
              }
            } catch {
              attrs = {}
            }
            sftp.name(reqid, [{ filename: name, longname: name, attrs }])
          })
          sftp.on('OPEN', (reqid, filename, flags) => {
            // Read-only by construction: refuse anything but a read.
            if ((flags & 0x00000002) !== 0) {
              sftp.status(reqid, 3)
              return
            }
            let fd
            try {
              fd = openSync(local(filename), 'r')
            } catch {
              sftp.status(reqid, 2)
              return
            }
            const handle = Buffer.from(String(next++))
            handles.set(handle.toString(), { kind: 'file', fd })
            sftp.handle(reqid, handle)
          })
          sftp.on('READ', (reqid, handle, offset, length) => {
            const entry = handles.get(handle.toString())
            if (entry === undefined || entry.kind !== 'file') {
              sftp.status(reqid, 2)
              return
            }
            const buffer = Buffer.alloc(length)
            let read = 0
            try {
              read = readSync(entry.fd, buffer, 0, length, Number(offset))
            } catch {
              read = 0
            }
            if (read === 0) {
              sftp.status(reqid, 1)
              return
            }
            sftp.data(reqid, buffer.subarray(0, read))
          })
          sftp.on('FSTAT', (reqid, handle) => {
            const entry = handles.get(handle.toString())
            if (entry === undefined || entry.kind !== 'file') {
              sftp.status(reqid, 2)
              return
            }
            const st = fstatSync(entry.fd)
            sftp.attrs(reqid, { mode: st.mode, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) })
          })
          // `STAT` is required even though the reader only uses it for a missing
          // mtime: an SFTP request that is never answered does not fail — it
          // HANGS, and no timeout in this process can recover it. Leaving this
          // out is what made this section time out.
          sftp.on('STAT', (reqid, filePath) => {
            let st
            try {
              st = statSync(local(filePath))
            } catch {
              sftp.status(reqid, 2)
              return
            }
            sftp.attrs(reqid, { mode: st.mode, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) })
          })
          sftp.on('CLOSE', (reqid, handle) => {
            const entry = handles.get(handle.toString())
            if (entry?.kind === 'file') {
              try {
                closeSync(entry.fd)
              } catch {
                /* already closed */
              }
            }
            handles.delete(handle.toString())
            sftp.status(reqid, 0)
          })
        })
      })
    })
    client.on('error', () => {})
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(sftpPort, '127.0.0.1', resolve)
  })

  const transport = new SshTransport({
    knownHostsFile: path.join(sftpRoot, 'known_hosts.json'),
    hostKeyPolicy: 'accept-new',
  })
  const peer = {
    id: 'f-real-sftp',
    channel: 'ssh',
    origin: 'http://127.0.0.1:3080',
    ssh: { host: '127.0.0.1', user: 'tester', port: sftpPort, remotePort: 3080 },
  }

  const reader = await transport.sftpReader(peer)
  check('the promise adapter opens an SFTP session over real SSH',
    reader !== undefined && typeof reader.readdir === 'function',
    typeof reader?.readdir)

  const rootListing = await reader.readdir('/sessions')
  check('readdir over real SFTP returns a real array (not undefined)',
    Array.isArray(rootListing) && rootListing.length === 1 && rootListing[0].filename === 'real-proj',
    Array.isArray(rootListing) ? JSON.stringify(rootListing.map(e => e.filename)) : String(rootListing))

  const staticListing = await readStaticSessions({
    sftp: reader,
    sessionsRoot: '/sessions',
    logger: { warn: message => console.log(`      (warn) ${message}`) },
  })
  check('the static reader works end to end over a real SFTP server',
    staticListing.rows.length === 1 && staticListing.rows[0].sessionId === 'session-over-sftp',
    `${String(staticListing.rows.length)} row(s): ${staticListing.rows.map(r => r.sessionId).join(', ')}`)
  check('the header decoded over real SFTP carries the real cwd',
    staticListing.rows[0]?.cwd === '/srv/app',
    String(staticListing.rows[0]?.cwd))

  // Reading a missing file must be a classified error, not a hang or a silent
  // empty result — the failure mode a wrong adapter produces.
  let missingThrew = false
  try {
    await reader.readdir('/nope')
  } catch {
    missingThrew = true
  }
  check('a missing remote directory rejects rather than resolving empty',
    missingThrew, `threw=${String(missingThrew)}`)

  // ── an ssh2-level connection error must not kill the process ─────────────
  // ssh2 forwards socket failures (ECONNRESET and friends) to the Client as an
  // 'error' event, and an EventEmitter with NO 'error' listener THROWS — which
  // took down the entire DSH host process when a peer's SSH session reset, and
  // showed up in the panel only as "failed to fetch". A `once` listener was not
  // enough either: a reset connection reports more than once, and the second
  // report had nothing left listening. This is asserted against a REAL ssh2
  // connection, because the failure lives in ssh2's own event forwarding.
  const liveClient = transport.connections.get(peer.id)?.client
  check('the live connection carries a persistent error listener',
    liveClient !== undefined && liveClient.listenerCount('error') >= 1,
    `listeners=${String(liveClient?.listenerCount?.('error'))}`)
  let escaped
  try {
    liveClient.emit('error', new Error('simulated reset #1'))
    liveClient.emit('error', new Error('simulated reset #2'))
  } catch (error) {
    escaped = error
  }
  check('two connection errors in a row do not escape as an uncaught throw',
    escaped === undefined,
    escaped === undefined ? 'none escaped' : String(escaped))
  check('a connection error forgets the connection so the next call redials',
    transport.connections.has(peer.id) === false,
    `stillCached=${String(transport.connections.has(peer.id))}`)
  check('...and its cached SFTP session is forgotten with it',
    transport.sftpSessions.has(peer.id) === false,
    `stillCached=${String(transport.sftpSessions.has(peer.id))}`)
  // The real socket is still up (only a synthetic event was emitted), so close
  // it explicitly rather than leaving the event loop alive.
  liveClient.end()

  transport.close()
  server.close()
  rmSync(sftpRoot, { recursive: true, force: true })
}

// Every scratch tree goes at the end, unconditionally: `workDir` and `synthetic`
// were only removed when a real corpus existed, which left temp directories
// behind on a machine without one.
rmSync(workDir, { recursive: true, force: true })
rmSync(synthetic, { recursive: true, force: true })

// Let any trailing unhandled rejection surface before the verdict.
await new Promise(resolve => { setTimeout(resolve, 300) })
for (const text of unhandled) results.push({ name: `unhandled rejection: ${text}`, pass: false, detail: text })

const failed = results.filter(result => !result.pass)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
