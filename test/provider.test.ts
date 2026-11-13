// The Strutvane provider: LoggerToken binding, request logging and the viewer through core hooks
// (no framework import: the hooks are driven the way framework's createHttpApp drives them).
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, HooksToken, LoggerToken } from '@strutvane/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import provider, { createLogsProvider } from '../src/provider.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0))
    await rm(d, { recursive: true, force: true }).catch(() => undefined)
})

async function boot(env: string, logging: Record<string, unknown> = {}) {
  vi.stubEnv('APP_ENV', env)
  const root = await mkdtemp(join(tmpdir(), 'sv-logs-'))
  dirs.push(root)
  const app = createApp({
    config: {
      app: { root },
      logging: {
        driver: 'file',
        path: 'storage/logs',
        maxDailySize: '5MB',
        retentionDays: 7,
        level: 'info',
        format: 'json',
        enabled: true,
        requests: { ignore: ['/health'], slowThresholdMs: 1000 },
        viewer: { enabled: true, path: '/_strutvane/logs' },
        ...logging,
      },
    },
    providers: [createLogsProvider()],
  })
  await app.boot()
  const hooks = app.make(HooksToken)
  const request = async (path: string) => {
    const req = new Request(`http://localhost${path}`)
    const out = (await hooks.run('http.onRequest', {
      request: req,
      actor: null,
      tenant: undefined,
    })) as {
      response?: Response
    }
    const status = out.response?.status ?? 200
    await hooks.run('http.onResponse', { request: req, status, requestId: 'r-1' })
    return out.response
  }
  return { app, root, request }
}

describe('@strutvane/logs/provider', () => {
  test('exports a ready provider and binds LoggerToken', async () => {
    expect(provider.name).toBe('@strutvane/logs')
    const { app } = await boot('local')
    expect(typeof app.make(LoggerToken).info).toBe('function')
    await app.shutdown()
  })

  test('writes one request line per request (ignored paths skipped) under the project root', async () => {
    const { app, root, request } = await boot('local')
    await request('/api/v1/invoices')
    await request('/health')
    await app.shutdown()
    const dir = join(root, 'storage/logs')
    const files = await readdir(dir)
    const text = await readFile(join(dir, files[0] ?? ''), 'utf8')
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.map((l) => l['msg'])).toEqual(['GET /api/v1/invoices 200'])
    expect(lines[0]?.['fields']).toMatchObject({ requestId: 'r-1', status: 200 })
  })

  test('the viewer answers locally and is a 404 in production without a token', async () => {
    const local = await boot('local')
    expect((await local.request('/_strutvane/logs'))?.status).toBe(200)
    await local.app.shutdown()
    const prod = await boot('production')
    expect((await prod.request('/_strutvane/logs'))?.status).toBe(404)
    expect(await prod.request('/api/v1/x')).toBeUndefined()
    await prod.app.shutdown()
  })

  test('viewer can be turned off; logging can be disabled', async () => {
    const off = await boot('local', { viewer: { enabled: false } })
    expect(await off.request('/_strutvane/logs')).toBeUndefined()
    await off.app.shutdown()
    const disabled = await boot('local', {
      enabled: false,
      path: undefined,
      maxDailySize: undefined,
    })
    expect(disabled.app.make(LoggerToken).isLevelEnabled('info')).toBe(false)
    await disabled.app.shutdown()
  })

  test('works with no logging config at all (env defaults)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sv-logs-'))
    dirs.push(root)
    vi.stubEnv('LOGS_DRIVER', 'stdout')
    vi.stubEnv('LOGS_VIEWER', 'false')
    const app = createApp({ config: {}, providers: [createLogsProvider()] })
    await app.boot()
    expect(typeof app.make(LoggerToken).warn).toBe('function')
    await app.shutdown()
  })
})
