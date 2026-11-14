/**
 * Live tail over Server-Sent Events: poll the log directory and stream newly appended records.
 *
 * - **Starts at the end** of the existing files: only new records are sent.
 * - **Follows rotation:** a new size part or a new day's file is picked up from its first byte.
 *   A file that shrinks (cleared and recreated) is re-read from the start.
 * - **Never sends torn lines:** bytes after the last newline are held back until completed.
 * - **Bounded:** at most `maxReadBytes` per file per poll; the rest comes on the next poll.
 * - **Always releases:** `onClose` runs exactly once on every way a stream can end: the request is
 *   aborted, the consumer cancels, an enqueue fails, setup fails, the consumer stops reading
 *   (nothing delivered for `stallBeats` heartbeats while data waits, or more than `maxQueuedBytes`
 *   waiting), or the stream reaches `maxDurationMs`. The last three matter when a server neither
 *   aborts the request nor cancels the body after a client goes away: without them a dead client
 *   would hold a tail slot, and buffer heartbeats, forever. `EventSource` clients reconnect by
 *   themselves, so ending a healthy stream is harmless.
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
  /**
   * End the stream when the consumer took nothing for this many heartbeats while data was
   * waiting. Default: 3 (45 s with the default heartbeat).
   */
  readonly stallBeats?: number
  /** End the stream when more than this many bytes wait for the consumer. Default: 1 MiB. */
  readonly maxQueuedBytes?: number
  /** End the stream after this long, whatever happens. Default: 1 hour. */
  readonly maxDurationMs?: number
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
  const stallBeats = options.stallBeats ?? 3
  const maxQueued = options.maxQueuedBytes ?? 1024 * 1024
  const maxDurationMs = options.maxDurationMs ?? 60 * 60 * 1000
  const now = options.now ?? Date.now
  const sanitize = options.sanitize ?? viewerSanitizer
  const encoder = new TextEncoder()
  const startDay = dayKeyOf(now())
  const followed = new Map<string, Followed>()
  let pollTimer: NodeJS.Timeout | undefined
  let heartbeatTimer: NodeJS.Timeout | undefined
  let lifetimeTimer: NodeJS.Timeout | undefined
  let closed = false
  // Delivery accounting in bytes (the queuing strategy below counts bytes).
  let enqueued = 0
  let deliveredAtLastBeat = 0
  let stalled = 0

  const close = (): void => {
    if (closed) return
    closed = true
    clearTimeout(pollTimer)
    clearInterval(heartbeatTimer)
    clearTimeout(lifetimeTimer)
    options.signal?.removeEventListener('abort', onAbort)
    options.onClose?.()
  }
  let onAbort: () => void = close

  return new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        /** End the stream from our side: release everything, then close the body. */
        const end = (): void => {
          close()
          try {
            controller.close()
          } catch {
            // Already closed or errored.
          }
        }
        /** Bytes waiting for the consumer (the high-water mark is 0, so all of the queue). */
        const queued = (): number => -(controller.desiredSize ?? 0)
        const send = (text: string): void => {
          if (closed) return
          try {
            const bytes = encoder.encode(text)
            controller.enqueue(bytes)
            enqueued += bytes.byteLength
          } catch {
            close()
            return
          }
          if (queued() > maxQueued) end()
        }
        onAbort = end
        if (options.signal?.aborted) {
          end()
          return
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })

        try {
          // Start at the end of what already exists.
          for (const file of await describeFiles(options.dir)) {
            if (file.day >= startDay)
              followed.set(file.name, { offset: file.size, pending: Buffer.alloc(0) })
          }
        } catch {
          end()
          return
        }
        if (closed) return
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
              const endAt = Math.min(file.size, state.offset + maxRead)
              const chunk = await readRange(join(options.dir, file.name), state.offset, endAt)
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

        const beat = (): void => {
          // A consumer that took nothing since the last beat while bytes were waiting is stalled.
          const delivered = enqueued - queued()
          stalled = queued() > 0 && delivered === deliveredAtLastBeat ? stalled + 1 : 0
          deliveredAtLastBeat = delivered
          if (stalled >= stallBeats) {
            end()
            return
          }
          send(': ping\n\n')
        }
        heartbeatTimer = setInterval(beat, heartbeatMs)
        heartbeatTimer.unref()
        lifetimeTimer = setTimeout(end, maxDurationMs)
        lifetimeTimer.unref()
        pollTimer = setTimeout(() => void poll(), pollMs)
        pollTimer.unref()
      },
      cancel() {
        close()
      },
    },
    // Count bytes, with no read-ahead: everything queued is waiting for the consumer.
    { highWaterMark: 0, size: (chunk) => chunk.byteLength },
  )
}
