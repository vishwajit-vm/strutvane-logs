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
 * - **The route template when the framework knows it** (`/invoices/:id`). Otherwise the path is
 *   logged through {@link safePath}: secrets redacted, opaque token-like segments masked, and the
 *   length capped, so a reset link or signed URL can't put its secret into every request line.
 * - **Level by outcome:** server errors (≥ 500) log at `error`, slow requests at `warn`, everything
 *   else at `info`.
 * - **Health checks are ignored by default** (`/health`, `/ready`), so probes don't flood the logs.
 *
 * @module
 */
import { randomUUID } from 'node:crypto'
import type { Logger, LogLevel } from '@strutvane/contracts'
import { log as defaultLogger } from '../default.ts'
import { REDACTED, redactString } from '../redact.ts'

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

/** Longest path written to a request line; longer paths are cut and marked with `…`. */
export const MAX_LOGGED_PATH_LENGTH = 200

const TOKEN_CHARS = /^[A-Za-z0-9_~=+-]{20,}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Character class for the randomness check: 0 lowercase, 1 uppercase, 2 digit, -1 separator. */
const charClass = (c: number): number =>
  c >= 97 && c <= 122 ? 0 : c >= 65 && c <= 90 ? 1 : c >= 48 && c <= 57 ? 2 : -1

/**
 * Does a path segment look like an opaque token (reset or invite token, signed id, API key)? At
 * least 20 URL-safe characters (no dots, so file names never match) whose neighbouring characters
 * switch between lowercase, uppercase and digits often, as random hex, base32 and base64 do (about
 * every other character) and words, slugs and dates don't. UUIDs are record ids, not secrets, and
 * are kept so request lines stay useful.
 */
function looksOpaque(segment: string): boolean {
  if (!TOKEN_CHARS.test(segment) || UUID.test(segment)) return false
  let pairs = 0
  let changes = 0
  for (let i = 1; i < segment.length; i++) {
    const a = charClass(segment.charCodeAt(i - 1))
    const b = charClass(segment.charCodeAt(i))
    if (a === -1 || b === -1) continue
    pairs++
    if (a !== b) changes++
  }
  return pairs > 0 && changes / pairs >= 0.2
}

/**
 * Make a raw path (no query string) safe to log when no route template is known: built-in secret
 * patterns are redacted, token-like segments become `[REDACTED]`, and the result is capped at
 * {@link MAX_LOGGED_PATH_LENGTH} characters. Never throws.
 *
 * @example
 * safePath('/password/reset/9f8e7d6c5b4a39281706f5e4d3c2b1a0') // '/password/reset/[REDACTED]'
 */
export function safePath(path: string): string {
  const masked = path
    .split('/')
    .map((segment) => (looksOpaque(segment) ? REDACTED : segment))
    .join('/')
  const clean = redactString(masked)
  return clean.length > MAX_LOGGED_PATH_LENGTH
    ? `${clean.slice(0, MAX_LOGGED_PATH_LENGTH)}…`
    : clean
}

/** The path of `url`, made safe to log with {@link safePath}. */
export function loggedPath(url: string): string {
  return safePath(pathOf(url))
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
