---
name: strutvane-contribute
description: The standard workflow for making any change in any Strutvane repo — understand the design first, change with tests and docs, verify, and land it on main. Use at the start of every contribution. Synced from strutvane-tooling.
---

# strutvane-contribute

## 1. Understand before you change

1. Read `.claude/ECOSYSTEM.md` (the ecosystem memory) and this repo's `CLAUDE.md`.
2. Locate the spec for the area you're touching (ECOSYSTEM.md §3), plus any ADRs and RFCs that constrain it.
3. Decide which kind of change this is:
   - **Internal:** behaviour inside one package, with no public API change. Go ahead.
   - **Public API or contract change:** write or extend an RFC first, and get it accepted.
   - **New connection between packages:** update `docs/17-integration-map.md` (in the hub) in the same change.
   - **New decision** (technology, process, security): record an ADR in the hub.
4. List the failure scenarios this change must handle *before* writing code.

## 2. Make the change

1. Confirm a green baseline:
   ```
   corepack pnpm@12.18.0 install
   corepack pnpm@12.18.0 run ci
   ```
2. Write the tests first, or alongside the code:
   - behaviour tests, including negative cases
   - security cases where relevant
   - type-level tests for public types (`test/*.test-d.ts`)
3. Implement in small, single-purpose modules, reusing contracts, core and devkit instead of duplicating.
4. Document the *why* in TSDoc and comments. Update the README, the hub spec and the docs site when behaviour visible to users changes.
5. For a published package, add a changeset: `corepack pnpm@12.18.0 changeset`.

## 3. Verify

1. Run `corepack pnpm@12.18.0 run ci`. It must pass, with no skipped tests and no lowered thresholds.
2. Run the `strutvane-ecosystem-guardian` agent on the diff and fix its findings.
3. Confirm you haven't edited synced files. Run this from strutvane-tooling:
   ```
   node scripts/sync.mjs --check
   ```

## 4. Land it

1. Commit with a conventional message (`feat:`, `fix:` …), signed off with `git commit -s`.
2. Integrate on `main`:
   - **Maintainers:** push to `main`.
   - **Contributors:** open a PR.
   - **Feature branches:** merge back into `main` once CI is green. Never leave work on a side branch.
3. Check the CI run on GitHub, and report the exact result.
