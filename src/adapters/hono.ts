/**
 * `@strutvane/logs/hono`: request logging and the log viewer for Hono apps.
 *
 * @example
 * import { Hono } from 'hono'
 * import { logs } from '@strutvane/logs/hono'
 * const app = new Hono()
 * app.use(logs())   // request logging + viewer at /_strutvane/logs (locked down by default)
 *
 * @module
 */
import type { Context, MiddlewareHandler } from 'hono'
import { runWithLogContext } from '../context.ts'
import {
  logCompletedRequest,
  type RequestLoggingOptions,
  requestIdFrom,
  resolveRequestLogging,
  safePath,
  sizeFrom,
} from '../http/core.ts'
import { createViewerHandler, type ViewerOptions } from '../viewer/handler.ts'

export type { RequestLoggingOptions } from '../http/core.ts'
export type { ViewerOptions } from '../viewer/handler.ts'

/** Hono middleware that logs every request and runs handlers inside a log context. */
export function requestLogging(options: RequestLoggingOptions = {}): MiddlewareHandler {
  const resolved = resolveRequestLogging(options)
  return async (c, next) => {
    const requestId = requestIdFrom(c.req.header(resolved.requestIdHeader))
    const started = performance.now()
    let thrown: unknown
    try {
      await runWithLogContext({ requestId }, () => next())
    } catch (error) {
      thrown = error
    }
    const error = thrown ?? c.error
    const size = sizeFrom(c.res.headers.get('content-length'))
    logCompletedRequest(resolved, {
      method: c.req.method,
      // routePath is the matched template (e.g. /invoices/:id); fall back to the safe path.
      route:
        c.req.routePath && c.req.routePath !== '*' && c.req.routePath !== '/*'
          ? c.req.routePath
          : safePath(c.req.path),
      status: thrown !== undefined ? 500 : c.res.status,
      durationMs: performance.now() - started,
      ...(size === undefined ? {} : { size }),
      ...(error === undefined ? {} : { error }),
    })
    if (thrown !== undefined) throw thrown
    try {
      c.res.headers.set(resolved.requestIdHeader, requestId)
    } catch {
      // Immutable headers (rare): the id is still in the log record.
    }
  }
}

/** Options for {@link logs}. */
export interface HonoLogsOptions {
  /** Request logging options, or `false` to disable request logging. */
  readonly requests?: RequestLoggingOptions | false
  /** Viewer options, or `false` to disable the viewer. */
  readonly viewer?: ViewerOptions | false
  /** How to find the client IP (for the viewer's IP allow-list), e.g. via `getConnInfo`. */
  readonly clientIp?: (c: Context) => string | undefined
}

/** Request logging plus the log viewer, as one middleware. */
export function logs(options: HonoLogsOptions = {}): MiddlewareHandler {
  const viewer = options.viewer === false ? undefined : createViewerHandler(options.viewer ?? {})
  const requests = options.requests === false ? undefined : requestLogging(options.requests ?? {})
  return async (c, next) => {
    if (viewer?.matches(c.req.raw)) {
      const ip = options.clientIp?.(c)
      return viewer.fetch(c.req.raw, ip === undefined ? {} : { ip })
    }
    if (requests) return requests(c, next)
    return next()
  }
}
