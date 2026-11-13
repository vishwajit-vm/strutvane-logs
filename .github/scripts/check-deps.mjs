#!/usr/bin/env node
// @ts-check
// Managed by strutvane-tooling (canonical/.github/scripts/check-deps.mjs). Do not edit in package repos.
//
// Fails if package.json (or pnpm-workspace.yaml overrides) contains a dependency that only works on
// one developer's machine: link:, file:, workspace: or a relative/absolute path. Such entries are
// allowed temporarily during local cross-repo development (ADR-0016) but must never be committed.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function main() {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const ws = existsSync('pnpm-workspace.yaml') ? readFileSync('pnpm-workspace.yaml', 'utf8') : ''
  const problems = findLocalDeps(pkg, ws)
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
