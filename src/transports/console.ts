/**
 * Console transports: JSON lines to stdout (production, container platforms), human-friendly
 * "pretty" lines (development), and the stderr fallback.
 *
 * @module
 */
import type { Batch, Transport, WritableLike } from './types.ts'

/** JSON lines to a stream (default `process.stdout`). */
export function stdoutTransport(stream: WritableLike = process.stdout): Transport {
  return {
    name: 'stdout',
    write(batch: Batch): Promise<void> {
      stream.write(batch.text)
      return Promise.resolve()
    },
    close: () => Promise.resolve(),
  }
}

/** A parsed NDJSON record (only the keys the formatter reads are declared). */
interface ParsedLine {
  time?: unknown
  level?: unknown
  msg?: unknown
  fields?: unknown
  err?: unknown
  [key: string]: unknown
}

const LEVEL_LABEL: Readonly<Record<string, string>> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
  fatal: 'FATAL',
}

/**
 * Format one NDJSON line for humans: `12:03:04.567 INFO  Invoice sent {"invoiceId":"…"}`.
 * Unparseable lines are passed through unchanged (they're already safe, escaped JSON).
 */
export function prettyLine(line: string): string {
  let rec: ParsedLine
  try {
    rec = JSON.parse(line) as ParsedLine
  } catch {
    return line
  }
  const time = typeof rec.time === 'string' ? rec.time.slice(11, 23) : ''
  const label = LEVEL_LABEL[String(rec.level)] ?? String(rec.level)
  const ids = ['requestId', 'traceId', 'tenantId', 'actorId']
    .filter((k) => typeof rec[k] === 'string')
    .map((k) => `${k}=${String(rec[k])}`)
  const extra: Record<string, unknown> & { err?: unknown } = {}
  if (rec.fields && typeof rec.fields === 'object') Object.assign(extra, rec.fields)
  if (rec.err) extra.err = rec.err
  const tail = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : ''
  const idText = ids.length > 0 ? ` (${ids.join(' ')})` : ''
  // Messages are re-escaped through JSON.stringify, so control characters can't reach the terminal.
  const msg = JSON.stringify(String(rec.msg ?? '')).slice(1, -1)
  return `${time} ${label} ${msg}${idText}${tail}`
}

/** Human-friendly lines to a stream (default `process.stdout`). For local development. */
export function prettyTransport(stream: WritableLike = process.stdout): Transport {
  return {
    name: 'pretty',
    write(batch: Batch): Promise<void> {
      const out = batch.text
        .split('\n')
        .filter((l) => l.length > 0)
        .map(prettyLine)
        .join('\n')
      stream.write(`${out}\n`)
      return Promise.resolve()
    },
    close: () => Promise.resolve(),
  }
}

/**
 * The fallback transport, used when the primary fails. It must be the most boring code in the
 * package: it never rejects and never throws, whatever the stream does.
 */
export function stderrTransport(stream: WritableLike = process.stderr): Transport {
  return {
    name: 'stderr',
    write(batch: Batch): Promise<void> {
      try {
        stream.write(batch.text)
      } catch {
        // Nowhere left to report to. For a fallback, swallowing is the only safe option.
      }
      return Promise.resolve()
    },
    close: () => Promise.resolve(),
  }
}
