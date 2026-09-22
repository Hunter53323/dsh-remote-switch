/**
 * Static session listing: read a remote's sessions from its files instead of
 * its API.
 *
 * This is the P3 fallback for the case that makes the panel useless otherwise:
 * the remote machine is up and reachable over SSH, but its `dsh web` is not
 * running — so there is no `/api` to ask. The session artifacts are still on
 * that disk, and their headers carry nearly everything the panel shows.
 *
 * The on-disk shape, confirmed against real files:
 *
 *   <DSH_HOME>/sessions/<project-slug>/<session-id>/session.v3.jsonl.zstd
 *
 * and the artifact is a **concatenation of independent Zstandard frames**: the
 * first frame is the session header, and later frames carry event batches. That
 * structure is what makes this cheap — decoding only the first frame yields the
 * header without touching the rest of a file that may be hundreds of kilobytes.
 *
 *   `dsh-session-persistence-jsonl/lib/index.js` — the frame container and
 *   `generationLogFilename` (version 0 keeps the suffix-only name, so both
 *   `session.jsonl[.zstd]` and `session.vN.jsonl[.zstd]` occur).
 *
 * Honesty about fidelity is the point of this module. A static read cannot know
 * what the live projection knows, so every row it produces is marked as coming
 * from a snapshot, and the differences are enumerated in {@link STATIC_LIMITS}
 * rather than silently papered over.
 *
 * @module dsh-remote-switch/federation/static
 */

import zlib from 'node:zlib'

import { sessionVisible } from './visible.js'

/** Zstandard frame magic, little-endian. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** First read attempt for a header frame. */
const INITIAL_HEADER_BYTES = 4096

/** Ceiling on the header read; a header frame beyond this is not a header. */
const MAX_HEADER_BYTES = 128 * 1024

/** Ceiling on a decoded header's *size*; the input bound above cannot cap this. */
const HEADER_OUTPUT_LIMIT = 1024 * 1024

/** Canonical artifact names, in both compressed and plaintext spellings. */
const ARTIFACT_PATTERN = /^session(?:\.v\d+)?\.jsonl(\.zstd)?$/u

/** How many session directories are scanned at most. */
const DEFAULT_SCAN_LIMIT = 500

/** How many header reads are in flight at once. */
const READ_CONCURRENCY = 8

/**
 * What a static read cannot reproduce, stated once so the panel can quote it
 * rather than inventing a plausible-looking value.
 */
export const STATIC_LIMITS = [
  '运行状态无法得知（远端实例没在跑，这里显示的都是空闲）',
  '空白会话无法识别（那需要读事件帧，静态清单不读）',
  '标题用的是目录名回退（真实标题存在事件帧里）',
  '更新时间取文件修改时间，不是最后一次提问时间',
]

/**
 * Join path segments with POSIX separators.
 *
 * Written by hand rather than `path.join` on purpose: the remote is always
 * POSIX here, and `path.join` on a Windows host would emit backslashes that the
 * remote would treat as literal filename characters.
 * @param {...string} segments - the segments.
 * @returns {string} the joined path.
 */
export function posixJoin(...segments) {
  const parts = []
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment === '') continue
    parts.push(segment.replace(/^\/+/u, '').replace(/\/+$/u, ''))
  }
  const joined = parts.filter(part => part !== '').join('/')
  return segments[0]?.startsWith('/') === true ? `/${joined}` : joined
}

/**
 * Read one session header out of the first Zstandard frame of an artifact.
 *
 * Node's one-shot decoder yields exactly the first frame and tolerates trailing
 * bytes (verified against a real 138-frame artifact), so "give it a prefix, get
 * the header" works without implementing frame-boundary scanning. The prefix is
 * grown only when the decoder says the frame is incomplete.
 *
 * @param {Buffer} prefix - bytes from the start of the artifact.
 * @param {(needed: number) => Promise<Buffer | undefined>} readMore - fetches a longer prefix.
 * @returns {Promise<object | undefined>} the parsed header, or undefined.
 */
export async function parseHeaderFrame(prefix, readMore) {
  let buffer = prefix
  let size = Math.max(prefix.length, INITIAL_HEADER_BYTES)
  for (;;) {
    const result = tryDecodeHeader(buffer)
    if (result !== undefined) return result
    if (size >= MAX_HEADER_BYTES) return undefined
    size = Math.min(size * 2, MAX_HEADER_BYTES)
    const longer = await readMore(size)
    if (longer === undefined || longer.length <= buffer.length) return undefined
    buffer = longer
  }
}

/**
 * One decode attempt over a candidate prefix.
 *
 * A plaintext artifact is tried first and costs nothing: if the bytes start
 * with `{` there is no frame container at all.
 * @param {Buffer} buffer - the candidate prefix.
 * @returns {object | undefined} the header, or undefined when undecidable.
 */
function tryDecodeHeader(buffer) {
  if (buffer.length === 0) return undefined
  const looksCompressed = buffer.length >= ZSTD_MAGIC.length && buffer.subarray(0, 4).equals(ZSTD_MAGIC)
  if (!looksCompressed) {
    // Plaintext JSONL: the header is simply the first line. No newline yet means
    // the prefix is short of the header, so the caller grows it.
    const newline = buffer.indexOf(0x0a)
    if (newline < 0) return undefined
    return parseHeaderLine(buffer.subarray(0, newline).toString('utf8'))
  }
  try {
    // `maxOutputLength` bounds the *output*, which the input prefix cannot: 128
    // KiB of a highly compressible frame expands without limit, and this runs in
    // the host process for every session file the scan touches. A header line is
    // a few hundred bytes, so a megabyte is already generous.
    return parseHeaderLine(zlib.zstdDecompressSync(buffer, { maxOutputLength: HEADER_OUTPUT_LIMIT }).toString('utf8'))
  } catch {
    // An incomplete frame throws; the caller grows the prefix and retries.
    return undefined
  }
}

/**
 * Parse the header line of a decoded frame.
 * @param {string} text - the decoded plaintext.
 * @returns {object | undefined} the header object, or undefined.
 */
function parseHeaderLine(text) {
  const line = text.split('\n', 1)[0]?.trim() ?? ''
  if (line === '') return undefined
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  // The header is the only record type that must be present and carries an id;
  // anything else means the frame order is not what this module assumes.
  if (parsed.type !== 'session' || typeof parsed.id !== 'string') return undefined
  return parsed
}

/**
 * Project one static header into the row shape the panel renders.
 *
 * The fields that exist are taken from the header; the rest follow the same
 * documented fallback chain the live path uses, so a title never appears to be
 * something it is not.
 * @param {object} header - the parsed session header.
 * @param {{ updatedAt?: number, projectDir?: string }} extra - facts from the filesystem.
 * @returns {object} the row.
 */
export function rowFromHeader(header, extra) {
  const cwd = typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined
  return {
    sessionId: header.id,
    // The durable title lives in an event frame this path deliberately does not
    // read, so the cwd basename (the live path's own fallback) is used and the
    // row is flagged as static.
    title: undefined,
    cwd,
    createdAt: typeof header.createdAt === 'number' && Number.isFinite(header.createdAt) ? header.createdAt : 0,
    updatedAt: typeof extra.updatedAt === 'number' && Number.isFinite(extra.updatedAt) ? extra.updatedAt : 0,
    // Nothing can be running on a machine whose instance is down.
    running: false,
    // `blank` is a projection, not a header field — see STATIC_LIMITS.
    blank: false,
    origin: typeof header.origin === 'string' ? header.origin : undefined,
    parentSessionId: typeof header.parentSession === 'string' ? header.parentSession : undefined,
    static: true,
    ...(extra.projectDir === undefined ? {} : { projectDir: extra.projectDir }),
  }
}

/**
 * Apply the shared visibility rules to a set of static rows.
 *
 * Archiving is deliberately *not* applied: the archived set lives in the
 * workspace registry, which is exactly the state this fallback cannot read. The
 * alternative — guessing — would hide sessions the user can still see on that
 * machine, so the archived ones stay listed and the panel says why.
 * @param {object[]} rows - candidate rows.
 * @returns {object[]} the visible rows, newest first.
 */
export function staticVisible(rows) {
  const archived = new Set()
  return rows
    .filter(row => sessionVisible(row, archived))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

/**
 * A minimal SFTP reader, satisfied by both a real ssh2 SFTP session and a test
 * stand-in: `readdir`, `read`, `stat`.
 *
 * Declared here rather than imported so this module stays free of the transport
 * and can be exercised with plain objects.
 *
 * @typedef {object} SftpReader
 * @property {(path: string) => Promise<Array<{ filename: string, attrs?: { isDirectory?: () => boolean, mtime?: number, size?: number } }>>} readdir
 * @property {(handle: unknown, buffer: Buffer, offset: number, length: number, position: number) => Promise<number>} read
 * @property {(handle: unknown) => Promise<void>} close
 * @property {(path: string) => Promise<unknown>} open
 * @property {(path: string) => Promise<{ mtime?: number, size?: number }>} stat
 */

/**
 * List one remote's sessions straight off its disk.
 *
 * @param {{
 *   sftp: SftpReader,
 *   sessionsRoot: string,
 *   scanLimit?: number,
 *   logger?: { warn: (message: string) => void },
 * }} options - the reader and where to look.
 * @returns {Promise<{ rows: object[], scanned: number, unreadable: number, truncated: boolean }>} the listing.
 */
export async function readStaticSessions(options) {
  const limit = options.scanLimit ?? DEFAULT_SCAN_LIMIT
  const root = options.sessionsRoot

  let projectDirs
  try {
    projectDirs = await options.sftp.readdir(root)
  } catch (error) {
    const failure = new Error(`读不到远端的会话目录 ${root}：${error instanceof Error ? error.message : String(error)}`)
    failure.code = 'static-unavailable'
    throw failure
  }

  /** @type {Array<{ sessionDir: string, projectDir: string, artifact: string, mtime?: number }>} */
  const found = []
  let truncated = false
  for (const project of projectDirs) {
    if (project.attrs?.isDirectory?.() === false) continue
    const projectPath = posixJoin(root, project.filename)
    let sessionDirs
    try {
      sessionDirs = await options.sftp.readdir(projectPath)
    } catch (error) {
      options.logger?.warn(`federation: cannot list ${projectPath}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const session of sessionDirs) {
      if (session.attrs?.isDirectory?.() === false) continue
      const sessionPath = posixJoin(projectPath, session.filename)
      let entries
      try {
        entries = await options.sftp.readdir(sessionPath)
      } catch {
        continue
      }
      const artifact = entries.find(entry => ARTIFACT_PATTERN.test(entry.filename))
      if (artifact === undefined) continue
      if (found.length >= limit) {
        truncated = true
        break
      }
      found.push({
        sessionDir: sessionPath,
        projectDir: project.filename,
        artifact: posixJoin(sessionPath, artifact.filename),
        ...(typeof artifact.attrs?.mtime === 'number' ? { mtime: artifact.attrs.mtime * 1000 } : {}),
      })
    }
    if (truncated) break
  }

  const rows = []
  let unreadable = 0
  for (let at = 0; at < found.length; at += READ_CONCURRENCY) {
    const batch = found.slice(at, at + READ_CONCURRENCY)
    const settled = await Promise.all(batch.map(async (entry) => {
      try {
        const header = await readHeader(options.sftp, entry.artifact)
        if (header === undefined) return undefined
        let updatedAt = entry.mtime
        if (updatedAt === undefined) {
          try {
            const stats = await options.sftp.stat(entry.artifact)
            if (typeof stats?.mtime === 'number') updatedAt = stats.mtime * 1000
          } catch {
            /* mtime is a nicety; the row is still useful without it */
          }
        }
        return rowFromHeader(header, {
          ...(updatedAt === undefined ? {} : { updatedAt }),
          projectDir: entry.projectDir,
        })
      } catch (error) {
        options.logger?.warn(`federation: cannot read ${entry.artifact}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }))
    for (const row of settled) {
      if (row === undefined) unreadable += 1
      else rows.push(row)
    }
  }

  return { rows: staticVisible(rows), scanned: found.length, unreadable, truncated }
}

/**
 * Read one artifact's header frame over SFTP.
 * @param {SftpReader} sftp - the reader.
 * @param {string} artifact - absolute path to the artifact.
 * @returns {Promise<object | undefined>} the header, or undefined.
 */
async function readHeader(sftp, artifact) {
  const handle = await sftp.open(artifact, 'r')
  try {
    const readPrefix = async (length) => {
      const buffer = Buffer.alloc(length)
      let filled = 0
      // SFTP `read` may return short; loop until the requested prefix is read or
      // the file ends, otherwise a header straddling a short read is misjudged
      // as a corrupt frame.
      while (filled < length) {
        const got = await sftp.read(handle, buffer, filled, length - filled, filled)
        if (got <= 0) break
        filled += got
      }
      return buffer.subarray(0, filled)
    }
    const first = await readPrefix(INITIAL_HEADER_BYTES)
    return await parseHeaderFrame(first, async needed => readPrefix(needed))
  } finally {
    try {
      await sftp.close(handle)
    } catch {
      /* the session may already be gone */
    }
  }
}
