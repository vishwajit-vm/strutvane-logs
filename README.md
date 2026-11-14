<div align="center">

# Strutvane Logs

**Zero-config logging for TypeScript apps: structured non-blocking logs, automatic rotation and retention, secret redaction, request logging, and a built-in, locked-down log viewer at /_strutvane/logs. Installed by default in Strutvane apps.**

[![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange)](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Part of Strutvane](https://img.shields.io/badge/ecosystem-Strutvane-1f3a5f)](https://github.com/vishwajit-vm/strutvane)

</div>

> [!NOTE]
> **Pre-release (`0.1.0-next.0`).** The package is implemented and tested, but not released to npm yet. APIs may still change before 1.0. The spec is [RFC-0004](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0004-logs-package.md).

## What it is

Strutvane Logs is part of **[Strutvane](https://github.com/vishwajit-vm/strutvane)**, a TypeScript framework and package ecosystem for enterprise B2B apps. It works in **any Node 24+ app** (plain `node:http`, Express, Hono, anything that speaks `Request`/`Response`), and it is installed **by default** in Strutvane apps.

- **Zero configuration.** `log.info('Invoice sent', { invoiceId })` just works. Records are one JSON object per line, and request context (requestId, traceId, tenant, actor) is added automatically.
- **Never slows or crashes your app.** Log calls are synchronous, cheap and never throw. Writing happens off the hot path in batches. If the disk fails, logs fall back to stderr (with exactly one warning) and recover by themselves.
- **Secrets never reach the disk.** Passwords, passphrases, tokens, cookies, sessions, authorization headers, API keys, signatures, one-time and MFA codes, PINs, card data, JWTs, credentials in URLs, secret query parameters (`?token=`, `&sig=`, `#access_token=`), well-known prefixed keys (`sk_live_…`, `ghp_…`, `AKIA…`, `xoxb-…`), private keys and card numbers (in text or stored as numbers) are redacted before anything is written. Add your own keys with `extraKeys`, or at runtime for every logger in the process with `registerSensitiveKeys(['taxNumber'])`.
- **Safe storage.** Daily files with a size cap per file, retention (60 days by default), one file per process when several processes log, and a guaranteed flush on shutdown.
- **Request logging.** One compact line per request: method, route template, status, duration and size. Query strings and bodies are never logged. When the route template isn't known, the path is logged with secrets redacted, token-like segments masked and its length capped.
- **A built-in viewer** at `/_strutvane/logs`: search, filters, live tail, download (NDJSON or CSV) and clearing old files. It is **closed by default**: open in local development, token- or callback-protected elsewhere, and invisible (404) in production unless you set it up.

## Quick start

```bash
pnpm add @strutvane/logs
```

```ts
import { log } from '@strutvane/logs'

log.info('Invoice sent', { invoiceId: 'inv_42', amount: 120 })
log.error('Payment failed', { orderId: 123, err: error }) // the error keeps its stack and cause chain

const billing = log.child({ module: 'billing' })
billing.warn('Retrying charge', { attempt: 2 })
```

Logs go to `storage/logs/2026-11-14.ndjson` (one file per UTC day):

```json
{"time":"2026-11-14T10:00:00.000Z","level":"info","msg":"Invoice sent","requestId":"9f1c…","fields":{"invoiceId":"inv_42","amount":120}}
```

Levels, lowest to highest: `trace`, `debug`, `info` (default), `warn`, `error`, `fatal`.

## Request logging and the viewer

Pick the adapter for your server. `logs()` adds request logging **and** the viewer in one line.

**Hono**

```ts
import { Hono } from 'hono'
import { logs } from '@strutvane/logs/hono'

const app = new Hono()
app.use(logs())
```

**Express 5**

```ts
import express from 'express'
import { logs, errorLogging } from '@strutvane/logs/express'

const app = express()
app.use(logs())
// … your routes …
app.use(errorLogging()) // logs unhandled errors with their stack, then passes them on
```

**Plain `node:http`**

```ts
import { createServer } from 'node:http'
import { toNodeHandler, withRequestLogging } from '@strutvane/logs/node'
import { createViewerHandler } from '@strutvane/logs/viewer'

const viewer = createViewerHandler()
const serveViewer = toNodeHandler((request, info) => viewer.fetch(request, info))

createServer(
  withRequestLogging((req, res) => {
    if (viewer.matchesPath(new URL(req.url ?? '/', 'http://x').pathname)) return void serveViewer(req, res)
    res.end('hello')
  }),
).listen(3000)
```

**Any `fetch`-style server** (Bun, Deno, Next.js route handlers…)

```ts
import { createRequestLogger } from '@strutvane/logs/http'

const requests = createRequestLogger()
export default { fetch: (request: Request) => requests.handle(request, (r) => app.fetch(r)) }
```

Every request gets one line like `GET /invoices/:id 200` with `{ method, route, status, durationMs, size }`. Server errors log at `error`, slow requests (over 1 s) at `warn`, and `/health` and `/ready` are skipped. The request id comes from a safe incoming `x-request-id` header, or a new UUID, and is echoed back in the response.

### Who can open the viewer

| Situation | Access |
|---|---|
| `APP_ENV=local` | Open, so `pnpm dev` just works, for requests to `localhost`, `127.0.0.1` or `[::1]` only (any other `Host` gets a 404, which blocks DNS-rebinding pages). When the runtime exposes the client's socket address, it must be loopback too (`127.0.0.0/8`, `::1`, `::ffff:127.x.x.x`), so a dev server listening on `0.0.0.0` doesn't open the viewer to the network; when it doesn't, only the host is checked |
| `LOGS_VIEWER_TOKEN` set (16+ characters) | `Authorization: Bearer <token>`, or open `/_strutvane/logs?token=<token>` once in a browser (sets an 8-hour, HttpOnly, SameSite=Strict cookie and redirects to a clean URL) |
| You pass `authorize: (request) => boolean` | Only your rule decides (for example "admins only") |
| Anything else (e.g. production with nothing set) | **404**, as if the viewer didn't exist |

```ts
logs({
  viewer: {
    authorize: async (request) => (await getUser(request))?.role === 'admin',
    ipAllowList: ['10.0.0.0/8'],                       // optional, all modes
    scopeRecords: (request) => {                        // optional tenant scoping
      const tenant = tenantOf(request)
      return tenant ? (record) => record.tenantId === tenant : undefined
    },
    onAudit: (event) => auditLog.write(event),          // clear and download events
  },
})
```

## Configuration

Everything works with no configuration. Explicit options win over environment variables, which win over the defaults. An invalid **option** throws (a programming mistake). An invalid **environment value** never crashes the app: the default is used and one warning is logged.

| Variable | Default | Meaning |
|---|---|---|
| `LOGS_ENABLED` | `true` | `false` turns every log call into a no-op |
| `LOG_LEVEL` | `info` | Minimum level written |
| `LOG_FORMAT` | `pretty` if `APP_ENV=local`, else `json` | Console format (files are always JSON) |
| `LOGS_DRIVER` | `file` | `file` or `stdout` (`database` is planned; it falls back to `file` with a warning) |
| `LOGS_PATH` | `storage/logs` | Log directory |
| `LOGS_RETENTION_DAYS` | `60` | Days to keep files (`0` keeps them forever) |
| `LOGS_MAX_DAILY_SIZE` | `30MB` | Size cap per file; a full file continues in `…-1.ndjson`, `…-2.ndjson` |
| `LOGS_VIEWER_TOKEN` | — | Opens the viewer for token holders (16+ characters) |

```ts
import { createLogger } from '@strutvane/logs'

const log = createLogger({
  level: 'debug',
  path: 'var/log/app',
  retentionDays: 14,
  sanitize: { extraKeys: ['iban'], extraPatterns: [/EMP-\d{6}/g] },
  bindings: { service: 'billing-api' },
  handleShutdown: true,
})
```

## Package entry points

| Import | What it gives you |
|---|---|
| `@strutvane/logs` | `log`, `createLogger`, `runWithLogContext`, redaction, transports, file utilities |
| `@strutvane/logs/http` | `createRequestLogger` for `Request`/`Response` handlers, plus the shared request-logging helpers |
| `@strutvane/logs/node` | `withRequestLogging`, `toNodeHandler` (serve any Web handler from `node:http`) |
| `@strutvane/logs/hono` | `requestLogging`, `logs` |
| `@strutvane/logs/express` | `requestLogging`, `errorLogging`, `logs` |
| `@strutvane/logs/viewer` | `createViewerHandler` and its building blocks |
| `@strutvane/logs/provider` | The Strutvane app provider: binds `LoggerToken`, logs every request and serves the viewer through core hooks (`http.onRequest` / `http.onResponse`), configured by `config/logging.ts` |

`hono` and `express` are optional peer dependencies: install only the one you use.

In a Strutvane app `create-strutvane` registers `@strutvane/logs/provider` for you. It reads
`config/logging.ts` (`level`, `format`, `driver`, `path` relative to the project root, `retentionDays`,
`maxDailySize`, `requests.ignore`, `requests.slowThresholdMs`, `viewer.enabled/path/token`, and
`viewer.authorize/ipAllowList/scopeRecords/onAudit`), and never imports the framework: request logging
and the viewer ride on the framework's core hooks. `createLogsProvider({ viewer: { authorize } })`
sets the same access rules in code (and wins over the config file). The IP allow-list is checked
against the hook's `clientAddress` (the socket peer, never a forwarded header); without one it denies.

## Security, in short

- **Redaction before storage**, by key (at any depth) and by pattern, with tripwire tests proving every rule matters.
- **Log injection is impossible**: every record is exactly one line (newlines and U+2028/U+2029 are escaped), and incoming request ids are validated.
- **The viewer** renders log text with `textContent` only, sends a strict CSP with a per-response nonce, checks a CSRF token and `Origin` before clearing, never deletes today's files, validates every parameter (no path traversal), re-redacts records on the way out, limits concurrent live tails (a slot is freed however a tail ends, including clients that vanish without closing; tails accept GET only) and bounds the work per search (files are read backwards in fixed-size chunks, never whole). Scoped viewers see which days exist, not file names or sizes.

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Works alone, better together

| Package | Role |
|---------|------|
| [`@strutvane/framework`](https://github.com/vishwajit-vm/strutvane-framework) | Backend & database core |
| [`@strutvane/auth`](https://github.com/vishwajit-vm/strutvane-auth) | Authentication, authorization, tenancy, audit |
| [`@strutvane/ui`](https://github.com/vishwajit-vm/strutvane-ui) | Metadata-driven frontend |
| [`@strutvane/core`](https://github.com/vishwajit-vm/strutvane-core) | Kernel: container, providers, config, context |
| [`@strutvane/contracts`](https://github.com/vishwajit-vm/strutvane-contracts) | Shared types and wire protocols |
| [`strutvane` / `@strutvane/cli`](https://github.com/vishwajit-vm/strutvane-cli) | Unified CLI |
| [`@strutvane/devkit`](https://github.com/vishwajit-vm/strutvane-devkit) | SDK for installers, generators and plugins |
| [`@strutvane/logs`](https://github.com/vishwajit-vm/strutvane-logs) | Zero-config logging + built-in log viewer (default) |
| [`create-strutvane`](https://github.com/vishwajit-vm/create-strutvane) | Project starter |

## Documentation

- **Package specification:** [RFC-0004](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0004-logs-package.md) and [ADR-0015](https://github.com/vishwajit-vm/strutvane/tree/main/docs/adr)
- **Ecosystem blueprint:** [strutvane/docs](https://github.com/vishwajit-vm/strutvane/tree/main/docs), starting with the [executive summary](https://github.com/vishwajit-vm/strutvane/blob/main/docs/00-executive-summary.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The quality gate is `corepack pnpm@12.18.0 run ci` (lint → typecheck → tests with coverage → build).

## License

[MIT](LICENSE) © 2026 The Strutvane Authors
