/**
 * The log viewer as a framework-agnostic Web handler (RFC-0004 §6). Adapters mount it; it works
 * with anything that speaks `Request`/`Response`.
 *
 * Routes (under `basePath`, default `/_strutvane/logs`):
 *
 * | Method | Path | Purpose |
 * |---|---|---|
 * | GET | `/` | The viewer page |
 * | GET | `/api/files` | Log files, newest first (days only for scoped viewers) |
 * | GET | `/api/records` | Search records, newest first, paged by `cursor` |
 * | GET | `/api/download?day=&format=ndjson\|csv` | Download one day (GET only, no HEAD) |
 * | GET | `/api/tail` | Live tail (Server-Sent Events; GET only, no HEAD) |
 * | GET | `/api/session` | CSRF token for state-changing calls |
 * | POST | `/api/clear` | Delete old files (never today's) |
 *
 * Security: closed by default (see `access.ts`), CSRF + Origin checks on `clear`, strict CSP with
 * per-response nonces, `no-store` caching, validated parameters (no path traversal), tenant
 * scoping via `scopeRecords`, and an audit hook for destructive actions.
 *
 * @module
 */
import { createHmac, randomBytes } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type Env, resolveLogsConfig } from '../config.ts'
import { dayKeyOf, isDayKey, listLogFiles, parseLogFileName } from '../files.ts'
import {
  type AccessPolicy,
  type AuthorizeFn,
  buildAllowList,
  decideAccess,
  safeEqual,
  tokenFromEnv,
  validateToken,
} from './access.ts'
import { csvHeader, csvRow } from './csv.ts'
import { parseRecordQuery, QueryError, type RecordFilter, type RecordQuery } from './filters.ts'
import {
  accept,
  cleanLine,
  decodeCursor,
  describeFiles,
  readDayLines,
  readPage,
  viewerSanitizer,
} from './store.ts'
import { createTailStream } from './tail.ts'
import { renderViewerPage } from './ui.ts'

/** A destructive or sensitive viewer action, reported to `onAudit`. */
export interface ViewerAuditEvent {
  readonly action: 'clear' | 'download'
  readonly time: string
  readonly ip?: string
  /** For `clear`: the deleted file names. */
  readonly deleted?: readonly string[]
  /** For `download`: the day downloaded. */
  readonly day?: string
}

/** Viewer options. Every option is optional; the defaults are safe. */
export interface ViewerOptions {
  /** Log directory. Default: `LOGS_PATH` or `storage/logs`, resolved from the working directory. */
  readonly dir?: string
  /** URL prefix. Default: `/_strutvane/logs`. Letters, digits, `/`, `_` and `-` only. */
  readonly basePath?: string
  /** Your own access rule. When set, it replaces the local/token rules. */
  readonly authorize?: AuthorizeFn
  /** Viewer token (≥ 16 characters). Default: `LOGS_VIEWER_TOKEN`. */
  readonly token?: string
  /** Client IPs or CIDR ranges allowed to reach the viewer (all modes). Default: no IP restriction. */
  readonly ipAllowList?: readonly string[]
  /**
   * Restrict which records a request may see (e.g. one tenant's). Return a filter, or `undefined`
   * for no restriction. Scoped requests may not clear logs. A thrown error denies the request.
   */
  readonly scopeRecords?: (
    request: Request,
  ) => RecordFilter | undefined | Promise<RecordFilter | undefined>
  /** Called after a clear or download, e.g. to write an audit log. Errors are ignored. */
  readonly onAudit?: (event: ViewerAuditEvent) => void
  /**
   * Maximum concurrent live tails. Default: 5. A slot is released on every way a tail can end
   * (abort, cancel, a consumer that stops reading, the one-hour lifetime), see `createTailStream`.
   */
  readonly maxTails?: number
  /** Live tail poll interval. Default: 1,000 ms. */
  readonly tailPollMs?: number
  /** Live tail keep-alive interval. Default: 15,000 ms. */
  readonly heartbeatMs?: number
  /** Lines examined per search request before returning a cursor. Default: 100,000. */
  readonly maxScanLines?: number
  /** Environment to read (`APP_ENV`, `LOGS_PATH`, `LOGS_VIEWER_TOKEN`). Default: `process.env`. */
  readonly env?: Env
  /** Clock, for tests. */
  readonly now?: () => number
}

/** Facts a `Request` can't carry. */
export interface ViewerRequestInfo {
  /** Client IP from the socket (never from forgeable headers), used by `ipAllowList`. */
  readonly ip?: string
}

/** The mounted viewer. */
export interface ViewerHandler {
  readonly basePath: string
  /** Does this request belong to the viewer? */
  matches(request: Request): boolean
  /** Does this path (no query string) belong to the viewer? */
  matchesPath(path: string): boolean
  /** Handle a viewer request. Never throws; failures become 500 responses. */
  fetch(request: Request, info?: ViewerRequestInfo): Promise<Response>
}

const BASE_PATH = /^\/[A-Za-z0-9/_-]*$/
const MAX_BODY_BYTES = 4096
const MAX_LIMIT = 500

function problem(
  status: number,
  title: string,
  detail?: string,
): { status: number; body: Record<string, unknown> } {
  return {
    status,
    body: { type: 'about:blank', title, status, ...(detail === undefined ? {} : { detail }) },
  }
}

const BASE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
  'x-robots-tag': 'noindex, nofollow',
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
})

function respond(
  status: number,
  body: BodyInit | null,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers: { ...BASE_HEADERS, ...headers } })
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  const type = status >= 400 ? 'application/problem+json' : 'application/json; charset=utf-8'
  return respond(status, JSON.stringify(value), { 'content-type': type, ...headers })
}

function fail(
  status: number,
  title: string,
  detail?: string,
  headers: Record<string, string> = {},
): Response {
  const p = problem(status, title, detail)
  return json(p.status, p.body, headers)
}

const notFound = (): Response =>
  respond(404, 'Not Found', { 'content-type': 'text/plain; charset=utf-8' })

/** Read a request body up to `max` bytes, or `undefined` if it is larger. */
async function readBody(request: Request, max: number): Promise<string | undefined> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > max) return undefined
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Read one environment variable. */
function readEnv(env: Env, name: string): string | undefined {
  return env[name]
}

interface ClearBody {
  readonly confirm?: unknown
  readonly before?: unknown
}

/**
 * Create the log viewer handler.
 *
 * @example
 * const viewer = createViewerHandler({ authorize: (req) => isAdmin(req) })
 * // in any Web-standard server:
 * if (viewer.matches(request)) return viewer.fetch(request, { ip })
 *
 * @throws TypeError on an invalid `basePath`, `token` or `ipAllowList` entry
 */
export function createViewerHandler(options: ViewerOptions = {}): ViewerHandler {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now
  const basePath = (options.basePath ?? '/_strutvane/logs').replace(/\/+$/, '') || '/'
  if (!BASE_PATH.test(basePath) || basePath === '/' || basePath.includes('//')) {
    throw new TypeError(
      `viewer basePath "${basePath}" is invalid: use a path like /_strutvane/logs`,
    )
  }
  const dir = resolve(options.dir ?? resolveLogsConfig({}, env).config.path)
  const maxTails = options.maxTails ?? 5
  if (!Number.isInteger(maxTails) || maxTails < 0)
    throw new RangeError('maxTails must be a non-negative integer')
  const policy: AccessPolicy = {
    authorize: options.authorize,
    token:
      options.token === undefined
        ? tokenFromEnv(env)
        : validateToken(options.token, 'viewer token'),
    local: (readEnv(env, 'APP_ENV') ?? '').trim().toLowerCase() === 'local',
    allowList: options.ipAllowList ? buildAllowList(options.ipAllowList) : undefined,
    cookiePath: basePath,
    now,
  }
  // CSRF token: random per handler instance, readable only by an authorised same-origin page.
  const csrfToken = createHmac('sha256', randomBytes(32))
    .update('strutvane-logs-csrf')
    .digest('base64url')
  let activeTails = 0

  const matchesPath = (path: string): boolean =>
    path === basePath || path.startsWith(`${basePath}/`)

  const audit = (event: ViewerAuditEvent): void => {
    try {
      options.onAudit?.(event)
    } catch {
      // An audit hook must not break the viewer.
    }
  }

  const page = (): Response => {
    const nonce = randomBytes(18).toString('base64')
    return respond(200, renderViewerPage({ nonce, basePath }), {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    })
  }

  /**
   * The file list. A scoped viewer (e.g. one tenant) sees only which days exist: file names, sizes
   * and modification times describe everyone's activity, not just its own records.
   */
  const files = async (scoped: boolean): Promise<Response> => {
    const all = await describeFiles(dir)
    if (!scoped) return json(200, { files: all })
    const days = [...new Set(all.map((f) => f.day))]
    return json(200, { files: days.map((day) => ({ day })), scoped: true })
  }

  const records = async (
    url: URL,
    query: RecordQuery,
    scope: RecordFilter | undefined,
  ): Promise<Response> => {
    const limitText = url.searchParams.get('limit')
    const limit = limitText === null ? 100 : Number(limitText)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return fail(400, 'Invalid query', `limit must be an integer from 1 to ${MAX_LIMIT}`)
    }
    const cursorText = url.searchParams.get('cursor')
    const cursor = cursorText === null ? undefined : decodeCursor(cursorText)
    if (cursorText !== null && cursor === undefined)
      return fail(400, 'Invalid query', 'cursor is invalid')
    const result = await readPage({
      dir,
      query,
      scope,
      limit,
      cursor,
      ...(options.maxScanLines === undefined ? {} : { maxScanLines: options.maxScanLines }),
    })
    return json(200, result)
  }

  const download = (
    url: URL,
    query: RecordQuery,
    scope: RecordFilter | undefined,
    ip: string | undefined,
  ): Response => {
    const day = url.searchParams.get('day') ?? ''
    if (!isDayKey(day)) return fail(400, 'Invalid query', 'day must be a date like 2026-11-14')
    const format = url.searchParams.get('format') ?? 'ndjson'
    if (format !== 'ndjson' && format !== 'csv')
      return fail(400, 'Invalid query', 'format must be ndjson or csv')
    const encoder = new TextEncoder()
    const lines = readDayLines(dir, day)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (format === 'csv') controller.enqueue(encoder.encode(csvHeader()))
      },
      async pull(controller) {
        // Emit in chunks of up to ~64 KB to keep memory flat.
        let out = ''
        while (out.length < 65_536) {
          const next = await lines.next()
          if (next.done) {
            if (out) controller.enqueue(encoder.encode(out))
            controller.close()
            return
          }
          const clean = cleanLine(next.value, viewerSanitizer)
          if (!clean || !accept(clean, query, scope)) continue
          out += format === 'csv' ? csvRow(clean.record) : `${clean.json}\n`
        }
        controller.enqueue(encoder.encode(out))
      },
      async cancel() {
        await lines.return(undefined)
      },
    })
    audit({
      action: 'download',
      time: new Date(now()).toISOString(),
      day,
      ...(ip === undefined ? {} : { ip }),
    })
    return respond(200, stream, {
      'content-type':
        format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="logs-${day}.${format}"`,
    })
  }

  const tail = (
    request: Request,
    query: RecordQuery,
    scope: RecordFilter | undefined,
  ): Response => {
    if (activeTails >= maxTails) {
      return fail(429, 'Too many live tails', `at most ${maxTails} live tails may run at once`, {
        'retry-after': '10',
      })
    }
    activeTails++
    // Release exactly once, whichever path ends the tail (including a throw right here).
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      activeTails--
    }
    try {
      const stream = createTailStream({
        dir,
        query,
        scope,
        signal: request.signal,
        now,
        ...(options.tailPollMs === undefined ? {} : { pollMs: options.tailPollMs }),
        ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
        onClose: release,
      })
      return respond(200, stream, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',
      })
    } catch (error) {
      release()
      throw error
    }
  }

  const clear = async (
    request: Request,
    url: URL,
    scoped: boolean,
    ip: string | undefined,
  ): Promise<Response> => {
    if (scoped) return fail(403, 'Forbidden', 'scoped viewers cannot clear logs')
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== url.origin)
      return fail(403, 'Forbidden', 'cross-origin request')
    const site = request.headers.get('sec-fetch-site')
    if (site !== null && site !== 'same-origin' && site !== 'none')
      return fail(403, 'Forbidden', 'cross-site request')
    const given = request.headers.get('x-csrf-token')
    if (given === null || !safeEqual(given, csrfToken))
      return fail(403, 'Forbidden', 'missing or invalid CSRF token')
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return fail(415, 'Unsupported media type', 'send application/json')
    }
    const text = await readBody(request, MAX_BODY_BYTES)
    if (text === undefined) return fail(413, 'Payload too large')
    let body: ClearBody
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('not an object')
      body = parsed
    } catch {
      return fail(400, 'Invalid body', 'body must be a JSON object')
    }
    if (body.confirm !== 'DELETE') return fail(400, 'Invalid body', 'confirm must be "DELETE"')
    const today = dayKeyOf(now())
    let before = today
    if (body.before !== undefined) {
      if (typeof body.before !== 'string' || !isDayKey(body.before)) {
        return fail(400, 'Invalid body', 'before must be a date like 2026-11-14')
      }
      // Today's files are never deleted: active writers append to them.
      if (body.before < today) before = body.before
    }
    const deleted: string[] = []
    for (const name of await listLogFiles(dir)) {
      const day = parseLogFileName(name)?.day
      if (day === undefined || day >= before) continue
      try {
        await unlink(join(dir, name))
        deleted.push(name)
      } catch {
        // Already gone or locked: skip.
      }
    }
    audit({
      action: 'clear',
      time: new Date(now()).toISOString(),
      deleted,
      ...(ip === undefined ? {} : { ip }),
    })
    return json(200, { deleted })
  }

  const handle = async (request: Request, info: ViewerRequestInfo): Promise<Response> => {
    const url = new URL(request.url)
    if (!matchesPath(url.pathname)) return notFound()
    const sub = url.pathname.slice(basePath.length) || '/'
    const isPage = sub === '/'

    const decision = await decideAccess(policy, request, info.ip, isPage)
    if (decision.kind === 'hidden') return notFound()
    if (decision.kind === 'login') {
      return respond(303, null, { location: basePath, 'set-cookie': decision.cookie })
    }
    if (decision.kind === 'unauthenticated') {
      return fail(401, 'Unauthorized', 'a valid viewer token is required', {
        'www-authenticate': 'Bearer realm="strutvane-logs"',
      })
    }

    let scope: RecordFilter | undefined
    try {
      scope = await options.scopeRecords?.(request)
    } catch {
      return notFound()
    }

    const isGet = request.method === 'GET' || request.method === 'HEAD'
    const known = [
      '/',
      '/api/files',
      '/api/records',
      '/api/download',
      '/api/tail',
      '/api/session',
      '/api/clear',
    ]
    if (!known.includes(sub)) return notFound()
    // Streaming routes hold resources (a tail slot, file handles, an audit entry) until the body
    // is consumed; a HEAD response has no body to consume, so they accept GET only.
    const getOnly = sub === '/api/tail' || sub === '/api/download'
    const allowed = sub === '/api/clear' ? 'POST' : getOnly ? 'GET' : 'GET, HEAD'
    const methodOk =
      sub === '/api/clear' ? request.method === 'POST' : getOnly ? request.method === 'GET' : isGet
    if (!methodOk) return fail(405, 'Method not allowed', undefined, { allow: allowed })

    if (isPage) return page()
    if (sub === '/api/session') return json(200, { csrfToken })
    if (sub === '/api/files') return files(scope !== undefined)
    if (sub === '/api/clear') return clear(request, url, scope !== undefined, info.ip)

    let query: RecordQuery
    try {
      query = parseRecordQuery(url.searchParams)
    } catch (error) {
      if (error instanceof QueryError) return fail(400, 'Invalid query', error.message)
      throw error
    }
    if (sub === '/api/records') return records(url, query, scope)
    if (sub === '/api/download') return download(url, query, scope, info.ip)
    return tail(request, query, scope)
  }

  return {
    basePath,
    matchesPath,
    matches: (request) => {
      try {
        return matchesPath(new URL(request.url).pathname)
      } catch {
        return false
      }
    },
    async fetch(request, info = {}) {
      try {
        return await handle(request, info)
      } catch {
        return fail(500, 'Internal Server Error')
      }
    },
  }
}
