<div align="center">

# Strutvane Logs

**Zero-config logging for TypeScript apps: structured non-blocking logs, automatic rotation and retention, secret redaction, request logging, and a built-in log viewer at /_strutvane/logs. Installed by default in Strutvane apps.**

[![Status: planning](https://img.shields.io/badge/status-planning-blueviolet)](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Part of Strutvane](https://img.shields.io/badge/ecosystem-Strutvane-1f3a5f)](https://github.com/vishwajit-vm/strutvane)

</div>

> [!NOTE]
> **Strutvane Logs is in the design phase.** The specification is written and implementation has not started. Nothing is published to npm yet, and the package name `@strutvane/logs` is reserved for this project. Follow [the roadmap](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md) for progress.

## What it is

Strutvane Logs is part of **[Strutvane](https://github.com/vishwajit-vm/strutvane)**, a TypeScript framework and package ecosystem for building enterprise B2B applications. You declare models as fields and types, and get migrations, a secured CRUD API, auth/RBAC/tenancy and a complete UI. Every line stays owned, overridable TypeScript.

## Planned capabilities

- **Zero configuration**: `log.info("Invoice sent", { invoiceId })` just works, with structured JSON and context (requestId, traceId, tenant, actor) added automatically
- **Automatic request logging**: method, route, status, duration and actor for every API request, plus unhandled exceptions with stack traces
- **Safe storage**: daily files with size caps and retention (default 60 days); a database driver for multi-instance deployments; stdout and OpenTelemetry export
- **Redaction before storage**: authorization headers, cookies, passwords, tokens, JWTs, DB URLs, card numbers and fields marked sensitive
- **Built-in viewer** at `/_strutvane/logs`: live tail, search, filters (level, route, status, traceId, tenant), download, clear, themes
- **Locked down by default**: the viewer is local-only, or permission-gated with @strutvane/auth; tenant-scoped; XSS/CSRF/log-injection safe
- **Never crashes your app**: non-blocking writes, bounded queues, graceful fallback to stderr, flush on shutdown
- Works in **any Node app** (Express, Fastify, Hono, NestJS), and **by default** in Strutvane apps

## A taste of the API (design preview)

```ts
import { log } from '@strutvane/logs'

log.info('Invoice sent', { invoiceId: invoice.id, amount: invoice.amount })
log.error('Payment failed', { orderId: 123, error })

const billing = log.child({ module: 'billing' })
billing.warn('Retrying charge', { attempt: 2 })

// Every API request is logged automatically.
// Open http://localhost:3000/_strutvane/logs to search and live-tail.
```

## Installation (once released)

```bash
pnpm sv add logs   # included by default in: npm create strutvane@latest
```

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

- **Package specification:** [rfcs/0004-logs-package.md](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0004-logs-package.md)
- **Ecosystem blueprint:** [strutvane/docs](https://github.com/vishwajit-vm/strutvane/tree/main/docs), starting with the [executive summary](https://github.com/vishwajit-vm/strutvane/blob/main/docs/00-executive-summary.md) and the [developer experience](https://github.com/vishwajit-vm/strutvane/blob/main/docs/05-developer-experience.md)

## Contributing

Ideas and design feedback are welcome while the project is in the design phase. Open an issue or discussion, and see [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 The Strutvane Authors
