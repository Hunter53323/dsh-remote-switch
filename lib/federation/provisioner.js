/**
 * Start and stop the remote machine's own `dsh web`.
 *
 * This is the one place in this plugin that runs a command on the remote, and
 * it exists because a peer whose instance is not running is otherwise useless:
 * the panel can list nothing, and the user has to go to that machine to bring
 * it up. Everything else here is read-only HTTP by design (§6).
 *
 * Two facts shape the implementation:
 *
 *   1. `dsh web` prints its launch URL — and therefore the **token** — exactly
 *      once, on stdout, at startup. So "start it" and "learn its credential"
 *      are the same act: the process is started detached with its output going
 *      to a log file, and the token is read back out of that file. That token
 *      is what makes the panel work immediately after a start, with no copy and
 *      paste.
 *   2. A non-interactive SSH command gets a minimal environment. `dsh` is often
 *      NOT on that PATH even when it is on the user's interactive PATH, so the
 *      command to run is configuration (`remoteDsh`), defaulting to `dsh`.
 *
 * Both platforms are supported, and they need genuinely different mechanisms:
 * POSIX uses `setsid nohup bash -lc … &` with the pid recorded from `echo $!`,
 * Windows writes a `launch.cmd` and starts it through WMI
 * (`Win32_Process.Create`), because a plain `Start-Process` child is killed with
 * the SSH channel's job object. The remote's platform is detected, not guessed
 * from the peer record.
 *
 * "POSIX" here means Linux with `bash`: `setsid`/`ss`/`netstat -ltn` are Linux
 * spellings, so macOS and the BSDs are not covered (and are not tested).
 *
 * @module dsh-remote-switch/federation/provisioner
 */

import { TransportError } from './ssh.js'

/** How long to wait for a started instance to print its token. */
const READY_TIMEOUT_MS = 30000

/** How often the log file is re-read while waiting. */
const READY_POLL_MS = 700

/** How long to wait between "is the port free yet" probes after a stop. */
const STOP_SETTLE_MS = 400

/** Lines of log returned to the panel. */
const LOG_TAIL_LINES = 40

/** Default command name when the peer does not override it. */
const DEFAULT_REMOTE_DSH = 'dsh'

/**
 * The launcher this plugin writes on a Windows remote.
 *
 * A file rather than an inline command line: it keeps the messy quoting (spaces
 * in `C:\Program Files\…`, `>>`, `&&`) in one place that can be read back and
 * debugged, and it reduces the WMI call to a single simple argument.
 */
const WINDOWS_LAUNCHER = 'launch.cmd'

/**
 * Quote one value for a POSIX shell.
 *
 * Single quotes make everything literal except a single quote itself, which is
 * closed, escaped, and reopened. Doing this manually (rather than trusting the
 * value) matters: a remote directory or command path comes from user
 * configuration and lands in a shell command line.
 * @param {string} value - the raw value.
 * @returns {string} a safely quoted word.
 */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/**
 * POSIX paths for the provisioner's own files on the remote.
 * @param {string} remoteHome - the remote `DSH_HOME`.
 * @param {'posix' | 'windows'} [kind] - the remote's platform family.
 * @returns {{ logFile: string, pidFile: string, dir: string, launcher: string }} the paths.
 */
function provisionPaths(remoteHome, kind = 'posix') {
  const separator = kind === 'windows' ? '\\' : '/'
  const dir = `${remoteHome.replace(/[/\\]+$/u, '')}${separator}federation`
  return {
    dir,
    logFile: `${dir}${separator}web.log`,
    pidFile: `${dir}${separator}web.pid`,
    launcher: `${dir}${separator}${WINDOWS_LAUNCHER}`,
  }
}

/**
 * Turn PowerShell's CLIXML error channel back into readable text.
 *
 * Over a non-interactive SSH session PowerShell writes errors as
 * `#< CLIXML` followed by a serialized `<Objs>` document, with newlines escaped
 * as `_x000D_`/`_x000A_`. Left alone that is what the user would be shown. The
 * `<S S="Error">` records carry the actual messages, so they are extracted and
 * unescaped here.
 * @param {string} text - raw stdout/stderr from the channel.
 * @returns {string} human-readable text.
 */
function stripClixml(text) {
  if (typeof text !== 'string' || !text.includes('#< CLIXML')) return typeof text === 'string' ? text : ''
  const marker = text.indexOf('#< CLIXML')
  const before = text.slice(0, marker).trim()
  const xml = text.slice(marker)
  const messages = [...xml.matchAll(/<S S="[^"]*">([\s\S]*?)<\/S>/gu)]
    .map(match => match[1].replaceAll('_x000D_', '').replaceAll('_x000A_', '\n').trim())
    .filter(message => message !== '')
  return [before, ...messages].filter(Boolean).join('\n')
}

/**
 * Run one PowerShell script on a Windows peer.
 *
 * The script is base64-encoded (`-EncodedCommand`) rather than passed as a
 * command line. That is not a stylistic choice: the paths involved contain
 * spaces (`C:\Program Files\…`) and the scripts contain quotes, `%`, `$` and
 * pipe characters — every one of which is mangled by at least one layer of
 * cmd/PowerShell/OpenSSH quoting. Encoding removes the whole problem, and it is
 * the only form that survived the probing on a real Windows host.
 * @param {string} script - the PowerShell source.
 * @returns {string} the `-EncodedCommand` argument value.
 */
function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Escape one value for a PowerShell SINGLE-quoted literal.
 *
 * Inside single quotes PowerShell treats everything literally except `'` itself,
 * which is escaped by doubling — the same idea as POSIX quoting, but a different
 * escape, so `shellQuote` must not be reused here.
 * @param {string} value - the raw value.
 * @returns {string} the escaped body (without the surrounding quotes).
 */
function escapeSingle(value) {
  return String(value).replaceAll("'", "''")
}

/**
 * Whether a Windows port line shows a listener.
 * @param {string} output - the PowerShell output.
 * @returns {boolean} true when a listener is present.
 */
function windowsShowsListener(output) {
  return /^LISTEN\s/mu.test(output)
}

/**
 * Pull the launch token out of `dsh web` output.
 *
 * The line is `dsh web: http://127.0.0.1:<port>/?token=<token>` (optionally
 * followed by a `(LAN: …)` suffix). The port is read from the same URL, which
 * is authoritative: a `--port 0` start picks its own, and the panel's view of
 * the peer must follow what actually happened rather than what was asked for.
 * @param {string} text - the log so far.
 * @returns {{ token: string, port?: number, url: string } | undefined} the launch facts.
 */
export function parseLaunchUrl(text) {
  const match = /dsh web:\s*(https?:\/\/[^\s)]+\?token=([^\s&)]+))/u.exec(text)
  if (match === null) return undefined
  const url = match[1]
  const token = match[2]
  if (token === undefined || token === '') return undefined
  let port
  try {
    const parsed = new URL(url)
    port = Number(parsed.port) || undefined
  } catch {
    port = undefined
  }
  return { token, url, ...(port === undefined ? {} : { port }) }
}

/**
 * Pull the browser-reachable origin out of `@linxin666/dsh-remote-web-ui` output.
 *
 * That plugin TAKES OVER the startup line: instead of
 * `dsh web: http://127.0.0.1:<port>/?token=…` it prints
 * `remote-web-ui: the paired Web GUI is reachable on LAN at http://…`.
 * There is no token in it, because access there is gated by device pairing
 * rather than by a launch token — so such a machine can never satisfy a
 * token-scraping check, and "no launch URL within 30s" was a FALSE failure while
 * the instance was actually up and serving.
 *
 * The URL it reports is also an address a browser on another machine can reach,
 * which is exactly the "jump address" the panel otherwise has to ask the user for.
 * @param {string} text - the log so far.
 * @returns {{ origin: string, url: string } | undefined} the reported origin.
 */
export function parseRemoteUiUrl(text) {
  const match = /remote-web-ui:.*?reachable on LAN at\s*(https?:\/\/[^\s,)]+)/u.exec(text)
  if (match === null) return undefined
  const url = match[1]
  return { origin: url.replace(/\/+$/u, ''), url }
}

/**
 * Whether a port line from `ss`/`netstat` shows a listener.
 * @param {string} output - the tool's output.
 * @param {number} port - the port to look for.
 * @returns {boolean} true when a listener is present.
 */
function outputShowsListener(output, port) {
  return new RegExp(`[:.]${String(port)}\\s`, 'u').test(output)
}

/**
 * Owns the remote instance lifecycle for one peer at a time.
 */
export class PeerProvisioner {
  /**
   * @param {{
   *   transport: import('./ssh.js').SshTransport,
   *   timeoutMs?: number,
   *   readyTimeoutMs?: number,
   *   logger?: { warn: (message: string) => void },
   * }} options - dependencies.
   */
  constructor(options) {
    this.transport = options.transport
    this.timeoutMs = options.timeoutMs ?? 20000
    // Configurable so a test does not have to spend the real half-minute
    // waiting out a remote that will never print a launch URL.
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.logger = options.logger
    /** @type {Map<string, 'posix' | 'windows'>} detected remote kind per peer. */
    this.kinds = new Map()
    /** @type {Map<string, string>} resolved remote home per peer+raw value. */
    this.homes = new Map()
  }

  /**
   * Forget every fact cached about one peer.
   *
   * Both caches are keyed by peer id while their *values* describe a particular
   * machine — so once the user edits a peer's host, user, port or home, the
   * cached answers belong to the old machine and would be applied to the new
   * one. `start()` would, for instance, keep running POSIX commands against a
   * host whose row now says Windows. Called from the peer-save path.
   * @param {string} peerId - the peer whose cached facts are stale.
   * @returns {void}
   */
  forget(peerId) {
    this.kinds.delete(peerId)
    for (const key of [...this.homes.keys()]) {
      // The home cache key is `<peerId>\u0000<raw>`; the NUL keeps one id from
      // ever being a prefix of another.
      if (key.startsWith(`${peerId}\u0000`)) this.homes.delete(key)
    }
  }

  /**
   * Resolve the remote `DSH_HOME` into a path that platform's shell can use.
   *
   * The configured default is `~/.dsh` — POSIX shell syntax. On Windows both the
   * `~` and the `/` are fatal, and they fail SILENTLY: PowerShell's `-Path`
   * expands `~` (so the directory is created in the right place), but `cmd.exe`
   * does not, so a launcher containing `>> "~/.dsh\federation\web.log"` redirects
   * to a path that does not exist. No log is ever written, and the failure
   * reaches the user as a bare "no launch URL within 30s" with an EMPTY log to
   * show for it. Both halves were observed on a real Windows host.
   *
   * Resolution happens ON the remote, where the real profile directory is
   * authoritative, rather than by guessing from this machine.
   * @param {object} peer - the peer row.
   * @param {string} remoteHome - the configured home (may contain `~`).
   * @returns {Promise<string>} a path usable by that platform's shell.
   */
  async remoteHomeOf(peer, remoteHome) {
    const kind = await this.remoteKind(peer)
    if (!remoteHome.includes('~') && !(kind === 'windows' && remoteHome.includes('/'))) return remoteHome
    const cacheKey = `${peer.id}\u0000${remoteHome}`
    const cached = this.homes.get(cacheKey)
    if (cached !== undefined) return cached

    let resolved = ''
    if (kind === 'windows') {
      const result = await this.powershell(peer, `
$raw = '${escapeSingle(remoteHome)}'
if ($raw -eq '~') { $raw = $env:USERPROFILE }
elseif ($raw.StartsWith('~/') -or $raw.StartsWith('~\\')) { $raw = Join-Path $env:USERPROFILE $raw.Substring(2) }
elseif ($raw.StartsWith('~')) { $raw = $env:USERPROFILE + $raw.Substring(1) }
Write-Output ($raw -replace '/', '\\')
`, 15000)
      resolved = result.stdout.trim().split('\n').pop()?.trim() ?? ''
    } else {
      // POSIX needs this too, and the reason is NOT obvious: every path handed to
      // the shell goes through `shellQuote`, whose single quotes SUPPRESS tilde
      // expansion. `mkdir -p '~/.dsh/federation'` therefore created a directory
      // literally named `~` under the working directory, `DSH_HOME='~/.dsh'`
      // pointed the instance at that same junk location, and the log this plugin
      // reads was never in the real home at all. Resolving `~` on the remote —
      // where $HOME is authoritative — removes the whole class.
      const result = await this.transport.exec(peer, [
        `raw=${shellQuote(remoteHome)}`,
        `case "$raw" in`,
        `  '~') printf '%s\\n' "$HOME" ;;`,
        `  '~/'*) printf '%s\\n' "$HOME/\${raw#\\~/}" ;;`,
        // `~user/...`. Resolved through the password database rather than `eval`:
        // the value comes from configuration and running it through `eval` would
        // turn a bad setting into arbitrary command execution.
        `  '~'*) u=\${raw#\\~}; u=\${u%%/*}; rest=\${raw#*"$u"}`,
        `         home=$(getent passwd "$u" 2>/dev/null | cut -d: -f6)`,
        `         if [ -n "$home" ]; then printf '%s\\n' "$home$rest"; else printf '%s\\n' "$raw"; fi ;;`,
        `  *) printf '%s\\n' "$raw" ;;`,
        `esac`,
      ].join('\n'), { timeoutMs: 10000 })
      resolved = result.stdout.trim().split('\n').pop()?.trim() ?? ''
    }

    // Fall back to the RAW value rather than inventing one: a wrong home is
    // diagnosable, a silently substituted one is not.
    const value = resolved === '' ? remoteHome : resolved
    this.homes.set(cacheKey, value)
    return value
  }

  /**
   * Detect the remote's platform family, once per peer.
   *
   * `uname` exists on every POSIX system and on Windows only inside a POSIX
   * emulation layer, so its absence plus a successful `cmd` probe means a
   * native Windows host.
   * @param {object} peer - the peer row.
   * @returns {Promise<'posix' | 'windows'>} the platform family.
   */
  async remoteKind(peer) {
    const known = this.kinds.get(peer.id)
    if (known !== undefined) return known
    // `cmd.exe` is the decisive marker, and it is checked FIRST on purpose.
    // `uname` alone is not enough: a Windows machine with Git for Windows on the
    // non-interactive PATH has a `uname.exe`, and that emulation would report
    // `Linux`-ish output while every process launched there is a Windows process
    // needing `taskkill`, not `kill`. Asking Windows directly cannot be spoofed
    // that way.
    const cmd = await this.transport.exec(peer, 'cmd /c ver', { timeoutMs: 8000 })
    if (/Microsoft Windows|Version \d+\.\d+/iu.test(`${cmd.stdout}${cmd.stderr}`)) {
      this.kinds.set(peer.id, 'windows')
      return 'windows'
    }
    const probe = await this.transport.exec(peer, 'uname -s', { timeoutMs: 8000 })
    const kind = probe.code === 0 && probe.stdout.trim() !== '' ? 'posix' : 'windows'
    this.kinds.set(peer.id, kind)
    return kind
  }

  /**
   * Run one PowerShell script on a Windows peer and return readable output.
   * @param {object} peer - the peer row.
   * @param {string} script - the PowerShell source.
   * @param {number} [timeoutMs] - command timeout.
   * @returns {Promise<{ code: number, stdout: string, stderr: string }>} the result, CLIXML decoded.
   */
  async powershell(peer, script, timeoutMs = 15000) {
    const prelude = '$ProgressPreference = \'SilentlyContinue\'\n$ErrorActionPreference = \'Stop\'\n'
    const result = await this.transport.exec(
      peer,
      `powershell -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ${encodePowerShell(prelude + script)}`,
      { timeoutMs },
    )
    return { ...result, stdout: stripClixml(result.stdout), stderr: stripClixml(result.stderr) }
  }

  /**
   * Whether an instance appears to be listening on the peer's web port.
   *
   * `unknown` matters as much as the boolean: when the platform cannot be
   * queried (no `ss`/`netstat`, no `Get-NetTCPConnection`), reporting
   * `listening: false` is a LIE — the panel would say "not running" about a
   * machine that is running. The caller must be able to say "cannot tell".
   * @param {object} peer - the peer row.
   * @returns {Promise<{ listening: boolean, evidence: string, unknown?: boolean }>} the finding.
   */
  async status(peer) {
    const port = peer.ssh.remotePort
    const kind = await this.remoteKind(peer)

    if (kind === 'windows') {
      const result = await this.powershell(peer, `
$found = @(Get-NetTCPConnection -LocalPort ${String(port)} -State Listen -ErrorAction SilentlyContinue)
if ($found.Count -gt 0) {
  $found | ForEach-Object { "LISTEN " + $_.LocalAddress + ":" + $_.LocalPort + " pid=" + $_.OwningProcess }
} else {
  "NO-LISTENER"
}
`, 15000)
      const output = `${result.stdout}\n${result.stderr}`.trim()
      // Neither answer present = the probe itself failed; do not guess.
      if (!windowsShowsListener(output) && !output.includes('NO-LISTENER')) {
        return { listening: false, unknown: true, evidence: output.slice(0, 400) }
      }
      return { listening: windowsShowsListener(output), evidence: output.slice(0, 400) }
    }

    // Try the modern tool first, then the older one; either may be absent from a
    // minimal environment, and absence must not read as "not listening".
    const command = `ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true`
    const result = await this.transport.exec(peer, command, { timeoutMs: 10000 })
    const output = `${result.stdout}\n${result.stderr}`.trim()
    // Empty output means neither tool exists, which is not evidence of absence.
    if (output === '') return { listening: false, unknown: true, evidence: '(ss/netstat 都不可用)' }
    return {
      listening: outputShowsListener(output, port),
      evidence: output.split('\n').slice(0, 6).join(' | ').slice(0, 400),
    }
  }

  /**
   * The last lines of the instance's log.
   * @param {object} peer - the peer row.
   * @param {string} remoteHome - the remote `DSH_HOME`.
   * @param {number} [lines] - how many lines.
   * @returns {Promise<string>} the tail (empty when there is no log).
   */
  async tailLog(peer, remoteHome, lines = LOG_TAIL_LINES) {
    const kind = await this.remoteKind(peer)
    const home = await this.remoteHomeOf(peer, remoteHome)
    const { logFile } = provisionPaths(home, kind)
    if (kind === 'windows') {
      const result = await this.powershell(peer, `
if (Test-Path -LiteralPath '${escapeSingle(logFile)}') {
  Get-Content -LiteralPath '${escapeSingle(logFile)}' -Tail ${String(lines)} -ErrorAction SilentlyContinue
} else {
  Write-Output '(远端没有 ${escapeSingle(logFile)} —— 拉起时日志没能创建出来)'
}
`, 15000)
      return result.stdout.trim()
    }
    const result = await this.transport.exec(peer, `tail -n ${String(lines)} ${shellQuote(logFile)} 2>/dev/null || true`, { timeoutMs: 10000 })
    return result.stdout.trim()
  }

  /**
   * Locate `node` and the dsh entry script on a Windows peer.
   *
   * `dsh` on Windows is a shim (`dsh.ps1` / `dsh.cmd`), and its npm prefix
   * directory holds the real `node_modules/@deepseek-ai/dsh/lib/bin.js`. Running
   * node against that file directly keeps the recorded pid meaningful — going
   * through the shim would add a PowerShell host process in between.
   * @param {object} peer - the peer row.
   * @param {string} [override] - a user-supplied path to use as the entry script.
   * @returns {Promise<{ node: string, bin: string }>} the resolved paths.
   * @throws {TransportError} when they cannot be resolved.
   */
  async resolveWindowsLaunch(peer, override) {
    const result = await this.powershell(peer, `
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$shim = (Get-Command dsh -ErrorAction SilentlyContinue).Source
$bin = $null
if ($shim) {
  $prefix = Split-Path $shim -Parent
  $candidate = Join-Path $prefix 'node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
  if (Test-Path -LiteralPath $candidate) { $bin = $candidate }
}
if (-not $bin -and $shim -and $shim.EndsWith('.js')) { $bin = $shim }
Write-Output ("node=" + $node)
Write-Output ("bin=" + $bin)
`, 15000)
    const node = /^node=(.+)$/mu.exec(result.stdout)?.[1]?.trim()
    const bin = /^bin=(.+)$/mu.exec(result.stdout)?.[1]?.trim()
    const resolveScript = override !== undefined && override !== '' ? override : bin
    if (resolveScript === undefined || resolveScript === '' || node === undefined || node === '') {
      throw new TransportError(
        'provision-unresolved',
        '在那台 Windows 上找不到 node 或 dsh 的入口脚本：请确认 dsh 已全局安装，或在「远端 dsh 命令」里直接填 bin.js 的完整路径',
        { detail: result.stdout.slice(0, 300) },
      )
    }
    return { node, bin: resolveScript }
  }

  /**
   * Start the remote's `dsh web` and read back its launch token.
   *
   * The process is detached with `setsid` so it survives the SSH channel
   * closing — which it must, since the whole point is to leave it running. Its
   * output goes to a log file rather than the channel for the same reason, and
   * that log is where the token is read from.
   *
   * @param {object} peer - the peer row.
   * @param {{ remoteHome: string, remoteDsh?: string, remoteDir?: string, port?: number, extraArgs?: string[], force?: boolean }} options - start options.
   *   `force` restarts an instance that is already listening (stop, then launch):
   *   that is how a stale stored token gets replaced with the current boot's.
   * @returns {Promise<{ started: boolean, alreadyRunning?: boolean, token?: string, port: number, pid?: number, logFile: string, detail?: string }>} the outcome.
   * @throws {TransportError} when the platform is unsupported or the start failed.
   */
  async start(peer, options) {
    const kind = await this.remoteKind(peer)
    // Resolve BEFORE anything is written: on Windows a `~`-style home would put
    // the log somewhere cmd cannot reach, and the failure would look like a
    // startup timeout with nothing to show for it.
    const remoteHome = await this.remoteHomeOf(peer, options.remoteHome)
    const { logFile, pidFile, dir, launcher } = provisionPaths(remoteHome, kind)
    const port = options.port ?? peer.ssh.remotePort

    const current = await this.status(peer)
    if (current.listening && options.force !== true) {
      return { started: false, alreadyRunning: true, port, logFile, detail: current.evidence }
    }
    // `force` means RESTART, not "launch a second one beside it": the running
    // process still holds the port, so launching again would only produce
    // EADDRINUSE and a message about the wrong problem. Stopping first is also
    // the only way this plugin can ever learn a *new* token — the log is cleared
    // at launch, so a fresh launch is what puts the current boot's token in it.
    if (current.listening) {
      const stopped = await this.stop(peer, { remoteHome })
      // A restart that did not actually stop anything is worse than no restart:
      // the old instance keeps the port, so the browser goes on talking to IT
      // while this plugin captures the new instance's token — and the harness
      // answers the mismatch with its 401 page, which looks like "the new token
      // does not work". So the stop has to be confirmed, not assumed.
      if (stopped.stopped !== true) {
        throw new TransportError('provision-stop-failed',
          `没能停掉远端 ${String(port)} 端口上的实例（${stopped.detail ?? '没找到它占用的进程'}），因此没有重新拉起：旧实例还在占着端口，而浏览器连上的是它——它手里的 token 和新捕获的对不上`)
      }
      // Killing is not the same as being gone; give the port a moment to be
      // released before concluding the stop failed.
      let stillListening = true
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise(resolve => { setTimeout(resolve, STOP_SETTLE_MS) })
        const after = await this.status(peer)
        stillListening = after.listening
        if (!stillListening || after.unknown === true) break
      }
      if (stillListening) {
        throw new TransportError('provision-stop-failed',
          `远端 ${String(port)} 端口仍在监听，实例没有真正停下来，因此没有重新拉起（再拉起一个只会撞端口，或被浏览器连到旧实例）`)
      }
    }

    const pid = kind === 'windows'
      ? await this.launchWindows(peer, { ...options, remoteHome, port, logFile, pidFile, dir, launcher })
      : await this.launchPosix(peer, { ...options, remoteHome, port, logFile, pidFile, dir })

    // The token only appears once the server is up, so poll the log rather than
    // guessing a fixed delay — a slow machine would otherwise be reported as a
    // failure while it is in fact starting fine.
    const deadline = Date.now() + this.readyTimeoutMs
    let lastLog = ''
    // A machine can print BOTH lines, and the remote-web-ui one comes FIRST: its
    // plugin announces the LAN bind before the harness prints the launch URL
    // (observed on a real instance). Returning on it inside the loop would throw
    // away a token that was about to arrive, so it is only a FALLBACK, consulted
    // once the poll is over.
    let sawPairingLine
    while (Date.now() < deadline) {
      await new Promise(resolve => { setTimeout(resolve, Math.min(READY_POLL_MS, Math.max(50, this.readyTimeoutMs / 4))) })
      lastLog = await this.tailLog(peer, remoteHome)
      const launch = parseLaunchUrl(lastLog)
      if (launch !== undefined) {
        return {
          started: true,
          token: launch.token,
          port: launch.port ?? port,
          credential: 'token',
          ...(Number.isFinite(pid) ? { pid } : {}),
          logFile,
        }
      }
      // @linxin666/dsh-remote-web-ui replaces the launch line with its own, and
      // access there is gated by device pairing — there may be no token at all.
      // Its line also names a browser-reachable address, which the panel would
      // otherwise have to ask the user for.
      const paired = parseRemoteUiUrl(lastLog)
      if (paired !== undefined) sawPairingLine = paired
    }

    if (sawPairingLine !== undefined) {
      return {
        started: true,
        port,
        credential: 'device',
        webOrigin: sawPairingLine.origin,
        ...(Number.isFinite(pid) ? { pid } : {}),
        logFile,
      }
    }

    // Neither line appeared. The port being up is still proof that it started —
    // the log format is not this plugin's to control, so absence of a recognised
    // line must not be reported as absence of an instance.
    const after = await this.status(peer)
    if (after.listening) {
      return {
        started: true,
        port,
        credential: 'unknown',
        ...(Number.isFinite(pid) ? { pid } : {}),
        logFile,
        detail: after.evidence,
      }
    }
    // "The command does not exist" is a different problem from "it started and
    // never printed a URL", and it has a concrete fix. Reporting both as an
    // undifferentiated timeout sends the user looking for port clashes when the
    // answer is a PATH.
    if (/failed to run command|无法运行命令|command not found|: not found|No such file or directory/iu.test(lastLog)) {
      throw new TransportError(
        'provision-dsh-not-found',
        `远端没能执行 ${options.remoteDsh ?? DEFAULT_REMOTE_DSH}：非交互 SSH 的 PATH 里通常没有它（nvm/volta/asdf 装的命令只对登录 shell 可见）。` +
          `已经尝试用登录 shell 解析；如果仍然失败，请在「远端 dsh 命令」里填它的绝对路径（在那边执行 bash -lc 'command -v dsh' 就能看到）。` +
          `DSH_HOME=${remoteHome}，日志=${logFile}`,
        { log: lastLog.slice(-1500), remoteHome, logFile },
      )
    }
    throw new TransportError(
      'provision-not-ready',
      `${String(Math.round(this.readyTimeoutMs / 1000))} 秒内没等到远端打印启动 URL：它可能起不来（端口被占、dsh 不在非交互 PATH 里），或这台机器上 DSH_HOME 不对。` +
        `本次用的 DSH_HOME 是 ${remoteHome}，日志在 ${logFile}`,
      { log: lastLog.slice(-1500), remoteHome, logFile },
    )
  }

  /**
   * Find the `dsh` command the way an INTERACTIVE login would.
   *
   * A non-interactive SSH command runs with a bare PATH — no nvm, no volta, no
   * asdf — so `dsh` is simply absent, and the launch dies with
   * `nohup: failed to run command 'dsh': No such file or directory` while
   * `ssh host` followed by `dsh web` works perfectly. That asymmetry is the
   * whole bug, and a login shell (`bash -lc`) is what closes it, because the
   * PATH that makes `dsh` visible is set up by the profile/rc files.
   *
   * Resolving the absolute path is only HALF the fix: nvm installs `dsh` as a
   * script whose interpreter is `node`, and `node` is missing from that same
   * bare PATH. The launcher therefore also runs through the login shell, so the
   * interpreter is found too.
   * @param {object} peer - the peer row.
   * @param {string} [override] - a user-supplied command name or path.
   * @returns {Promise<string>} the command to launch (absolute when resolvable).
   */
  async resolvePosixLaunch(peer, override) {
    const configured = override !== undefined && override.trim() !== '' ? override.trim() : DEFAULT_REMOTE_DSH
    const probe = await this.transport.exec(
      peer,
      `bash -lc ${shellQuote(`command -v ${shellQuote(configured)}`)} 2>/dev/null || true`,
      { timeoutMs: 10000 },
    )
    const found = probe.stdout.trim().split('\n').pop()?.trim() ?? ''
    // An absolute path when the login shell knows one; otherwise the configured
    // name, so a shell that resolves it at run time still works.
    return found.startsWith('/') ? found : configured
  }

  /**
   * Launch `dsh web` detached on a POSIX peer.
   * @param {object} peer - the peer row.
   * @param {object} options - resolved start options.
   * @returns {Promise<number>} the recorded pid (NaN when unreadable).
   */
  async launchPosix(peer, options) {
    const dsh = await this.resolvePosixLaunch(peer, options.remoteDsh)
    const args = ['web', '--port', String(options.port), '--no-open', ...(options.extraArgs ?? [])]
    // `cd` goes INSIDE the login shell: a login shell may start elsewhere (a
    // profile is free to `cd`), so a `cd` on the outer command would not
    // reliably survive into it.
    const cd = options.remoteDir !== undefined && options.remoteDir !== ''
      ? `cd ${shellQuote(options.remoteDir)} && `
      : ''
    const env = `DSH_HOME=${shellQuote(options.remoteHome)}`
    const inner = `${cd}exec ${shellQuote(dsh)} ${args.map(shellQuote).join(' ')}`
    const command = [
      `mkdir -p ${shellQuote(options.dir)}`,
      `rm -f ${shellQuote(options.pidFile)}`,
      // The log is TRUNCATED, not appended to. It is where the launch URL is read
      // from, so leftover text from an earlier run would be parsed as this run's
      // result and the panel would store a stale token. Only this attempt's
      // output is meaningful for that read.
      `: > ${shellQuote(options.logFile)}`,
      // `bash -lc` here is the fix for the interactive/non-interactive PATH
      // split: it is what makes an nvm/volta/asdf-installed `dsh` — and the
      // `node` its shebang needs — visible at all.
      `${env} setsid nohup bash -lc ${shellQuote(inner)} ` +
        `>> ${shellQuote(options.logFile)} 2>&1 < /dev/null & echo $! > ${shellQuote(options.pidFile)}; cat ${shellQuote(options.pidFile)}`,
    ].join('; ')
    const launched = await this.transport.exec(peer, command, { timeoutMs: this.timeoutMs })
    return Number.parseInt(launched.stdout.trim(), 10)
  }

  /**
   * Launch `dsh web` detached on a Windows peer.
   *
   * `Start-Process` is NOT enough here, and this was measured rather than
   * assumed: Windows OpenSSH runs each session's commands inside a job object,
   * so a `Start-Process` child is killed the moment the channel closes (a probe
   * wrote 5 lines while connected and then died). `Win32_Process.Create` is
   * owned by WMI instead, and the same probe kept writing after a 5s disconnect.
   *
   * The recorded pid is the `cmd.exe` that runs the launcher — the actual `node`
   * is its child — so `stop` must kill the TREE.
   * @param {object} peer - the peer row.
   * @param {object} options - resolved start options.
   * @returns {Promise<number>} the recorded pid (NaN when unreadable).
   * @throws {TransportError} when the launcher cannot be written or the process cannot start.
   */
  async launchWindows(peer, options) {
    const { node, bin } = await this.resolveWindowsLaunch(peer, options.remoteDsh)
    const args = ['web', '--port', String(options.port), '--no-open', ...(options.extraArgs ?? [])]
    const cd = options.remoteDir !== undefined && options.remoteDir !== ''
      ? `cd /d "${options.remoteDir}"\n`
      : ''
    // `>>` appends *within this launch*, which is fine because the log is cleared
    // first (below): the launch URL is read out of this file, so text left over
    // from an earlier run would be mistaken for this run's result.
    const body = [
      '@echo off',
      `set "DSH_HOME=${options.remoteHome}"`,
      ...(cd === '' ? [] : [cd.trimEnd()]),
      `"${node}" "${bin}" ${args.join(' ')} >> "${options.logFile}" 2>&1`,
    ].join('\r\n')

    const result = await this.powershell(peer, `
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path '${escapeSingle(options.dir)}' | Out-Null
Remove-Item -LiteralPath '${escapeSingle(options.pidFile)}' -ErrorAction SilentlyContinue
Remove-Item -LiteralPath '${escapeSingle(options.logFile)}' -ErrorAction SilentlyContinue
Set-Content -LiteralPath '${escapeSingle(options.launcher)}' -Encoding ascii -Value @'
${body}
'@
$cmdline = 'cmd.exe /c "' + '${escapeSingle(options.launcher)}' + '"'
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
if ($created.ReturnValue -ne 0) { throw ("Win32_Process.Create 返回 " + $created.ReturnValue) }
$created.ProcessId | Out-File -LiteralPath '${escapeSingle(options.pidFile)}' -Encoding ascii
Write-Output ("pid=" + $created.ProcessId)
`, this.timeoutMs)

    const pid = Number.parseInt(/^pid=(\d+)$/mu.exec(result.stdout)?.[1] ?? '', 10)
    if (!Number.isFinite(pid)) {
      throw new TransportError('provision-launch-failed', '在那台 Windows 上启动失败（没拿到进程号）', {
        detail: `${result.stdout}\n${result.stderr}`.trim().slice(0, 500),
      })
    }
    return pid
  }

  /**
   * Stop the remote's `dsh web`.
   *
   * Two ways in, tried in order: the pid recorded on the REMOTE when this plugin
   * started the instance (`<remoteHome>/federation/web.pid`), then whatever
   * actually holds the port. The second exists because an instance started by
   * hand has no pid file — and without it "stop" would silently do nothing while
   * the user believed it worked.
   *
   * The pid file is read here rather than passed in: the caller has no way to
   * know a pid that was recorded on the other machine in an earlier session, and
   * requiring one would make "stop" useless exactly when it is needed.
   *
   * @param {object} peer - the peer row.
   * @param {{ remoteHome: string }} options - stop options.
   * @returns {Promise<{ stopped: boolean, by?: 'pid' | 'port', detail?: string }>} the outcome.
   */
  async stop(peer, options) {
    const kind = await this.remoteKind(peer)
    return kind === 'windows'
      ? this.stopWindows(peer, options)
      : this.stopPosix(peer, options)
  }

  /**
   * Stop the remote's `dsh web` on a POSIX peer.
   * @param {object} peer - the peer row.
   * @param {{ remoteHome: string }} options - stop options.
   * @returns {Promise<{ stopped: boolean, by?: 'pid' | 'port', detail?: string }>} the outcome.
   */
  async stopPosix(peer, options) {
    const port = peer.ssh.remotePort
    const { pidFile } = provisionPaths(await this.remoteHomeOf(peer, options.remoteHome), 'posix')

    const recorded = await this.transport.exec(peer, `cat ${shellQuote(pidFile)} 2>/dev/null || true`, { timeoutMs: 10000 })
    const pid = Number.parseInt(recorded.stdout.trim(), 10)

    if (Number.isFinite(pid) && pid > 0) {
      const killed = await this.transport.exec(peer, `kill ${String(pid)} 2>/dev/null && echo killed || echo gone`, { timeoutMs: 10000 })
      if (killed.stdout.includes('killed')) {
        await this.transport.exec(peer, `rm -f ${shellQuote(pidFile)}; true`, { timeoutMs: 8000 })
        return { stopped: true, by: 'pid' }
      }
    }

    // Fall back to the port holder. `fuser` is the most widely available of the
    // several tools that can answer this; each arm is guarded so a missing tool
    // does not abort the whole command.
    const byPort = [
      `PIDS=$( (command -v fuser >/dev/null 2>&1 && fuser -n tcp ${String(port)} 2>/dev/null) ` +
        `|| (command -v lsof >/dev/null 2>&1 && lsof -ti tcp:${String(port)} 2>/dev/null) )`,
      `if [ -n "$PIDS" ]; then kill $PIDS 2>/dev/null; sleep 1; kill -9 $PIDS 2>/dev/null; echo stopped; else echo none; fi`,
      `rm -f ${shellQuote(pidFile)}`,
    ].join('; ')
    const result = await this.transport.exec(peer, byPort, { timeoutMs: 15000 })
    if (result.stdout.includes('stopped')) return { stopped: true, by: 'port' }
    return { stopped: false, detail: `没有找到占用 ${String(port)} 端口的进程（它可能本来就没在跑）` }
  }

  /**
   * Stop the remote's `dsh web` on a Windows peer.
   *
   * The recorded pid belongs to the `cmd.exe` that runs the launcher, and the
   * real `node` is its CHILD — killing only the parent would leave the server
   * running with nothing left pointing at it. `taskkill /T` kills the tree.
   *
   * When there is no pid file (an instance started by hand, which is the normal
   * case on Windows) the port holder answers instead: `Get-NetTCPConnection`
   * reports the owning process, and that process is the node itself.
   * @param {object} peer - the peer row.
   * @param {{ remoteHome: string }} options - stop options.
   * @returns {Promise<{ stopped: boolean, by?: 'pid' | 'port', detail?: string }>} the outcome.
   */
  async stopWindows(peer, options) {
    const port = peer.ssh.remotePort
    const { pidFile } = provisionPaths(await this.remoteHomeOf(peer, options.remoteHome), 'windows')
    const result = await this.powershell(peer, `
$ErrorActionPreference = 'Continue'
$recorded = $null
if (Test-Path -LiteralPath '${escapeSingle(pidFile)}') {
  $raw = (Get-Content -LiteralPath '${escapeSingle(pidFile)}' -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($raw) { $recorded = [int]$raw }
}
if ($recorded) {
  $alive = (Get-Process -Id $recorded -ErrorAction SilentlyContinue) -ne $null
  if ($alive) {
    # /T because the recorded pid is the cmd.exe wrapper and node is its child.
    & taskkill /T /F /PID $recorded 2>&1 | Out-Null
    Start-Sleep -Milliseconds 400
    if ((Get-Process -Id $recorded -ErrorAction SilentlyContinue) -eq $null) {
      Remove-Item -LiteralPath '${escapeSingle(pidFile)}' -ErrorAction SilentlyContinue
      Write-Output 'stopped-by-pid'
      exit 0
    }
  }
}
$owners = @(Get-NetTCPConnection -LocalPort ${String(port)} -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique)
if ($owners.Count -gt 0) {
  foreach ($owner in $owners) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 400
  Remove-Item -LiteralPath '${escapeSingle(pidFile)}' -ErrorAction SilentlyContinue
  Write-Output ('stopped-by-port:' + ($owners -join ','))
  exit 0
}
Write-Output 'none'
`, 20000)

    const output = result.stdout
    if (output.includes('stopped-by-pid')) return { stopped: true, by: 'pid' }
    if (output.includes('stopped-by-port')) return { stopped: true, by: 'port' }
    return { stopped: false, detail: `没有找到占用 ${String(port)} 端口的进程（它可能本来就没在跑）` }
  }
}
