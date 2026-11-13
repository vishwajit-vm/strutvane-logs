# @strutvane/logs

## 0.1.0-next.0

### Minor Changes

- First implementation of `@strutvane/logs` (RFC-0004, ADR-0015): the zero-config `log` and `createLogger` with a non-blocking, bounded pipeline, redaction before storage, daily size-capped files with retention and per-process files, stderr fallback and shutdown flush; request logging for Web handlers (`/http`), `node:http` (`/node`), Hono (`/hono`) and Express (`/express`); and the secured built-in viewer (`/viewer`) with search, live tail, download and CSRF-protected clearing; and `@strutvane/logs/provider` for Strutvane apps (binds `LoggerToken`, request logging and the viewer through core hooks, settings from `config/logging.ts`).
