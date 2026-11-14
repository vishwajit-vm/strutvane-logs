/**
 * Request lines never carry secrets from the path, and the Strutvane provider passes the viewer's
 * access rules and the socket client address through (VAPT regression tests).
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HttpRequestHookPayload } from '@strutvane/contracts'
import { createApp, HooksToken } from '@strutvane/core'
import { Hono } from 'hono'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as honoAdapter from '../src/adapters/hono.ts'
import {
  createRequestLogger,
  loggedPath,
  MAX_LOGGED_PATH_LENGTH,
  safePath,
} from '../src/http/index.ts'
import { createPipelineLogger } from '../src/logger.ts'
import { createLogsProvider, type LogsProviderOptions } from '../src/provider.ts'
import { memoryTransport } from './helpers.ts'

const RESET_TOKEN = '9f8e7d6c5b4a39281706f5e4d3c2b1a0'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl'

describe('safePath', () => {
  test('token-like segments, JWTs and prefixed keys in a path are hidden', () => {
    expect(safePath(`/password/reset/${RESET_TOKEN}`)).toBe('/password/reset/[REDACTED]')
    expect(safePath(`/verify/${JWT}`)).not.toContain('c2lnbmF0dXJl')
    expect(safePath(`/keys/${'sk_live_'}51HxAbCdEfGh12345678/revoke`)).not.toContain('51HxAbCd')
    expect(safePath('/invite/aB3dE5gH7jK9mN1pQ3sT5vW7')).toBe('/invite/[REDACTED]')
  })

  test('ordinary paths are kept', () => {
    for (const path of [
      '/',
      '/invoices/42',
      '/users/ann-smith/settings',
      '/files/2026-11-14-quarterly-report-final.pdf',
      '/orders/550e8400',
      '/orders/550e8400-e29b-41d4-a716-446655440000',
      '/docs/getting_started_with_the_platform',
      '/n/12345678901234567890123',
    ])
      expect(safePath(path)).toBe(path)
  })

  test('long paths are capped', () => {
    const out = safePath(`/${'a/'.repeat(500)}`)
    expect(out.length).toBe(MAX_LOGGED_PATH_LENGTH + 1)
    expect(out.endsWith('…')).toBe(true)
    expect(loggedPath(`http://h/reset/${RESET_TOKEN}?token=x`)).toBe('/reset/[REDACTED]')
  })

  test('the Web handler and the Hono fallback log the safe path', async () => {
    const t = memoryTransport()
    const logger = createPipelineLogger({ transport: t })
    await createRequestLogger({ logger }).handle(
      new Request(`http://x/reset/${RESET_TOKEN}`),
      () => new Response('ok'),
    )
    const app = new Hono()
    app.use(honoAdapter.requestLogging({ logger }))
    app.get('/known/:token', (c) => c.text('ok'))
    await app.fetch(new Request(`http://x/known/${RESET_TOKEN}`))
    await app.fetch(new Request(`http://x/unknown/${RESET_TOKEN}`))
    await logger.flush()
    const text = JSON.stringify(t.records())
    expect(text).not.toContain(RESET_TOKEN)
    expect(text).toContain('/known/:token')
    expect(text).toContain('/unknown/[REDACTED]')
  })
})

describe('provider: viewer access pass-through', () => {
  const dirs: string[] = []
  afterEach(async () => {
    vi.unstubAllEnvs()
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
  })

  async function boot(
    env: string,
    viewer: Record<string, unknown> = {},
    options: LogsProviderOptions = {},
  ) {
    vi.stubEnv('APP_ENV', env)
    const root = await mkdtemp(join(tmpdir(), 'sv-logs-'))
    dirs.push(root)
    const app = createApp({
      config: {
        app: { root },
        logging: { driver: 'file', path: 'storage/logs', viewer: { enabled: true, ...viewer } },
      },
      providers: [createLogsProvider(options)],
    })
    await app.boot()
    const hooks = app.make(HooksToken)
    const request = async (url: string, clientAddress?: string, host?: string, route?: string) => {
      const req = new Request(url, host ? { headers: { host } } : {})
      const payload: HttpRequestHookPayload = {
        request: req,
        actor: null,
        tenant: undefined,
        ...(clientAddress === undefined ? {} : { clientAddress }),
      }
      const out = (await hooks.run('http.onRequest', payload)) as HttpRequestHookPayload
      await hooks.run('http.onResponse', {
        request: req,
        status: out.response?.status ?? 200,
        requestId: 'r-1',
        ...(route === undefined ? {} : { route }),
      })
      return out.response?.status
    }
    return { app, root, request }
  }

  test('ipAllowList is checked against the hook clientAddress, and fails closed without it', async () => {
    const { app, request } = await boot('production', {
      ipAllowList: ['10.0.0.0/8'],
      authorize: () => true,
    })
    const url = 'https://app.example.test/_strutvane/logs/api/files'
    expect(await request(url, '10.1.2.3')).toBe(200)
    expect(await request(url, '192.168.1.5')).toBe(404)
    expect(await request(url)).toBe(404)
    await app.shutdown()
  })

  test('authorize and scopeRecords from config are used; provider options win', async () => {
    const scoped = await boot('production', {
      authorize: () => true,
      scopeRecords: () => () => true,
    })
    const res = await scoped.request('https://app.example.test/_strutvane/logs/api/files')
    expect(res).toBe(200)
    await scoped.app.shutdown()

    const overridden = await boot(
      'production',
      { authorize: () => true },
      { viewer: { authorize: () => false } },
    )
    expect(await overridden.request('https://app.example.test/_strutvane/logs/api/files')).toBe(404)
    await overridden.app.shutdown()
  })

  test('local mode through the provider refuses foreign hosts', async () => {
    const { app, request } = await boot('local')
    expect(await request('http://localhost:3000/_strutvane/logs')).toBe(200)
    expect(await request('http://localhost:3000/_strutvane/logs', '127.0.0.1', 'evil.test')).toBe(
      404,
    )
    expect(await request('http://evil.test/_strutvane/logs')).toBe(404)
    await app.shutdown()
  })

  test('local mode through the provider checks the peer clientAddress when present', async () => {
    const { app, request } = await boot('local')
    const url = 'http://localhost:3000/_strutvane/logs/api/files'
    expect(await request(url, '127.0.0.1')).toBe(200)
    expect(await request(url, '::1')).toBe(200)
    expect(await request(url, '::ffff:127.0.0.1')).toBe(200)
    expect(await request(url, '192.168.1.20')).toBe(404)
    expect(await request(url)).toBe(200) // unknown peer: host-only check
    await app.shutdown()
  })

  test('request lines from the provider use the route template when the payload has one', async () => {
    const { app, root, request } = await boot('local')
    await request(
      `http://localhost/password/reset/${RESET_TOKEN}`,
      undefined,
      undefined,
      '/password/reset/:token',
    )
    await request('http://localhost/api/v1/invoices/42', undefined, undefined, '')
    await app.shutdown()
    const d = join(root, 'storage/logs')
    const text = await readFile(join(d, (await readdir(d))[0] ?? ''), 'utf8')
    const msgs = text
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { msg: string }).msg)
    expect(msgs).toEqual(['GET /password/reset/:token 200', 'GET /api/v1/invoices/42 200'])
    expect(text).not.toContain(RESET_TOKEN)
  })

  test('request lines from the provider carry the safe path', async () => {
    const { app, root, request } = await boot('local')
    await request(`http://localhost/password/reset/${RESET_TOKEN}?token=abc`)
    await app.shutdown()
    const d = join(root, 'storage/logs')
    const text = await readFile(join(d, (await readdir(d))[0] ?? ''), 'utf8')
    expect(text).not.toContain(RESET_TOKEN)
    expect(text).toContain('/password/reset/[REDACTED]')
  })
})
