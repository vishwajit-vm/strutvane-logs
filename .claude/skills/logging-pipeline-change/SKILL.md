---
name: logging-pipeline-change
description: Change the logging pipeline (record → enrich → redact → sample → queue → transports) while keeping the non-blocking guarantee, redaction-before-storage and never-throw-into-app-code rules, with tests and benchmarks.
---

# logging-pipeline-change

## When to use
Change the logging pipeline (record → enrich → redact → sample → queue → transports) while keeping the non-blocking guarantee, redaction-before-storage and never-throw-into-app-code rules, with tests and benchmarks.

## Before you start
1. Read `CLAUDE.md` in this repo, then the package spec `../../docs/rfcs/0004-logs-package.md` and the canonical decisions `../../docs/00-executive-summary.md`.
2. Check `../../docs/adr/` for decisions that constrain this change.
3. If the change touches a shared type or wire protocol, stop and follow the contract-change process (RFC first).

## Steps
1. Restate the goal and the affected public surface (APIs, CLI, generated files, wire protocol).
2. Write or adjust tests first: unit, integration (DB matrix if relevant), golden files for generators.
3. Implement the smallest change that satisfies the spec. Keep the package boundaries in CLAUDE.md.
4. Update the docs (spec section, reference, examples) and add a changeset.
5. Run lint, typecheck and tests. For generator changes, also run the generate → typecheck → test e2e.
6. Summarise what changed, what was not verified, and any follow-ups.

## Never
- Never import another Strutvane product package directly (use `@strutvane/contracts`).
- Never commit secrets, `.env` or Docker files.
- Never weaken a security default without an ADR.
