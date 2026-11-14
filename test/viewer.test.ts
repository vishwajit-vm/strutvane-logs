/**
 * The log viewer (RFC-0004 §6): access control, CSRF, XSS, CSP, tenant scoping, traversal,
 * search, paging, download, live tail and clearing. These are attack-style tests (VAPT).
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  buildAllowList,
  decideAccess,
  ipAllowed,
  readCookie,
  SESSION_COOKIE,
  safeEqual,
  sessionValue,
  validateToken,
  verifySession,
} from '../src/viewer/access.ts'
import { csvCell, csvHeader, csvRow } from '../src/viewer/csv.ts'
import { matchesQuery, parseRecordQuery, QueryError } from '../src/viewer/filters.ts'
import {
  createViewerHandler,
  type ViewerAuditEvent,
  type ViewerOptions,
} from '../src/viewer/handler.ts'
import {
  cleanLine,
  decodeCursor,
  encodeCursor,
  readDayLines,
  readPage,
  readRange,
  viewerSanitizer,
} from '../src/viewer/store.ts'
import { createTailStream } from '../src/viewer/tail.ts'
import { escapeHtml, renderViewerPage } from '../src/viewer/ui.ts'
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

/** A log dir with two days of records. */
function fixture(): string {
  const t = tempDir()
  cleanups.push(t.cleanup)
  writeFileSync(
    join(t.dir, '2026-11-13.ndjson'),
    line({ time: '2026-11-13T09:00:00.000Z', msg: 'yesterday', tenantId: 'acme' }) +
      line({
        time: '2026-11-13T09:30:00.000Z',
        level: 'error',
        msg: 'old failure',
        tenantId: 'globex',
      }),
  )
  writeFileSync(
    join(t.dir, '2026-11-14.ndjson'),
    line({
      time: '2026-11-14T10:00:00.000Z',
      msg: 'GET /invoices 200',
      tenantId: 'acme',
      fields: { route: '/invoices', status: 200 },
    }) +
      line({
        time: '2026-11-14T10:01:00.000Z',
        level: 'error',
        msg: 'GET /pay 503',
        tenantId: 'globex',
        traceId: 'tr1',
        fields: { route: '/pay', status: 503 },
      }) +
      line({
        time: '2026-11-14T10:02:00.000Z',
        level: 'warn',
        msg: '<img src=x onerror=alert(1)>',
        requestId: 'r9',
        tenantId: 'acme',
      }) +
      // A line written by something else, with an unredacted secret: re-sanitised on the way out.
      line({
        time: '2026-11-14T10:03:00.000Z',
        msg: 'foreign',
        fields: { password: 'hunter2', note: 'Bearer abcdefghijklmnop' },
      }) +
      'not json\n' +
      '{"time":"2026-11-14T10:04:00.000Z","level":"info","msg":"partial',
  )
  writeFileSync(join(t.dir, 'secrets.env'), 'DB_PASSWORD=x')
  return t.dir
}

function viewer(dir: string, options: ViewerOptions = {}) {
  return createViewerHandler({ dir, env: { APP_ENV: 'local' }, now: () => NOW, ...options })
}

/** A viewer API response body, as the tests read it. */
interface ApiBody {
  records?: Array<{ msg?: unknown; tenantId?: unknown; [key: string]: unknown }>
  nextCursor?: string
  csrfToken?: string
  deleted?: string[]
  files?: Array<{ name: string; day: string; size: number }>
}

async function body(res: Response): Promise<ApiBody> {
  return (await res.json()) as ApiBody
}

describe('access control', () => {
  test('production default: the viewer does not exist (404 everywhere)', async () => {
    const v = createViewerHandler({ dir: fixture(), env: {} })
    for (const path of ['', '/', '/api/files', '/api/records', '/api/clear', '/api/tail']) {
      expect((await v.fetch(new Request(`${BASE}${path}`))).status).toBe(404)
    }
  })

  test('APP_ENV=local allows access', async () => {
    const v = viewer(fixture())
    expect((await v.fetch(new Request(BASE))).status).toBe(200)
  })

  test('token mode: bearer works, wrong or missing token is 401', async () => {
    const v = createViewerHandler({ dir: fixture(), env: { LOGS_VIEWER_TOKEN: TOKEN } })
    const ok = await v.fetch(
      new Request(`${BASE}/api/files`, { headers: { authorization: `Bearer ${TOKEN}` } }),
    )
    expect(ok.status).toBe(200)
    const wrong = await v.fetch(
      new Request(`${BASE}/api/files`, {
        headers: { authorization: 'Bearer nope-nope-nope-nope' },
      }),
    )
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('www-authenticate')).toContain('Bearer')
    expect((await v.fetch(new Request(`${BASE}/api/files`))).status).toBe(401)
  })

  test('token login: ?token= on the page sets an HttpOnly SameSite=Strict cookie and redirects to a clean URL', async () => {
    let now = NOW
    const v = createViewerHandler({ dir: fixture(), token: TOKEN, env: {}, now: () => now })
    const login = await v.fetch(new Request(`https://app.test/_strutvane/logs/?token=${TOKEN}`))
    expect(login.status).toBe(303)
    expect(login.headers.get('location')).toBe('/_strutvane/logs')
    const cookie = login.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Strict/)
    expect(cookie).toMatch(/Secure/)
    expect(cookie).toMatch(/Path=\/_strutvane\/logs/)
    expect(cookie).not.toContain(TOKEN)
    const value = cookie.split(';')[0] ?? ''
    expect(
      (await v.fetch(new Request(`${BASE}/api/files`, { headers: { cookie: value } }))).status,
    ).toBe(200)

    // ?token= is only accepted on the page, never on the API.
    expect((await v.fetch(new Request(`${BASE}/api/files?token=${TOKEN}`))).status).toBe(401)
    // A wrong token on the page doesn't log in.
    expect((await v.fetch(new Request(`${BASE}/?token=wrong-wrong-wrong-wrong`))).status).toBe(401)
    // Sessions expire.
    now += 9 * 60 * 60 * 1000
    expect(
      (await v.fetch(new Request(`${BASE}/api/files`, { headers: { cookie: value } }))).status,
    ).toBe(401)
    // Plain-HTTP logins don't set Secure.
    const http = await createViewerHandler({ dir: fixture(), token: TOKEN, env: {} }).fetch(
      new Request(`${BASE}/?token=${TOKEN}`),
    )
    expect(http.headers.get('set-cookie')).not.toMatch(/Secure/)
  })

  test('forged and tampered session cookies are rejected', async () => {
    const v = createViewerHandler({ dir: fixture(), token: TOKEN, env: {}, now: () => NOW })
    const exp = NOW + 1_000_000
    const forged = [
      `${exp}.AAAA`,
      sessionValue('another-token-1234567', exp),
      `${exp + 1}.${sessionValue(TOKEN, exp).split('.')[1]}`,
      'garbage',
      '.x',
      `abc.${'x'.repeat(43)}`,
    ]
    for (const value of forged) {
      const res = await v.fetch(
        new Request(`${BASE}/api/files`, { headers: { cookie: `${SESSION_COOKIE}=${value}` } }),
      )
      expect(res.status).toBe(401)
    }
  })

  test('short tokens: an explicit one throws, one from the environment keeps the viewer closed', async () => {
    expect(() => createViewerHandler({ token: 'short', env: {} })).toThrow(TypeError)
    const v = createViewerHandler({ dir: fixture(), env: { LOGS_VIEWER_TOKEN: 'short' } })
    expect(
      (await v.fetch(new Request(BASE, { headers: { authorization: 'Bearer short' } }))).status,
    ).toBe(404)
    expect(validateToken('', 'x')).toBeUndefined()
  })

  test('authorize(): replaces the defaults; false or a thrown error hides the viewer', async () => {
    const dir = fixture()
    const yes = createViewerHandler({
      dir,
      env: {},
      authorize: (r) => r.headers.get('x-role') === 'admin',
    })
    expect((await yes.fetch(new Request(BASE, { headers: { 'x-role': 'admin' } }))).status).toBe(
      200,
    )
    expect((await yes.fetch(new Request(BASE))).status).toBe(404)
    const local = createViewerHandler({ dir, env: { APP_ENV: 'local' }, authorize: () => false })
    expect((await local.fetch(new Request(BASE))).status).toBe(404) // authorize wins over local
    const throws = createViewerHandler({
      dir,
      env: {},
      authorize: async () => {
        throw new Error('auth service down')
      },
    })
    expect((await throws.fetch(new Request(BASE))).status).toBe(404) // fail closed
  })

  test('IP allow-list applies in every mode; IPv4-mapped addresses and CIDR ranges work', async () => {
    const v = viewer(fixture(), { ipAllowList: ['10.0.0.0/8', '::1'] })
    expect((await v.fetch(new Request(BASE), { ip: '10.1.2.3' })).status).toBe(200)
    expect((await v.fetch(new Request(BASE), { ip: '::ffff:10.9.9.9' })).status).toBe(200)
    expect((await v.fetch(new Request(BASE), { ip: '::1' })).status).toBe(200)
    expect((await v.fetch(new Request(BASE), { ip: '192.168.1.1' })).status).toBe(404)
    expect((await v.fetch(new Request(BASE))).status).toBe(404) // unknown IP: denied
    expect(
      (await v.fetch(new Request(BASE, { headers: { 'x-forwarded-for': '10.0.0.1' } }))).status,
    ).toBe(404) // headers aren't trusted
    expect(() => buildAllowList(['not-an-ip'])).toThrow(TypeError)
    expect(() => buildAllowList(['10.0.0.0/33'])).toThrow(TypeError)
    expect(() => buildAllowList(['::/x'])).toThrow(TypeError)
    expect(ipAllowed(buildAllowList(['fd00::/8']), 'fd00::1')).toBe(true)
    expect(ipAllowed(buildAllowList(['1.2.3.4']), 'garbage')).toBe(false)
  })

  test('helpers: constant-time comparison and cookie parsing', async () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(readCookie('a=1; b = 2 ; junk', 'b')).toBe('2')
    expect(readCookie(null, 'b')).toBeUndefined()
    expect(readCookie('a=1', 'b')).toBeUndefined()
    expect(verifySession(TOKEN, sessionValue(TOKEN, NOW + 10), NOW)).toBe(true)
    const policy = {
      authorize: undefined,
      token: TOKEN,
      local: false,
      allowList: undefined,
      cookiePath: '/',
      now: () => NOW,
    }
    expect(
      (
        await decideAccess(
          policy,
          new Request(`${BASE}/?token=${TOKEN}`, { method: 'POST' }),
          undefined,
          true,
        )
      ).kind,
    ).toBe('unauthenticated')
  })
})

describe('response hardening', () => {
  test('the page has a nonce-based CSP, a fresh nonce per response, and security headers', async () => {
    const v = viewer(fixture())
    const a = await v.fetch(new Request(BASE))
    const b = await v.fetch(new Request(`${BASE}/`))
    const csp = a.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).not.toContain('unsafe-inline')
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]
    expect(nonce).toBeTruthy()
    expect(b.headers.get('content-security-policy')).not.toContain(nonce)
    const html = await a.text()
    expect(html).toContain(`<script nonce="${nonce}">`)
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/)
    expect(html).not.toMatch(/\son[a-z]+=/i) // no inline event handlers
    for (const res of [a, await v.fetch(new Request(`${BASE}/api/files`))]) {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(res.headers.get('cache-control')).toContain('no-store')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
    }
  })

  test('XSS: hostile log text is returned as JSON data and rendered with textContent only', async () => {
    const v = viewer(fixture())
    const res = await v.fetch(new Request(`${BASE}/api/records?q=onerror`))
    expect(res.headers.get('content-type')).toContain('application/json')
    const { records } = await body(res)
    expect(records?.[0]?.msg).toBe('<img src=x onerror=alert(1)>')
    const html = renderViewerPage({ nonce: 'n"><script>', basePath: '/a"><b' })
    expect(html).not.toContain('<script>"')
    expect(html).toContain('data-base="/a&quot;&gt;&lt;b"')
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;')
  })

  test('invalid base paths are rejected at startup', () => {
    for (const basePath of ['/', 'logs', '/a b', '/a//b', '/<x>', '/a?b']) {
      expect(() => createViewerHandler({ basePath, env: {} })).toThrow(TypeError)
    }
    expect(createViewerHandler({ basePath: '/ops/logs/', env: {} }).basePath).toBe('/ops/logs')
    expect(() => createViewerHandler({ maxTails: -1, env: {} })).toThrow(RangeError)
  })

  test('routing: matches only its own paths; unknown routes 404; wrong methods 405', async () => {
    const v = viewer(fixture())
    expect(v.matches(new Request(BASE))).toBe(true)
    expect(v.matches(new Request('http://app.test/_strutvane/logsX'))).toBe(false)
    expect(v.matchesPath('/_strutvane/logs/api/files')).toBe(true)
    expect(v.matches({ url: 'not a url' } as Request)).toBe(false)
    expect((await v.fetch(new Request('http://app.test/other'))).status).toBe(404)
    expect((await v.fetch(new Request(`${BASE}/api/nope`))).status).toBe(404)
    const post = await v.fetch(new Request(`${BASE}/api/files`, { method: 'POST' }))
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET, HEAD')
    expect((await v.fetch(new Request(`${BASE}/api/clear`))).headers.get('allow')).toBe('POST')
  })

  test('internal failures become a 500 problem, never a crash or a stack trace', async () => {
    const v = viewer(fixture(), {
      scopeRecords: () => () => true,
      authorize: () => true,
    })
    const broken = new Proxy(new Request(BASE), {
      get(target, key) {
        if (key === 'method') throw new Error('boom')
        return Reflect.get(target, key)
      },
    })
    const res = await v.fetch(broken)
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('boom')
  })
})

describe('reading records', () => {
  test('lists only log files, newest first', async () => {
    const { files } = (await body(
      await viewer(fixture()).fetch(new Request(`${BASE}/api/files`)),
    )) as {
      files: Array<{ name: string; day: string; size: number }>
    }
    expect(files.map((f) => f.name)).toEqual(['2026-11-14.ndjson', '2026-11-13.ndjson'])
    expect(files[0]?.size).toBeGreaterThan(0)
  })

  test('records come newest first; partial and invalid lines are skipped; output is re-sanitised', async () => {
    const res = await viewer(fixture()).fetch(new Request(`${BASE}/api/records`))
    const { records } = await body(res)
    expect(records?.map((r) => r.msg)).toEqual([
      'foreign',
      '<img src=x onerror=alert(1)>',
      'GET /pay 503',
      'GET /invoices 200',
      'old failure',
      'yesterday',
    ])
    const foreign = JSON.stringify(records?.[0])
    expect(foreign).not.toContain('hunter2')
    expect(foreign).not.toContain('abcdefghijklmnop')
  })

  test('a search cannot be used to guess a secret that only exists unredacted on disk', async () => {
    const v = viewer(fixture())
    const { records } = await body(await v.fetch(new Request(`${BASE}/api/records?q=hunter2`)))
    expect(records).toEqual([])
  })

  test('filters: level, status class, route, trace id, request id, tenant id, time range, text', async () => {
    const v = viewer(fixture())
    const msgs = async (qs: string): Promise<unknown[]> =>
      ((await body(await v.fetch(new Request(`${BASE}/api/records?${qs}`)))).records ?? []).map(
        (r) => r.msg,
      )
    expect(await msgs('level=error')).toEqual(['GET /pay 503', 'old failure'])
    expect(await msgs('level=warn,error&from=2026-11-14T00:00:00Z')).toEqual([
      '<img src=x onerror=alert(1)>',
      'GET /pay 503',
    ])
    expect(await msgs('status=5xx')).toEqual(['GET /pay 503'])
    expect(await msgs('status=200')).toEqual(['GET /invoices 200'])
    expect(await msgs('route=/invoices')).toEqual(['GET /invoices 200'])
    expect(await msgs('traceId=tr1')).toEqual(['GET /pay 503'])
    expect(await msgs('requestId=r9')).toEqual(['<img src=x onerror=alert(1)>'])
    expect(await msgs('tenantId=acme&to=2026-11-13T23:59:59Z')).toEqual(['yesterday'])
    expect(await msgs('q=INVOICES')).toEqual(['GET /invoices 200'])
  })

  test('invalid queries are a 400 problem, never ignored', async () => {
    const v = viewer(fixture())
    for (const qs of [
      'level=loud',
      'from=yesterday',
      'from=2026-11-14&to=2026-11-13',
      'status=600',
      `q=${'x'.repeat(201)}`,
      'limit=0',
      'limit=501',
      'limit=abc',
      'cursor=***',
    ]) {
      const res = await v.fetch(new Request(`${BASE}/api/records?${qs}`))
      expect(res.status, qs).toBe(400)
      expect(res.headers.get('content-type')).toBe('application/problem+json')
    }
  })

  test('paging with an opaque cursor visits every record exactly once', async () => {
    const v = viewer(fixture())
    const seen: unknown[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const qs = `limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const res = await body(await v.fetch(new Request(`${BASE}/api/records?${qs}`)))
      seen.push(...(res.records ?? []).map((r) => r.msg))
      cursor = res.nextCursor as string | undefined
      if (!cursor) break
    }
    expect(seen).toHaveLength(6)
    expect(new Set(seen).size).toBe(6)
  })

  test('the scan budget bounds work per request and returns a cursor to continue', async () => {
    const dir = fixture()
    const page = await readPage({ dir, query: {}, limit: 100, maxScanLines: 2 })
    expect(page.scanned).toBe(2)
    expect(page.nextCursor).toBeDefined()
    const rest = await readPage({
      dir,
      query: {},
      limit: 100,
      cursor: decodeCursor(page.nextCursor ?? ''),
    })
    expect(page.records.length + rest.records.length).toBe(6)
  })

  test('a cursor naming a deleted file continues with older files', async () => {
    const dir = fixture()
    const page = await readPage({
      dir,
      query: {},
      limit: 100,
      cursor: { file: '2026-11-14.w9.ndjson', before: 3 },
    })
    expect(page.records.map((r) => r.msg)).toEqual([
      'foreign',
      '<img src=x onerror=alert(1)>',
      'GET /pay 503',
      'GET /invoices 200',
      'old failure',
      'yesterday',
    ])
  })

  test('cursors are validated: traversal, wrong shapes and oversized values are rejected', () => {
    expect(decodeCursor(encodeCursor({ file: '2026-11-14.ndjson', before: 3 }))).toEqual({
      file: '2026-11-14.ndjson',
      before: 3,
    })
    const enc = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
    for (const bad of [
      enc(['../../etc/passwd', 1]),
      enc(['2026-11-14.ndjson', -1]),
      enc(['2026-11-14.ndjson', 1.5]),
      enc({ file: 'x' }),
      enc(['2026-11-14.ndjson']),
      'x'.repeat(600),
      '!!',
      Buffer.from('not json').toString('base64url'),
    ]) {
      expect(decodeCursor(bad)).toBeUndefined()
    }
  })

  test('tenant scoping: a scoped request sees only its records, in search, download and tail', async () => {
    const dir = fixture()
    const v = viewer(dir, {
      scopeRecords: (r) => {
        const tenant = r.headers.get('x-tenant')
        return tenant ? (rec) => rec.tenantId === tenant : undefined
      },
    })
    const scoped = { headers: { 'x-tenant': 'acme' } }
    const { records } = await body(await v.fetch(new Request(`${BASE}/api/records`, scoped)))
    expect(new Set(records?.map((r) => r.tenantId))).toEqual(new Set(['acme']))
    // Asking for another tenant explicitly still returns nothing.
    const other = await body(
      await v.fetch(new Request(`${BASE}/api/records?tenantId=globex`, scoped)),
    )
    expect(other.records).toEqual([])
    const dl = await (
      await v.fetch(new Request(`${BASE}/api/download?day=2026-11-14`, scoped))
    ).text()
    expect(dl).not.toContain('globex')
    expect(dl).toContain('acme')
  })

  test('a scope that throws hides the viewer; a filter that throws hides the record', async () => {
    const dir = fixture()
    const v = viewer(dir, {
      scopeRecords: () => {
        throw new Error('no tenant')
      },
    })
    expect((await v.fetch(new Request(`${BASE}/api/records`))).status).toBe(404)
    const page = await readPage({
      dir,
      query: {},
      limit: 10,
      scope: () => {
        throw new Error('bad filter')
      },
    })
    expect(page.records).toEqual([])
  })
})

describe('download', () => {
  test('NDJSON download of one day, re-sanitised, as an attachment; audited', async () => {
    const events: ViewerAuditEvent[] = []
    const v = viewer(fixture(), { onAudit: (e) => events.push(e) })
    const res = await v.fetch(new Request(`${BASE}/api/download?day=2026-11-14`), {
      ip: '127.0.0.1',
    })
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="logs-2026-11-14.ndjson"',
    )
    const text = await res.text()
    expect(text.trim().split('\n')).toHaveLength(4)
    expect(text).not.toContain('hunter2')
    expect(events).toEqual([
      expect.objectContaining({ action: 'download', day: '2026-11-14', ip: '127.0.0.1' }),
    ])
  })

  test('CSV download neutralises spreadsheet formulas (CSV injection)', async () => {
    const t = tempDir()
    cleanups.push(t.cleanup)
    writeFileSync(
      join(t.dir, '2026-11-14.ndjson'),
      line({ msg: '=HYPERLINK("http://evil","x")' }) + line({ msg: 'a,"b"' }),
    )
    const res = await viewer(t.dir).fetch(
      new Request(`${BASE}/api/download?day=2026-11-14&format=csv`),
    )
    expect(res.headers.get('content-type')).toContain('text/csv')
    const csv = await res.text()
    expect(csv.startsWith(csvHeader())).toBe(true)
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`)
    expect(csv).toContain('"a,""b"""')
  })

  test('day and format are validated (no path traversal through ?day=)', async () => {
    const v = viewer(fixture())
    for (const qs of [
      'day=../../etc/passwd',
      'day=2026-11-14/../../x',
      'day=2026-02-30',
      '',
      'day=2026-11-14&format=xlsx',
    ]) {
      expect((await v.fetch(new Request(`${BASE}/api/download?${qs}`))).status, qs).toBe(400)
    }
    const empty = await v.fetch(new Request(`${BASE}/api/download?day=2020-01-01`))
    expect(await empty.text()).toBe('')
  })

  test('a large day streams in chunks', async () => {
    const t = tempDir()
    cleanups.push(t.cleanup)
    writeFileSync(
      join(t.dir, '2026-11-14.ndjson'),
      Array.from({ length: 2_000 }, (_, i) => line({ i, pad: 'p'.repeat(100) })).join(''),
    )
    const res = await viewer(t.dir).fetch(new Request(`${BASE}/api/download?day=2026-11-14`))
    const reader = res.body?.getReader()
    let chunks = 0
    for (;;) {
      const r = await reader?.read()
      if (!r || r.done) break
      chunks++
    }
    expect(chunks).toBeGreaterThan(1)
    const cancelled = await viewer(t.dir).fetch(new Request(`${BASE}/api/download?day=2026-11-14`))
    await cancelled.body?.cancel()
  })

  test('csv helpers', () => {
    expect(csvCell(undefined)).toBe('')
    expect(csvCell(5)).toBe('5')
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"')
    for (const prefix of ['=', '+', '-', '@', '\t', '\r'])
      expect(csvCell(`${prefix}x`).replace(/^"/, '').startsWith("'")).toBe(true)
    expect(csvRow({ time: 't', level: 'info', msg: 'm' })).toBe('t,info,m,,,,,,\r\n')
  })
})

describe('clear', () => {
  async function csrf(v: ReturnType<typeof viewer>): Promise<string> {
    return String((await body(await v.fetch(new Request(`${BASE}/api/session`)))).csrfToken)
  }
  const post = (
    headers: Record<string, string>,
    payload: unknown = { confirm: 'DELETE' },
  ): Request =>
    new Request(`${BASE}/api/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    })

  test("deletes old files but never today's, never foreign files; audited", async () => {
    const dir = fixture()
    const events: ViewerAuditEvent[] = []
    const v = viewer(dir, { onAudit: (e) => events.push(e) })
    const res = await v.fetch(
      post({ 'x-csrf-token': await csrf(v), origin: 'http://localhost:3000' }),
      {
        ip: '::1',
      },
    )
    expect(res.status).toBe(200)
    expect((await body(res)).deleted).toEqual(['2026-11-13.ndjson'])
    expect(readdirSync(dir).sort()).toEqual(['2026-11-14.ndjson', 'secrets.env'])
    expect(events[0]).toMatchObject({ action: 'clear', deleted: ['2026-11-13.ndjson'], ip: '::1' })
  })

  test('`before` is honoured but capped at today', async () => {
    const dir = fixture()
    writeFileSync(join(dir, '2026-11-01.ndjson'), line({}))
    mkdirSync(join(dir, '2026-11-02.ndjson')) // undeletable: skipped
    const v = viewer(dir)
    const token = await csrf(v)
    const first = await body(
      await v.fetch(post({ 'x-csrf-token': token }, { confirm: 'DELETE', before: '2026-11-05' })),
    )
    expect(first.deleted).toEqual(['2026-11-01.ndjson'])
    const second = await body(
      await v.fetch(post({ 'x-csrf-token': token }, { confirm: 'DELETE', before: '2099-01-01' })),
    )
    expect(second.deleted).toEqual(['2026-11-13.ndjson'])
    expect(existsSync(join(dir, '2026-11-14.ndjson'))).toBe(true)
  })

  test('CSRF: missing or wrong token, cross-origin and cross-site requests are refused', async () => {
    const dir = fixture()
    const v = viewer(dir)
    const token = await csrf(v)
    const cases: Array<[Record<string, string>, number]> = [
      [{}, 403],
      [{ 'x-csrf-token': 'forged' }, 403],
      [{ 'x-csrf-token': token, origin: 'https://evil.example' }, 403],
      [{ 'x-csrf-token': token, 'sec-fetch-site': 'cross-site' }, 403],
    ]
    for (const [headers, status] of cases)
      expect((await v.fetch(post(headers))).status).toBe(status)
    expect(readdirSync(dir)).toContain('2026-11-13.ndjson') // nothing was deleted
    // A different viewer instance has a different CSRF token.
    expect((await viewer(dir).fetch(post({ 'x-csrf-token': token }))).status).toBe(403)
  })

  test('body validation: content type, size, JSON shape, confirmation, before', async () => {
    const v = viewer(fixture())
    const token = await csrf(v)
    const h = { 'x-csrf-token': token }
    const form = new Request(`${BASE}/api/clear`, {
      method: 'POST',
      headers: { ...h, 'content-type': 'text/plain' },
      body: 'x',
    })
    expect((await v.fetch(form)).status).toBe(415)
    expect((await v.fetch(post(h, 'x'.repeat(5_000)))).status).toBe(413)
    expect((await v.fetch(post({ ...h, 'content-length': '999999' }, '{}'))).status).toBe(413)
    expect((await v.fetch(post(h, 'not json'))).status).toBe(400)
    expect((await v.fetch(post(h, '[]'))).status).toBe(400)
    expect((await v.fetch(post(h, {}))).status).toBe(400)
    expect((await v.fetch(post(h, { confirm: 'yes' }))).status).toBe(400)
    expect((await v.fetch(post(h, { confirm: 'DELETE', before: '../x' }))).status).toBe(400)
    const noBody = new Request(`${BASE}/api/clear`, {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
    })
    expect((await v.fetch(noBody)).status).toBe(400)
  })

  test('scoped (tenant) viewers can never clear logs; audit hook errors are ignored', async () => {
    const dir = fixture()
    const v = viewer(dir, {
      scopeRecords: () => () => true,
      onAudit: () => {
        throw new Error('audit down')
      },
    })
    expect((await v.fetch(post({ 'x-csrf-token': await csrf(v) }))).status).toBe(403)
    const unscoped = viewer(dir, {
      onAudit: () => {
        throw new Error('audit down')
      },
    })
    expect((await unscoped.fetch(post({ 'x-csrf-token': await csrf(unscoped) }))).status).toBe(200)
  })
})

describe('live tail', () => {
  async function readEvents(
    stream: ReadableStream<Uint8Array>,
    until: (text: string) => boolean,
  ): Promise<string> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 5_000
    while (!until(text) && Date.now() < deadline) {
      const r = await Promise.race([reader.read(), sleep(100).then(() => undefined)])
      if (r?.done) break
      if (r?.value) text += decoder.decode(r.value)
    }
    await reader.cancel()
    return text
  }

  test('streams only new, complete, filtered records; follows rotation; never sends torn lines', async () => {
    const t = tempDir()
    cleanups.push(t.cleanup)
    const file = join(t.dir, '2026-11-14.ndjson')
    writeFileSync(file, line({ msg: 'already there' }))
    let closed = 0
    const stream = createTailStream({
      dir: t.dir,
      query: { levels: new Set(['info']) },
      pollMs: 20,
      heartbeatMs: 30,
      now: () => NOW,
      onClose: () => closed++,
    })
    const done = readEvents(stream, (text) => text.includes('rotated') && text.includes(': ping'))
    await sleep(60)
    const { appendFileSync } = await import('node:fs')
    appendFileSync(
      file,
      line({ msg: 'new one' }) +
        line({ level: 'debug', msg: 'filtered out' }) +
        '{"level":"info","msg":"half',
    )
    await sleep(60)
    appendFileSync(file, ' done"}\n')
    await sleep(60)
    writeFileSync(join(t.dir, '2026-11-14-1.ndjson'), line({ msg: 'rotated' }))
    const text = await done
    expect(text).toContain(': connected')
    expect(text).not.toContain('already there')
    expect(text).toContain('"msg":"new one"')
    expect(text).toContain('"msg":"half done"')
    expect(text).not.toContain('filtered out')
    for (const event of text.split('\n\n').filter((e) => e.startsWith('data: '))) {
      expect(() => JSON.parse(event.slice(6))).not.toThrow()
    }
    expect(closed).toBe(1)
  })

  test('a truncated (cleared and recreated) file is re-read from the start', async () => {
    const t = tempDir()
    cleanups.push(t.cleanup)
    const file = join(t.dir, '2026-11-14.ndjson')
    writeFileSync(file, line({ msg: 'x'.repeat(500) }))
    const stream = createTailStream({ dir: t.dir, query: {}, pollMs: 20, now: () => NOW })
    const done = readEvents(stream, (text) => text.includes('after truncate'))
    await sleep(60)
    writeFileSync(file, line({ msg: 'after truncate' }))
    expect(await done).toContain('after truncate')
  })

  test('the handler limits concurrent tails (429) and frees a slot on disconnect', async () => {
    const v = viewer(fixture(), { maxTails: 1, tailPollMs: 20, heartbeatMs: 1_000 })
    const controller = new AbortController()
    const first = await v.fetch(new Request(`${BASE}/api/tail`, { signal: controller.signal }))
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toContain('text/event-stream')
    const reader = first.body?.getReader()
    await reader?.read()
    const second = await v.fetch(new Request(`${BASE}/api/tail`))
    expect(second.status).toBe(429)
    expect(second.headers.get('retry-after')).toBe('10')
    controller.abort()
    await sleep(30)
    const third = await v.fetch(new Request(`${BASE}/api/tail`))
    expect(third.status).toBe(200)
    await third.body?.cancel()
  })

  test('an already-aborted request closes immediately', async () => {
    const t = tempDir()
    cleanups.push(t.cleanup)
    const controller = new AbortController()
    controller.abort()
    let closed = 0
    const stream = createTailStream({
      dir: t.dir,
      query: {},
      signal: controller.signal,
      onClose: () => closed++,
    })
    const r = await stream.getReader().read()
    expect(r.done).toBe(true)
    expect(closed).toBe(1)
  })

  test('large appends are read in bounded chunks', async () => {
    const t = tempDir()
    cleanups.push(t.cleanup)
    const file = join(t.dir, '2026-11-14.ndjson')
    writeFileSync(file, '')
    const stream = createTailStream({
      dir: t.dir,
      query: {},
      pollMs: 10,
      maxReadBytes: 256,
      now: () => NOW,
    })
    const done = readEvents(stream, (text) => text.includes('"n":49'))
    await sleep(30)
    writeFileSync(file, Array.from({ length: 50 }, (_, n) => line({ n })).join(''))
    const text = await done
    expect(text.match(/^data: /gm)?.length).toBe(50)
  })
})

describe('store and filter helpers', () => {
  test('readRange and readDayLines tolerate missing files', async () => {
    expect((await readRange('/definitely/missing', 0, 10)).length).toBe(0)
    expect((await readRange('/definitely/missing', 5, 5)).length).toBe(0)
    const lines: string[] = []
    for await (const l of readDayLines('/definitely/missing', '2026-11-14')) lines.push(l)
    expect(lines).toEqual([])
  })

  test('cleanLine rejects non-objects', () => {
    expect(cleanLine('[1,2]', viewerSanitizer)).toBeUndefined()
    expect(cleanLine('{bad', viewerSanitizer)).toBeUndefined()
    expect(cleanLine('42', viewerSanitizer)).toBeUndefined()
  })

  test('query parsing and matching edge cases', () => {
    expect(() => parseRecordQuery(new URLSearchParams('status=abc'))).toThrow(QueryError)
    expect(parseRecordQuery(new URLSearchParams('level=&q=  '))).toEqual({})
    const q = parseRecordQuery(new URLSearchParams('status=4XX&from=2026-11-14'))
    expect(q.status).toEqual({ min: 400, max: 499 })
    expect(matchesQuery({ time: 'not a date' }, '', q)).toBe(false)
    expect(
      matchesQuery({ time: '2026-11-14T01:00:00Z', fields: null }, '', {
        status: { min: 400, max: 499 },
      }),
    ).toBe(false)
    expect(matchesQuery({ time: 5 }, '', { toMs: 10 })).toBe(false)
    expect(matchesQuery({ level: 5 }, '', { levels: new Set(['info']) })).toBe(false)
  })
})

describe('page structure', () => {
  test('element ids are unique and every input has a label', () => {
    const html = renderViewerPage({ nonce: 'n', basePath: '/_strutvane/logs' })
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
    for (const m of html.matchAll(/<(?:input|select)[^>]*\sid="([^"]+)"/g)) {
      expect(html, `label for ${m[1]}`).toContain(`for="${m[1]}"`)
    }
  })
})
