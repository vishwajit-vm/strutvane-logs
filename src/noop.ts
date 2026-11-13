/**
 * The no-op logger, used when logging is switched off (`LOGS_ENABLED=false`). Every call is a cheap
 * no-op, so application code never needs to check whether logging is enabled.
 *
 * @module
 */
import type { LogLevel } from '@strutvane/contracts'
import type { FlushResult, LoggerStats, StrutvaneLogger } from './logger.ts'

const DONE: FlushResult = Object.freeze({ flushed: true, pending: 0 })
const STATS: LoggerStats = Object.freeze({
  written: 0,
  dropped: 0,
  droppedByLevel: {},
  fallbackActive: false,
  primaryFailures: 0,
  fallbackWarnings: 0,
  internalErrors: 0,
  queued: 0,
  queuePeak: 0,
  queuePeakBytes: 0,
})

/** Create a logger that does nothing. */
export function createNoopLogger(level: LogLevel = 'info'): StrutvaneLogger {
  const noop = (): void => {}
  const logger: StrutvaneLogger = {
    level,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
    isLevelEnabled: () => false,
    flush: () => Promise.resolve(),
    drain: () => Promise.resolve(DONE),
    close: () => Promise.resolve(DONE),
    stats: () => STATS,
  }
  return logger
}
