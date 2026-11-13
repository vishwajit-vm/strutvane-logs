/**
 * `@strutvane/logs/express`: request logging and the log viewer for Express 5 apps.
 *
 * @example
 * import express from 'express'
 * import { logs, errorLogging } from '@strutvane/logs/express'
 * const app = express()
 * app.use(logs())          // request logging + viewer at /_strutvane/logs (locked down by default)
 * // … routes …
 * app.use(errorLogging())  // logs thrown errors with their stack, then passes them on
 *
 * @module
 */
import type { ErrorRequestHandler, Request, RequestHandler } from 'express'
import { runWithLogContext } from '../context.ts'
import { pathOf, type RequestLoggingOptions, resolveRequestLogging } from '../http/core.ts'
import { createViewerHandler, type ViewerOptions } from '../viewer/handler.ts'
import { toNodeHandler, trackNodeRequest } from './node.ts'

export type { RequestLoggingOptions } from '../http/core.ts'
export type { ViewerOptions } from '../viewer/handler.ts'

/** The matched route template (e.g. `/invoices/:id`) when Express knows it, otherwise the path. */
function routeOf(req: Request): string {
  const routePath: unknown = (req.route as { path?: unknown } | undefined)?.path
  // Express clears `baseUrl` when an error leaves a router, so it may be undefined at finish time.
  const base: unknown = req.baseUrl
  return typeof routePath === 'string'
    ? `${typeof base === 'string' ? base : ''}${routePath}`
    : pathOf(req.originalUrl || req.url)
}

/** Express middleware that logs every request and runs the rest of the chain inside a log context. */
export function requestLogging(options: RequestLoggingOptions = {}): RequestHandler {
  const resolved = resolveRequestLogging(options)
  return (req, res, next) => {
    const requestId = trackNodeRequest(resolved, req, res, () => routeOf(req))
    runWithLogContext({ requestId }, () => next())
  }
}

/**
 * Express error middleware that logs the error with its stack (at `error`), then passes it on to
 * the next error handler. Mount it after your routes.
 */
export function errorLogging(
  options: Pick<RequestLoggingOptions, 'logger'> = {},
): ErrorRequestHandler {
  const { logger } = resolveRequestLogging(options)
  return (err, req, _res, next) => {
    try {
      logger.error(`Unhandled error in ${req.method} ${routeOf(req)}`, { err })
    } catch {
      // Never let logging hide the original error.
    }
    next(err)
  }
}

/** Options for {@link logs}. */
export interface ExpressLogsOptions {
  /** Request logging options, or `false` to disable request logging. */
  readonly requests?: RequestLoggingOptions | false
  /** Viewer options, or `false` to disable the viewer. */
  readonly viewer?: ViewerOptions | false
}

/** Request logging plus the log viewer, as one middleware. */
export function logs(options: ExpressLogsOptions = {}): RequestHandler {
  const viewer = options.viewer === false ? undefined : createViewerHandler(options.viewer ?? {})
  const serveViewer = viewer
    ? toNodeHandler((request, info) => viewer.fetch(request, info))
    : undefined
  const requests = options.requests === false ? undefined : requestLogging(options.requests ?? {})
  return (req, res, next) => {
    if (viewer && serveViewer && viewer.matchesPath(pathOf(req.originalUrl || req.url))) {
      void serveViewer(req, res)
      return
    }
    if (requests) {
      requests(req, res, next)
      return
    }
    next()
  }
}
