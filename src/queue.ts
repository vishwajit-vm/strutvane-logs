/**
 * Bounded, priority-aware queue of serialised log lines (RFC-0004 §6, "log flooding").
 *
 * Guarantees:
 * - **Bounded:** never holds more than `maxRecords` items or `maxBytes` bytes.
 * - **Priority when full:**
 *   - an incoming low-severity record (trace/debug/info) is dropped
 *   - an incoming important record (warn and up) evicts the oldest low record
 *   - only when the queue holds nothing but important records is the oldest important record
 *     evicted, so the queue stays bounded no matter what
 * - **Counted drops:** drops are counted per level, so the logger can report them later.
 * - **Ordered output:** items come out in input order. There are two FIFOs, merged by sequence
 *   number when drained.
 *
 * @module
 */
import type { LogLevel } from '@strutvane/contracts'
import { IMPORTANT_SEVERITY } from './levels.ts'

/** One serialised record waiting to be written. */
export interface QueueItem {
  readonly seq: number
  readonly line: string
  readonly bytes: number
  readonly severity: number
  readonly level: LogLevel
  /** UTC day of the record (`YYYY-MM-DD`). A batch never mixes days, which keeps rotation correct. */
  readonly dayKey: string
}

/** Queue limits. */
export interface QueueLimits {
  readonly maxRecords: number
  readonly maxBytes: number
}

/** Default limits: 10,000 records or 16 MB, whichever is reached first. */
export const DEFAULT_QUEUE_LIMITS: QueueLimits = Object.freeze({
  maxRecords: 10_000,
  maxBytes: 16 * 1024 * 1024,
})

/** A FIFO with O(1) amortised shift (no `Array.prototype.shift` re-indexing). */
class Fifo {
  private items: (QueueItem | undefined)[] = []
  private head = 0

  get length(): number {
    return this.items.length - this.head
  }

  push(item: QueueItem): void {
    this.items.push(item)
  }

  peek(): QueueItem | undefined {
    return this.items[this.head]
  }

  shift(): QueueItem | undefined {
    const item = this.items[this.head]
    if (item === undefined) return undefined
    this.items[this.head] = undefined // release for GC
    this.head++
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head)
      this.head = 0
    }
    return item
  }
}

/** Outcome of {@link BoundedQueue.push}. */
export type PushResult = 'queued' | 'dropped' | 'evicted-other'

/** The bounded queue. */
export class BoundedQueue {
  private readonly low = new Fifo()
  private readonly high = new Fifo()
  private bytes = 0
  private dropped: Partial<Record<LogLevel, number>> = {}
  private readonly limits: QueueLimits
  /** Highest record count seen (for stats and tests). */
  peakRecords = 0
  /** Highest byte size seen. */
  peakBytes = 0

  constructor(limits: QueueLimits = DEFAULT_QUEUE_LIMITS) {
    if (limits.maxRecords < 1 || limits.maxBytes < 1)
      throw new RangeError('queue limits must be ≥ 1')
    this.limits = limits
  }

  /** Records currently queued. */
  get size(): number {
    return this.low.length + this.high.length
  }

  /** Bytes currently queued. */
  get byteSize(): number {
    return this.bytes
  }

  /** Add an item, dropping or evicting according to the priority rules. */
  push(item: QueueItem): PushResult {
    const important = item.severity >= IMPORTANT_SEVERITY
    let result: PushResult = 'queued'
    while (this.size >= this.limits.maxRecords || this.bytes + item.bytes > this.limits.maxBytes) {
      if (this.size === 0 || !important) {
        // Empty but still too big, or a low record arriving at a full queue: drop the newcomer.
        this.count(item.level)
        return 'dropped'
      }
      const victim = this.low.length > 0 ? this.low.shift() : this.high.shift()
      if (victim) {
        this.bytes -= victim.bytes
        this.count(victim.level)
        result = 'evicted-other'
      }
    }
    ;(important ? this.high : this.low).push(item)
    this.bytes += item.bytes
    if (this.size > this.peakRecords) this.peakRecords = this.size
    if (this.bytes > this.peakBytes) this.peakBytes = this.bytes
    return result
  }

  /**
   * Remove and return the oldest items in input order, up to `maxBytes`. At least one item is
   * returned, and every item belongs to the same day as the oldest one.
   */
  takeBatch(maxBytes: number): QueueItem[] {
    const out: QueueItem[] = []
    let total = 0
    let day: string | undefined
    for (;;) {
      const a = this.low.peek()
      const b = this.high.peek()
      const next = a && b ? (a.seq < b.seq ? a : b) : (a ?? b)
      if (!next) break
      if (day === undefined) day = next.dayKey
      else if (next.dayKey !== day) break
      if (out.length > 0 && total + next.bytes > maxBytes) break
      ;(next === a ? this.low : this.high).shift()
      this.bytes -= next.bytes
      total += next.bytes
      out.push(next)
    }
    return out
  }

  /** Drop counts per level since the last call, then reset them. `undefined` if nothing dropped. */
  takeDropped(): Partial<Record<LogLevel, number>> | undefined {
    const d = this.dropped
    if (Object.keys(d).length === 0) return undefined
    this.dropped = {}
    return d
  }

  private count(level: LogLevel): void {
    this.dropped[level] = (this.dropped[level] ?? 0) + 1
  }
}
