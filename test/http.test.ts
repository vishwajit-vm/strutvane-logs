/** Request logging: the core, the Web handler, and the Node, Hono and Express adapters. */
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { Hono } from 'hono'
import { afterEach, describe, expect, test } from 'vitest'
import * as expressAdapter from '../src/adapters/express.ts'
import * as honoAdapter from '../src/adapters/hono.ts'
import {
  sendWebResponse,
  toNodeHandler,
  toWebRequest,
  withRequestLogging,
} from '../src/adapters/node.ts'
import { getLogContext } from '../src/context.ts'
import { setDefaultLogger } from '../src/default.ts'
import {
  createRequestLogger,
  levelFor,
  logCompletedRequest,
  pathOf,
  requestIdFrom,
  resolveRequestLogging,
  sizeFrom,
} from '../src/http/index.ts'
import { createPipelineLogger, type StrutvaneLogger } from '../src/logger.ts'
import { memoryTransport, type Rec, waitFor } from './helpers.ts'

function capture(): { logger: StrutvaneLogger; records: () => Promise<Rec[]> } {
  const t = memoryTransport()
  const logger = createPipelineLogger({ transport: t, level: 'trace' })
  return {
    logger,
    records: async () => {
      await logger.flush()
      return t.records()
    },
  }
}

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  setDefaultLogger(undefined)
})

async function listen(listener: RequestListener): Promise<string> {
  const server = createServer(listener)
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('core helpers', () => {
  test('request ids: safe incoming ids are kept, anything else is replaced', () => {
    expect(requestIdFrom('abc-123_x.y:z')).toBe('abc-123_x.y:z')
    for (const bad of [
      '',
      null,
      undefined,
      'a b',
      'x'.repeat(129),
      'evil\n{"level":"fatal"}',
      '<script>',
    ]) {
      expect(requestIdFrom(bad)).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  test('paths never include query strings or fragments', () => {
    expect(pathOf('/invoices?token=secret')).toBe('/invoices')
    expect(pathOf('/a#frag')).toBe('/a')
    expect(pathOf('http://h/x/y?q=1')).toBe('/x/y')
    expect(pathOf('::bad::')).toBe('/')
  })

  test('levels by outcome', () => {
    const base = { method: 'GET', route: '/', status: 200, durationMs: 5 }
    expect(levelFor(base, 1000)).toBe('info')
    expect(levelFor({ ...base, durationMs: 1500 }, 1000)).toBe('warn')
    expect(levelFor({ ...base, aborted: true }, 1000)).toBe('warn')
    expect(levelFor({ ...base, status: 503 }, 1000)).toBe('error')
    expect(levelFor({ ...base, error: new Error('x') }, 1000)).toBe('error')
  })

  test('sizes and option validation', () => {
    expect(sizeFrom('42')).toBe(42)
    expect(sizeFrom(7)).toBe(7)
    expect(sizeFrom(['5'])).toBe(5)
    expect(sizeFrom('-1')).toBeUndefined()
    expect(sizeFrom(null)).toBeUndefined()
    expect(() => resolveRequestLogging({ slowThresholdMs: 0 })).toThrow(RangeError)
    expect(() => resolveRequestLogging({ requestIdHeader: 'bad header' })).toThrow(TypeError)
    expect(resolveRequestLogging({ requestIdHeader: 'X-Correlation-Id' }).requestIdHeader).toBe(
      'x-correlation-id',
    )
  })

  test('the record is compact; ignored paths and logger failures are silent', async () => {
    const c = capture()
    const resolved = resolveRequestLogging({ logger: c.logger })
    logCompletedRequest(resolved, {
      method: 'GET',
      route: '/invoices',
      status: 200,
      durationMs: 12.345,
      size: 10,
    })
    logCompletedRequest(resolved, { method: 'GET', route: '/health', status: 200, durationMs: 1 })
    expect(await c.records()).toEqual([
      expect.objectContaining({
        level: 'info',
        msg: 'GET /invoices 200',
        fields: { method: 'GET', route: '/invoices', status: 200, durationMs: 12.3, size: 10 },
      }),
    ])
    const broken = resolveRequestLogging({
      logger: new Proxy(c.logger, {
        get() {
          throw new Error('logger broke')
        },
      }),
    })
    expect(() =>
      logCompletedRequest(broken, { method: 'GET', route: '/', status: 200, durationMs: 1 }),
    ).not.toThrow()
  })
})

describe('Web handler (createRequestLogger)', () => {
  test('logs, runs downstream in a log context, echoes the request id', async () => {
    const c = capture()
    const requests = createRequestLogger({ logger: c.logger })
    let seen: unknown
    const res = await requests.handle(
      new Request('http://x/invoices?secret=1', { headers: { 'x-request-id': 'req-1' } }),
      () => {
        seen = getLogContext()?.requestId
        return new Response('ok', { headers: { 'content-length': '2' } })
      },
    )
    expect(seen).toBe('req-1')
    expect(res.headers.get('x-request-id')).toBe('req-1')
    const [rec] = await c.records()
    expect(rec).toMatchObject({ msg: 'GET /invoices 200', requestId: 'req-1', fields: { size: 2 } })
    expect(JSON.stringify(rec)).not.toContain('secret')
  })

  test('immutable response headers get a copy; thrown errors are logged and rethrown', async () => {
    const c = capture()
    const requests = createRequestLogger({ logger: c.logger })
    const res = await requests.handle(new Request('http://x/r'), () =>
      Response.redirect('http://x/elsewhere', 302),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    await expect(
      requests.handle(new Request('http://x/boom', { method: 'POST' }), () => {
        throw new Error('handler failed')
      }),
    ).rejects.toThrow('handler failed')
    const records = await c.records()
    expect(records[1]).toMatchObject({
      level: 'error',
      msg: 'POST /boom 500',
      err: { message: 'handler failed' },
    })
  })

  test('uses the default logger when none is given', async () => {
    const t = memoryTransport()
    setDefaultLogger(createPipelineLogger({ transport: t }))
    await createRequestLogger().handle(new Request('http://x/d'), () => new Response('ok'))
    await createPipelineLogger({ transport: t }).flush()
    await waitFor(() => t.records().length === 1)
  })
})

describe('node:http adapter', () => {
  test('logs finished requests with context and the request id header', async () => {
    const c = capture()
    let seen: unknown
    const url = await listen(
      withRequestLogging(
        (_req, res) => {
          seen = getLogContext()?.requestId
          res.setHeader('content-length', '2')
          res.end('ok')
        },
        { logger: c.logger },
      ),
    )
    const res = await fetch(`${url}/orders?x=1`, { headers: { 'x-request-id': 'abc' } })
    expect(await res.text()).toBe('ok')
    expect(res.headers.get('x-request-id')).toBe('abc')
    expect(seen).toBe('abc')
    await waitFor(async () => (await c.records()).length === 1)
    expect((await c.records())[0]).toMatchObject({ msg: 'GET /orders 200', fields: { size: 2 } })
  })

  test('a client that disconnects early is logged once as aborted (499)', async () => {
    const c = capture()
    const url = await listen(
      withRequestLogging(
        (_req, res) => {
          res.write('partial')
        },
        { logger: c.logger },
      ),
    )
    const controller = new AbortController()
    const res = await fetch(`${url}/slow`, { signal: controller.signal })
    controller.abort()
    await res.body?.cancel().catch(() => undefined)
    await waitFor(async () => (await c.records()).length === 1)
    expect((await c.records())[0]).toMatchObject({
      level: 'warn',
      fields: { status: 499, aborted: true },
    })
  })

  test('toNodeHandler bridges Web handlers: body, headers, cookies, client IP, streaming', async () => {
    let ip: string | undefined
    let body = ''
    const url = await listen(
      toNodeHandler(async (request, info) => {
        ip = info.ip
        body = await request.text()
        const headers = new Headers({ 'x-a': '1' })
        headers.append('set-cookie', 'a=1')
        headers.append('set-cookie', 'b=2')
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('hel'))
            controller.enqueue(new TextEncoder().encode('lo'))
            controller.close()
          },
        })
        return new Response(stream, { status: 201, headers })
      }),
    )
    const res = await fetch(`${url}/x`, {
      method: 'POST',
      body: 'payload',
      headers: { 'x-multi': 'v' },
    })
    expect(res.status).toBe(201)
    expect(await res.text()).toBe('hello')
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
    expect(body).toBe('payload')
    expect(ip).toMatch(/127\.0\.0\.1/)
  })

  test('toNodeHandler turns a throwing handler into a 500; empty bodies work', async () => {
    const url = await listen(
      toNodeHandler(async (request) => {
        if (new URL(request.url).pathname === '/empty') return new Response(null, { status: 204 })
        throw new Error('boom')
      }),
    )
    expect((await fetch(`${url}/boom`)).status).toBe(500)
    expect((await fetch(`${url}/empty`)).status).toBe(204)
  })

  test('toWebRequest ignores a hostile Host header; sendWebResponse survives a failing body', async () => {
    const req = toWebRequest({
      headers: { host: 'evil.com/<script>', cookie: ['a=1', 'b=2'], skip: undefined },
      url: '/p?q=1',
      method: undefined,
    } as never)
    expect(req.url).toBe('http://localhost/p?q=1')
    const url = await listen((_req, res) => {
      const failing = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('stream broke'))
        },
      })
      void sendWebResponse(new Response(failing), res)
    })
    await expect(fetch(url).then((r) => r.text())).rejects.toThrow()
  })
})

describe('Hono adapter', () => {
  test('logs the route template, sets the id header, runs handlers in context', async () => {
    const c = capture()
    const app = new Hono()
    app.use(honoAdapter.requestLogging({ logger: c.logger }))
    let seen: unknown
    app.get('/invoices/:id', (ctx) => {
      seen = getLogContext()?.requestId
      return ctx.text('ok')
    })
    const res = await app.request('/invoices/42?token=x', { headers: { 'x-request-id': 'h1' } })
    expect(res.headers.get('x-request-id')).toBe('h1')
    expect(seen).toBe('h1')
    expect((await c.records())[0]).toMatchObject({
      msg: 'GET /invoices/:id 200',
      fields: { route: '/invoices/:id', status: 200 },
    })
  })

  test('errors handled by Hono are logged at error with the error', async () => {
    const c = capture()
    const app = new Hono()
    app.use(honoAdapter.requestLogging({ logger: c.logger }))
    app.get('/boom', () => {
      throw new Error('kaput')
    })
    const res = await app.request('/boom')
    expect(res.status).toBe(500)
    expect((await c.records())[0]).toMatchObject({ level: 'error', err: { message: 'kaput' } })
  })

  test('unmatched routes log the plain path; errors thrown past Hono are rethrown', async () => {
    const c = capture()
    const app = new Hono()
    app.use(honoAdapter.requestLogging({ logger: c.logger }))
    await app.request('/nothing-here')
    expect((await c.records())[0]).toMatchObject({ msg: 'GET /nothing-here 404' })

    const mw = honoAdapter.requestLogging({ logger: c.logger })
    const fakeCtx = {
      req: { header: () => undefined, method: 'GET', routePath: '/x', path: '/x' },
      res: new Response('x'),
      error: undefined,
    }
    await expect(
      mw(fakeCtx as never, () => {
        throw new Error('outside')
      }),
    ).rejects.toThrow('outside')
    expect((await c.records())[1]).toMatchObject({ level: 'error', fields: { status: 500 } })
  })

  test('logs() combines request logging and the viewer; either can be disabled', async () => {
    const c = capture()
    const app = new Hono()
    app.use(
      honoAdapter.logs({
        requests: { logger: c.logger },
        viewer: { env: { APP_ENV: 'local' }, dir: '.' },
        clientIp: () => '127.0.0.1',
      }),
    )
    app.get('/x', (ctx) => ctx.text('x'))
    expect((await app.request('/_strutvane/logs')).status).toBe(200)
    expect((await app.request('/x')).status).toBe(200)
    expect((await c.records()).map((r) => r.msg)).toEqual(['GET /x 200']) // viewer calls aren't logged

    const bare = new Hono()
    bare.use(honoAdapter.logs({ requests: false, viewer: false }))
    bare.get('/y', (ctx) => ctx.text('y'))
    expect((await bare.request('/y')).status).toBe(200)
    expect((await bare.request('/_strutvane/logs')).status).toBe(404)

    const defaults = new Hono()
    defaults.use(honoAdapter.logs({ requests: { logger: c.logger } }))
    expect((await defaults.request('/_strutvane/logs')).status).toBe(404) // closed by default
  })
})

describe('Express adapter', () => {
  test('logs the route template including the router base path', async () => {
    const c = capture()
    const app = express()
    app.use(expressAdapter.requestLogging({ logger: c.logger }))
    const router = express.Router()
    let seen: unknown
    router.get('/items/:id', (_req, res) => {
      seen = getLogContext()?.requestId
      res.send('ok')
    })
    app.use('/api', router)
    const url = await listen(app)
    const res = await fetch(`${url}/api/items/9?secret=1`, { headers: { 'x-request-id': 'e1' } })
    expect(res.headers.get('x-request-id')).toBe('e1')
    expect(seen).toBe('e1')
    await waitFor(async () => (await c.records()).length === 1)
    expect((await c.records())[0]).toMatchObject({
      msg: 'GET /api/items/:id 200',
      fields: { route: '/api/items/:id' },
    })
  })

  test('errorLogging logs the error with its stack and passes it on', async () => {
    const c = capture()
    const app = express()
    app.use(expressAdapter.requestLogging({ logger: c.logger }))
    app.get('/fail', () => {
      throw new Error('express failure')
    })
    app.use(expressAdapter.errorLogging({ logger: c.logger }))
    const url = await listen(app)
    expect((await fetch(`${url}/fail`)).status).toBe(500)
    await waitFor(async () => (await c.records()).length === 2)
    const records = await c.records()
    expect(records[0]).toMatchObject({
      level: 'error',
      msg: 'Unhandled error in GET /fail',
      err: { message: 'express failure' },
    })
    expect(records[1]).toMatchObject({ level: 'error', msg: 'GET /fail 500' })
  })

  test('errorLogging never hides the original error, even if logging throws', () => {
    const handler = expressAdapter.errorLogging({
      logger: new Proxy(capture().logger, {
        get() {
          throw new Error('broken')
        },
      }),
    })
    let passed: unknown
    handler(
      new Error('orig'),
      { method: 'GET', url: '/', originalUrl: '/', baseUrl: '' } as never,
      {} as never,
      (e?: unknown) => {
        passed = e
      },
    )
    expect((passed as Error).message).toBe('orig')
  })

  test('logs() serves the viewer and logs other requests; parts can be disabled', async () => {
    const c = capture()
    const app = express()
    app.use(
      expressAdapter.logs({
        requests: { logger: c.logger },
        viewer: { env: { APP_ENV: 'local' }, dir: '.' },
      }),
    )
    app.get('/x', (_req, res) => {
      res.send('x')
    })
    const url = await listen(app)
    const page = await fetch(`${url}/_strutvane/logs`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("script-src 'nonce-")
    expect((await fetch(`${url}/x`)).status).toBe(200)
    await waitFor(async () => (await c.records()).length === 1)

    const bare = express()
    bare.use(expressAdapter.logs({ requests: false, viewer: false }))
    bare.get('/y', (_req, res) => {
      res.send('y')
    })
    const bareUrl = await listen(bare)
    expect((await fetch(`${bareUrl}/y`)).status).toBe(200)
    expect((await fetch(`${bareUrl}/_strutvane/logs`)).status).toBe(404)
  })
})
