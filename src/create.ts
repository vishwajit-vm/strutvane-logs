/**
 * `createLogger`: the high-level, zero-config entry point. It resolves the configuration (options
 * → environment → defaults), picks the transport, chooses a per-process file tag when several
 * processes write, and optionally drains on shutdown.
 *
 * @module
 */
import cluster from 'node:cluster'
import { resolve } from 'node:path'
import { isMainThread, threadId } from 'node:worker_threads'
import { type Env, type LogsConfig, resolveLogsConfig } from './config.ts'
import { createPipelineLogger, type PipelineOptions, type StrutvaneLogger } from './logger.ts'
import { createNoopLogger } from './noop.ts'
import { registerShutdownFlush } from './shutdown.ts'
import { prettyTransport, stdoutTransport } from './transports/console.ts'
import { fileTransport } from './transports/file.ts'
import type { Transport } from './transports/types.ts'

/** Options for {@link createLogger}. Everything is optional. */
export interface CreateLoggerOptions
  extends Partial<LogsConfig>,
    Partial<Omit<PipelineOptions, 'transport' | 'level'>> {
  /** Use this transport instead of the one from configuration. */
  readonly transport?: Transport
  /**
   * Writer tag for per-process files (ADR-0015). Default: automatic. Cluster workers use
   * `w<workerId>` and worker threads use `wt<threadId>`; the main process is untagged. `false`
   * disables tagging.
   */
  readonly writerTag?: string | false
  /** Drain on SIGTERM/SIGINT/beforeExit. Default: `false` (the default `log` turns it on). */
  readonly handleShutdown?: boolean
  /** Deadline for the shutdown drain. Default: 2,000 ms. */
  readonly shutdownTimeoutMs?: number
  /** Environment to read (defaults to `process.env`; injectable for tests). */
  readonly env?: Env
}

/** The automatic writer tag for this process or thread, if it needs one. */
export function automaticWriterTag(): string | undefined {
  if (cluster.isWorker && cluster.worker) return `w${cluster.worker.id}`
  if (!isMainThread) return `wt${threadId}`
  return undefined
}

/**
 * Create a logger.
 *
 * @example
 * const log = createLogger()                                  // file logs in storage/logs
 * const log = createLogger({ driver: 'stdout', level: 'debug' })
 * const log = createLogger({ path: 'var/log', retentionDays: 14, sanitize: { extraKeys: ['iban'] } })
 */
export function createLogger(options: CreateLoggerOptions = {}): StrutvaneLogger {
  const { config, warnings } = resolveLogsConfig(pickConfig(options), options.env)
  if (!config.enabled) return createNoopLogger(config.level)

  const transport = options.transport ?? transportFor(config, options)
  const logger = createPipelineLogger({ ...options, transport, level: config.level })
  for (const warning of warnings) logger.warn(`logs: ${warning}`, { component: 'logs.config' })
  if (options.handleShutdown)
    registerShutdownFlush(logger, { timeoutMs: options.shutdownTimeoutMs ?? 2_000 })
  return logger
}

function pickConfig(o: CreateLoggerOptions): Partial<LogsConfig> {
  const out: { -readonly [K in keyof LogsConfig]?: LogsConfig[K] } = {}
  if (o.enabled !== undefined) out.enabled = o.enabled
  if (o.level !== undefined) out.level = o.level
  if (o.format !== undefined) out.format = o.format
  if (o.driver !== undefined) out.driver = o.driver
  if (o.path !== undefined) out.path = o.path
  if (o.retentionDays !== undefined) out.retentionDays = o.retentionDays
  if (o.maxDailyBytes !== undefined) out.maxDailyBytes = o.maxDailyBytes
  return out
}

function transportFor(config: LogsConfig, options: CreateLoggerOptions): Transport {
  if (config.driver === 'stdout')
    return config.format === 'pretty' ? prettyTransport() : stdoutTransport()
  const tag = options.writerTag === false ? undefined : (options.writerTag ?? automaticWriterTag())
  return fileTransport({
    dir: resolve(config.path),
    maxFileBytes: config.maxDailyBytes,
    retentionDays: config.retentionDays,
    ...(tag ? { tag } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
}
