#!/usr/bin/env node
// @ts-check
// Managed by strutvane-tooling (canonical/.github/scripts/publish-if-new.mjs). Do not edit in
// package repos. See ADR-0016 ("version on main, CI publishes what's new") and ADR-0018 (staged
// publishing).
//
// STAGES each of this repo's packages on npm (`npm stage publish`) only if its exact version is
// neither published nor already staged. A maintainer then approves the staged version on
// npmjs.com with 2FA, so a CI run alone can never make a version live. Safe to re-run
// (idempotent). Uses npm trusted publishing (OIDC) with provenance; no tokens.
//
// Which packages:
//   - Root package.json not private: that one package, staged from the repo root.
//   - Root private: every non-private package listed in pnpm-workspace.yaml `packages:` (plain
//     paths and `dir/*` only; see workspace-packages.mjs), each staged from its own folder, in
//     dependency order (a package after the workspace packages it depends on). If one fails, the
//     others are still attempted, except those that depend on it; the run then exits non-zero.
//     Workspace packages depend on each other by exact published version, never `workspace:`
//     (check-deps.mjs refuses it), because `npm stage publish` does not rewrite that protocol.
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dependencyNames,
  listWorkspacePackages,
  orderByDependencies,
  readJsonObject,
} from './workspace-packages.mjs'

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
 * @param {{ version: string, published: readonly string[], latest: string | undefined, staged?: readonly string[] }} input
 * @returns {{ action: 'skip', reason: string } | { action: 'stage', tag: string }}
 */
export function decide({ version, published, latest, staged = [] }) {
  const tag = distTagFor(version)
  if (published.includes(version)) return { action: 'skip', reason: `${version} is already on npm` }
  if (staged.includes(version)) {
    return { action: 'skip', reason: `${version} is already staged and waiting for approval` }
  }
  if (tag === 'latest' && latest && !latest.includes('-') && compareStable(version, latest) < 0) {
    throw new Error(`refusing to publish ${version} as latest: a higher latest (${latest}) exists`)
  }
  return { action: 'stage', tag }
}

/**
 * Collect the versions of `name` found in `npm stage list --json` output. The exact JSON shape is
 * not part of a documented contract yet, so this walks any nesting and keeps every object that has
 * a string `version` (and, when present, a matching `name`). Exported for tests.
 * @param {unknown} data
 * @param {string} name
 * @returns {string[]}
 */
export function stagedVersions(data, name) {
  /** @type {string[]} */
  const found = []
  const walk = (/** @type {unknown} */ node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node === null || typeof node !== 'object') return
    const rec = /** @type {Record<string, unknown>} */ (node)
    const recName = rec['name'] ?? rec['package']
    if (typeof rec['version'] === 'string' && (recName === undefined || recName === name)) {
      found.push(rec['version'])
    }
    for (const value of Object.values(rec)) if (value && typeof value === 'object') walk(value)
  }
  walk(data)
  return [...new Set(found)]
}

/** @typedef {{ name: string, version: string, dir: string, deps: string[] }} ReleaseTarget */

/**
 * Decide which packages to stage, in order. Pure: takes parsed manifests. Exported for tests.
 * - A non-private root is the only target (`dir: '.'`), exactly as before workspaces existed.
 * - A private root yields its non-private workspace packages, ordered so a package comes after
 *   any other target it depends on (dependencies, peerDependencies, optionalDependencies).
 *   Private workspace packages are never staged. A dependency cycle or a duplicate name throws.
 * @param {Record<string, unknown>} root parsed root package.json
 * @param {readonly import('./workspace-packages.mjs').WorkspacePackage[]} workspace
 * @returns {ReleaseTarget[]}
 */
export function releaseTargets(root, workspace) {
  if (!root['private']) {
    return [{ name: String(root['name']), version: String(root['version']), dir: '.', deps: [] }]
  }
  const publishable = workspace.filter((p) => !p.manifest['private'])
  /** @type {Set<unknown>} */
  const names = new Set(publishable.map((p) => p.manifest['name']))
  const targets = publishable.map(({ dir, manifest }) => {
    const name = manifest['name']
    const version = manifest['version']
    if (typeof name !== 'string' || name === '') {
      throw new Error(`${dir}/package.json: a publishable package needs a "name"`)
    }
    if (typeof version !== 'string' || version === '') {
      throw new Error(`${dir}/package.json: a publishable package needs a "version"`)
    }
    return { name, version, dir, deps: dependencyNames(manifest).filter((d) => names.has(d)) }
  })
  return orderByDependencies(targets)
}

/** @typedef {'staged' | 'skipped' | 'failed' | 'blocked'} StageStatus */
/** @typedef {{ status: 'staged' | 'skipped', detail: string } | { status: 'failed', detail: string, code: number }} StageOutcome */
/** @typedef {{ name: string, version: string, dir: string, status: StageStatus, detail: string }} StageResult */

/**
 * Stage every target in order with `stageOne`, isolating failures. Exported for tests.
 * - A target whose `stageOne` throws or returns `failed` is recorded as `failed`.
 * - A target that depends on a failed or blocked target is not attempted (`blocked`): staging it
 *   would ask a maintainer to approve a version whose dependency was never staged.
 * - Every other target is still attempted.
 * @param {readonly ReleaseTarget[]} targets in dependency order (see releaseTargets)
 * @param {(target: ReleaseTarget) => StageOutcome} stageOne
 * @returns {StageResult[]}
 */
export function stageAll(targets, stageOne) {
  /** @type {Set<string>} */
  const broken = new Set()
  /** @type {StageResult[]} */
  const results = []
  for (const target of targets) {
    const { name, version, dir } = target
    const blockers = target.deps.filter((d) => broken.has(d))
    if (blockers.length > 0) {
      broken.add(name)
      results.push({
        name,
        version,
        dir,
        status: 'blocked',
        detail: `not attempted: depends on ${blockers.join(', ')}, which did not stage`,
      })
      continue
    }
    /** @type {StageOutcome} */
    let outcome
    try {
      outcome = stageOne(target)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      outcome = { status: 'failed', detail, code: 1 }
    }
    if (outcome.status === 'failed') broken.add(name)
    results.push({ name, version, dir, status: outcome.status, detail: outcome.detail })
  }
  return results
}

/**
 * True if any result means the run must exit non-zero. Exported for tests.
 * @param {readonly StageResult[]} results
 */
export function hasFailures(results) {
  return results.some((r) => r.status === 'failed' || r.status === 'blocked')
}

/**
 * A per-package summary, one line each. Exported for tests.
 * @param {readonly StageResult[]} results
 * @returns {string}
 */
export function formatSummary(results) {
  const lines = results.map(
    (r) => `  ${r.status.padEnd(7)} ${r.name}@${r.version} (${r.dir}): ${r.detail}`,
  )
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'blocked').length
  return `Summary: ${results.length} package(s), ${failed} failed\n${lines.join('\n')}\n`
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/**
 * Run npm in `cwd`. The package folder is the working directory so npm reads that package's
 * package.json (name, version, files, publishConfig) and packs only that folder.
 * @param {string[]} args
 * @param {string} cwd
 * @param {boolean} [inherit] stream output to the console instead of capturing it
 */
function runNpm(args, cwd, inherit = false) {
  return spawnSync(npm, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...(inherit ? { stdio: 'inherit' } : {}),
  })
}

/**
 * Versions of `name` already staged. If the list can't be read (e.g. the registry needs a login
 * for it), return `[]` with a warning: staging then either succeeds or fails loudly, and never
 * makes anything live, because approval on npmjs.com is still required.
 */
function stagedState(/** @type {string} */ name, /** @type {string} */ cwd) {
  const r = runNpm(['stage', 'list', name, '--json'], cwd)
  if (r.status !== 0) {
    process.stderr.write(`warning: could not list staged versions: ${(r.stderr ?? '').trim()}\n`)
    return []
  }
  try {
    return stagedVersions(JSON.parse(r.stdout || '[]'), name)
  } catch {
    process.stderr.write('warning: could not parse `npm stage list --json` output\n')
    return []
  }
}

/** Read registry state for a package. A package that was never published yields empty state. */
function registryState(/** @type {string} */ name, /** @type {string} */ cwd) {
  const r = runNpm(['view', name, 'versions', 'dist-tags', '--json'], cwd)
  if (r.status !== 0) {
    if (/E404|404 Not Found/.test(r.stderr ?? '')) return { published: [], latest: undefined }
    throw new Error(`npm view failed: ${(r.stderr ?? '').trim()}`)
  }
  const data = JSON.parse(r.stdout || '{}')
  const versions = Array.isArray(data.versions)
    ? data.versions
    : data.versions
      ? [data.versions]
      : []
  return { published: versions, latest: data['dist-tags']?.latest }
}

/**
 * Stage one package from its own folder, unless it is already published or staged.
 * @param {ReleaseTarget} target
 * @param {string} repoRoot
 * @returns {StageOutcome}
 */
function stageOne({ name, version, dir }, repoRoot) {
  const cwd = resolve(repoRoot, dir)
  const decision = decide({
    version,
    ...registryState(name, cwd),
    staged: stagedState(name, cwd),
  })
  if (decision.action === 'skip') {
    process.stdout.write(`skip: ${decision.reason}\n`)
    return { status: 'skipped', detail: decision.reason }
  }
  process.stdout.write(`staging ${name}@${version} with tag "${decision.tag}"\n`)
  const r = runNpm(
    ['stage', 'publish', '--access', 'public', '--provenance', '--tag', decision.tag],
    cwd,
    true,
  )
  if (r.status !== 0) {
    const code = r.status ?? 1
    return { status: 'failed', detail: `npm stage publish exited with code ${code}`, code }
  }
  process.stdout.write('staged. Approve it on npmjs.com to make it live.\n')
  return { status: 'staged', detail: `staged with tag "${decision.tag}", approve it on npmjs.com` }
}

function main() {
  const repoRoot = process.cwd()
  const root = readJsonObject(join(repoRoot, 'package.json'))
  if (!root['private']) {
    // One package from the repo root: the same flow, output and exit code as before workspaces.
    for (const target of releaseTargets(root, [])) {
      const outcome = stageOne(target, repoRoot)
      if (outcome.status === 'failed') process.exitCode = outcome.code
    }
    return
  }
  const targets = releaseTargets(root, listWorkspacePackages(repoRoot))
  if (targets.length === 0) {
    process.stdout.write(`${String(root['name'])} is private, nothing to publish.\n`)
    return
  }
  process.stdout.write(
    `${String(root['name'])} is a private workspace root. Staging ${targets.length} package(s) in dependency order: ${targets.map((t) => t.name).join(', ')}\n`,
  )
  const results = stageAll(targets, (target) => {
    process.stdout.write(`\n== ${target.name} (${target.dir})\n`)
    return stageOne(target, repoRoot)
  })
  process.stdout.write(`\n${formatSummary(results)}`)
  if (hasFailures(results)) process.exitCode = 1
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
