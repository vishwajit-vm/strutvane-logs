/**
 * Viewer hardening (VAPT regression tests for whole classes): local mode answers loopback hosts
 * only, streaming routes refuse HEAD, every way a live tail can end frees its slot, scoped viewers
 * don't see the file list, and files are read backwards in bounded chunks.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { addressedToLoopback, decideAccess, isLoopbackHost } from '../src/viewer/access.ts'
import {
  createViewerHandler,
  type ViewerAuditEvent,
  type ViewerOptions,
} from '../src/viewer/handler.ts'
import { decodeCursor, readLinesBackward, readPage } from '../src/viewer/store.ts'
import { createTailStream } from '../src/viewer/tail.ts'
import { sleep, tempDir } from './helpers.ts'

const TOKEN = 'correct-horse-battery-staple'
const NOW = Date.parse('2026-11-14T12:00:00.000Z')
const BASE = 'http://localhost:3000/_strutvane/logs'
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function line(rec: Record<string, unknown>): string {
  return `${JSON.stringify({ time: '2026-11-14T10:00:00.000Z', level: 'info', msg: 'm', ...rec })}\n`
}

function dir(): string {
  const t = tempDir()
  cleanups.push(t.cleanup)
  return t.dir
}

function fixture(): string {
  const d = dir()
  writeFileSync(
    join(d, '2026-11-13.ndjson'),
    line({ time: '2026-11-13T09:00:00.000Z', tenantId: 'acme' }),
  )
  writeFileSync(join(d, '2026-11-14.ndjson'), line({ tenantId: 'acme' }) + line({ tenantId: 'x' }))
  return d
}

function viewer(d: string, options: ViewerOptions = {}) {
  return createViewerHandler({ dir: d, env: { APP_ENV: 'local' }, now: () => NOW, ...options })
}

describe('local mode only answers loopback hosts', () => {
  test('isLoopbackHost accepts exactly localhost, 127.0.0.1 and [::1], with an optional port', () => {
    for (const ok of ['localhost', 'LOCALHOST:3000', '127.0.0.1', '127.0.0.1:8080', '[::1]'])
      expect(isLoopbackHost(ok), ok).toBe(true)
    expect(isLoopbackHost('[::1]:65535')).toBe(true)
    for (const bad of [
      undefined,
      null,
      '',
      'evil.test',
      'localhost.evil.test',
      'evil.localhost',
      'localhost.',
      '127.0.0.1.nip.io',
      '127.0.0.2',
      '0.0.0.0',
      '::1',
      '[::1',
      'localhost:0',
      'localhost:70000',
      'localhost:3000@evil.test',
    ])
      expect(isLoopbackHost(bad), String(bad)).toBe(false)
  })

  test('a foreign Host header or URL host gets a 404 on every route (DNS rebinding)', async () => {
    const v = viewer(fixture())
    for (const path of ['', '/api/files', '/api/records', '/api/session', '/api/tail']) {
      const viaHeader = new Request(`${BASE}${path}`, { headers: { host: 'evil.test:3000' } })
      expect((await v.fetch(viaHeader)).status, path).toBe(404)
      const viaUrl = new Request(`http://evil.test:3000/_strutvane/logs${path}`)
      expect((await v.fetch(viaUrl)).status, path).toBe(404)
    }
  })

  test('loopback hosts in the URL and the Host header are allowed', async () => {
    const v = viewer(fixture())
    for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000']) {
      const res = await v.fetch(
        new Request(`http://${host}/_strutvane/logs/api/files`, { headers: { host } }),
      )
      expect(res.status, host).toBe(200)
    }
    expect(addressedToLoopback(new Request('http://localhost/_strutvane/logs'))).toBe(true)
  })

  test('token mode does not depend on the host', async () => {
    const v = createViewerHandler({ dir: fixture(), env: { LOGS_VIEWER_TOKEN: TOKEN } })
    const res = await v.fetch(
      new Request('https://logs.example.test/_strutvane/logs/api/files', {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    )
    expect(res.status).toBe(200)
    const decision = await decideAccess(
      {
        authorize: undefined,
        token: undefined,
        local: true,
        allowList: undefined,
        cookiePath: '/_strutvane/logs',
        now: () => NOW,
      },
      new Request('http://evil.test/_strutvane/logs'),
      undefined,
      true,
    )
    expect(decision.kind).toBe('hidden')
  })
})

describe('streaming routes refuse HEAD', () => {
  test('HEAD on /api/tail and /api/download is 405, takes no tail slot and writes no audit', async () => {
    const audits: ViewerAuditEvent[] = []
    const v = viewer(fixture(), { maxTails: 1, onAudit: (e) => audits.push(e) })
    for (const path of ['/api/tail', '/api/download?day=2026-11-14']) {
      const res = await v.fetch(new Request(`${BASE}${path}`, { method: 'HEAD' }))
      expect(res.status, path).toBe(405)
      expect(res.headers.get('allow'), path).toBe('GET')
    }
    expect(audits).toEqual([])
    const tail = await v.fetch(new Request(`${BASE}/api/tail`))
    expect(tail.status).toBe(200)
    await tail.body?.cancel()
    expect((await v.fetch(new Request(`${BASE}/api/files`, { method: 'HEAD' }))).status).toBe(200)
  })
})

describe('tail slots are released on every disconnect path', () => {
  test('cancelling the body (no abort signal) frees the slot', async () => {
    const v = viewer(fixture(), { maxTails: 1, tailPollMs: 20 })
    const first = await v.fetch(new Request(`${BASE}/api/tail`))
    expect((await v.fetch(new Request(`${BASE}/api/tail`))).status).toBe(429)
    await first.body?.cancel()
    const again = await v.fetch(new Request(`${BASE}/api/tail`))
    expect(again.status).toBe(200)
    await again.body?.cancel()
  })

  test('a body nobody reads (dropped without cancel or abort) frees the slot', async () => {
    const v = viewer(fixture(), { maxTails: 1, tailPollMs: 10, heartbeatMs: 10 })
    const abandoned = await v.fetch(new Request(`${BASE}/api/tail`))
    expect(abandoned.status).toBe(200)
    await vi.waitFor(
      async () => {
        const next = await v.fetch(new Request(`${BASE}/api/tail`))
        expect(next.status).toBe(200)
        await next.body?.cancel()
      },
      { timeout: 5_000, interval: 20 },
    )
  })

  test('a stalled consumer ends the stream exactly once', async () => {
    let closed = 0
    createTailStream({
      dir: dir(),
      query: {},
      heartbeatMs: 10,
      stallBeats: 2,
      now: () => NOW,
      onClose: () => closed++,
    })
    await vi.waitFor(() => expect(closed).toBe(1), { timeout: 5_000, interval: 10 })
    await sleep(40)
    expect(closed).toBe(1)
  })

  test('a consumer that keeps reading is not treated as stalled', async () => {
    let closed = 0
    const stream = createTailStream({
      dir: dir(),
      query: {},
      heartbeatMs: 10,
      stallBeats: 1,
      now: () => NOW,
      onClose: () => closed++,
    })
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let pings = 0
    while (pings < 5) {
      const r = await reader.read()
      if (r.done) break
      if (decoder.decode(r.value).includes(': ping')) pings++
    }
    expect(pings).toBe(5)
    expect(closed).toBe(0)
    await reader.cancel()
    expect(closed).toBe(1)
  })

  test('too many bytes waiting ends the stream', async () => {
    let closed = 0
    const stream = createTailStream({
      dir: dir(),
      query: {},
      maxQueuedBytes: 4,
      now: () => NOW,
      onClose: () => closed++,
    })
    await vi.waitFor(() => expect(closed).toBe(1), { timeout: 5_000, interval: 10 })
    const reader = stream.getReader()
    let r = await reader.read()
    while (!r.done) r = await reader.read()
    expect(r.done).toBe(true)
  })

  test('the stream ends after maxDurationMs even while being read', async () => {
    let closed = 0
    const stream = createTailStream({
      dir: dir(),
      query: {},
      maxDurationMs: 30,
      now: () => NOW,
      onClose: () => closed++,
    })
    const reader = stream.getReader()
    let r = await reader.read()
    while (!r.done) r = await reader.read()
    expect(closed).toBe(1)
  })
})

describe('scoped viewers and the file list', () => {
  test('a scoped viewer sees only which days exist, not file names or sizes', async () => {
    const v = viewer(fixture(), { scopeRecords: () => (r) => r.tenantId === 'acme' })
    const res = (await (await v.fetch(new Request(`${BASE}/api/files`))).json()) as {
      files: Array<Record<string, unknown>>
      scoped?: boolean
    }
    expect(res.scoped).toBe(true)
    expect(res.files).toEqual([{ day: '2026-11-14' }, { day: '2026-11-13' }])
  })

  test('an unscoped viewer gets the full list', async () => {
    const v = viewer(fixture())
    const res = (await (await v.fetch(new Request(`${BASE}/api/files`))).json()) as {
      files: Array<{ name: string; size: number }>
      scoped?: boolean
    }
    expect(res.scoped).toBeUndefined()
    expect(res.files.map((f) => f.name)).toEqual(['2026-11-14.ndjson', '2026-11-13.ndjson'])
    expect(res.files.every((f) => f.size > 0)).toBe(true)
  })
})

describe('files are read backwards in bounded chunks', () => {
  async function collect(path: string, end?: number, chunk?: number) {
    const out: Array<{ text: string; start: number }> = []
    for await (const l of readLinesBackward(path, end, chunk)) out.push(l)
    return out
  }

  test('every complete line, newest first, with byte offsets, whatever the chunk size', async () => {
    const file = join(dir(), '2026-11-14.ndjson')
    const lines = ['{"n":1}', '{"msg":"ünïcödé ✓"}', '', '{"n":3}']
    const content = `${lines.join('\n')}\n`
    writeFileSync(file, `${content}{"partial`)
    for (const chunk of [1, 2, 3, 7, 64, 65_536]) {
      const got = await collect(file, undefined, chunk)
      expect(
        got.map((l) => l.text),
        String(chunk),
      ).toEqual([...lines].reverse())
      for (const l of got)
        expect(Buffer.from(content).subarray(l.start).toString('utf8').startsWith(l.text)).toBe(
          true,
        )
    }
    const last = (await collect(file)).find((l) => l.text === '{"n":3}')
    expect((await collect(file, last?.start, 5)).map((l) => l.text)).toEqual([
      '',
      lines[1],
      '{"n":1}',
    ])
    // A forged cursor in the middle of the first line yields nothing torn.
    expect(await collect(file, 3, 2)).toEqual([])
    expect(await collect(file, 0)).toEqual([])
    expect(await collect(join(dir(), 'missing.ndjson'))).toEqual([])
  })

  test('a line too long to be a record is skipped without being buffered', async () => {
    const file = join(dir(), '2026-11-14.ndjson')
    writeFileSync(file, `{"n":1}\n${'x'.repeat(1_100_000)}\n{"n":2}\n`)
    expect((await collect(file)).map((l) => l.text)).toEqual(['{"n":2}', '{"n":1}'])
    writeFileSync(file, `${'y'.repeat(1_100_000)}\n{"n":2}\n`)
    expect((await collect(file)).map((l) => l.text)).toEqual(['{"n":2}'])
  })

  test('paging through a file larger than one chunk visits every record once', async () => {
    const d = dir()
    const total = 3_000
    writeFileSync(
      join(d, '2026-11-14.ndjson'),
      Array.from({ length: total }, (_, n) => line({ msg: `m${n}`, pad: 'p'.repeat(40) })).join(''),
    )
    const seen = new Set<unknown>()
    let cursor: ReturnType<typeof decodeCursor>
    for (let i = 0; i < 100; i++) {
      const page = await readPage({ dir: d, query: {}, limit: 97, cursor, maxScanLines: 500 })
      for (const r of page.records) seen.add(r.msg)
      if (!page.nextCursor) break
      cursor = decodeCursor(page.nextCursor)
    }
    expect(seen.size).toBe(total)
  })
})
