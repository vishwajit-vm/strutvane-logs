/**
 * Record → exactly ONE line of NDJSON. Never throws.
 *
 * - **Escaping:** `JSON.stringify` escapes CR, LF and every control character, including ESC (ANSI
 *   colour codes) and NUL. A message can therefore never forge extra log lines or colour a
 *   terminal, which makes it safe against log injection.
 * - **U+2028 / U+2029** are not escaped by `JSON.stringify`, and some viewers treat them as line
 *   breaks, so they are escaped explicitly.
 * - **Size cap:** a record larger than `maxBytes` is replaced by a small, well-formed marker record.
 *   One huge log call can never blow up memory, the disk or the viewer.
 *
 * @module
 */

/** U+2028 / U+2029, built from char codes so this file never contains a literal line separator. */
export const LINE_SEPARATOR: string = String.fromCharCode(0x2028)
export const PARAGRAPH_SEPARATOR: string = String.fromCharCode(0x2029)
const BACKSLASH = String.fromCharCode(0x5c)

/** Default maximum size of one record, in bytes (RFC-0004 §6). */
export const DEFAULT_MAX_RECORD_BYTES: number = 32 * 1024

function safeSlice(msg: unknown): string {
  return typeof msg === 'string' ? msg.slice(0, 1024) : '[non-string message]'
}

/** Escape U+2028/U+2029 inside an already-serialised JSON string. */
export function escapeLineSeparators(json: string): string {
  if (!json.includes(LINE_SEPARATOR) && !json.includes(PARAGRAPH_SEPARATOR)) return json
  return json
    .split(LINE_SEPARATOR)
    .join(`${BACKSLASH}u2028`)
    .split(PARAGRAPH_SEPARATOR)
    .join(`${BACKSLASH}u2029`)
}

/** What the serialiser needs to know about a record (the rest is serialised as-is). */
export interface SerializableRecord {
  readonly time?: unknown
  readonly level?: unknown
  readonly msg?: unknown
  readonly [key: string]: unknown
}

/**
 * Serialise a (sanitised) record to one NDJSON line, including the trailing `\n`.
 *
 * @param record a JSON-safe object (output of the sanitiser)
 * @param maxBytes the size cap; larger records become a `truncated: true` marker
 */
export function serializeRecord(
  record: SerializableRecord,
  maxBytes: number = DEFAULT_MAX_RECORD_BYTES,
): string {
  let json: string
  try {
    json = JSON.stringify(record)
  } catch (error) {
    json = JSON.stringify({
      time: record.time,
      level: record.level,
      msg: safeSlice(record.msg),
      fields: { serializationError: error instanceof Error ? error.message : 'unknown' },
    })
  }
  json = escapeLineSeparators(json)
  // Byte length only matters near the limit: JSON is at most 3 bytes per UTF-16 unit.
  if (json.length * 3 > maxBytes) {
    const bytes = Buffer.byteLength(json)
    if (bytes > maxBytes) {
      json = escapeLineSeparators(
        JSON.stringify({
          time: record.time,
          level: record.level,
          msg: safeSlice(record.msg),
          fields: { truncated: true, originalBytes: bytes },
        }),
      )
    }
  }
  return `${json}\n`
}
