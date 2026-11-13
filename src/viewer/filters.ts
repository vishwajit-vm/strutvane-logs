/**
 * Viewer search filters: parsed strictly from the query string (anything invalid is a 400, never
 * silently ignored) and matched against parsed records.
 *
 * @module
 */
import { isLogLevel } from '../levels.ts'

/** A parsed log record as the viewer sees it. Unknown keys are kept. */
export interface ViewerRecord {
  readonly time?: unknown
  readonly level?: unknown
  readonly msg?: unknown
  readonly requestId?: unknown
  readonly traceId?: unknown
  readonly tenantId?: unknown
  readonly actorId?: unknown
  readonly fields?: unknown
  readonly err?: unknown
  readonly [key: string]: unknown
}

/** A filter on records, e.g. "only this tenant's records" (see `scopeRecords`). */
export type RecordFilter = (record: ViewerRecord) => boolean

/** An HTTP status filter: one exact code, or a class such as `5xx`. */
export interface StatusFilter {
  readonly min: number
  readonly max: number
}

/** A parsed search. Every property is optional; an empty query matches everything. */
export interface RecordQuery {
  readonly levels?: ReadonlySet<string>
  readonly fromMs?: number
  readonly toMs?: number
  /** Lower-cased free text, matched against the whole line. */
  readonly q?: string
  readonly route?: string
  readonly status?: StatusFilter
  readonly requestId?: string
  readonly traceId?: string
  readonly tenantId?: string
}

/** An invalid query parameter (reported to the client as 400). */
export class QueryError extends Error {
  override readonly name = 'QueryError'
}

const MAX_TEXT = 200

function text(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)
  if (value === null || value.trim() === '') return undefined
  if (value.length > MAX_TEXT)
    throw new QueryError(`${name} must be at most ${MAX_TEXT} characters`)
  return value.trim()
}

function time(params: URLSearchParams, name: string): number | undefined {
  const value = text(params, name)
  if (value === undefined) return undefined
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new QueryError(`${name} must be an ISO 8601 date or date-time`)
  return ms
}

function status(value: string | undefined): StatusFilter | undefined {
  if (value === undefined) return undefined
  if (/^[1-5]\d\d$/.test(value)) return { min: Number(value), max: Number(value) }
  if (/^[1-5]xx$/i.test(value)) {
    const base = Number(value[0]) * 100
    return { min: base, max: base + 99 }
  }
  throw new QueryError('status must be a code such as 404 or a class such as 5xx')
}

/**
 * Parse search filters from a query string.
 *
 * @example
 * parseRecordQuery(new URLSearchParams('level=error,fatal&status=5xx&q=timeout'))
 * @throws QueryError on any invalid value
 */
export function parseRecordQuery(params: URLSearchParams): RecordQuery {
  const query: {
    levels?: ReadonlySet<string>
    fromMs?: number
    toMs?: number
    q?: string
    route?: string
    status?: StatusFilter
    requestId?: string
    traceId?: string
    tenantId?: string
  } = {}

  const levels = text(params, 'level')
  if (levels !== undefined) {
    const list = levels.split(',').map((l) => l.trim().toLowerCase())
    for (const l of list) if (!isLogLevel(l)) throw new QueryError(`unknown level "${l}"`)
    query.levels = new Set(list)
  }
  const from = time(params, 'from')
  const to = time(params, 'to')
  if (from !== undefined) query.fromMs = from
  if (to !== undefined) query.toMs = to
  if (from !== undefined && to !== undefined && from > to)
    throw new QueryError('from must not be after to')

  const q = text(params, 'q')
  if (q !== undefined) query.q = q.toLowerCase()
  const s = status(text(params, 'status'))
  if (s !== undefined) query.status = s
  for (const key of ['route', 'requestId', 'traceId', 'tenantId'] as const) {
    const value = text(params, key)
    if (value !== undefined) query[key] = value
  }
  return query
}

interface RequestFields {
  readonly route?: unknown
  readonly status?: unknown
}

/** Does a parsed record (and its raw line) match the query? */
export function matchesQuery(record: ViewerRecord, line: string, query: RecordQuery): boolean {
  if (query.levels && !(typeof record.level === 'string' && query.levels.has(record.level)))
    return false
  if (query.fromMs !== undefined || query.toMs !== undefined) {
    const ms = typeof record.time === 'string' ? Date.parse(record.time) : Number.NaN
    if (!Number.isFinite(ms)) return false
    if (query.fromMs !== undefined && ms < query.fromMs) return false
    if (query.toMs !== undefined && ms > query.toMs) return false
  }
  if (query.requestId !== undefined && record.requestId !== query.requestId) return false
  if (query.traceId !== undefined && record.traceId !== query.traceId) return false
  if (query.tenantId !== undefined && record.tenantId !== query.tenantId) return false
  if (query.route !== undefined || query.status !== undefined) {
    const fields: RequestFields =
      typeof record.fields === 'object' && record.fields !== null ? record.fields : {}
    if (query.route !== undefined && fields.route !== query.route) return false
    if (query.status !== undefined) {
      const code = fields.status
      if (typeof code !== 'number' || code < query.status.min || code > query.status.max)
        return false
    }
  }
  if (query.q !== undefined && !line.toLowerCase().includes(query.q)) return false
  return true
}

/** The UTC day range a query can match, used to skip whole files. */
export function dayRange(query: RecordQuery): { readonly from?: string; readonly to?: string } {
  return {
    ...(query.fromMs === undefined
      ? {}
      : { from: new Date(query.fromMs).toISOString().slice(0, 10) }),
    ...(query.toMs === undefined ? {} : { to: new Date(query.toMs).toISOString().slice(0, 10) }),
  }
}
