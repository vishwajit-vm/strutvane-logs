/**
 * Request context carried implicitly through async calls (AsyncLocalStorage), so every log line
 * written while handling a request is enriched with its ids, without passing a logger around.
 *
 * `@strutvane/core` owns the framework's request context. Loggers therefore accept an injected
 * {@link ContextGetter}, and this module's own store is the default for standalone use.
 *
 * @module
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** Correlation fields added to every record. Extra keys are kept under `fields`. */
export interface LogContext {
  readonly requestId?: string
  readonly traceId?: string
  readonly tenantId?: string
  readonly actorId?: string
  readonly [key: string]: unknown
}

/** Returns the current context, or `undefined` outside any request. */
export type ContextGetter = () => LogContext | undefined

const storage = new AsyncLocalStorage<LogContext>()

/**
 * Run `fn` with `context` visible to every log call made inside it, synchronously or
 * asynchronously. Nested calls merge with the outer context (inner values win).
 *
 * @example
 * runWithLogContext({ requestId: 'req-1', tenantId: 't-9' }, async () => {
 *   log.info('Invoice sent') // → { …, requestId: 'req-1', tenantId: 't-9' }
 * })
 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  const outer = storage.getStore()
  return storage.run(outer ? { ...outer, ...context } : context, fn)
}

/** The current context from this module's store, or `undefined` outside any request. */
export const getLogContext: ContextGetter = () => storage.getStore()
