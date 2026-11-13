/** registerShutdownFlush in-process (the child-process tests prove the real exit behaviour). */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createPipelineLogger, type StrutvaneLogger } from '../src/logger.ts'
import { registerShutdownFlush } from '../src/shutdown.ts'
import { memoryTransport, sleep } from './helpers.ts'

const unregister: Array<() => void> = []
afterEach(() => {
  for (const u of unregister.splice(0)) u()
})

function fakeLogger(drain: StrutvaneLogger['drain']): StrutvaneLogger {
  return { ...createPipelineLogger({ transport: memoryTransport() }), drain }
}

describe('registerShutdownFlush', () => {
  test('a signal drains, then exits with 128 + the signal number', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const t = memoryTransport()
    const logger = createPipelineLogger({ transport: t })
    unregister.push(registerShutdownFlush(logger, { signals: ['SIGHUP'], timeoutMs: 1_000 }))
    logger.info('last words')
    process.emit('SIGHUP', 'SIGHUP')
    process.emit('SIGHUP', 'SIGHUP') // a second signal while flushing is ignored
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(129))
    expect(exit).toHaveBeenCalledTimes(1)
    expect(t.records().map((r) => r.msg)).toEqual(['last words'])
  })

  test('a drain that never finishes still exits at the deadline', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const logger = fakeLogger(() => new Promise(() => {}))
    unregister.push(registerShutdownFlush(logger, { signals: ['SIGINT'], timeoutMs: 30 }))
    process.emit('SIGINT', 'SIGINT')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130))
  })

  test('a drain that rejects or misses the deadline exits once, at the deadline', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const logger = fakeLogger(() => Promise.reject(new Error('broken')))
    unregister.push(registerShutdownFlush(logger, { signals: ['SIGTERM'], timeoutMs: 30 }))
    process.emit('SIGTERM', 'SIGTERM')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143))
    await sleep(50)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  test('exitOnSignal: false drains without exiting (the host app exits itself)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const drain = vi.fn(() => Promise.resolve({ flushed: true, pending: 0 }))
    unregister.push(
      registerShutdownFlush(fakeLogger(drain), {
        signals: ['SIGTERM'],
        exitOnSignal: false,
        timeoutMs: 20,
      }),
    )
    process.emit('SIGTERM', 'SIGTERM')
    await sleep(40)
    expect(drain).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
  })

  test('beforeExit drains once; unregister removes every listener', () => {
    const drain = vi.fn(() => Promise.resolve({ flushed: true, pending: 0 }))
    const before = {
      exit: process.listenerCount('beforeExit'),
      term: process.listenerCount('SIGTERM'),
    }
    const off = registerShutdownFlush(fakeLogger(drain))
    expect(process.listenerCount('beforeExit')).toBe(before.exit + 1)
    process.emit('beforeExit', 0)
    process.emit('beforeExit', 0)
    expect(drain).toHaveBeenCalledTimes(1)
    off()
    expect(process.listenerCount('beforeExit')).toBe(before.exit)
    expect(process.listenerCount('SIGTERM')).toBe(before.term)
  })
})
