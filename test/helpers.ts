import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareLogFiles } from '../src/files.ts'
import type { Batch, FileWriter, FileWriterFactory, Transport } from '../src/transports/types.ts'

/** A fresh temp directory and its cleanup function. */
export function tempDir(prefix = 'sv-logs-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  }
}

export type Rec = Record<string, unknown> & {
  time?: string
  level?: string
  msg?: string
  requestId?: string
  traceId?: string
  tenantId?: string
  fields?: Record<string, unknown>
  err?: Record<string, unknown>
}

/** Parse every log file in `dir` in log order. Throws on any torn or invalid line. */
export function readLogDir(dir: string): Array<{ file: string; records: Rec[] }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ndjson'))
    .sort(compareLogFiles)
    .map((file) => {
      const text = readFileSync(join(dir, file), 'utf8')
      if (text.length > 0 && !text.endsWith('\n'))
        throw new Error(`${file}: last line is not terminated`)
      const records = text
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l, i) => {
          try {
            return JSON.parse(l) as Rec
          } catch {
            throw new Error(`${file}:${i + 1}: torn or invalid line: ${l.slice(0, 120)}`)
          }
        })
      return { file, records }
    })
}

/** All records in `dir`, in log order. */
export const allRecords = (dir: string): Rec[] => readLogDir(dir).flatMap((f) => f.records)

/** An in-memory transport that records batches (optionally slow). */
export function memoryTransport(
  opts: { delayMs?: number } = {},
): Transport & { batches: Batch[]; text: () => string; records: () => Rec[]; closed: number } {
  const batches: Batch[] = []
  const t = {
    name: 'memory',
    batches,
    closed: 0,
    text: () => batches.map((b) => b.text).join(''),
    records: () =>
      t
        .text()
        .split('\n')
        .filter((l) => l)
        .map((l) => JSON.parse(l) as Rec),
    async write(batch: Batch): Promise<void> {
      if (opts.delayMs) await sleep(opts.delayMs)
      batches.push(batch)
    },
    async close(): Promise<void> {
      t.closed++
    },
  }
  return t
}

/** A transport whose writes fail (or succeed) as controlled by `failing.value`. */
export function flakyTransport(): Transport & {
  failing: { value: boolean }
  ok: Batch[]
  attempts: number
} {
  const t = {
    name: 'flaky',
    failing: { value: true },
    ok: [] as Batch[],
    attempts: 0,
    async write(batch: Batch): Promise<void> {
      t.attempts++
      if (t.failing.value)
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      t.ok.push(batch)
    },
    async close(): Promise<void> {},
  }
  return t
}

/** A stream stand-in that captures what is written to it. */
export function captureStream(): {
  stream: { write(chunk: string): boolean }
  text: () => string
  lines: () => Rec[]
} {
  let text = ''
  return {
    stream: {
      write(chunk: string): boolean {
        text += chunk
        return true
      },
    },
    text: () => text,
    lines: () =>
      text
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Rec),
  }
}

/** A file writer factory whose appends fail with an errno `code` (e.g. ENOSPC) after `after` writes. */
export function failingWriter(code: string, after = 0): FileWriterFactory {
  let writes = 0
  return async (): Promise<FileWriter> => ({
    async append(): Promise<void> {
      writes++
      if (writes > after) throw Object.assign(new Error(`${code}: simulated`), { code })
    },
    async close(): Promise<void> {},
  })
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll `check` until it returns true, or fail after `timeoutMs`. */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await check()) return
    await sleep(10)
  }
  throw new Error('waitFor: timed out')
}
