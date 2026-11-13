/**
 * The logging pipeline (RFC-0004, ADR-0015):
 *
 * ```
 * record → enrich (bindings + context) → sanitise/redact → one-line serialise → bounded queue
 *        → batched, non-blocking writes (setImmediate) → transport (stderr fallback)
 * ```
 *
 * Contract with application code:
 * - **A log call is synchronous, cheap and NEVER throws,** whatever it is given.
 * - **Writing happens off the hot path,** with exactly one batch in flight at a time.
 * - **Fallback on failure.** If the primary transport fails:
 *   - logging falls back to stderr with exactly ONE warning per outage
 *   - the batch is kept (written to stderr instead)
 *   - the primary is retried later, and logging recovers automatically
 * - **Bounded memory.** The queue caps memory. Low-severity records are dropped first, and the
 *   drops are reported in a later `warn` record.
 *
 * @module
 */
import type { LogFields, Logger, LogLevel } from '@strutvane/contracts'
import { type ContextGetter, getLogContext } from './context.ts'
import { dayKeyOf } from './files.ts'
import { severityOf } from './levels.ts'
import { BoundedQueue, DEFAULT_QUEUE_LIMITS, type QueueItem, type QueueLimits } from './queue.ts'
import { buildRecord } from './record.ts'
import { createSanitizer, type SanitizeOptions, type Sanitizer } from './redact.ts'
import { DEFAULT_MAX_RECORD_BYTES, escapeLineSeparators, serializeRecord } from './serialize.ts'
import { stderrTransport } from './transports/console.ts'
import type { Batch, Transport } from './transports/types.ts'

/** Low-level options: an explicit transport plus pipeline tuning. */
export interface PipelineOptions {
  /** Where records go. */
  readonly transport: Transport
  /** Used while the primary transport fails. Default: stderr. */
  readonly fallback?: Transport
  /** Minimum level written. Default: `info`. */
  readonly level?: LogLevel
  /** Redaction and safety settings. `{ redact: false }` keeps only the safety transformations. */
  readonly sanitize?: Partial<SanitizeOptions>
  /** Maximum size of one record. Larger records become a truncation marker. Default: 32 KB. */
  readonly maxRecordBytes?: number
  /** Queue limits. Default: 10,000 records / 16 MB. */
  readonly queue?: Partial<QueueLimits>
  /** Maximum size of one write. Default: 256 KB. */
  readonly maxBatchBytes?: number
  /** Retry the primary transport this long after a failure. Default: 30 s. */
  readonly retryPrimaryMs?: number
  /** Bindings added to every record, e.g. `{ service: 'api' }`. */
  readonly bindings?: LogFields
  /** Where request context comes from. Default: this package's AsyncLocalStorage store. */
  readonly context?: ContextGetter
  /** Injectable clock (epoch ms), for tests. */
  readonly now?: () => number
}

/** Result of a bounded flush. */
export interface FlushResult {
  /** `true` if everything queued at the time was written before the deadline. */
  readonly flushed: boolean
  /** Records still queued when the call returned. */
  readonly pending: number
}

/** Counters for monitoring and tests. */
export interface LoggerStats {
  readonly written: number
  readonly dropped: number
  readonly droppedByLevel: Readonly<Partial<Record<LogLevel, number>>>
  readonly fallbackActive: boolean
  readonly primaryFailures: number
  readonly fallbackWarnings: number
  readonly internalErrors: number
  readonly queued: number
  readonly queuePeak: number
  readonly queuePeakBytes: number
}

/** A Strutvane logger: the contracts' `Logger`, plus lifecycle and stats. */
export interface StrutvaneLogger extends Logger {
  /** The minimum level written. */
  readonly level: LogLevel
  child(bindings: LogFields): StrutvaneLogger
  /** Like `flush`, but reports whether everything was written before the deadline. */
  drain(timeoutMs?: number): Promise<FlushResult>
  /** Drain (bounded) and close the transport. Later log calls are ignored. */
  close(timeoutMs?: number): Promise<FlushResult>
  stats(): LoggerStats
}

/** Shared state of one logger and all of its children. */
interface Core {
  readonly maxRecordBytes: number
  readonly maxBatchBytes: number
  readonly retryPrimaryMs: number
  readonly level: LogLevel
  readonly minSeverity: number
  readonly sanitize: Sanitizer
  readonly queue: BoundedQueue
  readonly primary: Transport
  readonly fallback: Transport
  readonly context: ContextGetter
  readonly now: () => number
  seq: number
  scheduled: boolean
  writing: boolean
  closed: boolean
  fallbackActive: boolean
  retryAt: number
  written: number
  dropped: number
  droppedByLevel: Partial<Record<LogLevel, number>>
  primaryFailures: number
  fallbackWarnings: number
  internalErrors: number
  waiters: Array<() => void>
  dayStart: number
  dayEnd: number
  dayKey: string
}

/**
 * Create a logger over an explicit transport. Most code uses `createLogger` (from the package
 * root), which picks the transport from configuration.
 */
export function createPipelineLogger(options: PipelineOptions): StrutvaneLogger {
  const level = options.level ?? 'info'
  const core: Core = {
    maxRecordBytes: positive(options.maxRecordBytes, DEFAULT_MAX_RECORD_BYTES, 'maxRecordBytes'),
    maxBatchBytes: positive(options.maxBatchBytes, 256 * 1024, 'maxBatchBytes'),
    retryPrimaryMs: positive(options.retryPrimaryMs, 30_000, 'retryPrimaryMs'),
    level,
    minSeverity: severityOf(level),
    sanitize: createSanitizer(options.sanitize),
    queue: new BoundedQueue({ ...DEFAULT_QUEUE_LIMITS, ...options.queue }),
    primary: options.transport,
    fallback: options.fallback ?? stderrTransport(),
    context: options.context ?? getLogContext,
    now: options.now ?? Date.now,
    seq: 0,
    scheduled: false,
    writing: false,
    closed: false,
    fallbackActive: false,
    retryAt: 0,
    written: 0,
    dropped: 0,
    droppedByLevel: {},
    primaryFailures: 0,
    fallbackWarnings: 0,
    internalErrors: 0,
    waiters: [],
    dayStart: 0,
    dayEnd: -1,
    dayKey: '',
  }
  return makeLogger(core, options.bindings ?? {})
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${name} must be a positive number`)
  return value
}

function makeLogger(core: Core, bindings: LogFields): StrutvaneLogger {
  const write = (level: LogLevel, msg: unknown, fields?: LogFields): void => {
    try {
      const severity = severityOf(level)
      if (severity < core.minSeverity || core.closed) return
      const time = core.now()
      let context: ReturnType<ContextGetter>
      try {
        context = core.context()
      } catch {
        context = undefined
      }
      const record = buildRecord(level, msg, bindings, context, fields, time)
      const safe = core.sanitize(record) as Record<string, unknown>
      enqueue(core, serializeRecord(safe, core.maxRecordBytes), severity, level, time)
    } catch {
      core.internalErrors++
    }
  }
  return {
    level: core.level,
    trace: (m, f) => write('trace', m, f),
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    fatal: (m, f) => write('fatal', m, f),
    child: (more) => makeLogger(core, { ...bindings, ...more }),
    isLevelEnabled: (level) => !core.closed && severityOf(level) >= core.minSeverity,
    flush: async (timeoutMs = 5_000) => {
      await drain(core, timeoutMs)
    },
    drain: (timeoutMs = 5_000) => drain(core, timeoutMs),
    close: async (timeoutMs = 5_000) => {
      const result = await drain(core, timeoutMs)
      core.closed = true
      await Promise.race([core.primary.close().catch(() => undefined), delay(timeoutMs)])
      return result
    },
    stats: () => ({
      written: core.written,
      dropped: core.dropped,
      droppedByLevel: { ...core.droppedByLevel },
      fallbackActive: core.fallbackActive,
      primaryFailures: core.primaryFailures,
      fallbackWarnings: core.fallbackWarnings,
      internalErrors: core.internalErrors,
      queued: core.queue.size,
      queuePeak: core.queue.peakRecords,
      queuePeakBytes: core.queue.peakBytes,
    }),
  }
}

function dayKeyFor(core: Core, time: number): string {
  if (time >= core.dayStart && time < core.dayEnd) return core.dayKey
  core.dayKey = dayKeyOf(time)
  core.dayStart = Date.parse(`${core.dayKey}T00:00:00.000Z`)
  core.dayEnd = core.dayStart + 86_400_000
  return core.dayKey
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false
  return true
}

function enqueue(core: Core, line: string, severity: number, level: LogLevel, time: number): void {
  const item: QueueItem = {
    seq: core.seq++,
    line,
    bytes: isAscii(line) ? line.length : Buffer.byteLength(line),
    severity,
    level,
    dayKey: dayKeyFor(core, time),
  }
  core.queue.push(item)
  schedule(core)
}

function schedule(core: Core): void {
  if (core.scheduled || core.writing) return
  core.scheduled = true
  setImmediate(() => {
    core.scheduled = false
    void pump(core)
  })
}

/** A pipeline-generated record (drop report, fallback warning). Already safe; no user data. */
function internalLine(core: Core, msg: string, fields: Record<string, unknown>): string {
  const json = JSON.stringify({
    time: new Date(core.now()).toISOString(),
    level: 'warn',
    msg,
    fields,
  })
  return `${escapeLineSeparators(json)}\n`
}

async function pump(core: Core): Promise<void> {
  if (core.writing) return
  core.writing = true
  try {
    for (;;) {
      const items = core.queue.takeBatch(core.maxBatchBytes)
      const first = items[0]
      if (!first) break
      let text = ''
      let bytes = 0
      const droppedNow = core.queue.takeDropped()
      if (droppedNow) {
        let total = 0
        for (const [lvl, n] of Object.entries(droppedNow)) {
          const level = lvl as LogLevel
          total += n ?? 0
          core.droppedByLevel[level] = (core.droppedByLevel[level] ?? 0) + (n ?? 0)
        }
        core.dropped += total
        const meta = internalLine(core, `logs: dropped ${total} records (queue full)`, {
          dropped: droppedNow,
        })
        text += meta
        bytes += meta.length
      }
      for (const it of items) {
        text += it.line
        bytes += it.bytes
      }
      await deliver(core, { text, bytes, records: items.length, dayKey: first.dayKey })
      core.written += items.length
    }
  } catch {
    core.internalErrors++
  } finally {
    core.writing = false
    if (core.queue.size > 0) schedule(core)
    else {
      const waiters = core.waiters
      core.waiters = []
      for (const w of waiters) w()
    }
  }
}

async function deliver(core: Core, batch: Batch): Promise<void> {
  const usePrimary = !core.fallbackActive || core.now() >= core.retryAt
  if (usePrimary) {
    try {
      await callTransport(core.primary, batch)
      core.fallbackActive = false // (recovered, if it was failing)
      return
    } catch (error) {
      core.primaryFailures++
      core.retryAt = core.now() + core.retryPrimaryMs
      if (!core.fallbackActive) {
        core.fallbackActive = true
        core.fallbackWarnings++
        const warning = internalLine(
          core,
          `logs: transport "${core.primary.name}" failed; writing to ${core.fallback.name} until it recovers`,
          { error: describe(error) },
        )
        await callTransport(core.fallback, {
          text: warning,
          bytes: warning.length,
          records: 1,
          dayKey: batch.dayKey,
        }).catch(() => undefined)
      }
    }
  }
  await callTransport(core.fallback, batch).catch(() => {
    core.internalErrors++
  })
}

/** Call a transport so that a synchronous throw becomes a rejection. */
function callTransport(t: Transport, batch: Batch): Promise<void> {
  try {
    return Promise.resolve(t.write(batch))
  } catch (error) {
    return Promise.reject(error)
  }
}

function describe(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return { name: error.name, message: error.message, ...(code ? { code: String(code) } : {}) }
  }
  return { message: String(error) }
}

function drain(core: Core, timeoutMs: number): Promise<FlushResult> {
  if (!core.writing && !core.scheduled && core.queue.size === 0) {
    return Promise.resolve({ flushed: true, pending: 0 })
  }
  return new Promise<FlushResult>((resolve) => {
    let done = false
    const finish = (flushed: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ flushed, pending: core.queue.size })
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    core.waiters.push(() => finish(true))
    schedule(core)
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}
