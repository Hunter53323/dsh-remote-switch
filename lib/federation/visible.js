/**
 * Visibility, titling, and grouping of a remote session list.
 *
 * `/api/session/list` returns *every* persisted session; the remote GUI then
 * filters and titles it in the browser. This module reproduces that projection
 * exactly, because a list that answers differently from the remote's own
 * sidebar is a bug the user sees immediately:
 *
 *   `dsh-client-ui-workspace/lib/client.js` — `sessionVisible`
 *     `origin !== 'subagent' && !archived.has(id) && (!blank || id === current)`
 *   `dsh-api-session-controller/lib/types/client/sessions/service.js`
 *     `displayTitleOf` — durable title, then the project directory basename,
 *     then the raw session id.
 *   `dsh-util-workspace-path/lib/index.js` — `workspaceTitleOf`, the last
 *     non-empty segment of either path spelling.
 *
 * The federation side has no "currently open session", so the remote's one
 * blank-row exemption collapses to excluding every blank row.
 *
 * @module dsh-remote-switch/federation/visible
 */

import { isRecord } from './wire.js'

/**
 * Last non-empty segment of a POSIX or Windows path, for display.
 * @param {string} path - a path in either spelling.
 * @returns {string} the final segment, or `''` for a separator-only path.
 */
export function workspaceTitleOf(path) {
  const trimmed = path.replace(/[/\\]+$/, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(separator + 1)
}

/**
 * The title a remote sidebar would print for one row.
 * @param {{ title?: unknown, cwd?: unknown, sessionId: string }} row - one raw summary.
 * @returns {string} the display title.
 */
export function displayTitleOf(row) {
  const title = typeof row.title === 'string' && row.title !== '' ? row.title : undefined
  if (title !== undefined) return title
  const cwd = typeof row.cwd === 'string' ? row.cwd : undefined
  if (cwd !== undefined && cwd !== '') {
    const base = workspaceTitleOf(cwd)
    if (base !== '') return base
  }
  return row.sessionId
}

/**
 * Normalize one raw `session/list` item into the row the panel renders.
 *
 * Only fields the Remote wire actually carries are read; every optional field
 * stays optional. A summary's minimum set is
 * `sessionId/updatedAt/running/blank/cwd`, with `origin` and `projections`
 * arriving only when the persistence layer has them.
 * @param {unknown} value - one raw item.
 * @returns {object | undefined} the normalized row, or undefined when unusable.
 */
export function normalizeSession(value) {
  if (!isRecord(value)) return undefined
  const sessionId = typeof value.sessionId === 'string' && value.sessionId !== '' ? value.sessionId : undefined
  if (sessionId === undefined) return undefined
  const projections = isRecord(value.projections) ? value.projections : undefined
  const values = projections !== undefined && isRecord(projections.values) ? projections.values : undefined
  return {
    sessionId,
    title: displayTitleOf({
      title: values === undefined ? undefined : values.title,
      cwd: value.cwd,
      sessionId,
    }),
    cwd: typeof value.cwd === 'string' && value.cwd !== '' ? value.cwd : undefined,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    running: value.running === true,
    blank: value.blank === true,
    origin: typeof value.origin === 'string' ? value.origin : undefined,
    parentSessionId: typeof value.parentSessionId === 'string' ? value.parentSessionId : undefined,
  }
}

/**
 * Whether one row belongs in the list, mirroring the remote sidebar.
 *
 * A row is hidden when it is a subagent child, when it is archived, or when it
 * is blank. Archived rows are hidden *without* an opt-in toggle, matching the
 * remote (and the user's decision for this feature).
 * @param {{ origin?: string, blank: boolean, sessionId: string }} row - a normalized row.
 * @param {ReadonlySet<string>} archived - archived session ids from the workspace baseline.
 * @returns {boolean} true when the row is visible.
 */
export function sessionVisible(row, archived) {
  return row.origin !== 'subagent' && !archived.has(row.sessionId) && !row.blank
}

/**
 * Project a raw list response into the visible, titled, newest-first rows.
 * @param {unknown} value - the `session/list` value (`{ items }`).
 * @param {ReadonlySet<string>} archived - archived session ids.
 * @param {number} limit - maximum rows to keep.
 * @returns {{ items: object[], total: number, truncated: boolean }} the projection.
 */
export function projectSessions(value, archived, limit) {
  const raw = isRecord(value) && Array.isArray(value.items) ? value.items : []
  const rows = []
  for (const item of raw) {
    const row = normalizeSession(item)
    if (row === undefined || !sessionVisible(row, archived)) continue
    rows.push(row)
  }
  rows.sort((left, right) => right.updatedAt - left.updatedAt)
  return {
    items: rows.slice(0, limit),
    total: rows.length,
    truncated: rows.length > limit,
  }
}

/**
 * Read `archivedSessionIds` out of a `workspace/follow` baseline first frame.
 * @param {unknown} frame - the first stream item.
 * @returns {Set<string>} the archived ids (empty when the frame is not a baseline).
 */
export function archivedFromBaseline(frame) {
  const archived = new Set()
  const value = isRecord(frame) && isRecord(frame.value) ? frame.value : undefined
  if (value === undefined || !Array.isArray(value.archivedSessionIds)) return archived
  for (const id of value.archivedSessionIds) {
    if (typeof id === 'string' && id !== '') archived.add(id)
  }
  return archived
}

/**
 * Group rows by their working directory.
 *
 * P1 groups by cwd — a fact every row carries, needing no extra call. P2
 * upgrades this to the remote's own workspace grouping using the same baseline
 * frame the archive set comes from.
 * @param {object[]} rows - normalized rows.
 * @returns {{ key: string, label: string, cwd: string | undefined, sessions: object[] }[]} the groups, in first-seen order.
 */
export function groupByCwd(rows) {
  /** @type {Map<string, { key: string, label: string, cwd: string | undefined, sessions: object[] }>} */
  const groups = new Map()
  for (const row of rows) {
    const key = row.cwd ?? ''
    let group = groups.get(key)
    if (group === undefined) {
      group = {
        key: key === '' ? '__ungrouped__' : key,
        label: key === '' ? '未分组' : workspaceTitleOf(key) || key,
        cwd: row.cwd,
        sessions: [],
      }
      groups.set(key, group)
    }
    group.sessions.push(row)
  }
  return [...groups.values()]
}
