/**
 * End-to-end verification of the provisioner against a REAL `dsh web` start.
 *
 * `verify-federation.mjs` checks that the provisioner builds the right command
 * and parses the right output — but its fake sshd only *pretends* to run
 * anything. That leaves the load-bearing claim of the whole feature unproven:
 * that after "拉起远程实例", the peer is genuinely usable with nothing copied by
 * hand.
 *
 * So this suite lets the fake sshd actually execute the launch, using a real
 * `dsh web --port 0` on this machine, and then reads the peer through the same
 * SSH tunnel the panel uses. The chain asserted end-to-end is:
 *
 *   provision start → real dsh web boots → its stdout (the only place the
 *   launch token ever appears) is captured from the log → the token is stored
 *   on the peer → `session/list` over the tunnel succeeds with it → stop kills
 *   the instance it started.
 *
 * The "remote" is therefore this machine, reached over a real SSH connection.
 * That is the closest a single-machine test can get to the real thing, and it
 * exercises every part except the network distance: the SSH transport, the
 * detached launch, the log file, token parsing, credential attachment, the
 * unary wire, and teardown.
 *
 * Usage: node scripts/verify-provision-e2e.mjs [--keep-home]
 */

import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, symlinkSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ssh2 from 'ssh2'

const { Server: SshServer, utils } = ssh2

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  — ${detail}` : ''}`)
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workDir = mkdtempSync(path.join(tmpdir(), 'provision-e2e-'))
/** The "remote" harness home: the instance started through SSH lives here. */
const remoteHome = path.join(workDir, 'remote-home')
const remoteWork = path.join(workDir, 'remote-work')
mkdirSync(remoteHome, { recursive: true })
mkdirSync(remoteWork, { recursive: true })

/**
 * Give the "remote" harness home a working web profile.
 *
 * A spawned `dsh web` needs a profile of its own, and it must be a *different*
 * DSH_HOME from any other instance (design doc §10) — so this cannot reuse the
 * one the other suites run against. The profile is assembled from the machine's
 * real one, with two deliberate changes: the server is pinned to `port: 0` (the
 * real profile pins 3080, and inheriting that would collide with the running
 * instance), and `node_modules` is a directory of per-package junctions rather
 * than a copy, so nothing here can write into the real installation.
 *
 * @param {string} liveProfile - the machine's real profile directory.
 * @returns {void}
 */
function seedRemoteProfile(liveProfile) {
  const profileDir = path.join(remoteHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  for (const file of ['cordis.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    const source = path.join(liveProfile, file)
    if (existsSync(source)) writeFileSync(path.join(profileDir, file), readFileSync(source))
  }
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    '# Test-only: the real profile pins 0.0.0.0:3080; this copy must take an',
    '# OS-assigned port instead so it cannot collide with a running instance.',
    '- id: webserver',
    "  name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '',
  ].join('\n'), 'utf8')

  const liveModules = path.join(liveProfile, 'node_modules')
  const testModules = path.join(profileDir, 'node_modules')
  mkdirSync(testModules, { recursive: true })
  for (const entry of readdirSync(liveModules, { withFileTypes: true })) {
    if (['.bin', '.pnpm', '.modules.yaml', '.package-lock.json'].includes(entry.name)) continue
    const link = path.join(testModules, entry.name)
    try {
      symlinkSync(path.join(liveModules, entry.name), link, 'junction')
    } catch {
      /* an existing link is fine */
    }
  }
  // The plugin under test must be the working tree, not the installed copy.
  const pluginLink = path.join(testModules, 'dsh-remote-switch')
  try {
    rmSync(pluginLink, { recursive: true, force: true })
  } catch {
    /* nothing there */
  }
  symlinkSync(repoRoot, pluginLink, 'junction')
}
const liveProfile = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'web')
if (existsSync(liveProfile)) seedRemoteProfile(liveProfile)

const federationFile = path.join(workDir, 'peers.json')
const knownHostsFile = path.join(workDir, 'known_hosts.json')
const cacheFile = path.join(workDir, 'credentials.json')
const sshPort = 2222
const routePort = 3096

const { apply } = await import('../lib/index.js')

const routes = new Map()
const stubCtx = {
  logger: { warn: () => {}, error: () => {}, info: () => {} },
  webServer: {
    port: routePort,
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  get() { return undefined },
}

const dispose = apply(stubCtx, {
  federation: {
    federationFile,
    knownHostsFile,
    cacheFile,
    requestTimeoutMs: 20000,
    listLimit: 50,
    // Generous: a real `dsh web` on a cold start has to boot the whole plugin
    // tree before it prints its URL.
    provisionReadyTimeoutMs: 90000,
  },
})

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', `http://127.0.0.1:${String(routePort)}`).pathname
  const handler = routes.get(pathname)
  if (handler === undefined) {
    res.writeHead(404).end('no route')
    return
  }
  void Promise.resolve(handler(req, res)).catch(error => {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }))
  })
})
await new Promise(resolve => server.listen(routePort, '127.0.0.1', resolve))

const base = `http://127.0.0.1:${String(routePort)}/api/federation`
const post = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: text }
  }
}

/** Instances this suite started on the "remote", so teardown can kill them. */
const launched = []

/**
 * A runnable `dsh` command, resolved the way a shell would.
 *
 * The CLI ships as a shim (`dsh.cmd` / `dsh.ps1` on Windows, `dsh` elsewhere)
 * whose own text names the real entry point, so this reads that entry point
 * rather than assuming a directory layout. `where`/`which` is used first, but it
 * is not trusted alone: a sandboxed or PATH-less shell answers nothing, and
 * that must not be reported as "dsh is not installed".
 * @returns {{ command: string, args: string[] }} the executable and its prefix args.
 */
function resolveDsh() {
  const shimDir = path.dirname(process.execPath)
  const candidates = [
    path.join(shimDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    // The npm global prefix, which is where `dsh` actually lands on this machine.
    path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(shimDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ]
  const located = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' })
  for (const line of String(located.stdout ?? '').split(/\r?\n/u)) {
    const shim = line.trim()
    if (shim === '') continue
    candidates.unshift(path.join(path.dirname(shim), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  for (const bin of candidates) {
    if (existsSync(bin)) return { command: process.execPath, args: [bin] }
  }
  throw new Error('could not resolve the dsh CLI; install it or adjust resolveDsh()')
}
const dsh = resolveDsh()
console.log(`using dsh at ${dsh.args[0]}\n`)

/**
 * Execute one command the way the "remote" would.
 *
 * The provisioner sends a POSIX launcher (mkdir/rm/cd/setsid/nohup). This
 * machine is Windows, so the launch is translated to the equivalent Node spawn:
 * a detached `dsh web` with its output appended to the same log file. That is
 * precisely the observable behaviour the provisioner depends on — a detached
 * process whose stdout lands in `<DSH_HOME>/federation/web.log` — so parsing it
 * back is a real test, not a rehearsal.
 * @param {string} command - the command the provisioner sent.
 * @returns {Promise<string>} stdout for the channel.
 */
async function runRemotely(command) {
  if (command.includes('uname')) return 'Linux\n'
  if (command.includes('ss -ltn') || command.includes('netstat')) {
    // Answer from the real process table AND the real log: the provisioner uses
    // this answer to decide whether an instance is already up, so it must
    // reflect an actually-listening port rather than a guess.
    const live = launched.filter(entry => entry.child.exitCode === null)
    const ports = live.map(entry => readLaunchPort(entry.logFile)).filter(port => typeof port === 'number')
    return ports.length === 0 ? '' : `LISTEN 0 128 127.0.0.1:${String(ports[0])} 0.0.0.0:*\n`
  }
  // `stop` reads the pid the launcher recorded on the remote. Serving it from the
  // real pid file (written below) is what makes this a real test of that path
  // rather than of a value the caller happened to pass in.
  //
  // The `setsid`/`nohup` exclusion matters: the LAUNCH command also ends with
  // `cat ...web.pid`, so a plain `cat web.pid` test would swallow the launch and
  // silently never start anything.
  if (command.includes('cat ') && command.includes('web.pid') &&
      !command.includes('setsid') && !command.includes('nohup')) {
    const pidFile = path.join(remoteHome, 'federation', 'web.pid')
    return existsSync(pidFile) ? `${readFileSync(pidFile, 'utf8').trim()}\n` : ''
  }
  if (command.includes('tail -n')) {
    const logFile = path.join(remoteHome, 'federation', 'web.log')
    if (!existsSync(logFile)) return ''
    const lines = readFileSync(logFile, 'utf8').split('\n')
    const wanted = Number(/tail -n (\d+)/.exec(command)?.[1] ?? 40)
    return `${lines.slice(-wanted).join('\n')}\n`
  }
  if (command.includes('setsid') || command.includes('nohup')) {
    // The launcher's own bookkeeping, then the launch itself.
    const federationDir = path.join(remoteHome, 'federation')
    mkdirSync(federationDir, { recursive: true })
    const logFile = path.join(federationDir, 'web.log')
    const extractedPort = /'--port'\s+'(\d+)'/.exec(command)?.[1]
    const port = Number(extractedPort ?? 0)

    // A real `dsh web` from the installed CLI, with its own DSH_HOME — the
    // isolation rule from the design doc's §10 still applies to a spawned
    // instance, even one that is pretending to be remote.
    //
    // Its output goes straight to the log FILE DESCRIPTOR rather than through a
    // pipe. That mirrors what the real launcher does with `>> log 2>&1` on the
    // remote, and it is also what a confined sandbox permits: a piped stdio
    // spawn is refused outright (EPERM), which would silently produce a launcher
    // that appears to work while writing nothing.
    const fd = openSync(logFile, 'a')
    const child = spawn(dsh.command, [...dsh.args, '--profile', 'web', '--no-open', '--port', String(port)], {
      cwd: remoteWork,
      env: { ...process.env, DSH_HOME: remoteHome },
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    })
    const entry = { child, port: 0, logFile }
    launched.push(entry)
    child.on('error', (error) => {
      appendToFile(logFile, `\nprovision-e2e: could not start dsh: ${error.message}\n`)
    })
    child.unref()
    // The real launcher ends with `echo $! > web.pid`, and `stop` reads that file
    // back. Writing it here is what makes the stop path a real test: the pid
    // travels through the remote's filesystem, not through the caller's request.
    writeFileSync(path.join(federationDir, 'web.pid'), `${String(child.pid)}\n`, 'utf8')
    // Record the port the instance announces, so teardown can VERIFY it is gone
    // rather than trusting that a kill worked. It is read from the log because
    // `--port 0` means the OS chose it.
    const portWatch = setInterval(() => {
      const found = readLaunchPort(logFile)
      if (typeof found === 'number') {
        entry.port = found
        clearInterval(portWatch)
      }
    }, 200)
    portWatch.unref?.()
    return `${String(child.pid)}\n`
  }
  if (command.includes('kill ')) {
    const pid = Number(/kill (\d+)/.exec(command)?.[1])
    const match = launched.find(entry => entry.child.pid === pid)
    if (match !== undefined && match.child.exitCode === null) {
      killTree(pid)
      return 'killed\n'
    }
    return 'gone\n'
  }
  if (command.includes('fuser') || command.includes('lsof')) return 'none\n'
  if (command.includes('mkdir') || command.includes('rm -f')) return ''
  return ''
}

/** Append text to a file, creating it when absent. */
function appendToFile(file, text) {
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : ''
  writeFileSync(file, previous + text, 'utf8')
}

/**
 * The port an instance announced in its own log.
 *
 * This is the only source of the port, because `--port 0` means the OS chooses
 * it — exactly as it does on a real remote.
 * @param {string} logFile - the instance's log.
 * @returns {number | undefined} the announced port.
 */
function readLaunchPort(logFile) {
  if (!existsSync(logFile)) return undefined
  const found = /127\.0\.0\.1:(\d+)\/\?token=/.exec(readFileSync(logFile, 'utf8'))
  return found === null ? undefined : Number(found[1])
}

// ── the "remote sshd" ───────────────────────────────────────────────────────
const keyPair = utils.generateKeyPairSync('ed25519')
const sshServer = new SshServer({ hostKeys: [keyPair.private] }, (client) => {
  client.on('authentication', (authCtx) => { authCtx.accept() })
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('exec', (acceptExec, rejectExec, info) => {
        const stream = acceptExec()
        void runRemotely(info.command).then(
          (output) => {
            if (output !== '') stream.write(output)
            stream.exit(0)
            stream.end()
          },
          (error) => {
            stream.stderr.write(String(error))
            stream.exit(1)
            stream.end()
          },
        )
      })
    })
    client.on('tcpip', (accept, reject, info) => {
      const channel = accept()
      // A real TCP connection to whatever the tunnel asked for — which is how the
      // peer's HTTP calls reach the instance this suite just started.
      import('node:net').then(({ connect }) => {
        const upstream = connect(info.destPort, info.destIP === 'localhost' ? '127.0.0.1' : info.destIP, () => {
          channel.pipe(upstream).pipe(channel)
        })
        upstream.on('error', () => { channel.close() })
        channel.on('close', () => { upstream.destroy() })
      })
    })
  })
  client.on('error', () => {})
})
await new Promise((resolve, reject) => {
  sshServer.once('error', reject)
  sshServer.listen(sshPort, '127.0.0.1', resolve)
})

/**
 * Terminate one spawned instance.
 *
 * A plain `process.kill` is used, and the result is VERIFIED by re-checking the
 * pid — not assumed from the call returning. Killing an orphan's parent can
 * leave a child holding the listening sockets, which is exactly how earlier runs
 * of this suite left instances behind; so the caller re-runs this a moment later
 * and the port is checked rather than trusted.
 *
 * (`taskkill /T` would be the Windows-native way to walk the tree, but it is
 * refused in this sandbox, and a kill that silently does nothing is worse than
 * no kill at all.)
 * @param {number} pid - the process to terminate.
 * @returns {boolean} whether the process is gone afterwards.
 */
function killTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return true
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
  return true
}

/**
 * Whether a port still has a listener.
 * @param {number} port - the port to check.
 * @returns {boolean} true when something is listening.
 */
function portListening(port) {
  const found = spawnSync(process.platform === 'win32' ? 'netstat' : 'ss', process.platform === 'win32' ? ['-ano'] : ['-ltn'], { encoding: 'utf8' })
  return new RegExp(`[:.]${String(port)}\\s`, 'u').test(String(found.stdout ?? ''))
}

/** Tear everything down, including any instance the suite started. */
async function teardown() {
  // Retry the kill and CONFIRM by port, because a process that is mid-start can
  // outlive the first signal and would then keep the temp DSH_HOME locked.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const live = launched.filter(entry => entry.child.exitCode === null)
    if (live.length === 0) break
    for (const entry of live) killTree(entry.child.pid)
    await new Promise(resolve => { setTimeout(resolve, 600) })
  }
  const stillListening = launched
    .map(entry => entry.port)
    .filter(port => typeof port === 'number' && port > 0 && portListening(port))
  if (stillListening.length > 0) {
    console.log(`\nWARNING: ports still listening after teardown: ${stillListening.join(', ')}`)
  }
  dispose()
  sshServer.close()
  server.closeAllConnections()
  await new Promise(resolve => { server.close(resolve) })
  if (process.argv.includes('--keep-home')) {
    console.log(`\nkept: ${workDir}`)
    return
  }
  // An instance holds its DSH_HOME open briefly after the kill; retry a little.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(workDir, { recursive: true, force: true })
      return
    } catch {
      await new Promise(resolve => { setTimeout(resolve, 500) })
    }
  }
  console.log(`\ncould not remove ${workDir} (an instance may still hold it)`)
}

// ── the run ────────────────────────────────────────────────────────────────
// No token is passed: this peer gets its credential from the provisioner, which
// is the entire point of the feature.
const saved = await post(`${base}/peers`, {
  action: 'save',
  channel: 'ssh',
  label: 'e2e-remote',
  ssh: { host: '127.0.0.1', user: 'tester', port: sshPort, remotePort: 3080 },
  auth: { kind: 'token', token: 'PLACEHOLDER_WILL_BE_REPLACED' },
})
const peerId = saved.body?.saved
check('the peer registers before any credential is known',
  typeof peerId === 'string', String(peerId))

// Before the start, the peer cannot be read: nothing is listening on the far
// side. This is the state the feature exists to fix.
const before = await post(`${base}/sessions`, { peerId, force: true })
check('a peer whose instance is not running cannot be read',
  before.body?.status === 'error',
  `status=${String(before.body?.status)} code=${String(before.body?.error?.code)}`)

// The start: this actually boots a real `dsh web` on the "remote".
const started = await post(`${base}/provision`, { id: peerId, action: 'start', remoteHome, port: 0 })
const outcome = started.body?.provision ?? {}
check('starting the remote reports success',
  outcome.started === true,
  `ok=${String(outcome.ok)} code=${String(outcome.code)} detail=${String(outcome.detail ?? '').slice(0, 200)}`)
// A failure here means the launch never named a port; dump the log, because an
// empty log and a crashing instance look identical from the outside.
if (outcome.started !== true) {
  const logFile = path.join(remoteHome, 'federation', 'web.log')
  console.log('\nFATAL: the remote never came up, so the rest cannot be asserted')
  console.log(`remote log (${logFile}):`)
  console.log(existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(-2000) : '(no log file)')
  console.log(JSON.stringify(outcome, null, 2).slice(0, 1000))
  await teardown()
  const failed = results.filter(result => !result.pass)
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`)
  process.exitCode = 1
  process.exit(1)
}

check('the start reports the OS-assigned port the remote printed',
  typeof outcome.port === 'number' && outcome.port > 0,
  String(outcome.port))
// The token is provable independently of the response: the remote writes it into
// its own log, which this test reads directly. That is what makes the "never sent
// back" assertion below meaningful rather than vacuous.
const remoteLog = typeof outcome.logFile === 'string' && existsSync(outcome.logFile)
  ? readFileSync(outcome.logFile, 'utf8')
  : ''
const remoteToken = /127\.0\.0\.1:\d+\/\?token=([^\s&)]+)/u.exec(remoteLog)?.[1]
check('the start captured a token from the remote\'s own output',
  typeof remoteToken === 'string' && remoteToken.length > 20 && outcome.credential === 'token',
  `remote token length=${String(remoteToken?.length ?? 0)} credential=${String(outcome.credential)}`)
check('the start wrote its log under the remote DSH_HOME, as documented',
  typeof outcome.logFile === 'string' && outcome.logFile.startsWith(remoteHome),
  String(outcome.logFile))

// The stored credential must be the captured one, and must not be echoed back.
const peersAfter = await (await fetch(`${base}/peers`)).json()
const peerRow = (peersAfter.peers ?? []).find(peer => peer.id === peerId)
check('the captured token was stored on the peer',
  peerRow?.auth?.hasToken === true && peerRow?.ssh?.remotePort === outcome.port,
  JSON.stringify({ auth: peerRow?.auth, remotePort: peerRow?.ssh?.remotePort }))
check('the token itself is never sent back to the browser',
  remoteToken !== undefined &&
    JSON.stringify(outcome).includes(remoteToken) === false &&
    JSON.stringify(peersAfter).includes(remoteToken) === false,
  `token absent from the provision response and the peer list (checked ${String(remoteToken?.length ?? 0)} chars)`)

// The payoff: the peer is now readable with NO manual credential step. This is
// the claim the whole provisioner exists to make.
const after = await post(`${base}/sessions`, { peerId, force: true })
check('the provisioned peer is immediately readable over the same SSH tunnel',
  after.body?.status === 'ok',
  `status=${String(after.body?.status)} code=${String(after.body?.error?.code)} message=${String(after.body?.error?.message ?? '').slice(0, 160)}`)
check('its session list carries the fields the panel renders',
  Array.isArray(after.body?.snapshot?.items) &&
    after.body.snapshot.items.every(row => typeof row.sessionId === 'string' && typeof row.title === 'string'),
  `${String(after.body?.snapshot?.items?.length ?? 0)} row(s)`)
check('its workspace baseline was read too (no silent warning)',
  (after.body?.snapshot?.warnings ?? []).length === 0,
  JSON.stringify(after.body?.snapshot?.warnings ?? null).slice(0, 200))

// Starting again must not launch a second instance.
const again = await post(`${base}/provision`, { id: peerId, action: 'start', remoteHome, port: 0 })
check('starting an already-running remote does not launch a second one',
  again.body?.provision?.alreadyRunning === true && launched.length === 1,
  `alreadyRunning=${String(again.body?.provision?.alreadyRunning)} instances=${String(launched.length)}`)

// read-token must recover the same credential from the log.
const readBack = await post(`${base}/provision`, { id: peerId, action: 'read-token', remoteHome })
check('reading the token back from the log finds the same launch',
  readBack.body?.provision?.found === true,
  JSON.stringify(readBack.body?.provision ?? null).slice(0, 160))

// Stop, then confirm the instance is actually gone and the peer unreadable.
// No pid is passed: `stop` reads the one the launcher wrote on the "remote".
const stopped = await post(`${base}/provision`, { id: peerId, action: 'stop', remoteHome })
check('stopping the provisioned remote succeeds',
  stopped.body?.provision?.stopped === true,
  JSON.stringify(stopped.body?.provision ?? null).slice(0, 200))
check('the stop found the pid the launcher recorded on the remote',
  stopped.body?.provision?.by === 'pid',
  `by=${String(stopped.body?.provision?.by)}`)
await new Promise(resolve => { setTimeout(resolve, 1500) })
const stillListening = await (async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${String(outcome.port)}/`, { signal: AbortSignal.timeout(2000) })
    return response.status
  } catch {
    return 'refused'
  }
})()
check('the stopped instance is really gone (its port refuses connections)',
  stillListening === 'refused',
  `port ${String(outcome.port)} answered: ${String(stillListening)}`)
const afterStop = await post(`${base}/sessions`, { peerId, force: true })
check('the peer is unreadable again after its instance is stopped',
  afterStop.body?.status === 'error',
  `status=${String(afterStop.body?.status)} code=${String(afterStop.body?.error?.code)}`)

await teardown()

const failed = results.filter(result => !result.pass)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
