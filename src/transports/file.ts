/**
 * The file transport: daily files, a size cap per file and retention (RFC-0004 §4, ADR-0015).
 *
 * Rotation never renames or truncates a file: a new day or a new part is a NEW file. A reader that
 * is tailing the old file never sees it change underneath it, and never reads a torn line as long
 * as it only consumes up to the last `\n`.
 *
 * @module
 */
import { mkdir, open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { applyRetention, dayKeyOf, fileName } from '../files.ts'
import type { Batch, FileWriter, FileWriterFactory, Transport } from './types.ts'

/**
 * Strutvane's own append-only writer (ADR-0015: as fast as sonic-boom or faster, no dependency).
 * It opens with flag `a` (O_APPEND). Each batch is ONE logical write of whole lines, and partial
 * writes are completed in a loop, so we never leave a line half-written.
 */
export const appendFileWriter: FileWriterFactory = async (path) => {
  const handle = await open(path, 'a')
  return {
    async append(text: string): Promise<void> {
      // The buffer's own length is the exact byte count (the caller's `bytes` is only used for
      // rotation accounting).
      const buf = Buffer.from(text, 'utf8')
      const length = buf.length
      let offset = 0
      while (offset < length) {
        const { bytesWritten } = await handle.write(buf, offset, length - offset, null)
        if (bytesWritten <= 0) throw new Error('write returned 0 bytes')
        offset += bytesWritten
      }
    },
    async close(): Promise<void> {
      await handle.close()
    },
  }
}

/** Options for {@link fileTransport}. */
export interface FileTransportOptions {
  /** Directory for log files (created if missing). */
  readonly dir: string
  /** Size cap per file in bytes. Default: 30 MB. */
  readonly maxFileBytes?: number
  /** Delete files older than this many days. Default: 60. `0` disables retention. */
  readonly retentionDays?: number
  /**
   * Writer tag for multi-process setups, e.g. `w3`. Each tag writes its own files, which keeps the
   * size cap correct (ADR-0015).
   */
  readonly tag?: string
  /** Injectable writer factory. Default: {@link appendFileWriter}. */
  readonly writer?: FileWriterFactory
  /** Injectable clock, used for retention. */
  readonly now?: () => number
}

/** A file transport that can report the file it's currently writing. */
export interface FileTransport extends Transport {
  readonly currentFile: () => string | undefined
}

/** Create a rotating file transport. */
export function fileTransport(options: FileTransportOptions): FileTransport {
  const maxFileBytes = options.maxFileBytes ?? 30 * 1024 * 1024
  const retentionDays = options.retentionDays ?? 60
  const openWriter = options.writer ?? appendFileWriter
  const now = options.now ?? Date.now
  if (options.tag !== undefined && !/^w[A-Za-z0-9_]{1,32}$/.test(options.tag)) {
    throw new RangeError(`invalid writer tag "${options.tag}": use "w" followed by letters/digits`)
  }
  let dayKey: string | undefined
  let part = 0
  let size = 0
  let writer: FileWriter | undefined
  let path: string | undefined

  const openPart = async (day: string): Promise<void> => {
    await mkdir(options.dir, { recursive: true })
    // Resume after a restart: continue the newest part of the day that still has room.
    for (;;) {
      const candidate = join(options.dir, fileName(day, part, options.tag))
      const existing = await stat(candidate).catch(() => undefined)
      if (!existing || existing.size < maxFileBytes) {
        size = existing?.size ?? 0
        path = candidate
        writer = await openWriter(candidate)
        return
      }
      part++
    }
  }

  const close = async (): Promise<void> => {
    const w = writer
    writer = undefined
    if (w) await w.close()
  }

  return {
    name: 'file',
    currentFile: () => path,
    async write(batch: Batch): Promise<void> {
      if (batch.dayKey !== dayKey) {
        await close()
        dayKey = batch.dayKey
        part = 0
        if (retentionDays > 0) {
          await applyRetention(options.dir, retentionDays, now()).catch(() => undefined)
        }
        await openPart(batch.dayKey)
      } else if (!writer) {
        await openPart(batch.dayKey)
      } else if (size > 0 && size + batch.bytes > maxFileBytes) {
        await close()
        part++
        await openPart(batch.dayKey)
      }
      const w = writer
      if (!w) throw new Error('log file is not open')
      try {
        await w.append(batch.text, batch.bytes)
      } catch (error) {
        // Force a reopen on the next write: the directory may come back.
        await close().catch(() => undefined)
        throw error
      }
      size += batch.bytes
    },
    close,
  }
}

/** Today's UTC day key (exported for tooling that needs to skip the active day). */
export function today(now: () => number = Date.now): string {
  return dayKeyOf(now())
}
