/**
 * Building one log record in the contracts' `LogRecord` shape:
 *
 * ```
 * { time, level, msg, requestId?, traceId?, tenantId?, actorId?, fields?, err? }
 * ```
 *
 * - Correlation ids come from the request context.
 * - `fields` merges, in order: child bindings → extra context keys → call-site fields. Later wins.
 * - An `Error` passed as `fields.err` or `fields.error` is moved to `err`, so the viewer and tools
 *   find errors in one place.
 *
 * The result is NOT yet sanitised. The logger sanitises it before serialising.
 *
 * @module
 */
import type { LogFields, LogLevel } from '@strutvane/contracts'
import type { LogContext } from './context.ts'

const CORRELATION_KEYS = ['requestId', 'traceId', 'tenantId', 'actorId'] as const

/** Fields being merged (may receive a diagnostic when the source object is unreadable). */
type MutableFields = Record<string, unknown> & { fieldsError?: string }

/** The unsanitised record. Declared keys keep property access type-safe. */
export interface RawRecord {
  time: string
  level: LogLevel
  msg: string
  requestId?: string
  traceId?: string
  tenantId?: string
  actorId?: string
  fields?: Record<string, unknown>
  err?: Error
}

/** Copy own enumerable keys defensively: a hostile object (throwing getters, Proxies) can't throw. */
function assignSafely(target: MutableFields, source: LogFields | undefined): void {
  if (!source) return
  let keys: string[]
  try {
    keys = Object.keys(source)
  } catch {
    target.fieldsError = 'unreadable fields object'
    return
  }
  for (const key of keys) {
    let value: unknown
    try {
      value = source[key]
    } catch {
      value = '[Unreadable]'
    }
    target[key] = value
  }
}

/** Coerce anything passed as a message into a string, without throwing. */
export function toMessage(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return String(value)
  } catch {
    return '[unprintable message]'
  }
}

/**
 * Build an unsanitised record.
 *
 * @param timeMs record timestamp in epoch milliseconds (from the logger's clock)
 */
export function buildRecord(
  level: LogLevel,
  msg: unknown,
  bindings: LogFields,
  context: LogContext | undefined,
  fields: LogFields | undefined,
  timeMs: number,
): RawRecord {
  const record: RawRecord = {
    time: new Date(timeMs).toISOString(),
    level,
    msg: toMessage(msg),
  }
  const merged: MutableFields = {}
  assignSafely(merged, bindings)
  if (context) {
    for (const key of CORRELATION_KEYS) {
      const v = context[key]
      if (typeof v === 'string' && v.length > 0) record[key] = v
    }
    const extra: MutableFields = {}
    assignSafely(extra, context)
    for (const key of CORRELATION_KEYS) delete extra[key]
    Object.assign(merged, extra)
  }
  assignSafely(merged, fields)
  for (const key of ['err', 'error'] as const) {
    const value = merged[key]
    if (value instanceof Error && record.err === undefined) {
      record.err = value
      delete merged[key]
    }
  }
  if (Object.keys(merged).length > 0) record.fields = merged
  return record
}
