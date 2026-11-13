/**
 * The zero-config default logger, `log`. It is created lazily on first use (importing the package
 * has no side effects). It reads the environment, writes to `storage/logs`, and drains on
 * shutdown.
 *
 * `@strutvane/core` can replace it with {@link setDefaultLogger}, e.g. to plug in its own request
 * context getter.
 *
 * @module
 */
import type { LogFields, LogLevel } from '@strutvane/contracts'
import { createLogger } from './create.ts'
import type { FlushResult, LoggerStats, StrutvaneLogger } from './logger.ts'

let instance: StrutvaneLogger | undefined

function current(): StrutvaneLogger {
  instance ??= createLogger({ handleShutdown: true })
  return instance
}

/** Replace the default logger (for framework integration and tests). */
export function setDefaultLogger(logger: StrutvaneLogger | undefined): void {
  instance = logger
}

/**
 * The default logger.
 *
 * @example
 * import { log } from '@strutvane/logs'
 * log.info('Invoice sent', { invoiceId: invoice.id })
 */
export const log: StrutvaneLogger = {
  get level(): LogLevel {
    return current().level
  },
  trace: (msg: string, fields?: LogFields) => current().trace(msg, fields),
  debug: (msg: string, fields?: LogFields) => current().debug(msg, fields),
  info: (msg: string, fields?: LogFields) => current().info(msg, fields),
  warn: (msg: string, fields?: LogFields) => current().warn(msg, fields),
  error: (msg: string, fields?: LogFields) => current().error(msg, fields),
  fatal: (msg: string, fields?: LogFields) => current().fatal(msg, fields),
  child: (bindings: LogFields) => current().child(bindings),
  isLevelEnabled: (level: LogLevel) => current().isLevelEnabled(level),
  flush: () => current().flush(),
  drain: (timeoutMs?: number): Promise<FlushResult> => current().drain(timeoutMs),
  close: (timeoutMs?: number): Promise<FlushResult> => current().close(timeoutMs),
  stats: (): LoggerStats => current().stats(),
}
