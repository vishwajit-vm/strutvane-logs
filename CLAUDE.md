# CLAUDE.md: Strutvane Logs (`@strutvane/logs`)

Project memory for Claude Code in this repository. Keep this file short, accurate and current.

## Ecosystem memory (shared by every Strutvane repo)

The file below is synced from strutvane-tooling and is identical in every repo. It covers how the whole ecosystem fits together: repo map, decisions, connection rules, standards, workflow and current status. Read it before changing anything.

@.claude/ECOSYSTEM.md

## What this repo is

Zero-config logging for TypeScript apps: structured non-blocking logs, automatic rotation and retention, secret redaction, request logging, and a built-in log viewer at /_strutvane/logs. Installed by default in Strutvane apps.

It is one repo of the **Strutvane** polyrepo ecosystem (one GitHub repo per package; see ADR-0002). The hub with the full blueprint is https://github.com/vishwajit-vm/strutvane. Locally it is the umbrella folder two levels up: `../../docs/`.

## Status

- **No code in this repo yet.** It is implemented in its roadmap phase (Phase 1, see ECOSYSTEM.md §7). Design first: [RFC-0004](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0004-logs-package.md) is the spec. A logger benchmark spike (09) runs before implementation.
- The source of truth for decisions is `../../docs/00-executive-summary.md` (D1–D20). If anything here conflicts with it, that file wins.
- The package spec is `../../docs/rfcs/0004-logs-package.md` (online: https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0004-logs-package.md).

## Boundaries (non-negotiable)

- Allowed dependencies: `@strutvane/core` and `@strutvane/contracts`. It must never import `@strutvane/framework`, `auth` or `ui`; it connects through the `Logger` token, framework hooks and installer `enhances` (see the integration map).
- Cooperation with other Strutvane packages happens **only through `@strutvane/contracts`**, resolved at runtime via the core container.
- Public API changes need a changeset, docs and tests. Contract changes need an RFC.

## Conventions (apply once code exists)

- TypeScript strict, ESM only, Node 24+ (Node 26 LTS is the target). No decorators or reflection.
- Validation uses Standard Schema with Zod 4 as the default. Errors are RFC 9457 problem+json.
- Tooling: pnpm, tsdown (build), Biome (lint/format), Vitest (tests), Playwright (UI e2e), Testcontainers (DB).
- Code generation and AST work pin the TypeScript 6 compiler API (`@typescript/typescript6`), because TypeScript 7 has no compiler API.
- Releases: Changesets, npm trusted publishing (OIDC) with provenance. Core packages share a major release train.
- **Docker is local-only and never committed** (ADR-0006). Never commit `.env`; keep `.env.example` complete and documented.
- Windows, macOS and Linux are all first-class. Use no bash-only scripts.

## Definition of done (for any change)

Code, tests, docs and a changeset ship together. Security implications are noted. The CLI help or reference is updated if commands changed.

## Where things are

- `.claude/skills/`: task playbooks for this package (invoke by name)
- `.claude/agents/`: specialised reviewer subagents
- `.claude/commands/`: slash commands (`/spec`, `/pre-pr`)
