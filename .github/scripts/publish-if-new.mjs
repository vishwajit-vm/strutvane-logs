#!/usr/bin/env node
// @ts-check
// Managed by strutvane-tooling (canonical/.github/scripts/publish-if-new.mjs). Do not edit in
// package repos. See ADR-0016: "version on main, CI publishes what's new".
//
// Publishes this repo's package to npm only if its exact version isn't on the registry yet.
// Safe to re-run (idempotent). Uses npm trusted publishing (OIDC) with provenance; no tokens.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Decide the npm dist-tag for a version. Exported for tests.
 * `1.2.3` → `latest`; `0.1.0-next.4` → `next`; `0.1.0-canary.20261114` → `canary`.
 * @param {string} version
 * @returns {string}
 */
export function distTagFor(version) {
  const m = SEMVER.exec(version)
  if (!m) throw new Error(`not a valid semver version: "${version}"`)
  const pre = m[4]
  if (!pre) return 'latest'
  const id = pre.split('.')[0] ?? ''
  if (!/^[a-z][a-z0-9-]*$/.test(id) || id === 'latest') {
    throw new Error(`pre-release id "${id}" must be lowercase letters (e.g. next, canary)`)
  }
  return id
}

/**
 * Compare two stable semver versions numerically. Exported for tests.
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
export function compareStable(/** @type {string} */ a, /** @type {string} */ b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Decide what to do. Pure: takes the registry state as input. Exported for tests.
 * @param {{ version: string, published: readonly string[], latest: string | undefined }} input
 * @returns {{ action: 'skip', reason: string } | { action: 'publish', tag: string }}
 */
export function decide({ version, published, latest }) {
  const tag = distTagFor(version)
  if (published.includes(version)) return { action: 'skip', reason: `${version} is already on npm` }
  if (tag === 'latest' && latest && !latest.includes('-') && compareStable(version, latest) < 0) {
    throw new Error(`refusing to publish ${version} as latest: a higher latest (${latest}) exists`)
  }
  return { action: 'publish', tag }
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** Read registry state for a package. A package that was never published yields empty state. */
function registryState(/** @type {string} */ name) {
  const r = spawnSync(npm, ['view', name, 'versions', 'dist-tags', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (r.status !== 0) {
    if (/E404|404 Not Found/.test(r.stderr)) return { published: [], latest: undefined }
    throw new Error(`npm view failed: ${r.stderr.trim()}`)
  }
  const data = JSON.parse(r.stdout || '{}')
  const versions = Array.isArray(data.versions)
    ? data.versions
    : data.versions
      ? [data.versions]
      : []
  return { published: versions, latest: data['dist-tags']?.latest }
}

function main() {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  if (pkg.private) {
    process.stdout.write(`${pkg.name} is private, nothing to publish.\n`)
    return
  }
  const decision = decide({ version: pkg.version, ...registryState(pkg.name) })
  if (decision.action === 'skip') {
    process.stdout.write(`skip: ${decision.reason}\n`)
    return
  }
  process.stdout.write(`publishing ${pkg.name}@${pkg.version} with tag "${decision.tag}"\n`)
  const r = spawnSync(
    npm,
    ['publish', '--access', 'public', '--provenance', '--tag', decision.tag],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  )
  process.exitCode = r.status ?? 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(
      `publish failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
