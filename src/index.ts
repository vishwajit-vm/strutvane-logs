/**
 * `@strutvane/logs`: zero-config logging for TypeScript apps (RFC-0004, ADR-0015).
 *
 * ```ts
 * import { log } from '@strutvane/logs'
 * log.info('Invoice sent', { invoiceId: invoice.id })
 * ```
 *
 * - **Request logging:** `@strutvane/logs/http`, with adapters `/node`, `/hono` and `/express`.
 * - **The built-in viewer:** `@strutvane/logs/viewer`.
 *
 * @packageDocumentation
 */
export type { LogError, LogFields, Logger, LogLevel, LogRecord } from '@strutvane/contracts'
export type { ConfigResult, Env, LogDriver, LogFormat, LogsConfig } from './config.ts'
export { DEFAULT_CONFIG, parseSize, resolveLogsConfig } from './config.ts'
export type { ContextGetter, LogContext } from './context.ts'
export { getLogContext, runWithLogContext } from './context.ts'
export type { CreateLoggerOptions } from './create.ts'
export { automaticWriterTag, createLogger } from './create.ts'
export { log, setDefaultLogger } from './default.ts'
export type { LogFileName } from './files.ts'
export {
  applyRetention,
  compareLogFiles,
  dayKeyOf,
  fileName,
  isDayKey,
  LOG_FILE_PATTERN,
  listLogFiles,
  parseLogFileName,
} from './files.ts'
export {
  IMPORTANT_SEVERITY,
  isLogLevel,
  LOG_LEVEL_SEVERITY,
  LOG_LEVELS,
  severityOf,
} from './levels.ts'
export type { FlushResult, LoggerStats, PipelineOptions, StrutvaneLogger } from './logger.ts'
export { createPipelineLogger } from './logger.ts'
export { createNoopLogger } from './noop.ts'
export type { PushResult, QueueItem, QueueLimits } from './queue.ts'
export { BoundedQueue, DEFAULT_QUEUE_LIMITS } from './queue.ts'
export type { PatternRule, SanitizeOptions, Sanitizer } from './redact.ts'
export {
  createSanitizer,
  DEFAULT_SANITIZE,
  luhnValid,
  normaliseKey,
  REDACTED,
  redactString,
} from './redact.ts'
export { DEFAULT_MAX_RECORD_BYTES, serializeRecord } from './serialize.ts'
export type { ShutdownOptions } from './shutdown.ts'
export { registerShutdownFlush } from './shutdown.ts'
export {
  prettyLine,
  prettyTransport,
  stderrTransport,
  stdoutTransport,
} from './transports/console.ts'
export type { FileTransport, FileTransportOptions } from './transports/file.ts'
export { appendFileWriter, fileTransport } from './transports/file.ts'
export type {
  Batch,
  FileWriter,
  FileWriterFactory,
  Transport,
  WritableLike,
} from './transports/types.ts'
