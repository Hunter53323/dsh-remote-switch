// Verify the Windows provisioning path against a REAL Windows host.
//
// Two separate questions are answered, and they must not be conflated:
//   1. Does MY mechanism work on Windows? (launcher → WMI detach → pid → log
//      poll → token parse → tree-kill stop.) Verified with a stand-in entry
//      script, so it does not depend on that machine's dsh install.
//   2. Does `dsh web` actually boot there? That depends on the machine's own
//      profile, so it is reported rather than asserted.
//
// Uses port 3099 and a private temp dir on the remote, so an instance already
// serving on 3080 is never touched. Cleans up on every path.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { SshTransport } from '../lib/federation/ssh.js'
import { PeerProvisioner } from '../lib/federation/provisioner.js'

const host = process.argv[2] ?? '192.168.3.7'
const user = process.argv[3] ?? 'admin'
const password = process.argv[4] ?? 'sjtuer10087'
const remoteHome = process.argv[5] ?? 'C:\\Users\\admin\\.dsh'
const PORT = 3099
const STAND_IN = 'C:\\Users\\admin\\dsh-verify-standin.js'
const TOKEN = 'STANDIN_TOKEN_42'

const scratch = mkdtempSync(path.join(tmpdir(), 'win-provision-'))
const transport = new SshTransport({
  knownHostsFile: path.join(scratch, 'known_hosts.json'),
  hostKeyPolicy: 'accept-new',
})
const provisioner = new PeerProvisioner({
  transport,
  readyTimeoutMs: 30000,
  logger: { warn: (message) => console.log('  (warn)', message) },
})

const peer = {
  id: 'win-real',
  label: 'windows-real',
  channel: 'ssh',
  origin: `http://127.0.0.1:${String(PORT)}`,
  ssh: { host, user, port: 22, remotePort: PORT, password },
}

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`)
}

let started = false
try {
  // ── 1. the environment ────────────────────────────────────────────────────
  const kind = await provisioner.remoteKind(peer)
  check('the host is detected as windows', kind === 'windows', kind)

  const before = await provisioner.status(peer)
  check('status answers on Windows instead of claiming unsupported',
    before.unknown !== true && /NO-LISTENER|LISTEN/u.test(before.evidence),
    `listening=${String(before.listening)} evidence=${before.evidence.slice(0, 70)}`)

  // ── 2. the mechanism, with a stand-in entry script ────────────────────────
  // The stand-in binds the port for real, so `status` and `stop` are exercised
  // against an actual listener rather than against a script that only prints.
  await provisioner.powershell(peer, `
Set-Content -LiteralPath '${STAND_IN}' -Encoding ascii -Value @'
const http = require("http");
http.createServer((request, response) => response.end("ok")).listen(${String(PORT)}, "127.0.0.1");
console.log("dsh web: http://127.0.0.1:${String(PORT)}/?token=${TOKEN}");
setInterval(() => {}, 1000);
'@
`)
  check('a stand-in entry script can be written to the remote', true, STAND_IN)

  const outcome = await provisioner.start(peer, { remoteHome, port: PORT, remoteDsh: STAND_IN })
  started = true
  check('a Windows start writes a launcher, detaches it, and reads the token back',
    outcome.started === true && outcome.token === TOKEN,
    `token=${String(outcome.token)} port=${String(outcome.port)} pid=${String(outcome.pid)}`)
  check('the recorded pid comes from WMI', Number.isFinite(outcome.pid), String(outcome.pid))

  const during = await provisioner.status(peer)
  check('status sees the instance that was just started', during.listening === true, during.evidence.slice(0, 80))

  const stopped = await provisioner.stop(peer, { remoteHome })
  started = false
  check('a Windows stop kills the wrapper AND the node child', stopped.stopped === true, `by=${String(stopped.by)}`)

  await new Promise((resolve) => setTimeout(resolve, 1500))
  const after = await provisioner.status(peer)
  check('the port is genuinely free afterwards', after.listening === false && after.unknown !== true,
    `listening=${String(after.listening)} evidence=${after.evidence.slice(0, 70)}`)

  // ── 3. does that machine's own `dsh web` boot? (reported, not asserted) ──
  console.log('\n--- 该机器自身的 dsh web 能否启动（取决于它的 profile，不计入判定）---')
  try {
    const real = await provisioner.start(peer, { remoteHome, port: PORT })
    started = true
    console.log(`  能启动：token=${String(real.token).slice(0, 12)}… port=${String(real.port)}`)
    await provisioner.stop(peer, { remoteHome })
    started = false
  } catch (error) {
    const log = error?.details?.log
    const cause = typeof log === 'string'
      ? (log.split('\n').filter(line => /Cannot find package|ERR_MODULE_NOT_FOUND|Error:/u.test(line)).slice(-3).join(' / ') || log.trim().split('\n').slice(-2).join(' / '))
      : ''
    console.log(`  起不来（${String(error?.code ?? '')}）：${String(error?.message ?? error).slice(0, 120)}`)
    if (cause !== '') console.log(`  远端日志里的原因：${cause.trim().slice(0, 300)}`)
  }
} catch (error) {
  check('the mechanism run completed without an unexpected failure', false,
    error instanceof Error ? `${String(error.code ?? error.name)}: ${error.message}` : String(error))
} finally {
  if (started) {
    console.log('\n(cleanup) an instance was still up — stopping it')
    try { await provisioner.stop(peer, { remoteHome }) } catch (error) { console.log('  cleanup failed:', error.message) }
  }
  try {
    await provisioner.powershell(peer, `Remove-Item -LiteralPath '${STAND_IN}' -ErrorAction SilentlyContinue`)
  } catch { /* best effort */ }
  transport.close()
  rmSync(scratch, { recursive: true, force: true })
}

const failed = results.filter((item) => !item.pass)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`)
process.exit(failed.length === 0 ? 0 : 1)
