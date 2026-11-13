/**
 * Read access to the log directory for the viewer: list files, page through records newest first,
 * stream a day for download, and read appended bytes for the live tail.
 *
 * Safety rules:
 *
 * - **Only Strutvane log files are read.** Names come from the directory listing and must match
 *   {@link LOG_FILE_PATTERN}; a client-supplied name is never joined into a path unchecked, so path
 *   traversal (`../../etc/passwd`) is impossible.
 * - **Every record is re-sanitised before it leaves the server,** in case a file was written by
 *   something other than this logger (defence in depth). Searches match the sanitised text, so a
 *   search can't be used to guess a secret character by character.
 * - **Work per request is bounded** (`maxScanLines`), so a search can't pin the CPU.
 * - **Partial last lines are ignored** (a writer may be mid-append).
 *
 * @module
 */
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { compareLogFiles, listLogFiles, parseLogFileName } from '../files.ts'
import { createSanitizer, type Sanitizer } from '../redact.ts'
import { escapeLineSeparators } from '../serialize.ts'
import {
  dayRange,
  matchesQuery,
  type RecordFilter,
  type RecordQuery,
  type ViewerRecord,
} from './filters.ts'

/** One log file, as listed by the viewer. */
export interface LogFileInfo {
  readonly name: string
  readonly day: string
  readonly size: number
  /** Last modification time (ISO 8601). */
  readonly modified: string
}

/** Where to continue paging: before line index `before` of `file`. */
export interface Cursor {
  readonly file: string
  readonly before: number
}

/** Describe the log files in `dir`, newest first. Files that vanish meanwhile are skipped. */
export async function describeFiles(dir: string): Promise<LogFileInfo[]> {
  const out: LogFileInfo[] = []
  for (const name of (await listLogFiles(dir)).reverse()) {
    const parsed = parseLogFileName(name)
    if (!parsed) continue
    try {
      const s = await stat(join(dir, name))
      if (s.isFile())
        out.push({ name, day: parsed.day, size: s.size, modified: s.mtime.toISOString() })
    } catch {
      // Deleted between listing and stat (retention or clear): skip it.
    }
  }
  return out
}

/** Encode a cursor as an opaque URL-safe string. */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.file, cursor.before])).toString('base64url')
}

/** Decode a cursor, or `undefined` if it is malformed or names something that isn't a log file. */
export function decodeCursor(value: string): Cursor | undefined {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
    const [file, before] = parsed as [unknown, unknown]
    if (typeof file !== 'string' || parseLogFileName(file) === undefined) return undefined
    if (typeof before !== 'number' || !Number.isInteger(before) || before < 0) return undefined
    return { file, before }
  } catch {
    return undefined
  }
}

/** Parse one NDJSON line into a record, or `undefined` if it isn't a JSON object. */
export function parseLine(line: string): ViewerRecord | undefined {
  if (!line.startsWith('{')) return undefined
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as ViewerRecord)
      : undefined
  } catch {
    return undefined
  }
}

/** A record re-sanitised for output, with its one-line JSON form. */
export interface CleanRecord {
  readonly record: ViewerRecord
  readonly json: string
}

/** Parse and re-sanitise a line. */
export function cleanLine(line: string, sanitize: Sanitizer): CleanRecord | undefined {
  const parsed = parseLine(line)
  if (!parsed) return undefined
  const record = sanitize(parsed) as ViewerRecord
  return { record, json: escapeLineSeparators(JSON.stringify(record)) }
}

/** Shared default sanitizer for viewer output. */
export const viewerSanitizer: Sanitizer = createSanitizer()

/** Does a cleaned record pass the query and the caller's scope? A throwing scope hides the record. */
export function accept(
  clean: CleanRecord,
  query: RecordQuery,
  scope: RecordFilter | undefined,
): boolean {
  if (!matchesQuery(clean.record, clean.json, query)) return false
  if (!scope) return true
  try {
    return scope(clean.record) === true
  } catch {
    return false
  }
}

/** Options for {@link readPage}. */
export interface PageOptions {
  readonly dir: string
  readonly query: RecordQuery
  readonly scope?: RecordFilter | undefined
  readonly limit: number
  readonly cursor?: Cursor | undefined
  /** Stop after examining this many lines and return a cursor. Default: 100,000. */
  readonly maxScanLines?: number
  readonly sanitize?: Sanitizer
}

/** One page of records, newest first. */
export interface Page {
  readonly records: ViewerRecord[]
  /** Present when more records may follow. */
  readonly nextCursor?: string
  /** Lines examined for this page. */
  readonly scanned: number
}

/** Complete lines of a file (a partial last line, still being written, is dropped). */
async function completeLines(path: string): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    const text = await handle.readFile('utf8')
    const lines = text.split('\n')
    lines.pop() // either '' after the final newline, or a partial line
    return lines
  } catch {
    return [] // deleted meanwhile
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Read one page of matching records, newest first. */
export async function readPage(options: PageOptions): Promise<Page> {
  const { dir, query, scope, limit, cursor } = options
  const maxScan = options.maxScanLines ?? 100_000
  const sanitize = options.sanitize ?? viewerSanitizer
  const range = dayRange(query)
  const files = (await listLogFiles(dir)).reverse().filter((name) => {
    const day = parseLogFileName(name)?.day ?? ''
    if (range.from !== undefined && day < range.from) return false
    if (range.to !== undefined && day > range.to) return false
    // Continue at the cursor's file, or the next older one if it was deleted.
    return cursor === undefined || compareLogFiles(name, cursor.file) <= 0
  })

  const records: ViewerRecord[] = []
  let scanned = 0
  for (const name of files) {
    const lines = await completeLines(join(dir, name))
    const start =
      cursor && name === cursor.file ? Math.min(cursor.before, lines.length) - 1 : lines.length - 1
    for (let i = start; i >= 0; i--) {
      if (scanned >= maxScan)
        return { records, scanned, nextCursor: encodeCursor({ file: name, before: i + 1 }) }
      scanned++
      const clean = cleanLine(lines[i] ?? '', sanitize)
      if (!clean || !accept(clean, query, scope)) continue
      records.push(clean.record)
      if (records.length >= limit) {
        const more = i > 0 || name !== files[files.length - 1]
        return more
          ? { records, scanned, nextCursor: encodeCursor({ file: name, before: i }) }
          : { records, scanned }
      }
    }
  }
  return { records, scanned }
}

/** Stream the complete lines of every file for `day`, oldest first. */
export async function* readDayLines(dir: string, day: string): AsyncGenerator<string> {
  for (const name of await listLogFiles(dir)) {
    if (parseLogFileName(name)?.day !== day) continue
    const stream = createReadStream(join(dir, name), { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
    try {
      for await (const line of lines) if (line) yield line
    } catch {
      // Deleted while reading: move on.
    } finally {
      lines.close()
      stream.destroy()
    }
  }
}

/** Read bytes `[start, end)` of a file. Returns an empty buffer if the file is gone. */
export async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(end - start)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        start + offset,
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return buffer.subarray(0, offset)
  } catch {
    return Buffer.alloc(0)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
