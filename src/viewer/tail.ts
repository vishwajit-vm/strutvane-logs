/**
 * Live tail over Server-Sent Events: poll the log directory and stream newly appended records.
 *
 * - **Starts at the end** of the existing files: only new records are sent.
 * - **Follows rotation:** a new size part or a new day's file is picked up from its first byte.
 *   A file that shrinks (cleared and recreated) is re-read from the start.
 * - **Never sends torn lines:** bytes after the last newline are held back until completed.
 * - **Bounded:** at most `maxReadBytes` per file per poll; the rest comes on the next poll.
 * - **Cleans up:** timers stop when the client disconnects or the request is aborted.
 *
 * Polling (rather than `fs.watch`) is deliberate: it behaves the same on every OS and filesystem,
 * including network and container volumes where watch events are unreliable.
 *
 * @module
 */
import { join } from 'node:path'
import { dayKeyOf } from '../files.ts'
import type { Sanitizer } from '../redact.ts'
import type { RecordFilter, RecordQuery } from './filters.ts'
import { accept, cleanLine, describeFiles, readRange, viewerSanitizer } from './store.ts'

/** Options for {@link createTailStream}. */
export interface TailOptions {
  readonly dir: string
  readonly query: RecordQuery
  readonly scope?: RecordFilter | undefined
  /** How often to check for new bytes. Default: 1,000 ms. */
  readonly pollMs?: number
  /** How often to send a keep-alive comment. Default: 15,000 ms. */
  readonly heartbeatMs?: number
  /** Maximum bytes read from one file per poll. Default: 1 MiB. */
  readonly maxReadBytes?: number
  readonly signal?: AbortSignal
  readonly now?: () => number
  readonly sanitize?: Sanitizer
  /** Called exactly once when the stream ends for any reason. */
  readonly onClose?: () => void
}

interface Followed {
  offset: number
  pending: Buffer
}

/** Create an SSE byte stream that tails the log directory. */
export function createTailStream(options: TailOptions): ReadableStream<Uint8Array> {
  const pollMs = options.pollMs ?? 1_000
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const maxRead = options.maxReadBytes ?? 1024 * 1024
  const now = options.now ?? Date.now
  const sanitize = options.sanitize ?? viewerSanitizer
  const encoder = new TextEncoder()
  const startDay = dayKeyOf(now())
  const followed = new Map<string, Followed>()
  let pollTimer: NodeJS.Timeout | undefined
  let heartbeatTimer: NodeJS.Timeout | undefined
  let closed = false

  const close = (): void => {
    if (closed) return
    closed = true
    clearTimeout(pollTimer)
    clearInterval(heartbeatTimer)
    options.signal?.removeEventListener('abort', onAbort)
    options.onClose?.()
  }
  let onAbort: () => void = close

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          close()
        }
      }
      onAbort = () => {
        close()
        try {
          controller.close()
        } catch {
          // Already closed.
        }
      }
      if (options.signal?.aborted) {
        onAbort()
        return
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      // Start at the end of what already exists.
      for (const file of await describeFiles(options.dir)) {
        if (file.day >= startDay)
          followed.set(file.name, { offset: file.size, pending: Buffer.alloc(0) })
      }
      send(`retry: ${Math.max(pollMs, 1_000)}\n: connected\n\n`)

      const poll = async (): Promise<void> => {
        if (closed) return
        try {
          const files = (await describeFiles(options.dir))
            .filter((f) => f.day >= startDay)
            .reverse()
          for (const file of files) {
            let state = followed.get(file.name)
            if (!state || file.size < state.offset) {
              state = { offset: 0, pending: Buffer.alloc(0) }
              followed.set(file.name, state)
            }
            if (file.size === state.offset) continue
            const end = Math.min(file.size, state.offset + maxRead)
            const chunk = await readRange(join(options.dir, file.name), state.offset, end)
            state.offset += chunk.length
            const data = state.pending.length > 0 ? Buffer.concat([state.pending, chunk]) : chunk
            const lastNewline = data.lastIndexOf(0x0a)
            if (lastNewline === -1) {
              state.pending = data
              continue
            }
            state.pending = Buffer.from(data.subarray(lastNewline + 1))
            for (const line of data.subarray(0, lastNewline).toString('utf8').split('\n')) {
              const clean = cleanLine(line, sanitize)
              if (clean && accept(clean, options.query, options.scope))
                send(`data: ${clean.json}\n\n`)
            }
          }
        } catch {
          // A transient filesystem error: try again at the next poll.
        }
        if (!closed) {
          pollTimer = setTimeout(() => void poll(), pollMs)
          pollTimer.unref()
        }
      }
      heartbeatTimer = setInterval(() => send(': ping\n\n'), heartbeatMs)
      heartbeatTimer.unref()
      pollTimer = setTimeout(() => void poll(), pollMs)
      pollTimer.unref()
    },
    cancel() {
      close()
    },
  })
}
