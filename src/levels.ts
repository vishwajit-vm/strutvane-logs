/**
 * Log levels. Names and numeric severities come from `@strutvane/contracts`, so every Strutvane
 * package agrees on them.
 *
 * @module
 */
import { LOG_LEVEL_SEVERITY, LOG_LEVELS, type LogLevel } from '@strutvane/contracts'

export type { LogLevel }
export { LOG_LEVEL_SEVERITY, LOG_LEVELS }

/**
 * Records at or above this severity (warn, error, fatal) are "important": when the queue is full,
 * less important records are dropped first (ADR-0015).
 */
export const IMPORTANT_SEVERITY: number = LOG_LEVEL_SEVERITY.warn

/** Is `value` one of the six level names? */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

/** Numeric severity of a level (higher = more severe). */
export function severityOf(level: LogLevel): number {
  return LOG_LEVEL_SEVERITY[level]
}
