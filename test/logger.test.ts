/**
 * The pipeline (RFC-0004, ADR-0015): never throws, never blocks, falls back safely, bounded memory,
 * and the file transport rotates exactly once without torn lines.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { runWithLogContext } from '../src/context.ts'
import { createPipelineLogger } from '../src/logger.ts'
import { stderrTransport } from '../src/transports/console.ts'
import { appendFileWriter, fileTransport, today } from '../src/transports/file.ts'
import type { Batch } from '../src/transports/types.ts'
import {
  allRecords,
  captureStream,
  failingWriter,
  flakyTransport,
  memoryTransport,
  readLogDir,
  sleep,
  tempDir,
} from './helpers.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})
function dir(): string {
  const t = tempDir()
  cleanups.push(t.cleanup)
  return t.dir
}
const T0 = Date.parse('2026-11-14T10:00:00.000Z')

describe('logging calls', () => {
  test('records carry level, message, bindings, context and redaction', async () => {
    const t = memoryTransport()
    const log = createPipelineLogger({ transport: t, bindings: { service: 'api' }, now: () => T0 })
    runWithLogContext({ requestId: 'r1', tenantId: 'acme' }, () => {
      log.child({ module: 'billing' }).info('Invoice sent', { invoiceId: 7, password: 'hunter2' })
    })
    await log.flush()
    expect(t.records()).toEqual([
      {
        time: '2026-11-14T10:00:00.000Z',
        level: 'info',
        msg: 'Invoice sent',
        requestId: 'r1',
        tenantId: 'acme',
        fields: { service: 'api', module: 'billing', invoiceId: 7, password: '[REDACTED]' },
      },
    ])
  })

  test('the level filter applies; isLevelEnabled reports it', async () => {
    const t = memoryTransport()
    const log = createPipelineLogger({ transport: t, level: 'warn' })
    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    log.fatal('f')
    await log.flush()
    expect(t.records().map((r) => r.level)).toEqual(['warn', 'error', 'fatal'])
    expect(log.level).toBe('warn')
    expect(log.isLevelEnabled('info')).toBe(false)
    expect(log.isLevelEnabled('error')).toBe(true)
  })

  test('a log call never throws, whatever it is given', async () => {
    const t = memoryTransport()
    const log = createPipelineLogger({
      transport: t,
      context: () => {
        throw new Error('context broke')
      },
    })
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('no keys')
        },
      },
    )
    expect(() => {
      log.info(undefined as unknown as string, hostile)
      log.info({ toString: () => 'obj' } as unknown as string)
      log.error('with error', { err: new Error('x') })
    }).not.toThrow()
    await log.flush()
    expect(t.records()).toHaveLength(3)
  })

  test('internal failures are counted, never thrown', () => {
    const log = createPipelineLogger({
      transport: memoryTransport(),
      sanitize: { maxDepth: Number.NaN },
    })
    expect(() => log.info('x')).not.toThrow()
  })

  test('a log call does not block: writing happens later, in batches', async () => {
    const t = memoryTransport({ delayMs: 5 })
    const log = createPipelineLogger({ transport: t, maxBatchBytes: 4 * 1024 })
    const started = performance.now()
    for (let i = 0; i < 5_000; i++) log.info('fast', { i })
    const elapsed = performance.now() - started
    expect(t.batches).toHaveLength(0) // nothing written synchronously
    expect(elapsed).toBeLessThan(1_000)
    await log.drain(10_000)
    expect(t.records()).toHaveLength(5_000)
    expect(t.batches.length).toBeGreaterThan(1)
    expect(t.records().map((r) => (r.fields as { i: number }).i)).toEqual([...Array(5_000).keys()])
  })

  test('throughput sanity: 50k records/s or more through the pipeline', async () => {
    const t = memoryTransport()
    const log = createPipelineLogger({
      transport: t,
      queue: { maxRecords: 200_000, maxBytes: 256 * 1024 * 1024 },
    })
    const n = 50_000
    const started = performance.now()
    for (let i = 0; i < n; i++)
      log.info('request handled', { method: 'GET', route: '/api/v1/invoices', status: 200, i })
    await log.drain(30_000)
    const perSecond = n / ((performance.now() - started) / 1000)
    expect(log.stats().written).toBe(n)
    expect(perSecond).toBeGreaterThan(50_000)
  })

  test('validates numeric options', () => {
    const transport = memoryTransport()
    expect(() => createPipelineLogger({ transport, maxRecordBytes: 0 })).toThrow(RangeError)
    expect(() => createPipelineLogger({ transport, maxBatchBytes: Number.NaN })).toThrow(RangeError)
    expect(() => createPipelineLogger({ transport, retryPrimaryMs: -1 })).toThrow(RangeError)
  })
})

describe('fail-safe', () => {
  test('primary failure → stderr fallback with ONE warning per outage, then automatic recovery', async () => {
    let now = T0
    const primary = flakyTransport()
    const fallback = captureStream()
    const log = createPipelineLogger({
      transport: primary,
      fallback: stderrTransport(fallback.stream),
      retryPrimaryMs: 1_000,
      now: () => now,
    })
    for (let i = 0; i < 3; i++) {
      log.info('during outage', { i })
      await log.flush()
    }
    const warnings = fallback
      .lines()
      .filter((l) => String(l.msg).includes('failed; writing to stderr'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.fields).toEqual({
      error: { name: 'Error', message: 'ENOSPC: no space left on device', code: 'ENOSPC' },
    })
    expect(fallback.lines().filter((l) => l.msg === 'during outage')).toHaveLength(3) // nothing lost
    expect(log.stats()).toMatchObject({
      fallbackActive: true,
      fallbackWarnings: 1,
      primaryFailures: 1,
    })

    // Recovery: after the retry interval, the primary is tried again and succeeds.
    primary.failing.value = false
    now += 1_001
    log.info('recovered')
    await log.flush()
    expect(primary.ok.map((b) => b.text).join('')).toContain('recovered')
    expect(log.stats().fallbackActive).toBe(false)

    // A second outage warns once more.
    primary.failing.value = true
    log.info('second outage')
    await log.flush()
    expect(log.stats().fallbackWarnings).toBe(2)
  })

  test('a transport that throws synchronously is handled like a rejection', async () => {
    const fallback = captureStream()
    const log = createPipelineLogger({
      transport: {
        name: 'sync-throw',
        write(): Promise<void> {
          throw new Error('sync')
        },
        close: () => Promise.resolve(),
      },
      fallback: stderrTransport(fallback.stream),
    })
    log.info('kept')
    await log.flush()
    expect(fallback.lines().some((l) => l.msg === 'kept')).toBe(true)
  })

  test('a broken fallback too: counted as an internal error, never thrown', async () => {
    const reject = {
      name: 'bad',
      write: () => Promise.reject(new Error('x')),
      close: () => Promise.resolve(),
    }
    const log = createPipelineLogger({ transport: reject, fallback: reject })
    log.info('x')
    await log.flush()
    expect(log.stats().internalErrors).toBeGreaterThan(0)
  })

  test('disk full (ENOSPC) on the file transport falls back to stderr', async () => {
    const d = dir()
    const fallback = captureStream()
    const log = createPipelineLogger({
      transport: fileTransport({ dir: d, writer: failingWriter('ENOSPC') }),
      fallback: stderrTransport(fallback.stream),
    })
    log.error('disk is full', { important: true })
    await log.flush()
    expect(fallback.lines().map((l) => l.msg)).toContain('disk is full')
  })

  test('a deleted log directory is recreated on the next rotation', async () => {
    const d = join(dir(), 'nested', 'logs')
    let now = T0
    const log = createPipelineLogger({
      transport: fileTransport({ dir: d, retentionDays: 0 }),
      now: () => now,
    })
    log.info('day one')
    await log.flush()
    await log.close()
    rmSync(d, { recursive: true, force: true })
    const log2 = createPipelineLogger({
      transport: fileTransport({ dir: d, retentionDays: 0 }),
      now: () => now,
    })
    now += 86_400_000
    log2.info('day two')
    await log2.close()
    expect(allRecords(d).map((r) => r.msg)).toEqual(['day two'])
  })
})

describe('bounded memory', () => {
  test('a stalled transport cannot grow the queue past its limits; drops are reported', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const written: Batch[] = []
    const log = createPipelineLogger({
      transport: {
        name: 'stalled',
        async write(b: Batch): Promise<void> {
          await gate
          written.push(b)
        },
        close: () => Promise.resolve(),
      },
      queue: { maxRecords: 100, maxBytes: 1024 * 1024 },
    })
    for (let i = 0; i < 1_000; i++) log.info('flood', { i })
    log.error('important')
    await sleep(5)
    expect(log.stats().queuePeak).toBeLessThanOrEqual(100)
    release()
    await log.flush()
    const text = written.map((b) => b.text).join('')
    expect(text).toContain('"msg":"important"') // important records survive
    expect(text).toMatch(/logs: dropped \d+ records \(queue full\)/)
    expect(log.stats().dropped).toBeGreaterThan(800)
    expect(log.stats().droppedByLevel.info).toBe(log.stats().dropped)
  })
})

describe('flush, drain and close', () => {
  test('drain reports a missed deadline; close stops logging and closes the transport', async () => {
    const hung = {
      name: 'hung',
      write: () => new Promise<void>(() => {}),
      close: () => new Promise<void>(() => {}),
    }
    const log = createPipelineLogger({ transport: hung })
    log.info('stuck')
    const result = await log.drain(30)
    expect(result.flushed).toBe(false)
    const closed = await log.close(30)
    expect(closed.flushed).toBe(false)
    log.info('ignored after close')
    expect(log.isLevelEnabled('fatal')).toBe(false)
  })

  test('an idle logger drains immediately', async () => {
    const t = memoryTransport()
    const log = createPipelineLogger({ transport: t })
    await expect(log.drain()).resolves.toEqual({ flushed: true, pending: 0 })
    await log.close()
    expect(t.closed).toBe(1)
  })
})

describe('file transport', () => {
  test('daily files: a new day is a new file (records never cross days)', async () => {
    const d = dir()
    let now = Date.parse('2026-11-14T23:59:59.900Z')
    const log = createPipelineLogger({
      transport: fileTransport({ dir: d, retentionDays: 0 }),
      now: () => now,
    })
    log.info('before midnight')
    now += 200
    log.info('after midnight')
    await log.close()
    expect(readLogDir(d).map((f) => [f.file, f.records.map((r) => r.msg)])).toEqual([
      ['2026-11-14.ndjson', ['before midnight']],
      ['2026-11-15.ndjson', ['after midnight']],
    ])
  })

  test('size rotation: exactly once per overflow, no file over the cap, no torn line', async () => {
    const d = dir()
    const cap = 16 * 1024
    const log = createPipelineLogger({
      transport: fileTransport({ dir: d, maxFileBytes: cap, retentionDays: 0 }),
      maxBatchBytes: 2 * 1024,
      now: () => T0,
    })
    for (let i = 0; i < 2_000; i++) log.info('rotate', { i, pad: 'x'.repeat(50) })
    await log.close()
    const files = readLogDir(d) // throws on any torn line
    expect(files.length).toBeGreaterThan(5)
    for (const f of files) expect(statSync(join(d, f.file)).size).toBeLessThanOrEqual(cap)
    const seq = files.flatMap((f) => f.records.map((r) => (r.fields as { i: number }).i))
    expect(seq).toEqual([...Array(2_000).keys()]) // order kept, nothing duplicated or lost
    expect(files.map((f) => f.file)).toEqual(
      files.map((_, i) => (i === 0 ? '2026-11-14.ndjson' : `2026-11-14-${i}.ndjson`)),
    )
  })

  test('a restart resumes the newest part that still has room', async () => {
    const d = dir()
    writeFileSync(join(d, '2026-11-14.ndjson'), `${'{"msg":"old"}\n'.repeat(100)}`)
    const t = fileTransport({ dir: d, maxFileBytes: 1_000, retentionDays: 0 })
    await t.write({ text: '{"msg":"new"}\n', bytes: 14, records: 1, dayKey: '2026-11-14' })
    expect(t.currentFile()).toBe(join(d, '2026-11-14-1.ndjson'))
    await t.close()
    await t.close() // idempotent
  })

  test('retention runs at each new day; foreign files are untouched', async () => {
    const d = dir()
    writeFileSync(join(d, '2026-01-01.ndjson'), 'x\n')
    writeFileSync(join(d, 'notes.txt'), 'keep')
    const t = fileTransport({ dir: d, retentionDays: 30, now: () => T0 })
    await t.write({ text: '{}\n', bytes: 3, records: 1, dayKey: '2026-11-14' })
    await t.close()
    expect(readdirSync(d).sort()).toEqual(['2026-11-14.ndjson', 'notes.txt'])
  })

  test('a failed write forces a reopen; invalid tags are rejected', async () => {
    const d = dir()
    let calls = 0
    const t = fileTransport({
      dir: d,
      retentionDays: 0,
      writer: async (path) => {
        const inner = await appendFileWriter(path)
        return {
          async append(text: string, bytes: number): Promise<void> {
            calls++
            if (calls === 1) throw new Error('EIO')
            await inner.append(text, bytes)
          },
          close: () => inner.close(),
        }
      },
    })
    const b = { text: '{"msg":"a"}\n', bytes: 12, records: 1, dayKey: '2026-11-14' }
    await expect(t.write(b)).rejects.toThrow('EIO')
    await t.write(b)
    await t.close()
    expect(readFileSync(join(d, '2026-11-14.ndjson'), 'utf8')).toBe(b.text)
    expect(() => fileTransport({ dir: d, tag: '../x' })).toThrow(RangeError)
    expect(today(() => T0)).toBe('2026-11-14')
    expect(typeof today()).toBe('string')
  })

  test('appendFileWriter writes multibyte text exactly', async () => {
    const d = dir()
    mkdirSync(d, { recursive: true })
    const w = await appendFileWriter(join(d, 'x.ndjson'))
    await w.append('€uro ✓\n', 0)
    await w.close()
    expect(readFileSync(join(d, 'x.ndjson'), 'utf8')).toBe('€uro ✓\n')
  })
})
