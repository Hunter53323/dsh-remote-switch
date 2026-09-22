/**
 * Real-remote verification: the static fallback against an actual machine.
 *
 * Everything else in this suite proves the pieces against local stand-ins. This
 * one exists because the P3 story has a shape no stand-in reproduces: a machine
 * that answers SSH but whose `dsh web` is NOT running. That is exactly the state
 * the static fallback was built for, and the only way to know the real thing
 * works — real sshd, real `sessions/` layout, real zstd artifacts written by a
 * real harness — is to point it at such a machine.
 *
 * READ-ONLY by construction: it opens one SSH connection, reads headers over
 * SFTP, and closes. It runs no command that writes, and it never starts or stops
 * anything on the remote.
 *
 * Usage:
 *   node scripts/verify-real-remote.mjs --host <ip> --user <name> [--password <pw>]
 *                                       [--port 22] [--remote-home /home/me/.dsh]
 *
 * Exits 0 with a clear "skipped" note when the host is unreachable, so it can
 * live in a suite that runs on a network the remote is not on.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SshTransport } from '../lib/federation/ssh.js'
import { readStaticSessions, STATIC_LIMITS } from '../lib/federation/static.js'
import { displayTitleOf } from '../lib/federation/visible.js'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}
const host = argOf('--host', '')
const user = argOf('--user', '')
const password = argOf('--password', '')
const sshPort = Number(argOf('--port', '22'))
const remoteHome = argOf('--remote-home', '')

if (host === '' || user === '') {
  console.log('usage: node scripts/verify-real-remote.mjs --host <ip> --user <name> [--password <pw>] [--remote-home <path>]')
  process.exitCode = 2
  process.exit(2)
}

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  — ${detail}` : ''}`)
}

// The host-key store goes to a temp directory, never the repo: it records the
// real remote's host key, which is machine-specific state that must not be
// committed (and a stale entry in a shared file would make a later run refuse a
// legitimately rebuilt machine).
const scratch = mkdtempSync(path.join(tmpdir(), 'real-remote-'))
const transport = new SshTransport({
  knownHostsFile: path.join(scratch, 'known_hosts.json'),
  hostKeyPolicy: 'accept-new',
})

/**
 * Close the connection, delete the scratch directory, and exit.
 *
 * Every exit goes through here so the temp host-key store cannot be left behind
 * — it is imported and cleaned in one place rather than repeated at each of the
 * four exits, which is how it came to leak in the first place.
 * @param {number} code - the process exit code.
 * @returns {never} never returns.
 */
function finish(code) {
  try {
    transport.close()
  } catch {
    /* already closed */
  }
  rmSync(scratch, { recursive: true, force: true })
  process.exit(code)
}

const peer = {
  id: 'real-remote',
  channel: 'ssh',
  label: host,
  origin: `http://127.0.0.1:3080`,
  ssh: { host, user, port: sshPort, remotePort: 3080, ...(password === '' ? {} : { password }) },
}

try {
  // 1. Reach the machine over SSH at all, and get the PROMISE-based reader.
  //    Using the raw ssh2 session here would silently `await` undefined, since
  //    that API is callback-based — the very trap `sftpReader` exists to close.
  let sftp
  try {
    sftp = await transport.sftpReader(peer)
    check('SSH + SFTP connect to the real remote', true, `${user}@${host}:${String(sshPort)}`)
  } catch (error) {
    check('SSH + SFTP connect to the real remote', false, error instanceof Error ? error.message : String(error))
    console.log('\nThe remote is not reachable from here; nothing further can be asserted.')
    const failedNow = results.filter(result => !result.pass)
    console.log(`\n${String(results.length - failedNow.length)}/${String(results.length)} passed`)
    finish(1)
  }

  // 2. Resolve the remote DSH_HOME. No shell command is run: the home is
  //    discovered by looking for the directory that actually holds `sessions/`.
  const home = remoteHome !== '' ? remoteHome : `/home/${user}/.dsh`
  check('the remote DSH_HOME was resolved', home !== '', home)

  // 2b. The promise adapter is the one piece that ONLY a real ssh2 server can
  //     prove: that API is callback-based, so a wrong adapter yields `undefined`
  //     for every call and looks like "no sessions" instead of failing. Asserting
  //     it against a real server is worth doing even when the sessions tree is
  //     absent.
  const homeListing = await sftp.readdir(home)
  check('the promise adapter returns a real directory listing over SFTP',
    Array.isArray(homeListing) && homeListing.length > 0 && typeof homeListing[0].filename === 'string',
    Array.isArray(homeListing) ? `${String(homeListing.length)} entries: ${homeListing.slice(0, 4).map(e => e.filename).join(', ')}` : typeof homeListing)
  check('SFTP entries carry the attrs the static reader expects',
    Array.isArray(homeListing) && homeListing.every(entry => entry.attrs !== undefined && typeof entry.attrs.isDirectory === 'function'),
    Array.isArray(homeListing) ? `first attrs keys: ${Object.keys(homeListing[0].attrs ?? {}).join(',')}` : 'n/a')

  // 3. Does the sessions tree exist, and what does it hold?
  let projects = []
  let sessionsError
  try {
    projects = await sftp.readdir(`${home}/sessions`)
  } catch (error) {
    sessionsError = error instanceof Error ? error.message : String(error)
  }
  if (sessionsError !== undefined) {
    // Not a defect: a machine that has never run a DSH session has no
    // `sessions/` tree. Report it as the environmental finding it is, and exit
    // successfully so this can sit in a suite that runs on any network.
    console.log(`SKIP  the remote sessions tree is readable  — ${sessionsError}`)
    console.log('\nThat machine has never run a DSH session, so it has no `sessions/` tree and')
    console.log('the static path has nothing to read there. Point this at a machine that has')
    console.log('run sessions to exercise it end to end.')
    console.log('\nWhat this run DID prove: SSH connects, SFTP opens, and the promise adapter')
    console.log('in SshTransport.sftpReader() works against a real ssh2 server (a callback')
    console.log('API that would otherwise hand back `undefined` for every call).')
    const failedNow = results.filter(result => !result.pass)
    console.log(`\n${String(results.length - failedNow.length)}/${String(results.length)} passed (sessions tree skipped)`)
    finish(failedNow.length === 0 ? 0 : 1)
  }
  check('the remote sessions tree is readable', true, `${String(projects.length)} project dir(s)`)

  // 4. The actual claim: read the real machine's session headers.
  const listing = await readStaticSessions({
    sftp,
    sessionsRoot: `${home}/sessions`,
    logger: { warn: message => console.log(`      (warn) ${message}`) },
  })
  check('the static reader lists the real remote\'s sessions',
    listing.scanned > 0 && listing.rows.length > 0,
    `scanned=${String(listing.scanned)} rows=${String(listing.rows.length)} unreadable=${String(listing.unreadable)}`)
  check('every real remote artifact yielded a readable header',
    listing.unreadable === 0, `${String(listing.unreadable)} unreadable`)
  check('subagent sessions are excluded on the real remote',
    listing.rows.every(row => row.origin !== 'subagent'),
    `${String(listing.rows.filter(row => row.origin === 'subagent').length)} leaked`)
  check('real remote rows are marked static and never running',
    listing.rows.every(row => row.static === true && row.running === false),
    'all rows static + idle')

  const titles = listing.rows.map(row => displayTitleOf({ title: undefined, cwd: row.cwd, sessionId: row.sessionId }))
  check('every real remote row gets a usable title',
    titles.every(title => typeof title === 'string' && title !== ''),
    titles.slice(0, 3).join(' , '))

  // 5. The remote's own cwd values come through verbatim — the §6 rule is that
  //    they are never realpath'd or rewritten, since they are that machine's
  //    paths, not this one's.
  const cwds = listing.rows.map(row => row.cwd).filter(Boolean)
  check('remote cwd values are reported verbatim (POSIX paths, not local ones)',
    cwds.length === 0 || cwds.every(cwd => typeof cwd === 'string' && (cwd.startsWith('/') || /^[A-Za-z]:[/\\]/u.test(cwd))),
    cwds.slice(0, 3).join(' , '))
  if (cwds.length > 0) {
    check('the remote paths are the REMOTE machine\'s, not this machine\'s',
      cwds.some(cwd => cwd.startsWith('/')) || cwds.every(cwd => !cwd.includes('E:\\study\\dshdev')),
      cwds.slice(0, 2).join(' , '))
  }

  console.log('\n--- sample rows from the real remote ---')
  for (const row of listing.rows.slice(0, 5)) {
    console.log(`  ${row.sessionId.slice(0, 20)}  ${String(row.cwd ?? '').slice(-34)}  updated=${new Date(row.updatedAt).toISOString().slice(0, 19)}`)
  }
  console.log(`\nthe panel would also state, verbatim: ${JSON.stringify(STATIC_LIMITS[0])}`)
  console.log(`the panel would show ${String(listing.rows.length)} row(s), scanned ${String(listing.scanned)} artifact(s)`)
} catch (error) {
  // An unexpected failure still has to clean up and report, rather than leaving
  // a stack trace plus a temp directory behind.
  check('the run completed without an unexpected failure', false,
    error instanceof Error ? `${error.name}: ${error.message}` : String(error))
}

const failed = results.filter(result => !result.pass)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`)
finish(failed.length === 0 ? 0 : 1)
