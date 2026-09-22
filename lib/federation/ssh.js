/**
 * SSH transport for a federation peer.
 *
 * One long-lived `ssh2.Client` per peer, opened lazily and kept alive with
 * server-side keepalives; every HTTP request and every WebSocket upgrade rides
 * a fresh `direct-tcpip` channel over that one connection. Node's own
 * `http.request` and `ws` both accept a `createConnection` override, which is
 * what lets an ordinary request be carried by an SSH channel with no local
 * port forward and no listener anywhere:
 *
 *   ssh2's own `HTTPAgent` does the same thing, but it builds a *new*
 *   connection per socket, so it cannot do the reuse this needs. `forwardOut` is
 *   the documented primitive both paths share.
 *
 * Host keys are verified TOFU by default: the first key seen for a host is
 * remembered in this plugin's own `known_hosts.json`, and a later change is
 * refused outright rather than re-learned.
 *
 * @module dsh-remote-switch/federation/ssh
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import ssh2 from 'ssh2'

const { Client } = ssh2

/** Default TCP port of an SSH server. */
const DEFAULT_SSH_PORT = 22

/** How long a connect + auth may take before it is given up on. */
const READY_TIMEOUT_MS = 15000

/** Server keepalive probe interval. */
const KEEPALIVE_INTERVAL_MS = 10000

/** How many unanswered keepalives are tolerated before the connection is dropped. */
const KEEPALIVE_COUNT_MAX = 3

/** Host-key policy values. */
export const HOST_KEY_POLICIES = ['accept-new', 'verify', 'off']

/**
 * Bound on one SFTP call.
 *
 * SFTP requests are matched by id, so an unanswered one leaves its promise
 * pending forever rather than erroring — a pending read stalls the poll and the
 * panel simply stops updating, with nothing to show the user. A bounded wait is
 * what converts that silence into a reportable failure.
 */
const SFTP_CALL_TIMEOUT_MS = 15000

/**
 * Read the host-key store (a plain `{ "<host>:<port>": "<sha256 base64>" }` map).
 * @param {string} file - absolute store path.
 * @returns {Record<string, string>} known hosts; empty when absent or corrupt.
 */
function readKnownHosts(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const hosts = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value !== '') hosts[key] = value
    }
    return hosts
  } catch {
    return {}
  }
}

/**
 * Write the host-key store atomically, best-effort 0600.
 * @param {string} file - absolute store path.
 * @param {Record<string, string>} hosts - the map to persist.
 * @returns {void}
 */
function writeKnownHosts(file, hosts) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${String(process.pid)}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(hosts, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
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
 * Format a host-key fingerprint the way `ssh-keygen -lf` would.
 * @param {Buffer} key - the raw key blob ssh2 hands the verifier.
 * @returns {string} `SHA256:<base64 without padding>`.
 */
function fingerprint(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`
}

/**
 * The error code that marks an SSH-level failure, so the caller can classify it
 * apart from an HTTP-level one.
 * @param {unknown} error - the failure.
 * @returns {string} a stable code.
 */
function sshCode(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/authentication|All configured authentication methods failed/iu.test(message)) return 'ssh-auth'
  if (/host key|Host denied/iu.test(message)) return 'ssh-host-key'
  if (/timed out|ETIMEDOUT|Timeout/iu.test(message)) return 'ssh-timeout'
  if (/ECONNREFUSED/iu.test(message)) return 'ssh-refused'
  if (/ENOTFOUND|EAI_AGAIN/iu.test(message)) return 'ssh-dns'
  return 'ssh-failed'
}

/**
 * An error carrying a machine-readable code for §5.4 classification.
 */
export class TransportError extends Error {
  /**
   * @param {string} code - stable category.
   * @param {string} message - correction-oriented text.
   * @param {object} [details] - extra context (never secrets).
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'TransportError'
    this.code = code
    this.details = details
  }
}

/**
 * Make an SSH channel usable as the socket of an `http.ClientRequest` / `ws`.
 *
 * Node's HTTP client treats whatever `createConnection` hands it as a `net.Socket`
 * and calls socket methods an ssh2 `Channel` does not have — without these, a
 * tunnelled request dies inside `_http_client` with `sock.setTimeout is not a
 * function` before a single byte is sent. ssh2's own `HTTPAgent` shims the same
 * set; the difference here is `setTimeout`, which is *implemented* rather than
 * stubbed: a no-op would silently disable every request timeout, so a hung
 * remote would hang the poller forever instead of failing over to the panel.
 *
 * @param {any} stream - the ssh2 channel.
 * @returns {any} the same stream, decorated in place.
 */
function decorateChannel(stream) {
  // ssh2 channels have no TCP-level knobs; keepalives already cover liveness.
  stream.setNoDelay = () => stream
  stream.setKeepAlive = () => stream
  stream.ref = () => stream
  stream.unref = () => stream
  stream.destroySoon = () => stream.destroy()
  /** @type {NodeJS.Timeout | undefined} */
  let idleTimer
  stream.setTimeout = (ms, callback) => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
    if (typeof ms !== 'number' || ms <= 0) return stream
    const arm = () => {
      idleTimer = setTimeout(() => {
        // Node's contract: emit 'timeout' and let the owner decide; the HTTP
        // client destroys the request when it has no listener of its own.
        if (typeof callback === 'function') callback()
        stream.emit('timeout')
      }, ms)
      idleTimer.unref?.()
    }
    // The timer measures IDLE time, so every byte resets it — matching
    // `net.Socket.setTimeout` rather than a whole-request deadline.
    stream.on('data', () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      arm()
    })
    arm()
    return stream
  }
  const originalDestroy = stream.destroy.bind(stream)
  stream.destroy = (...args) => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
    return originalDestroy(...args)
  }
  return stream
}

/**
 * Owns one SSH connection per peer, plus the host-key policy.
 */
export class SshTransport {
  /**
   * @param {{ hostKeyPolicy?: string, knownHostsFile: string, logger?: { warn: (message: string) => void } }} options - transport options.
   */
  constructor(options) {
    this.policy = HOST_KEY_POLICIES.includes(options.hostKeyPolicy ?? '') ? options.hostKeyPolicy : 'accept-new'
    this.knownHostsFile = options.knownHostsFile
    this.logger = options.logger
    /** @type {Map<string, { client: any, ready: Promise<any> }>} */
    this.connections = new Map()
    /** @type {Map<string, any>} one cached SFTP session per peer. */
    this.sftpSessions = new Map()
    /**
     * The last connection-level error seen per peer, after it was already
     * connected.
     *
     * Kept so those errors are RECORDED rather than silently discarded — they
     * cannot reject a promise nobody is waiting on any more, but they explain
     * why the next read had to redial.
     * @type {Map<string, string>}
     */
    this.lastError = new Map()
  }

  /**
   * Build the ssh2 connect config for one peer.
   * @param {object} peer - the peer row.
   * @returns {object} the config.
   */
  connectConfig(peer) {
    const ssh = peer.ssh
    const config = {
      host: ssh.host,
      port: ssh.port ?? DEFAULT_SSH_PORT,
      username: ssh.user,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      hostHash: 'sha256',
      hostVerifier: (hashedKey) => this.verifyHostKey(ssh.host, ssh.port ?? DEFAULT_SSH_PORT, hashedKey),
    }
    if (typeof ssh.privateKeyPath === 'string' && ssh.privateKeyPath !== '') {
      try {
        config.privateKey = readFileSync(ssh.privateKeyPath)
      } catch (error) {
        throw new TransportError('ssh-key-unreadable', `读不到私钥 ${ssh.privateKeyPath}：${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (typeof ssh.password === 'string' && ssh.password !== '') {
      config.password = ssh.password
    }
    return config
  }

  /**
   * Apply the host-key policy to one presented key.
   *
   * ssh2 hands the verifier a hash when `hostHash` is set, so the stored value
   * is directly comparable; returning true accepts, false aborts the handshake.
   * @param {string} host - the SSH host.
   * @param {number} port - the SSH port.
   * @param {string} presented - the presented key hash (`sha256` base64).
   * @returns {boolean} whether to accept the key.
   */
  verifyHostKey(host, port, presented) {
    if (this.policy === 'off') return true
    const key = `${host}:${String(port)}`
    const known = readKnownHosts(this.knownHostsFile)
    const remembered = known[key]
    if (remembered === undefined) {
      if (this.policy === 'verify') {
        this.logger?.warn(`federation: refusing unseen SSH host key for ${key} (policy verify)`)
        return false
      }
      known[key] = presented
      try {
        writeKnownHosts(this.knownHostsFile, known)
      } catch (error) {
        this.logger?.warn(`federation: could not record SSH host key for ${key}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return true
    }
    if (remembered !== presented) {
      this.logger?.warn(`federation: SSH host key CHANGED for ${key}; refusing the connection`)
      return false
    }
    return true
  }

  /**
   * Get (or open) the shared connection for one peer.
   *
   * A failed connect is *not* cached: the next attempt starts a fresh client,
   * which is what makes "retry after fixing the machine config" work at all.
   * @param {object} peer - the peer row.
   * @returns {Promise<any>} the ready ssh2 client.
   */
  async client(peer) {
    const existing = this.connections.get(peer.id)
    if (existing !== undefined) return existing.ready
    const client = new Client()
    const ready = new Promise((resolve, reject) => {
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        this.drop(peer.id)
        client.end()
        reject(new TransportError(sshCode(error), `SSH 连接失败：${error instanceof Error ? error.message : String(error)}`))
      }
      client.once('ready', () => {
        if (settled) return
        settled = true
        resolve(client)
      })
      // PERSISTENT, deliberately NOT `once`.
      //
      // ssh2 forwards socket-level failures to the Client as an 'error' event,
      // and an EventEmitter with no 'error' listener THROWS — which here means
      // the whole DSH host process dies. A `once` listener is consumed by the
      // first error, and a connection that resets produces more than one
      // (ECONNRESET on read, then again during teardown), so the second one
      // crashed the host. That is not a hypothetical: `查看远端状态` on a peer
      // whose SSH session dropped took the server down.
      client.on('error', (error) => {
        // The connection is gone either way: forget it so the next caller
        // redials instead of reusing a dead client (and a dead SFTP session).
        this.drop(peer.id)
        if (!settled) {
          fail(error)
          return
        }
        // Already connected: nothing is waiting on this error, so it is recorded
        // and swallowed. Escaping here is what killed the process.
        this.lastError.set(peer.id, error instanceof Error ? error.message : String(error))
      })
      client.once('close', () => {
        this.drop(peer.id)
        if (!settled) fail(new Error('connection closed before ready'))
      })
      try {
        client.connect(this.connectConfig(peer))
      } catch (error) {
        fail(error)
      }
    })
    this.connections.set(peer.id, { client, ready })
    // A cached rejection would be replayed forever; drop it as soon as it lands.
    ready.catch(() => { this.connections.delete(peer.id) })
    return ready
  }

  /**
   * Forget everything cached for one peer.
   *
   * Called whenever a connection dies. The SFTP session must go with it: it
   * rides the same connection, so keeping it would make every later static read
   * fail against a channel that no longer exists.
   * @param {string} peerId - the peer whose state to drop.
   * @returns {void}
   */
  drop(peerId) {
    this.connections.delete(peerId)
    this.sftpSessions.delete(peerId)
  }

  /**
   * Open one TCP stream to the far end of the tunnel.
   *
   * The destination is always `127.0.0.1:<remotePort>` — loopback as the remote
   * machine sees it, which is both the only authority its web server trusts and
   * the reason no port has to be exposed on that machine's network.
   *
   * There is no jump-host support: the connection goes straight to the peer, and
   * a peer behind a bastion is reached by pointing `host` at a forwarded address
   * instead. Claiming ProxyJump here would be a promise the code does not keep.
   * @param {object} peer - the peer row.
   * @returns {Promise<any>} the channel stream.
   */
  async dial(peer) {
    const client = await this.client(peer)
    const host = '127.0.0.1'
    const port = peer.ssh.remotePort
    return new Promise((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
        if (error) {
          // "Channel open failure: Connection refused" means the SSH connection
          // itself SUCCEEDED: the remote sshd accepted the request to reach its
          // own loopback and found nothing there. Reporting that as a bare
          // "cannot open 127.0.0.1:3080" is actively misleading — it reads as if
          // the configured host had been ignored, when `127.0.0.1` is precisely
          // the far side of the tunnel. Say what actually happened and where the
          // address points.
          const raw = error instanceof Error ? error.message : String(error)
          if (/Connection refused|ECONNREFUSED|Channel open failure/iu.test(raw)) {
            reject(new TransportError(
              'ssh-remote-not-listening',
              `SSH 已经连上 ${peer.ssh.host}，但那台机器自己的 127.0.0.1:${String(port)} 没有服务在监听——也就是对方的 dsh web 没在跑。` +
                `（这个 127.0.0.1 指的是对方机器的回环，不是你这台；隧道正是靠它把请求送进对方本机，所以对方不需要对外开放端口。）`,
            ))
            return
          }
          reject(new TransportError('ssh-forward-failed', `SSH 通道打不开 ${host}:${String(port)}：${raw}`))
          return
        }
        const channel = decorateChannel(stream)
        // An 'error' event with no listener THROWS and would take the host down.
        // The consumer (Node's http client, or `ws`) attaches its own handler,
        // but only on a later tick — and any second error after that one has
        // fired is unhandled again. This listener does not replace theirs (both
        // run); it only stops the crash and records what happened.
        channel.on('error', (channelError) => {
          this.logger?.warn?.(`SSH 通道出错（${peer.label ?? peer.id}）：${channelError instanceof Error ? channelError.message : String(channelError)}`)
        })
        resolve(channel)
      })
    })
  }

  /**
   * A `createConnection` override for `http.request` / `ws`, bound to one peer.
   * @param {object} peer - the peer row.
   * @returns {(options: object, callback: (error: Error | null, stream?: any) => void) => void} the override.
   */
  createConnection(peer) {
    return (options, callback) => {
      this.dial(peer).then(
        (stream) => {
          callback(null, stream)
        },
        (error) => {
          callback(error instanceof Error ? error : new Error(String(error)))
        },
      )
    }
  }

  /**
   * Run one command on the remote machine and collect its output.
   *
   * Used only by `PeerProvisioner`, which starts and stops the remote's own
   * `dsh web`. Everything else in this plugin is read-only HTTP; this is the
   * one place a command runs, and it runs exactly the command the caller
   * passes — no shell interpolation of user data happens here (callers that
   * need a value in the command line quote it themselves).
   *
   * @param {object} peer - the peer row.
   * @param {string} command - the command to run.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bounds.
   * @returns {Promise<{ code: number, stdout: string, stderr: string, signal?: string }>} the outcome.
   */
  async exec(peer, command, options = {}) {
    const client = await this.client(peer)
    const timeoutMs = options.timeoutMs ?? 20000
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        fn(value)
      }
      const onAbort = () => {
        finish(reject, new TransportError('ssh-exec-aborted', 'SSH 命令被取消'))
      }
      const timer = setTimeout(() => {
        finish(reject, new TransportError('ssh-exec-timeout', `SSH 命令超时（${String(timeoutMs)}ms）`))
      }, timeoutMs)
      timer.unref?.()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      client.exec(command, (error, stream) => {
        if (error) {
          finish(reject, new TransportError('ssh-exec-failed', `SSH 命令无法执行：${error.message}`))
          return
        }
        let stdout = ''
        let stderr = ''
        // Cap what one command may return: a chatty remote must not be able to
        // grow this process's memory by starting a server that never stops
        // talking.
        const CAP = 64 * 1024
        // Both streams need an 'error' handler: a command channel is torn down
        // when its connection resets, and an 'error' event with no listener
        // THROWS — killing the host process rather than failing this one call.
        stream.on('error', (streamError) => {
          finish(reject, new TransportError('ssh-exec-failed', `SSH 命令中断：${streamError instanceof Error ? streamError.message : String(streamError)}`))
        })
        stream.stderr.on('error', () => {
          // The command's own stderr failing says nothing useful; the channel's
          // 'error' (above) or 'close' reports the real outcome. Handled here
          // only so it cannot escape as an unhandled 'error' event.
        })
        stream.on('data', (chunk) => {
          if (stdout.length < CAP) stdout += chunk.toString('utf8')
        })
        stream.stderr.on('data', (chunk) => {
          if (stderr.length < CAP) stderr += chunk.toString('utf8')
        })
        stream.on('close', (code, signal) => {
          finish(resolve, {
            code: typeof code === 'number' ? code : -1,
            stdout: stdout.slice(0, CAP),
            stderr: stderr.slice(0, CAP),
            ...(signal === undefined ? {} : { signal }),
          })
        })
      })
    })
  }

  /**
   * Open an SFTP session on the shared connection.
   *
   * Used only by the P3 static fallback, which reads session headers straight
   * off the remote's disk when its `dsh web` is not running. One SFTP session is
   * cached per peer and reused: opening one per file would be the dominant cost
   * of scanning a directory of hundreds of sessions.
   * @param {object} peer - the peer row.
   * @returns {Promise<any>} the ready ssh2 SFTP session.
   */
  async sftp(peer) {
    const cached = this.sftpSessions.get(peer.id)
    if (cached !== undefined) return cached
    const client = await this.client(peer)
    const session = await new Promise((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) {
          reject(new TransportError('ssh-sftp-failed', `SSH 连上了，但打不开 SFTP 会话：${error.message}`))
          return
        }
        resolve(sftp)
      })
    })
    // A dropped connection must not leave a dead SFTP session cached, or every
    // later read would fail against a closed channel.
    session.on?.('close', () => { this.sftpSessions.delete(peer.id) })
    session.on?.('end', () => { this.sftpSessions.delete(peer.id) })
    // An SFTP session can also emit 'error' (a reset connection, a server that
    // drops the subsystem). Without a listener that THROWS and takes the host
    // down; the in-flight call is bounded by its own timeout, so this only has
    // to record the failure and stop the dead session being reused.
    session.on?.('error', (sessionError) => {
      this.sftpSessions.delete(peer.id)
      this.lastError.set(peer.id, sessionError instanceof Error ? sessionError.message : String(sessionError))
    })
    this.sftpSessions.set(peer.id, session)
    return session
  }

  /**
   * A promise-based view of one peer's SFTP session.
   *
   * ssh2's SFTP API is **callback-based**, so `await session.readdir(...)`
   * silently yields `undefined` instead of a listing — a failure that only
   * shows up against a real remote and reads as "no sessions found" rather than
   * an error. This adapter is therefore not a convenience: it is what makes the
   * static reader's `await` calls mean anything.
   *
   * `readdir`'s entries carry an ssh2 `Stats` with an `isDirectory()` method and
   * an `mtime` in SECONDS; the static reader expects exactly that, so entries
   * are passed through untouched.
   *
   * @param {object} peer - the peer row.
   * @returns {Promise<import('./static.js').SftpReader>} the reader.
   */
  async sftpReader(peer) {
    const session = await this.sftp(peer)
    /**
     * Turn one callback-style SFTP call into a promise.
     *
     * The timeout is not decoration: SFTP requests are matched by request id, so
     * a request the server never answers (an unimplemented opcode, a stalled
     * channel) leaves this promise pending forever — and a pending read means the
     * panel's poll never completes and the whole feature stops responding with no
     * error anywhere. Failing after a bounded wait turns that into a visible,
     * classified error instead.
     *
     * @param {string} method - the SFTP method to call.
     * @param {unknown[]} params - its parameters.
     * @returns {Promise<any>} the callback's result.
     */
    const call = (method, params) => new Promise((resolve, reject) => {
      const fn = session[method]
      if (typeof fn !== 'function') {
        reject(new TransportError('ssh-sftp-unsupported', `远端 SFTP 不支持 ${method}()`))
        return
      }
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new TransportError('ssh-sftp-timeout', `SFTP ${method} 在 ${String(SFTP_CALL_TIMEOUT_MS / 1000)} 秒内没有回应`))
      }, SFTP_CALL_TIMEOUT_MS)
      timer.unref?.()
      try {
        fn.call(session, ...params, (error, result) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) {
            reject(new TransportError('ssh-sftp-failed', `SFTP ${method} 失败：${error.message}`))
            return
          }
          resolve(result)
        })
      } catch (error) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new TransportError('ssh-sftp-failed', `SFTP ${method} 无法发出：${error instanceof Error ? error.message : String(error)}`))
        }
      }
    })
    return {
      readdir: location => call('readdir', [location]),
      open: (file, flags) => call('open', [file, flags ?? 'r']),
      read: (handle, buffer, offset, length, position) => call('read', [handle, buffer, offset, length, position]),
      stat: file => call('stat', [file]),
      close: handle => call('close', [handle]),
    }
  }

  /**
   * Tear down one peer's connection (or every connection when no id is given).
   * @param {string} [peerId] - the peer to drop.
   * @returns {void}
   */
  close(peerId) {
    if (peerId === undefined) {
      for (const [id, entry] of this.connections) {
        this.sftpSessions.delete(id)
        try {
          entry.client.end()
        } catch {
          /* already gone */
        }
      }
      this.connections.clear()
      this.sftpSessions.clear()
      return
    }
    this.sftpSessions.delete(peerId)
    const entry = this.connections.get(peerId)
    if (entry === undefined) return
    this.connections.delete(peerId)
    try {
      entry.client.end()
    } catch {
      /* already gone */
    }
  }
}
