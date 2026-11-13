/**
 * Real child processes: shutdown flushing (RFC-0004 §6) and several processes writing one log
 * directory (ADR-0015 per-process files).
 */
import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { allRecords, tempDir } from './helpers.ts'

const shutdownChild = fileURLToPath(new URL('./fixtures/shutdown-child.ts', import.meta.url))
const writerChild = fileURLToPath(new URL('./fixtures/child-writer.ts', import.meta.url))
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function dir(): string {
  const t = tempDir()
  cleanups.push(t.cleanup)
  return t.dir
}

function run(
  args: string[],
  onReady?: (kill: () => void) => void,
): Promise<{ code: number | null; ms: number; stdout: string }> {
  return new Promise((resolve) => {
    const started = performance.now()
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    p.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      if (onReady && stdout.includes('READY')) onReady(() => p.kill('SIGTERM'))
    })
    p.once('exit', (code) => resolve({ code, ms: performance.now() - started, stdout }))
  })
}

const countShutdown = (d: string): number =>
  allRecords(d).filter((r) => r.msg === 'shutdown-test').length

describe('shutdown flush (child processes)', () => {
  test('SIGTERM: every queued record is written before exit, and the exit code is 143', async () => {
    const d = dir()
    const r = await run([shutdownChild, d, 'signal-emit', '20000'])
    expect(r.code).toBe(143)
    expect(countShutdown(d)).toBe(20_000)
  })

  test.skipIf(process.platform === 'win32')(
    'a real external SIGTERM flushes too (Linux/macOS)',
    async () => {
      const d = dir()
      const r = await run([shutdownChild, d, 'signal-real', '20000'], (kill) => kill())
      expect(r.code).toBe(143)
      expect(countShutdown(d)).toBe(20_000)
    },
  )

  test('beforeExit: a process that just ends still writes everything', async () => {
    const d = dir()
    const r = await run([shutdownChild, d, 'before-exit', '20000'])
    expect(r.code).toBe(0)
    expect(countShutdown(d)).toBe(20_000)
  })

  test('a hung transport cannot block shutdown beyond the deadline, and 143 survives', async () => {
    const d = dir()
    const r = await run([shutdownChild, d, 'hung', '1000'])
    expect(r.code).toBe(143)
    expect(r.ms).toBeGreaterThanOrEqual(300)
    expect(r.ms).toBeLessThan(5_000)
  })
})

describe('several processes, one log directory', () => {
  test('per-process files: no torn lines, nothing lost, size cap respected', async () => {
    const d = dir()
    const procs = 4
    const count = 10_000
    const cap = 256 * 1024
    const results = await Promise.all(
      Array.from({ length: procs }, (_, id) =>
        run([writerChild, d, String(id), String(count), String(cap)]),
      ),
    )
    for (const r of results) expect(r.code).toBe(0)

    const files = readdirSync(d).filter((f) => f.endsWith('.ndjson'))
    for (const f of files) {
      expect(f).toMatch(/\.w\d+(-\d+)?\.ndjson$/)
      expect(statSync(join(d, f)).size).toBeLessThanOrEqual(cap)
    }
    const perProc = new Map<number, Set<number>>()
    for (const r of allRecords(d)) {
      const f = r.fields as { proc: number; i: number }
      if (!perProc.has(f.proc)) perProc.set(f.proc, new Set())
      perProc.get(f.proc)?.add(f.i)
    }
    for (let p = 0; p < procs; p++) expect(perProc.get(p)?.size).toBe(count)
  })
})
