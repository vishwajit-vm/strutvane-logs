/** Unit tests for the small building blocks: levels, context, records, serialisation, queue, files. */
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, test } from 'vitest'
import { getLogContext, runWithLogContext } from '../src/context.ts'
import {
  applyRetention,
  compareLogFiles,
  dayKeyOf,
  fileName,
  isDayKey,
  listLogFiles,
  parseLogFileName,
} from '../src/files.ts'
import { IMPORTANT_SEVERITY, isLogLevel, LOG_LEVELS, severityOf } from '../src/levels.ts'
import { BoundedQueue, type QueueItem } from '../src/queue.ts'
import { buildRecord, toMessage } from '../src/record.ts'
import {
  DEFAULT_MAX_RECORD_BYTES,
  escapeLineSeparators,
  LINE_SEPARATOR,
  PARAGRAPH_SEPARATOR,
  serializeRecord,
} from '../src/serialize.ts'
import { tempDir } from './helpers.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

describe('levels', () => {
  test('six levels in order, warn and above are important', () => {
    expect(LOG_LEVELS).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    expect(severityOf('trace')).toBeLessThan(severityOf('fatal'))
    expect(IMPORTANT_SEVERITY).toBe(severityOf('warn'))
    expect(isLogLevel('info')).toBe(true)
    expect(isLogLevel('verbose')).toBe(false)
    expect(isLogLevel(3)).toBe(false)
  })
})

describe('context', () => {
  test('is visible through async calls and nests', async () => {
    expect(getLogContext()).toBeUndefined()
    await runWithLogContext({ requestId: 'r1', tenantId: 't1' }, async () => {
      await new Promise((r) => setTimeout(r, 1))
      expect(getLogContext()).toEqual({ requestId: 'r1', tenantId: 't1' })
      runWithLogContext({ tenantId: 't2', extra: 1 }, () => {
        expect(getLogContext()).toEqual({ requestId: 'r1', tenantId: 't2', extra: 1 })
      })
    })
  })
})

describe('buildRecord', () => {
  const T = Date.parse('2026-11-14T10:00:00.000Z')

  test('correlation ids go top-level, other context into fields, errors into err', () => {
    const err = new Error('boom')
    const rec = buildRecord(
      'error',
      'failed',
      { service: 'api' },
      { requestId: 'r', traceId: 'tr', tenantId: 't', actorId: 'a', region: 'eu', empty: '' },
      { err, invoiceId: 1 },
      T,
    )
    expect(rec).toEqual({
      time: '2026-11-14T10:00:00.000Z',
      level: 'error',
      msg: 'failed',
      requestId: 'r',
      traceId: 'tr',
      tenantId: 't',
      actorId: 'a',
      fields: { service: 'api', region: 'eu', empty: '', invoiceId: 1 },
      err,
    })
  })

  test('`error` is accepted as the error key; no fields means no fields key', () => {
    const e = new Error('x')
    expect(buildRecord('info', 'm', {}, undefined, { error: e }, T).err).toBe(e)
    expect(buildRecord('info', 'm', {}, undefined, undefined, T)).not.toHaveProperty('fields')
  })

  test('hostile fields never throw', () => {
    const getter = Object.defineProperty({}, 'x', {
      enumerable: true,
      get() {
        throw new Error('no')
      },
    })
    expect(buildRecord('info', 'm', {}, undefined, getter, T).fields).toEqual({ x: '[Unreadable]' })
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    expect(buildRecord('info', 'm', {}, undefined, proxy, T).fields).toEqual({
      fieldsError: 'unreadable fields object',
    })
  })

  test('toMessage coerces anything', () => {
    expect(toMessage('a')).toBe('a')
    expect(toMessage(5)).toBe('5')
    expect(
      toMessage({
        toString() {
          throw new Error('x')
        },
      }),
    ).toBe('[unprintable message]')
  })
})

describe('serializeRecord', () => {
  test('always exactly one line, even with newlines and Unicode line separators (log injection)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (msg, field) => {
        const line = serializeRecord({ time: 't', level: 'info', msg, fields: { field } })
        const body = line.slice(0, -1)
        const unsafe = [10, 13, 0x2028, 0x2029].some((c) => body.includes(String.fromCharCode(c)))
        return line.endsWith(String.fromCharCode(10)) && !unsafe && JSON.parse(body).msg === msg
      }),
      { numRuns: 500 },
    )
    const injected = serializeRecord({
      msg: `ok\n{"level":"fatal","msg":"forged"}${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}`,
    })
    expect(injected.split('\n')).toHaveLength(2)
    expect(escapeLineSeparators(`a${LINE_SEPARATOR}b`)).toBe('a\\u2028b')
  })

  test('oversized records become a truncation marker', () => {
    const line = serializeRecord({
      time: 't',
      level: 'info',
      msg: 'm'.repeat(2000),
      fields: { big: 'x'.repeat(50_000) },
    })
    const rec = JSON.parse(line)
    expect(rec.fields).toEqual({ truncated: true, originalBytes: expect.any(Number) })
    expect(rec.msg).toHaveLength(1024)
    expect(Buffer.byteLength(line)).toBeLessThan(DEFAULT_MAX_RECORD_BYTES)
    const multibyte = serializeRecord({ msg: '€'.repeat(400) }, 1024)
    expect(JSON.parse(multibyte).fields.truncated).toBe(true)
  })

  test('a serialisation failure is reported, not thrown', () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    const rec = JSON.parse(serializeRecord({ time: 't', level: 'info', msg: 5, fields: circular }))
    expect(rec.fields.serializationError).toEqual(expect.any(String))
    expect(rec.msg).toBe('[non-string message]')
  })
})

describe('BoundedQueue', () => {
  let seq = 0
  const item = (
    level: 'debug' | 'info' | 'warn' | 'error',
    bytes = 10,
    dayKey = '2026-11-14',
  ): QueueItem => ({
    seq: seq++,
    line: 'x',
    bytes,
    severity: severityOf(level),
    level,
    dayKey,
  })

  test('rejects invalid limits', () => {
    expect(() => new BoundedQueue({ maxRecords: 0, maxBytes: 10 })).toThrow(RangeError)
  })

  test('a full queue drops new low-severity records but evicts for important ones', () => {
    const q = new BoundedQueue({ maxRecords: 2, maxBytes: 1_000 })
    expect(q.push(item('info'))).toBe('queued')
    expect(q.push(item('warn'))).toBe('queued')
    expect(q.push(item('debug'))).toBe('dropped')
    expect(q.push(item('error'))).toBe('evicted-other') // evicts the info
    expect(q.push(item('error'))).toBe('evicted-other') // only important left: evicts the oldest warn
    expect(q.takeDropped()).toEqual({ debug: 1, info: 1, warn: 1 })
    expect(q.takeDropped()).toBeUndefined()
    expect(q.size).toBe(2)
    expect(q.peakRecords).toBe(2)
  })

  test('a record bigger than the whole queue is dropped', () => {
    const q = new BoundedQueue({ maxRecords: 10, maxBytes: 5 })
    expect(q.push(item('error', 6))).toBe('dropped')
  })

  test('takeBatch keeps input order across priorities, respects size, never mixes days', () => {
    const q = new BoundedQueue({ maxRecords: 100, maxBytes: 10_000 })
    const a = item('info', 10)
    const b = item('error', 10)
    const c = item('info', 10)
    const d = item('info', 10, '2026-11-15')
    for (const i of [a, b, c, d]) q.push(i)
    expect(q.byteSize).toBe(40)
    expect(q.takeBatch(20)).toEqual([a, b])
    expect(q.takeBatch(1)).toEqual([c]) // at least one item, even over the limit
    expect(q.takeBatch(1_000)).toEqual([d])
    expect(q.takeBatch(1_000)).toEqual([])
    expect(q.peakBytes).toBe(40)
  })
})

describe('log file names', () => {
  test('parse, build and validate', () => {
    expect(fileName('2026-11-14', 0)).toBe('2026-11-14.ndjson')
    expect(fileName('2026-11-14', 3, 'w2')).toBe('2026-11-14.w2-3.ndjson')
    expect(parseLogFileName('2026-11-14.w2-3.ndjson')).toEqual({
      day: '2026-11-14',
      tag: 'w2',
      part: 3,
    })
    expect(parseLogFileName('2026-02-30.ndjson')).toBeUndefined()
    expect(parseLogFileName('../2026-11-14.ndjson')).toBeUndefined()
    expect(parseLogFileName('notes.txt')).toBeUndefined()
    expect(isDayKey('2026-11-14')).toBe(true)
    expect(isDayKey('2026-13-01')).toBe(false)
    expect(isDayKey('20261114')).toBe(false)
    expect(dayKeyOf(Date.parse('2026-11-14T23:59:59Z'))).toBe('2026-11-14')
  })

  test('compareLogFiles orders by day, tag, then part NUMBER (string sort is wrong)', () => {
    const names = [
      'z.txt',
      '2026-11-14-10.ndjson',
      '2026-11-14.w1.ndjson',
      '2026-11-14-2.ndjson',
      'a.txt',
      '2026-11-13.ndjson',
      '2026-11-14.ndjson',
    ]
    expect(names.sort(compareLogFiles)).toEqual([
      '2026-11-13.ndjson',
      '2026-11-14.ndjson',
      '2026-11-14-2.ndjson',
      '2026-11-14-10.ndjson',
      '2026-11-14.w1.ndjson',
      'a.txt',
      'z.txt',
    ])
    expect(compareLogFiles('a.txt', 'a.txt')).toBe(0)
  })

  test('listLogFiles ignores foreign files; a missing dir is empty', async () => {
    const { dir, cleanup } = tempDir()
    cleanups.push(cleanup)
    writeFileSync(join(dir, '2026-11-14-1.ndjson'), '')
    writeFileSync(join(dir, '2026-11-14.ndjson'), '')
    writeFileSync(join(dir, 'secrets.env'), '')
    expect(await listLogFiles(dir)).toEqual(['2026-11-14.ndjson', '2026-11-14-1.ndjson'])
    expect(await listLogFiles(join(dir, 'missing'))).toEqual([])
  })

  test('retention deletes only old Strutvane log files, by name', async () => {
    const { dir, cleanup } = tempDir()
    cleanups.push(cleanup)
    for (const n of [
      '2026-09-01.ndjson',
      '2026-09-01.w1-2.ndjson',
      '2026-11-10.ndjson',
      'keep.ndjson.bak',
      '2020-01-01.txt',
    ]) {
      writeFileSync(join(dir, n), 'x\n')
    }
    // A directory with a log-like name can't be unlinked: skipped, never fatal.
    mkdirSync(join(dir, '2026-08-01.ndjson'))
    utimesSync(join(dir, '2026-11-10.ndjson'), new Date(0), new Date(0)) // mtime is irrelevant
    const deleted = await applyRetention(dir, 30, Date.parse('2026-11-14T00:00:00Z'))
    expect(deleted.sort()).toEqual(['2026-09-01.ndjson', '2026-09-01.w1-2.ndjson'])
    expect((await listLogFiles(dir)).sort()).toEqual(['2026-08-01.ndjson', '2026-11-10.ndjson'])
    expect(await applyRetention(dir, 0, Date.now())).toEqual([])
  })
})
