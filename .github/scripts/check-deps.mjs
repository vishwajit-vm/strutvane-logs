#!/usr/bin/env node
// @ts-check
// Managed by strutvane-tooling (canonical/.github/scripts/check-deps.mjs). Do not edit in package repos.
//
// Fails if package.json (or pnpm-workspace.yaml overrides) contains a dependency that only works on
// one developer's machine: link:, file:, workspace: or a relative/absolute path. Such entries are
// allowed temporarily during local cross-repo development (ADR-0016) but must never be committed.
//
// In a repo with a pnpm workspace (pnpm-workspace.yaml `packages:`), every workspace package's
// package.json is checked too, not only the root. That includes `workspace:` links between them:
// the release script stages each package with `npm stage publish`, which does not rewrite that
// protocol, so it would ship a dependency nobody can install.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listWorkspacePackages, readJsonObject } from './workspace-packages.mjs'

const LOCAL_SPEC = /^(link:|file:|workspace:|portal:|\.{1,2}\/|\/|[A-Za-z]:[\\/])/

/**
 * Find local-only dependency specs. Exported for tests.
 * @param {Record<string, unknown>} pkg parsed package.json
 * @param {string} workspaceYaml contents of pnpm-workspace.yaml ('' if absent)
 * @returns {string[]} human-readable problems
 */
export function findLocalDeps(pkg, workspaceYaml) {
  const problems = []
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const deps = pkg[field]
    if (deps && typeof deps === 'object') {
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec === 'string' && LOCAL_SPEC.test(spec))
          problems.push(`${field}.${name} = "${spec}"`)
      }
    }
  }
  // pnpm overrides in pnpm-workspace.yaml: lines like `  '@strutvane/contracts': link:../contracts`
  for (const line of workspaceYaml.split(/\r?\n/)) {
    const m = /^\s+['"]?([^'":]+)['"]?\s*:\s*['"]?([^'"\s#]+)/.exec(line)
    if (m?.[2] && LOCAL_SPEC.test(m[2])) problems.push(`pnpm-workspace.yaml: ${m[1]} = "${m[2]}"`)
  }
  return problems
}

/**
 * Check the repo at `root`: its package.json and pnpm-workspace.yaml, plus the package.json of
 * every workspace package. Problems in a workspace package are prefixed with its path. Throws if
 * the workspace file can't be read (fail closed: an unreadable list must not pass the check).
 * Exported for tests.
 * @param {string} root
 * @returns {string[]}
 */
export function findRepoLocalDeps(root) {
  const wsFile = join(root, 'pnpm-workspace.yaml')
  const ws = existsSync(wsFile) ? readFileSync(wsFile, 'utf8') : ''
  const problems = findLocalDeps(readJsonObject(join(root, 'package.json')), ws)
  for (const { dir, manifest } of listWorkspacePackages(root)) {
    for (const problem of findLocalDeps(manifest, ''))
      problems.push(`${dir}/package.json: ${problem}`)
  }
  return problems
}

function main() {
  const problems = findRepoLocalDeps(process.cwd())
  if (problems.length > 0) {
    process.stderr.write(
      `Local-only dependencies must not be committed (ADR-0016):\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
        'Depend on a published version instead (e.g. "@strutvane/contracts": "0.1.0-next.0").\n',
    )
    process.exitCode = 1
    return
  }
  process.stdout.write('No local-only dependencies.\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(
      `check-deps failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
