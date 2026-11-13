/**
 * CSV export that is safe to open in spreadsheet apps.
 *
 * **CSV injection:** a cell starting with `=`, `+`, `-`, `@`, tab or carriage return can run as a
 * formula in Excel, LibreOffice or Google Sheets. Log text comes from users (paths, messages), so
 * such cells get a leading `'`, which spreadsheets show as plain text (OWASP guidance).
 *
 * @module
 */
import type { ViewerRecord } from './filters.ts'

/** The exported columns, in order. Objects (`fields`, `err`) are written as JSON. */
export const CSV_COLUMNS: readonly string[] = Object.freeze([
  'time',
  'level',
  'msg',
  'requestId',
  'traceId',
  'tenantId',
  'actorId',
  'fields',
  'err',
])

/** Format one value as a CSV cell: formula-neutralised and quoted when needed. */
export function csvCell(value: unknown): string {
  if (value === undefined || value === null) return ''
  let text =
    typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** The header row (with CRLF, as RFC 4180 specifies). */
export function csvHeader(): string {
  return `${CSV_COLUMNS.join(',')}\r\n`
}

/** One record as a CSV row (with CRLF). */
export function csvRow(record: ViewerRecord): string {
  return `${CSV_COLUMNS.map((column) => csvCell(record[column])).join(',')}\r\n`
}
