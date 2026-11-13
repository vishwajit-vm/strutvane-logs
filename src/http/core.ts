/**
 * Framework-agnostic request logging (RFC-0004 §1). Every adapter (Web, Node, Hono, Express) uses
 * these helpers, so all of them produce the same compact record:
 *
 * ```
 * msg: "GET /api/v1/invoices 200"
 * fields: { method, route, status, durationMs, size? }   (+ requestId from the context)
 * ```
 *
 * - **Compact by default** (spike 09: a ~1 KB record per request costs about a third of request
 *   throughput).
 * - **No query strings or bodies,** which can carry tokens or personal data.
 * - **Level by outcome:** server errors (≥ 500) log at `error`, slow requests at `warn`, everything
 *   else at `info`.
 * - **Health checks are ignored by default** (`/health`, `/ready`), so probes don't flood the logs.
 *
 * @module
 */
import { randomUUID } from 'node:crypto'
import type { Logger, LogLevel } from '@strutvane/contracts'
import { log as defaultLogger } from '../default.ts'

/** Options shared by every request-logging adapter. */
export interface RequestLoggingOptions {
  /** The logger to write to. Default: the package's default `log`. */
  readonly logger?: Logger
  /** Exact paths that are never logged. Default: `['/health', '/ready']`. */
  readonly ignore?: readonly string[]
  /** Requests slower than this are logged at `warn`. Default: 1,000 ms. */
  readonly slowThresholdMs?: number
  /** Header that carries the request id, in and out. Default: `x-request-id`. */
  readonly requestIdHeader?: string
}

/** Resolved options with defaults applied. */
export interface ResolvedRequestLogging {
  readonly logger: Logger
  readonly ignore: ReadonlySet<string>
  readonly slowThresholdMs: number
  readonly requestIdHeader: string
}

/** Facts about one finished request. */
export interface CompletedRequest {
  readonly method: string
  /** Route template when the framework knows it (e.g. `/invoices/:id`), otherwise the path. */
  readonly route: string
  readonly status: number
  readonly durationMs: number
  /** Response size in bytes, when known. */
  readonly size?: number
  /** The error thrown by the handler, if any. */
  readonly error?: unknown
  /** `true` if the client went away before the response finished. */
  readonly aborted?: boolean
}

/** Apply defaults and validate options. */
export function resolveRequestLogging(options: RequestLoggingOptions = {}): ResolvedRequestLogging {
  const slow = options.slowThresholdMs ?? 1_000
  if (!Number.isFinite(slow) || slow <= 0)
    throw new RangeError('slowThresholdMs must be a positive number')
  const header = (options.requestIdHeader ?? 'x-request-id').toLowerCase()
  if (!/^[a-z0-9-]{1,64}$/.test(header))
    throw new TypeError(`invalid request id header "${header}"`)
  return {
    logger: options.logger ?? defaultLogger,
    ignore: new Set(options.ignore ?? ['/health', '/ready']),
    slowThresholdMs: slow,
    requestIdHeader: header,
  }
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Use the incoming request id if it is safe, otherwise generate a new one. Incoming ids are
 * untrusted: anything that isn't a short, plain token is replaced, so a client can't inject
 * control characters or huge values into every log line.
 */
export function requestIdFrom(value: string | null | undefined): string {
  return value && SAFE_REQUEST_ID.test(value) ? value : randomUUID()
}

/** The path without query string or fragment. Never throws. */
export function pathOf(url: string): string {
  const q = url.search(/[?#]/)
  const path = q === -1 ? url : url.slice(0, q)
  try {
    return path.startsWith('/') ? path : new URL(url).pathname
  } catch {
    return '/'
  }
}

/** The level for a finished request. */
export function levelFor(info: CompletedRequest, slowThresholdMs: number): LogLevel {
  if (info.error !== undefined || info.status >= 500) return 'error'
  if (info.aborted || info.durationMs >= slowThresholdMs) return 'warn'
  return 'info'
}

/** Write the record for a finished request. Never throws. */
export function logCompletedRequest(options: ResolvedRequestLogging, info: CompletedRequest): void {
  try {
    if (options.ignore.has(info.route)) return
    const level = levelFor(info, options.slowThresholdMs)
    const fields = {
      method: info.method,
      route: info.route,
      status: info.status,
      durationMs: Math.round(info.durationMs * 10) / 10,
      ...(info.size === undefined ? {} : { size: info.size }),
      ...(info.aborted ? { aborted: true } : {}),
      ...(info.error === undefined ? {} : { err: info.error }),
    }
    options.logger[level](`${info.method} ${info.route} ${info.status}`, fields)
  } catch {
    // Logging must never break request handling.
  }
}

/** Parse a `content-length` header value into a byte count, if valid. */
export function sizeFrom(
  value: string | number | readonly string[] | null | undefined,
): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined || raw === null) return undefined
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}
