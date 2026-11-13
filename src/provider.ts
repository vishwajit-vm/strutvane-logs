/**
 * `@strutvane/logs/provider`: the provider `strutvane.config.ts` registers in a Strutvane app.
 *
 * It connects logs to the app only through core (integration map: container tokens + hooks):
 * - binds `LoggerToken`, so every package logs through this logger;
 * - on `http.onRequest`, answers log-viewer requests (`/_strutvane/logs`) and notes the start
 *   time of every other request;
 * - on `http.onResponse`, writes one request-log line (method, route, status, duration).
 *
 * Settings come from `config/logging.ts` (`level`, `format`, `driver`, `path`, `retentionDays`,
 * `maxDailySize`, `requests`, `viewer`), falling back to the `LOG_*`/`LOGS_*` environment. The
 * viewer follows the RFC-0004 access rules: open when `APP_ENV=local`, otherwise only with
 * `LOGS_VIEWER_TOKEN`, and a 404 (not a 403) for everyone else, so its existence isn't revealed.
 *
 * @module
 */
import { isAbsolute, resolve } from 'node:path'
import {
  type Application,
  defineProvider,
  HooksToken,
  LoggerToken,
  type Provider,
} from '@strutvane/core'
import { parseSize } from './config.ts'
import { createLogger } from './create.ts'
import { logCompletedRequest, pathOf, resolveRequestLogging } from './http/core.ts'
import type { StrutvaneLogger } from './logger.ts'
import { createViewerHandler, type ViewerHandler } from './viewer/handler.ts'

/** `config/logging.ts`, as far as the provider reads it. */
export interface AppLoggingConfig {
  readonly enabled?: boolean
  readonly level?: string
  readonly format?: string
  readonly driver?: string
  readonly path?: string
  readonly retentionDays?: number
  readonly maxDailySize?: string
  readonly requests?: { readonly ignore?: readonly string[]; readonly slowThresholdMs?: number }
  readonly viewer?: { readonly enabled?: boolean; readonly path?: string; readonly token?: string }
}

interface RequestPayload {
  readonly request: Request
  readonly response?: Response
}

interface ResponsePayload {
  readonly request: Request
  readonly status: number
  readonly requestId: string
}

const section = <T>(app: Application, name: string): T | undefined =>
  (app.settings as Readonly<Record<string, unknown>>)[name] as T | undefined

/** Create the logs provider (a factory so every app and test gets fresh state). */
export function createLogsProvider(): Provider {
  let logger: StrutvaneLogger | undefined
  return defineProvider({
    name: '@strutvane/logs',
    register(app) {
      const cfg = section<AppLoggingConfig>(app, 'logging') ?? {}
      const root = section<{ root?: string }>(app, 'app')?.root ?? process.cwd()
      const maxDailyBytes = cfg.maxDailySize ? parseSize(cfg.maxDailySize) : undefined
      const path = cfg.path
        ? isAbsolute(cfg.path)
          ? cfg.path
          : resolve(root, cfg.path)
        : undefined
      logger = createLogger({
        ...(cfg.enabled !== undefined ? { enabled: cfg.enabled } : {}),
        ...(cfg.level ? { level: cfg.level as never } : {}),
        ...(cfg.format ? { format: cfg.format as never } : {}),
        ...(cfg.driver ? { driver: cfg.driver as never } : {}),
        ...(path ? { path } : {}),
        ...(cfg.retentionDays !== undefined ? { retentionDays: cfg.retentionDays } : {}),
        ...(maxDailyBytes !== undefined ? { maxDailyBytes } : {}),
      })
      app.container.value(LoggerToken, logger)
    },
    boot(app) {
      const cfg = section<AppLoggingConfig>(app, 'logging') ?? {}
      const root = section<{ root?: string }>(app, 'app')?.root ?? process.cwd()
      const active = logger
      if (!active) return
      const requests = resolveRequestLogging({
        logger: active,
        ...(cfg.requests?.ignore ? { ignore: cfg.requests.ignore } : {}),
        ...(cfg.requests?.slowThresholdMs !== undefined
          ? { slowThresholdMs: cfg.requests.slowThresholdMs }
          : {}),
      })
      let viewer: ViewerHandler | undefined
      if (cfg.viewer?.enabled !== false) {
        const dir = cfg.path
          ? isAbsolute(cfg.path)
            ? cfg.path
            : resolve(root, cfg.path)
          : undefined
        viewer = createViewerHandler({
          ...(dir ? { dir } : {}),
          ...(cfg.viewer?.path ? { basePath: cfg.viewer.path } : {}),
          ...(cfg.viewer?.token ? { token: cfg.viewer.token } : {}),
        })
      }
      const started = new WeakMap<Request, number>()
      const hooks = app.make(HooksToken)
      hooks.on(
        'http.onRequest',
        async (payload, control) => {
          const p = payload as RequestPayload
          started.set(p.request, performance.now())
          if (!viewer?.matches(p.request)) return undefined
          control.stop()
          return { ...p, response: await viewer.fetch(p.request) }
        },
        { name: 'logs.requests', before: ['auth.identity'] },
      )
      hooks.on(
        'http.onResponse',
        (payload) => {
          const p = payload as ResponsePayload
          const begin = started.get(p.request)
          if (begin === undefined || viewer?.matches(p.request)) return undefined
          const route = pathOf(p.request.url)
          if (requests.ignore.has(route)) return undefined
          logCompletedRequest(
            { ...requests, logger: active.child({ requestId: p.requestId }) },
            {
              method: p.request.method,
              route,
              status: p.status,
              durationMs: performance.now() - begin,
            },
          )
          return undefined
        },
        { name: 'logs.requests', failSoft: true },
      )
    },
    async shutdown() {
      await logger?.flush()
    },
  })
}

/** The logs provider for `strutvane.config.ts`. */
const provider: Provider = createLogsProvider()
export default provider
