/**
 * Log file naming, ordering and retention (RFC-0004 §4, ADR-0015).
 *
 * File names use UTC days. A writer tag separates processes when several of them log:
 *
 * ```
 * 2026-11-14.ndjson  2026-11-14-1.ndjson  2026-11-14-2.ndjson   (single writer, size parts)
 * 2026-11-14.w3.ndjson  2026-11-14.w3-1.ndjson                  (writer "w3", e.g. cluster worker 3)
 * ```
 *
 * @module
 */
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Matches a Strutvane log file name: day, optional writer tag, optional part number. */
export const LOG_FILE_PATTERN: RegExp =
  /^(\d{4}-\d{2}-\d{2})(?:\.(w[A-Za-z0-9_]{1,32}))?(?:-(\d{1,6}))?\.ndjson$/

/** A parsed log file name. */
export interface LogFileName {
  readonly day: string
  readonly tag: string | undefined
  readonly part: number
}

/** UTC day key `YYYY-MM-DD` of an epoch-millisecond timestamp. */
export function dayKeyOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Is `value` a valid `YYYY-MM-DD` day key (a real calendar date)? */
export function isDayKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(ms) && dayKeyOf(ms) === value
}

/** Build a log file name. `tag` must start with `w` (e.g. `w3`). */
export function fileName(day: string, part: number, tag?: string): string {
  return `${day}${tag ? `.${tag}` : ''}${part > 0 ? `-${part}` : ''}.ndjson`
}

/** Parse a log file name, or `undefined` if it isn't one (so foreign files are never touched). */
export function parseLogFileName(name: string): LogFileName | undefined {
  const m = LOG_FILE_PATTERN.exec(name)
  if (!m?.[1] || !isDayKey(m[1])) return undefined
  return { day: m[1], tag: m[2], part: m[3] ? Number(m[3]) : 0 }
}

/**
 * Order log files chronologically: by day, then writer tag, then part NUMBER.
 *
 * Plain string sorting is wrong, as spike 09 found. `.` (0x2E) sorts after `-` (0x2D), so
 * `2026-11-14.ndjson` (part 0) would come after `2026-11-14-17.ndjson`, and `-10` before `-2`.
 * Non-log names sort after log names, alphabetically.
 */
export function compareLogFiles(a: string, b: string): number {
  const pa = parseLogFileName(a)
  const pb = parseLogFileName(b)
  if (!pa || !pb) {
    if (pa) return -1
    if (pb) return 1
    return a < b ? -1 : a > b ? 1 : 0
  }
  if (pa.day !== pb.day) return pa.day < pb.day ? -1 : 1
  const ta = pa.tag ?? ''
  const tb = pb.tag ?? ''
  if (ta !== tb) return ta < tb ? -1 : 1
  return pa.part - pb.part
}

/** List the log files in `dir`, oldest first. A missing directory yields an empty list. */
export async function listLogFiles(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  return names.filter((n) => parseLogFileName(n) !== undefined).sort(compareLogFiles)
}

/**
 * Delete log files whose day is more than `days` days before `nowMs`. Files that aren't Strutvane
 * log files are never touched. Files that can't be deleted (in use, already gone) are skipped and
 * retried at the next rotation.
 *
 * @returns the names of the deleted files
 */
export async function applyRetention(dir: string, days: number, nowMs: number): Promise<string[]> {
  if (days <= 0) return []
  const cutoff = dayKeyOf(nowMs - days * 86_400_000)
  const deleted: string[] = []
  for (const name of await listLogFiles(dir)) {
    const parsed = parseLogFileName(name)
    if (!parsed || parsed.day >= cutoff) continue
    try {
      await unlink(join(dir, name))
      deleted.push(name)
    } catch {
      // In use or already gone: retried at the next rotation.
    }
  }
  return deleted
}
