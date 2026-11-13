/**
 * Configuration from options and environment variables (RFC-0004 §7).
 *
 * Precedence: explicit options → environment variables → safe defaults.
 * - **An invalid explicit option throws.** It's a programming mistake, so it fails fast and loudly.
 * - **An invalid environment value never crashes the app.** The default is used and a warning is
 *   logged once, telling you which variable to fix.
 *
 * @module
 */
import type { LogLevel } from '@strutvane/contracts'
import { isLogLevel } from './levels.ts'

/** Output format for the console drivers (files are always NDJSON). */
export type LogFormat = 'json' | 'pretty'

/** Where logs are written. */
export type LogDriver = 'file' | 'stdout'

/** The resolved configuration. */
export interface LogsConfig {
  /** `false` turns every log call into a no-op. Env: `LOGS_ENABLED`. */
  readonly enabled: boolean
  /** Env: `LOG_LEVEL`. Default: `info`. */
  readonly level: LogLevel
  /** Env: `LOG_FORMAT`. Default: `pretty` when `APP_ENV=local`, otherwise `json`. */
  readonly format: LogFormat
  /** Env: `LOGS_DRIVER`. Default: `file`. */
  readonly driver: LogDriver
  /** Log directory. Env: `LOGS_PATH`. Default: `storage/logs`. */
  readonly path: string
  /** Days to keep log files (0 = keep forever). Env: `LOGS_RETENTION_DAYS`. Default: 60. */
  readonly retentionDays: number
  /** Size cap per file in bytes. Env: `LOGS_MAX_DAILY_SIZE` (e.g. `30MB`). Default: 30 MB. */
  readonly maxDailyBytes: number
}

/** Defaults used when neither an option nor an environment variable is set. */
export const DEFAULT_CONFIG: Omit<LogsConfig, 'format'> = Object.freeze({
  enabled: true,
  level: 'info',
  driver: 'file',
  path: 'storage/logs',
  retentionDays: 60,
  maxDailyBytes: 30 * 1024 * 1024,
})

/** Resolution result: the config plus warnings about invalid environment values. */
export interface ConfigResult {
  readonly config: LogsConfig
  readonly warnings: readonly string[]
}

/** Environment variables as read from `process.env` (only strings matter). */
export type Env = Readonly<Record<string, string | undefined>>

const UNITS: Readonly<Record<string, number>> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }

/** Parse a size like `30MB`, `512kb` or `1048576` into bytes. Returns `undefined` if invalid. */
export function parseSize(value: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(value)
  if (!m?.[1]) return undefined
  const bytes = Math.floor(Number(m[1]) * (UNITS[(m[2] ?? 'b').toLowerCase()] ?? 1))
  return bytes >= 1024 ? bytes : undefined
}

function parseBool(value: string): boolean | undefined {
  const v = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(v)) return true
  if (['false', '0', 'no', 'off'].includes(v)) return false
  return undefined
}

/**
 * Resolve the configuration.
 *
 * @example
 * resolveLogsConfig({}, { LOG_LEVEL: 'debug', LOGS_PATH: 'var/logs' }).config.level // 'debug'
 */
export function resolveLogsConfig(
  options: Partial<LogsConfig> = {},
  env: Env = process.env,
): ConfigResult {
  const warnings: string[] = []
  const fromEnv = <T>(
    name: string,
    parse: (v: string) => T | undefined,
    fallback: T,
    hint: string,
  ): T => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const parsed = parse(raw)
    if (parsed === undefined) {
      warnings.push(`${name}="${raw}" is not valid (${hint}); using ${String(fallback)}`)
      return fallback
    }
    return parsed
  }

  validateOptions(options)
  const read = (name: string): string | undefined => env[name]
  const local = (read('APP_ENV') ?? '').toLowerCase() === 'local'

  const driverFromEnv = fromEnv<LogDriver>(
    'LOGS_DRIVER',
    (v) => {
      const d = v.trim().toLowerCase()
      if (d === 'file' || d === 'stdout') return d
      if (d === 'database') {
        warnings.push('LOGS_DRIVER="database" is not available yet (Phase 4); using file')
        return 'file'
      }
      return undefined
    },
    DEFAULT_CONFIG.driver,
    'use file or stdout',
  )

  const config: LogsConfig = {
    enabled: options.enabled ?? fromEnv('LOGS_ENABLED', parseBool, true, 'use true or false'),
    level:
      options.level ??
      fromEnv(
        'LOG_LEVEL',
        (v) =>
          isLogLevel(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as LogLevel) : undefined,
        DEFAULT_CONFIG.level,
        'use trace, debug, info, warn, error or fatal',
      ),
    format:
      options.format ??
      fromEnv<LogFormat>(
        'LOG_FORMAT',
        (v) => (v.trim() === 'json' || v.trim() === 'pretty' ? (v.trim() as LogFormat) : undefined),
        local ? 'pretty' : 'json',
        'use json or pretty',
      ),
    driver: options.driver ?? driverFromEnv,
    path:
      options.path ??
      fromEnv(
        'LOGS_PATH',
        (v) => (v.trim() ? v.trim() : undefined),
        DEFAULT_CONFIG.path,
        'use a directory path',
      ),
    retentionDays:
      options.retentionDays ??
      fromEnv(
        'LOGS_RETENTION_DAYS',
        (v) => (/^\d{1,5}$/.test(v.trim()) ? Number(v.trim()) : undefined),
        DEFAULT_CONFIG.retentionDays,
        'use a whole number of days, 0 to keep forever',
      ),
    maxDailyBytes:
      options.maxDailyBytes ??
      fromEnv(
        'LOGS_MAX_DAILY_SIZE',
        parseSize,
        DEFAULT_CONFIG.maxDailyBytes,
        'use a size like 30MB (minimum 1KB)',
      ),
  }
  return { config, warnings }
}

function validateOptions(o: Partial<LogsConfig>): void {
  if (o.level !== undefined && !isLogLevel(o.level))
    throw new TypeError(`invalid level "${String(o.level)}"`)
  if (o.format !== undefined && o.format !== 'json' && o.format !== 'pretty') {
    throw new TypeError(`invalid format "${String(o.format)}"`)
  }
  if (o.driver !== undefined && o.driver !== 'file' && o.driver !== 'stdout') {
    throw new TypeError(`invalid driver "${String(o.driver)}"`)
  }
  if (
    o.retentionDays !== undefined &&
    (!Number.isInteger(o.retentionDays) || o.retentionDays < 0)
  ) {
    throw new RangeError('retentionDays must be a whole number ≥ 0')
  }
  if (
    o.maxDailyBytes !== undefined &&
    (!Number.isFinite(o.maxDailyBytes) || o.maxDailyBytes < 1024)
  ) {
    throw new RangeError('maxDailyBytes must be at least 1024')
  }
  if (o.path !== undefined && o.path.trim() === '') throw new TypeError('path must not be empty')
}
