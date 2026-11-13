<!--
  Managed by strutvane-tooling (canonical/.claude/ECOSYSTEM.md). Do not edit in other repos:
  change it in strutvane-tooling and run `node scripts/sync.mjs` there. Every Strutvane repo
  imports this file from its CLAUDE.md, so it is the shared memory of the whole ecosystem.
-->

# Strutvane: ecosystem memory (shared by every repo)

> You are in one repository of the **Strutvane** ecosystem. This file is identical in every repo. It tells you how the whole ecosystem fits together, so you can contribute here even if you cloned only this one repo. Repo-specific memory is in this repo's `CLAUDE.md`.

## 1. What Strutvane is

An MIT-licensed **TypeScript framework and package ecosystem for enterprise B2B apps**: Laravel's productivity, built natively for TypeScript.

**The promise:** declare models as fields and types, run one command, and get migrations, a secured and documented CRUD API, auth/RBAC/multi-tenancy and a complete UI. Every line of the result is owned, overridable code.

**Brand:** npm scope `@strutvane`, CLI `strutvane` (alias `pnpm sv` in apps), starter `create-strutvane`. Trademark clearance is pending: never claim the name is legally cleared.

## 2. Repository map (one repo per package; GitHub org `vishwajit-vm`)

| Repo | Publishes | Role |
|---|---|---|
| [strutvane](https://github.com/vishwajit-vm/strutvane) | — | **Hub:** blueprint, decisions (ADRs), RFCs, spikes. **Source of truth.** |
| [strutvane-contracts](https://github.com/vishwajit-vm/strutvane-contracts) | `@strutvane/contracts` | Shared types and wire protocols. Zero runtime deps. |
| [strutvane-core](https://github.com/vishwajit-vm/strutvane-core) | `@strutvane/core` | Kernel: container, providers, config, env, errors, messages, events, hooks, context |
| [strutvane-framework](https://github.com/vishwajit-vm/strutvane-framework) | `@strutvane/framework` | Backend and database: models, migrations, CRUD API, OpenAPI, storage/uploads, queue, cache, mail |
| [strutvane-auth](https://github.com/vishwajit-vm/strutvane-auth) | `@strutvane/auth` | Identity adapters, RBAC/ABAC compiled to SQL, tenancy (Postgres RLS), audit |
| [strutvane-ui](https://github.com/vishwajit-vm/strutvane-ui) | `@strutvane/ui` | Metadata-driven UI: tables, forms, detail pages, auth screens, themes |
| [strutvane-cli](https://github.com/vishwajit-vm/strutvane-cli) | `strutvane`, `@strutvane/cli` | Unified CLI |
| [strutvane-devkit](https://github.com/vishwajit-vm/strutvane-devkit) | `@strutvane/devkit` | SDK for installers, generators, plugins |
| [strutvane-logs](https://github.com/vishwajit-vm/strutvane-logs) | `@strutvane/logs` | Zero-config logging: redaction, retention, request logging, built-in viewer at `/_strutvane/logs`. **Installed by default** (RFC-0004). |
| [create-strutvane](https://github.com/vishwajit-vm/create-strutvane) | `create-strutvane` | Project starter (presets: full, api, ui) |
| [strutvane-tooling](https://github.com/vishwajit-vm/strutvane-tooling) | — | Canonical configs, CI/release workflows, config sync (this file comes from here) |
| [strutvane-docs](https://github.com/vishwajit-vm/strutvane-docs) | — | Friendly public docs site |

Planned: `@strutvane/files` (RFC-0002), then notify, reports, payments/billing, analytics.

**Local layout:** the hub folder contains every other repo under `packages/<name>/`. Hub paths such as `../../docs/...` only exist in that layout. If you cloned a single repo, use the online links below instead.

## 3. Where the truth lives (read before designing anything)

| Topic | Hub path | Online |
|---|---|---|
| Canonical decisions D1–D24 | `docs/00-executive-summary.md` | [link](https://github.com/vishwajit-vm/strutvane/blob/main/docs/00-executive-summary.md) |
| Developer experience contract | `docs/05-developer-experience.md` | [link](https://github.com/vishwajit-vm/strutvane/blob/main/docs/05-developer-experience.md) |
| How packages connect (the only allowed connections) | `docs/17-integration-map.md` | [link](https://github.com/vishwajit-vm/strutvane/blob/main/docs/17-integration-map.md) |
| Architecture decision records | `docs/adr/` | [link](https://github.com/vishwajit-vm/strutvane/tree/main/docs/adr) |
| RFCs (public API / contract changes) | `docs/rfcs/` | [link](https://github.com/vishwajit-vm/strutvane/tree/main/docs/rfcs) |
| Roadmap and current phase | `docs/14-roadmap.md` | [link](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md) |
| Security model | `docs/12-security-model.md` | [link](https://github.com/vishwajit-vm/strutvane/blob/main/docs/12-security-model.md) |

**Precedence:** the executive summary (D1–D24) and accepted ADRs win over everything, including this file and any repo's own docs. If you find a conflict, report it. Don't silently pick one.

## 4. Architecture rules (non-negotiable)

1. **Dependency direction:** `contracts` ← `core` ← product packages (`framework`, `auth`, `ui`, `files`, …). **Product packages never import each other.**
2. **The only allowed connections** between packages are the six in the integration map: contracts (types), container tokens, hooks, domain events, installer `enhances`, and HTTP + manifest. A new connection is added to the map in the same PR.
3. **Every package works alone and installs itself completely** (config, `.env` + `.env.example`, migrations, routes, screens) through the installer protocol. Install order never changes the result.
4. **Logging:** log only through the `Logger` contract (`@strutvane/logs` by default; core fallback). Never use `console.*` in package code. Never log secrets or request bodies by default (RFC-0004).
5. **One error model:** RFC 9457 `Problem` with a stable `code` and structured `issues`. Messages come from catalogs, never hard-coded (RFC-0003).
6. **Security by default:**
   - deny-by-default authorization
   - tenancy enforced by Postgres RLS under the five rules of ADR-0007
   - two-valued NULL-safe policy semantics (ADR-0008)
   - secrets never in code, logs or `.env.example`

## 5. Engineering standards (apply to every line)

- **Think before code.** Read the spec, the ADRs and the integration map first. If a public API or contract changes, write or extend an RFC *before* implementing.
- **TypeScript strict, ESM only, Node 24+ (target Node 26 LTS).** No `any`, no non-null assertions, no decorators or reflection. Strictness comes from the synced `tsconfig.base.json`.
- **Small, single-purpose, reusable modules.** One concept per file, no duplicated logic, and shared behaviour extracted to the right layer (contracts, core or devkit).
- **Explain the *why*.** TSDoc on every public API, plus comments wherever a decision isn't obvious.
- **Handle failure deliberately:**
  - name the failure scenarios
  - fail closed
  - always clean up (connections, temp files)
  - make every retry idempotent
- **Tests are part of the change.** Every behaviour has unit tests. Data logic is tested against real engines (no mocks for SQL). Public types get type-level tests that prove misuse fails to compile. Coverage thresholds: 90/90/85/90.
- **Security is tested continuously (VAPT).**
  - Write a threat model before code, and attack-style tests for your package's surface (tenancy, injection, uploads, sessions, enumeration, rate limits).
  - Fuzz every parser.
  - Every security fix ships with a regression test for the whole class.
  - See the hub `docs/13-testing-strategy.md` §14.
- **Never edit synced files** (`tsconfig.base.json`, `biome.base.json`, `vitest.shared.ts`, `.github/workflows/*`, `.gitattributes`, `.editorconfig`, `.claude/ECOSYSTEM.md`, shared agents/skills). Change them in strutvane-tooling.

## 6. Workflow

- **Branches:** every repo uses `main`. Short-lived feature branches are fine, but they must be merged back into `main` once tests pass. Never leave work stranded on a side branch. `main` is protected against force-push and deletion.
- **Before committing:** run the repo's quality gate, `corepack pnpm@12.18.0 run ci` (lint → typecheck → tests + coverage → build). It must pass.
- **Changesets:** any change to a published package adds one (`corepack pnpm@12.18.0 changeset`).
- **Commits:** conventional commits (`feat:`, `fix:`, `docs:`, `chore:` …). Sign off with `git commit -s` (DCO).
- **Releases:** Changesets plus npm trusted publishing (OIDC, no tokens). The release workflow only runs once the repo variable `RELEASE_ENABLED=true` is set.
- **Docker:** for local development only, and never committed (ADR-0006).
- **pnpm** is used via corepack: `corepack pnpm@12.18.0 <command>`. Package scripts call tools directly, never `pnpm run x`.

## 7. Current status

**Phase 0: foundations, in progress (updated 2026-11-13).**
- **Done:**
  - tooling (configs, CI, sync)
  - contracts v0 (implemented and tested, not released)
  - docs site
  - spikes 01–08 (375 tests: migrations, policy → SQL, RLS, registry compiler, OpenAPI client, three-way merge, Better Auth adapter, UI renderer) → ADR-0007 to ADR-0014
  - RFC-0002 (files), RFC-0003 (errors & messages) and RFC-0004 (`@strutvane/logs`) drafted
- **Next:** spike 09 (logger throughput, RFC-0004), GOVERNANCE.md, then Phase 1: core, CLI, framework and `@strutvane/logs`.
- **npm:** `@strutvane/{contracts,core,framework,auth,ui,cli,devkit,logs}`, `strutvane` and `create-strutvane` are reserved with placeholder versions. Nothing is released yet.

## 8. Contributor quick start (human or AI)

1. Read this file, then this repo's `CLAUDE.md` and `README.md`.
2. Find the spec for what you're touching (§3) and the decisions behind it.
3. Run `corepack pnpm@12.18.0 install` and then `corepack pnpm@12.18.0 run ci` to confirm a green baseline.
4. Make the change with its tests and docs. Run the `strutvane-ecosystem-guardian` agent on your diff.
5. Run the gate again, add a changeset if needed, commit, and open a PR (or push to `main` if you're a maintainer).
