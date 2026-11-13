/**
 * `@strutvane/logs/viewer`: the built-in log viewer as a framework-agnostic Web handler.
 *
 * Most apps mount it through an adapter (`@strutvane/logs/hono`, `/express`, `/node`). Use this
 * entry point directly for any other server that speaks `Request`/`Response`.
 *
 * @example
 * import { createViewerHandler } from '@strutvane/logs/viewer'
 * const viewer = createViewerHandler({ authorize: (req) => isAdmin(req) })
 * if (viewer.matches(request)) return viewer.fetch(request, { ip })
 *
 * @module
 */
export type { AccessDecision, AccessPolicy, AuthorizeFn } from './access.ts'
export {
  buildAllowList,
  decideAccess,
  ipAllowed,
  MIN_TOKEN_LENGTH,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  safeEqual,
  sessionValue,
  verifySession,
} from './access.ts'
export { CSV_COLUMNS, csvCell, csvHeader, csvRow } from './csv.ts'
export type { RecordFilter, RecordQuery, StatusFilter, ViewerRecord } from './filters.ts'
export { matchesQuery, parseRecordQuery, QueryError } from './filters.ts'
export type {
  ViewerAuditEvent,
  ViewerHandler,
  ViewerOptions,
  ViewerRequestInfo,
} from './handler.ts'
export { createViewerHandler } from './handler.ts'
export type { Cursor, LogFileInfo, Page, PageOptions } from './store.ts'
export { decodeCursor, describeFiles, encodeCursor, readPage } from './store.ts'
export type { TailOptions } from './tail.ts'
export { createTailStream } from './tail.ts'
export { escapeHtml, renderViewerPage } from './ui.ts'
