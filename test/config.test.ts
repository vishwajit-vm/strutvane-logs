/** Configuration from options and environment (RFC-0004 §7), createLogger, the default `log`. */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_CONFIG, parseSize, resolveLogsConfig } from '../src/config.ts'
import { automaticWriterTag, createLogger } from '../src/create.ts'
import { log, setDefaultLogger } from '../src/default.ts'
import { createNoopLogger } from '../src/noop.ts'
import {
  prettyLine,
  prettyTransport,
  stderrTransport,
  stdoutTransport,
} from '../src/transports/console.ts'
import { allRecords, captureStream, memoryTransport, tempDir } from './helpers.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  setDefaultLogger(undefined)
})

describe('resolveLogsConfig', () => {
  test('defaults: info, file, storage/logs, 60 days, 30 MB, json outside local', () => {
    expect(resolveLogsConfig({}, {})).toEqual({
      config: { ...DEFAULT_CONFIG, format: 'json' },
      warnings: [],
    })
    expect(resolveLogsConfig({}, { APP_ENV: 'local' }).config.format).toBe('pretty')
  })

  test('reads every environment variable', () => {
    const { config, warnings } = resolveLogsConfig(
      {},
      {
        LOGS_ENABLED: 'off',
        LOG_LEVEL: ' DEBUG ',
        LOG_FORMAT: 'pretty',
        LOGS_DRIVER: 'stdout',
        LOGS_PATH: ' var/logs ',
        LOGS_RETENTION_DAYS: '14',
        LOGS_MAX_DAILY_SIZE: '2mb',
      },
    )
    expect(warnings).toEqual([])
    expect(config).toEqual({
      enabled: false,
      level: 'debug',
      format: 'pretty',
      driver: 'stdout',
      path: 'var/logs',
      retentionDays: 14,
      maxDailyBytes: 2 * 1024 * 1024,
    })
  })

  test('invalid environment values never crash: defaults plus one warning each', () => {
    const { config, warnings } = resolveLogsConfig(
      {},
      {
        LOGS_ENABLED: 'maybe',
        LOG_LEVEL: 'loud',
        LOG_FORMAT: 'xml',
        LOGS_DRIVER: 'kafka',
        LOGS_PATH: '   ',
        LOGS_RETENTION_DAYS: '-1',
        LOGS_MAX_DAILY_SIZE: '10',
      },
    )
    expect(config).toEqual({ ...DEFAULT_CONFIG, format: 'json' })
    expect(warnings).toHaveLength(6) // a blank LOGS_PATH counts as unset, not invalid
    expect(warnings.join('\n')).toContain('LOG_LEVEL="loud"')
  })

  test('LOGS_DRIVER=database is not available yet: warns and uses files', () => {
    const { config, warnings } = resolveLogsConfig({}, { LOGS_DRIVER: 'database' })
    expect(config.driver).toBe('file')
    expect(warnings[0]).toContain('not available yet')
  })

  test('explicit options win over the environment; invalid options throw', () => {
    expect(resolveLogsConfig({ level: 'error' }, { LOG_LEVEL: 'debug' }).config.level).toBe('error')
    expect(() => resolveLogsConfig({ level: 'loud' as 'info' })).toThrow(TypeError)
    expect(() => resolveLogsConfig({ format: 'xml' as 'json' })).toThrow(TypeError)
    expect(() => resolveLogsConfig({ driver: 'kafka' as 'file' })).toThrow(TypeError)
    expect(() => resolveLogsConfig({ retentionDays: 1.5 })).toThrow(RangeError)
    expect(() => resolveLogsConfig({ maxDailyBytes: 10 })).toThrow(RangeError)
    expect(() => resolveLogsConfig({ path: ' ' })).toThrow(TypeError)
  })

  test('parseSize', () => {
    expect(parseSize('30MB')).toBe(30 * 1024 * 1024)
    expect(parseSize('1.5 kb')).toBe(1536)
    expect(parseSize('1gb')).toBe(1024 ** 3)
    expect(parseSize('2048')).toBe(2048)
    expect(parseSize('100')).toBeUndefined()
    expect(parseSize('ten')).toBeUndefined()
  })
})

describe('createLogger', () => {
  test('disabled logging returns a no-op logger', async () => {
    const l = createLogger({ enabled: false, level: 'warn' })
    l.error('nothing')
    expect(l.level).toBe('warn')
    expect(l.isLevelEnabled('fatal')).toBe(false)
    expect(l.child({}).stats().written).toBe(0)
    await expect(l.flush()).resolves.toBeUndefined()
    await expect(l.drain()).resolves.toEqual({ flushed: true, pending: 0 })
    await expect(l.close()).resolves.toEqual({ flushed: true, pending: 0 })
    for (const m of ['trace', 'debug', 'info', 'warn', 'fatal'] as const) l[m]('x')
    expect(createNoopLogger().level).toBe('info')
  })

  test('file driver writes NDJSON under the configured path', async () => {
    const { dir, cleanup } = tempDir()
    cleanups.push(cleanup)
    const l = createLogger({
      path: join(dir, 'logs'),
      env: {},
      writerTag: false,
      now: () => Date.parse('2026-11-14T12:00:00Z'),
    })
    l.info('hello', { a: 1 })
    await l.close()
    expect(readdirSync(join(dir, 'logs'))).toEqual(['2026-11-14.ndjson'])
    expect(allRecords(join(dir, 'logs'))[0]).toMatchObject({ msg: 'hello', fields: { a: 1 } })
  })

  test('explicit writer tag names per-process files', async () => {
    const { dir, cleanup } = tempDir()
    cleanups.push(cleanup)
    const l = createLogger({ path: dir, env: {}, writerTag: 'w7' })
    l.info('x')
    await l.close()
    expect(readdirSync(dir)[0]).toMatch(/\.w7\.ndjson$/)
  })

  test('configuration warnings are logged once, at warn', async () => {
    const t = memoryTransport()
    const l = createLogger({ transport: t, env: { LOG_LEVEL: 'loud' } })
    await l.flush()
    expect(t.records()).toEqual([
      expect.objectContaining({ level: 'warn', fields: { component: 'logs.config' } }),
    ])
  })

  test('stdout drivers: json and pretty', async () => {
    const writes: string[] = []
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk))
        return true
      })
    const json = createLogger({ driver: 'stdout', format: 'json', env: {} })
    json.info('as-json')
    await json.flush()
    const pretty = createLogger({ driver: 'stdout', format: 'pretty', env: {} })
    pretty.info('as-pretty')
    await pretty.flush()
    spy.mockRestore()
    expect(writes.join('')).toContain('"msg":"as-json"')
    expect(writes.join('')).toMatch(/INFO {2}as-pretty/)
  })

  test('handleShutdown registers process listeners', async () => {
    const before = process.listenerCount('beforeExit')
    const l = createLogger({
      transport: memoryTransport(),
      handleShutdown: true,
      shutdownTimeoutMs: 100,
      env: {},
    })
    expect(process.listenerCount('beforeExit')).toBe(before + 1)
    process.emit('beforeExit', 0)
    await l.close()
    for (const listener of process.listeners('beforeExit').slice(before))
      process.off('beforeExit', listener)
    for (const listener of process.listeners('SIGTERM').slice(-1)) process.off('SIGTERM', listener)
    for (const listener of process.listeners('SIGINT').slice(-1)) process.off('SIGINT', listener)
  })

  test('the main thread of a non-cluster process needs no writer tag', () => {
    expect(automaticWriterTag()).toBeUndefined()
  })
})

describe('default log', () => {
  test('delegates to the configured default logger', async () => {
    const t = memoryTransport()
    setDefaultLogger(createLogger({ transport: t, level: 'trace', env: {} }))
    for (const m of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) log[m](m)
    log.child({ c: 1 }).info('child')
    expect(log.level).toBe('trace')
    expect(log.isLevelEnabled('trace')).toBe(true)
    await log.flush()
    await log.drain()
    expect(log.stats().written).toBe(7)
    await log.close()
    expect(t.records().map((r) => r.msg)).toEqual([
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
      'child',
    ])
  })
})

describe('console transports', () => {
  const batch = (text: string) => ({ text, bytes: text.length, records: 1, dayKey: '2026-11-14' })

  test('prettyLine formats ids, fields and errors; escapes control characters', () => {
    const line = JSON.stringify({
      time: '2026-11-14T12:03:04.567Z',
      level: 'error',
      msg: 'bad\u001b[31mred',
      requestId: 'r1',
      fields: { a: 1 },
      err: { message: 'x' },
    })
    const out = prettyLine(line)
    expect(out).toBe(
      '12:03:04.567 ERROR bad\\u001b[31mred (requestId=r1) {"a":1,"err":{"message":"x"}}',
    )
    expect(prettyLine('not json')).toBe('not json')
    expect(prettyLine('{"level":"custom"}')).toBe(' custom ')
  })

  test('stdout, pretty and stderr transports write to their stream', async () => {
    const out = captureStream()
    await stdoutTransport(out.stream).write(batch('{"msg":"a"}\n'))
    await prettyTransport(out.stream).write(batch('{"level":"info","msg":"b"}\n'))
    await stderrTransport(out.stream).write(batch('c\n'))
    expect(out.text()).toBe('{"msg":"a"}\n INFO  b\nc\n')
    for (const t of [
      stdoutTransport(out.stream),
      prettyTransport(out.stream),
      stderrTransport(out.stream),
    ]) {
      await expect(t.close()).resolves.toBeUndefined()
    }
  })

  test('the stderr fallback never throws, even if its stream does', async () => {
    const t = stderrTransport({
      write() {
        throw new Error('EPIPE')
      },
    })
    await expect(t.write(batch('x'))).resolves.toBeUndefined()
  })
})
