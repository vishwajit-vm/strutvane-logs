/**
 * `@strutvane/logs/http`: request logging for any framework built on the Web `Request` /
 * `Response` API (Hono, Next.js route handlers, Deno-style servers, `fetch` handlers…).
 *
 * @example
 * import { createRequestLogger } from '@strutvane/logs/http'
 * const requests = createRequestLogger()
 * export default { fetch: (req: Request) => requests.handle(req, (r) => app.fetch(r)) }
 *
 * @module
 */
import { runWithLogContext } from '../context.ts'
import {
  type CompletedRequest,
  logCompletedRequest,
  loggedPath,
  type RequestLoggingOptions,
  requestIdFrom,
  resolveRequestLogging,
  sizeFrom,
} from './core.ts'

export type { CompletedRequest, RequestLoggingOptions, ResolvedRequestLogging } from './core.ts'
export {
  levelFor,
  logCompletedRequest,
  loggedPath,
  MAX_LOGGED_PATH_LENGTH,
  pathOf,
  requestIdFrom,
  resolveRequestLogging,
  safePath,
  sizeFrom,
} from './core.ts'

/** A Web request handler. */
export type WebHandler = (request: Request) => Response | Promise<Response>

/** A request logger for Web handlers. */
export interface WebRequestLogger {
  /**
   * Handle `request` with `next` and log the outcome. Downstream code runs inside a log context
   * carrying the request id, and the id is echoed in the response header.
   */
  handle(request: Request, next: WebHandler): Promise<Response>
}

/** Return `response` with `header: value` added, even if its headers are immutable. */
function withHeader(response: Response, header: string, value: string): Response {
  try {
    response.headers.set(header, value)
    return response
  } catch {
    const headers = new Headers(response.headers)
    headers.set(header, value)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

/** Create a request logger for Web `Request`/`Response` handlers. */
export function createRequestLogger(options: RequestLoggingOptions = {}): WebRequestLogger {
  const resolved = resolveRequestLogging(options)
  return {
    async handle(request: Request, next: WebHandler): Promise<Response> {
      const requestId = requestIdFrom(request.headers.get(resolved.requestIdHeader))
      const route = loggedPath(request.url)
      const started = performance.now()
      const finish = (info: Omit<CompletedRequest, 'method' | 'route' | 'durationMs'>): void => {
        logCompletedRequest(resolved, {
          method: request.method,
          route,
          durationMs: performance.now() - started,
          ...info,
        })
      }
      return runWithLogContext({ requestId }, async () => {
        let response: Response
        try {
          response = await next(request)
        } catch (error) {
          finish({ status: 500, error })
          throw error
        }
        const size = sizeFrom(response.headers.get('content-length'))
        finish({ status: response.status, ...(size === undefined ? {} : { size }) })
        return withHeader(response, resolved.requestIdHeader, requestId)
      })
    },
  }
}
