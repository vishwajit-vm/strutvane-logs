/**
 * `@strutvane/logs/node`: request logging and viewer serving for plain `node:http` servers. It is
 * also the base of the Express adapter.
 *
 * @example
 * import { createServer } from 'node:http'
 * import { withRequestLogging } from '@strutvane/logs/node'
 * createServer(withRequestLogging((req, res) => res.end('ok'))).listen(3000)
 *
 * @module
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { runWithLogContext } from '../context.ts'
import {
  logCompletedRequest,
  loggedPath,
  type RequestLoggingOptions,
  type ResolvedRequestLogging,
  requestIdFrom,
  resolveRequestLogging,
  sizeFrom,
} from '../http/core.ts'

export type { RequestLoggingOptions } from '../http/core.ts'

/**
 * Track one Node request/response pair and log it once the response finishes, or once the client
 * disconnects early. Shared by the Node and Express adapters.
 *
 * @param route returns the route at finish time (Express knows the template only then)
 */
export function trackNodeRequest(
  resolved: ResolvedRequestLogging,
  req: IncomingMessage,
  res: ServerResponse,
  route: () => string,
): string {
  const header = resolved.requestIdHeader
  const incoming = req.headers[header]
  const requestId = requestIdFrom(Array.isArray(incoming) ? incoming[0] : incoming)
  if (!res.headersSent) res.setHeader(header, requestId)
  const started = performance.now()
  let logged = false
  const done = (aborted: boolean): void => {
    if (logged) return
    logged = true
    const size = sizeFrom(res.getHeader('content-length') as string | number | undefined)
    logCompletedRequest(resolved, {
      method: req.method ?? 'GET',
      route: route(),
      status: aborted && !res.writableFinished ? 499 : res.statusCode,
      durationMs: performance.now() - started,
      ...(size === undefined ? {} : { size }),
      ...(aborted && !res.writableFinished ? { aborted: true } : {}),
    })
  }
  res.once('finish', () => done(false))
  res.once('close', () => done(true))
  return requestId
}

/** Wrap a `node:http` request listener with request logging and a per-request log context. */
export function withRequestLogging(
  listener: RequestListener,
  options: RequestLoggingOptions = {},
): RequestListener {
  const resolved = resolveRequestLogging(options)
  return (req, res) => {
    const requestId = trackNodeRequest(resolved, req, res, () => loggedPath(req.url ?? '/'))
    runWithLogContext({ requestId }, () => listener(req, res))
  }
}

/** Extra facts a Web handler may need that a `Request` can't carry (e.g. the client IP). */
export interface RequestInfo {
  /** The client IP from the socket (never from headers, which clients can forge). */
  readonly ip?: string
}

/** A Web handler that also accepts {@link RequestInfo}. */
export type InfoWebHandler = (request: Request, info: RequestInfo) => Promise<Response>

/** Convert a Node request into a Web `Request` (streaming the body for non-GET methods). */
export function toWebRequest(req: IncomingMessage): Request {
  const host =
    typeof req.headers.host === 'string' && /^[A-Za-z0-9.:[\]-]+$/.test(req.headers.host)
      ? req.headers.host
      : 'localhost'
  const url = `http://${host}${req.url ?? '/'}`
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v)
  }
  const method = req.method ?? 'GET'
  const init: RequestInit & { duplex?: 'half' } = { method, headers }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>
    init.duplex = 'half'
  }
  return new Request(url, init)
}

/** Write a Web `Response` to a Node response, streaming the body and stopping if the client leaves. */
export async function sendWebResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) headers['set-cookie'] = cookies
  res.writeHead(response.status, headers)
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  const stop = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  res.once('close', stop)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(value)) await new Promise<void>((resolve) => res.once('drain', resolve))
    }
    res.end()
  } catch {
    res.destroy()
  } finally {
    res.off('close', stop)
  }
}

/** Serve a Web handler (such as the log viewer) from a `node:http` server or Express. */
export function toNodeHandler(
  handler: InfoWebHandler,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const ip = req.socket.remoteAddress
      const response = await handler(toWebRequest(req), ip === undefined ? {} : { ip })
      await sendWebResponse(response, res)
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Internal Server Error')
    }
  }
}
