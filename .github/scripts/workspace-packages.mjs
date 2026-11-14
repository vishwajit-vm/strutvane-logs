// @ts-check
// Managed by strutvane-tooling (canonical/.github/scripts/workspace-packages.mjs). Do not edit in
// package repos.
//
// Finds the packages of a pnpm workspace, for the release scripts (`publish-if-new.mjs`,
// `check-deps.mjs`). Most Strutvane repos publish one package from the repo root, but a repo can
// have a private root and several publishable packages listed in `pnpm-workspace.yaml` (the CLI
// repo ships `@strutvane/cli` and its `strutvane` launcher that way).
//
// Dependency-free on purpose: these scripts run in CI before `pnpm install`, so they cannot use a
// YAML library. Instead of a partial YAML parser that guesses, the `packages:` list is read in the
// one simple form we use (a block list of plain paths or `dir/*` globs) and anything else is
// rejected with a clear error. Failing closed here is safer than staging the wrong set of packages.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Characters that make an entry a glob. Only a trailing `/*` is supported. */
const GLOB_CHARS = /[*?[\]{}!()]/

/**
 * Read the `packages:` entries from the text of `pnpm-workspace.yaml`. Supports the block-list
 * form, with optional quotes and comments:
 *
 * ```yaml
 * packages:
 *   - packages/*      # comment
 *   - 'tools/x'
 * ```
 *
 * Returns `[]` when there is no `packages:` key (a single-package repo whose workspace file only
 * holds settings such as `overrides`) or when it is `packages: []`. Throws on any other inline
 * value, nested content, inconsistent indentation, tabs, or a repeated `packages:` key.
 * @param {string} yaml
 * @returns {string[]}
 */
export function parseWorkspacePackages(yaml) {
  const lines = yaml.replace(/^\uFEFF/, '').split(/\r?\n/)
  /** @type {string[] | undefined} */
  let entries
  for (let i = 0; i < lines.length; i++) {
    const key = /^packages\s*:(.*)$/.exec(lines[i] ?? '')
    if (!key) continue
    if (entries) throw new Error('pnpm-workspace.yaml: "packages:" appears more than once')
    const inline = stripComment(key[1] ?? '').trim()
    if (inline === '[]') {
      entries = []
      continue
    }
    if (inline !== '') {
      throw new Error(
        `pnpm-workspace.yaml: unsupported inline "packages: ${inline}"; write it as a block list ("- path" lines)`,
      )
    }
    entries = []
    /** @type {number | undefined} */
    let indent
    for (i += 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (stripComment(line).trim() === '') continue
      if (/^[ ]*\t/.test(line)) {
        throw new Error(`pnpm-workspace.yaml line ${i + 1}: tabs are not allowed for indentation`)
      }
      const item = /^( *)-(?:\s+(.*))?$/.exec(line)
      if (!item && /^ *-/.test(line)) {
        throw new Error(
          `pnpm-workspace.yaml line ${i + 1}: malformed list item (expected "- path")`,
        )
      }
      if (!item) {
        if (!line.startsWith(' ')) {
          i -= 1 // a new top-level key ends the list; let the outer loop look at it
          break
        }
        throw new Error(
          `pnpm-workspace.yaml line ${i + 1}: only "- path" items are supported under "packages:"`,
        )
      }
      const itemIndent = item[1]?.length ?? 0
      indent ??= itemIndent
      if (itemIndent !== indent) {
        throw new Error(
          `pnpm-workspace.yaml line ${i + 1}: inconsistent indentation in the "packages:" list`,
        )
      }
      entries.push(parseScalar(item[2] ?? '', i + 1))
    }
  }
  return entries ?? []
}

/** Remove a YAML comment: `#` at the start or after whitespace, outside quotes. */
function stripComment(/** @type {string} */ text) {
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === "'" || c === '"') {
      quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1] ?? ''))) {
      return text.slice(0, i)
    }
  }
  return text
}

/**
 * Parse one list item: plain, 'single-quoted' (`''` is a literal quote) or "double-quoted"
 * (escapes are rejected rather than half-supported).
 */
function parseScalar(/** @type {string} */ raw, /** @type {number} */ lineNo) {
  const text = stripComment(raw).trim()
  const where = `pnpm-workspace.yaml line ${lineNo}`
  let value = text
  if (text.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'$/.exec(text)
    if (!m) throw new Error(`${where}: unterminated or malformed single-quoted value`)
    value = (m[1] ?? '').replace(/''/g, "'")
  } else if (text.startsWith('"')) {
    const m = /^"([^"\\]*)"$/.exec(text)
    if (!m) throw new Error(`${where}: unterminated double-quoted value, or escapes (unsupported)`)
    value = m[1] ?? ''
  }
  if (value.trim() === '') throw new Error(`${where}: empty "packages:" item`)
  return value.trim()
}

/** @typedef {{ kind: 'path', dir: string } | { kind: 'glob', parent: string }} WorkspaceEntry */

/**
 * Validate one `packages:` entry. Only two forms are supported, because they are the only ones
 * used and both are easy to expand exactly: a plain relative path (`packages/cli`) and a path
 * ending in `/*` (`packages/*`, every direct subfolder). Exclusions (`!x`), `**`, other globs,
 * absolute paths, `..` and the repo root itself are rejected.
 * @param {string} entry
 * @returns {WorkspaceEntry}
 */
export function parseWorkspaceEntry(entry) {
  const fail = () =>
    new Error(
      `pnpm-workspace.yaml: unsupported packages entry "${entry}": only plain relative paths ` +
        '("packages/cli") and a trailing "/*" ("packages/*") are supported',
    )
  let path = entry.trim().replace(/^(\.\/)+/, '')
  const isGlob = path.endsWith('/*')
  path = isGlob ? path.slice(0, -2) : path.replace(/\/+$/, '')
  const segments = path.split('/')
  if (
    path === '' ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    GLOB_CHARS.test(path) ||
    segments.some((s) => s === '' || s === '.' || s === '..')
  ) {
    throw fail()
  }
  return isGlob ? { kind: 'glob', parent: path } : { kind: 'path', dir: path }
}

/**
 * Expand entries to package folders (relative, `/`-separated, sorted, without duplicates). A glob
 * matches every direct subfolder returned by `listSubdirs`, except hidden folders and
 * `node_modules` (pnpm ignores those too).
 * @param {readonly string[]} entries raw `packages:` entries
 * @param {(dir: string) => readonly string[]} listSubdirs names of the subfolders of a relative dir
 * @returns {{ dir: string, fromGlob: boolean }[]}
 */
export function expandWorkspaceEntries(entries, listSubdirs) {
  /** @type {Map<string, boolean>} */
  const found = new Map()
  for (const raw of entries) {
    const entry = parseWorkspaceEntry(raw)
    if (entry.kind === 'path') {
      found.set(entry.dir, false) // an explicit path wins: it must exist
      continue
    }
    for (const name of listSubdirs(entry.parent)) {
      if (name.startsWith('.') || name === 'node_modules') continue
      const dir = `${entry.parent}/${name}`
      if (!found.has(dir)) found.set(dir, true)
    }
  }
  return [...found]
    .map(([dir, fromGlob]) => ({ dir, fromGlob }))
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
}

/**
 * Subfolder names of `root/dir`, or `[]` if it doesn't exist (a glob may legitimately match
 * nothing).
 * @param {string} root
 * @returns {(dir: string) => string[]}
 */
export function fsListSubdirs(root) {
  return (dir) => {
    const abs = join(root, dir)
    if (!existsSync(abs)) return []
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  }
}

/** @typedef {{ dir: string, manifest: Record<string, unknown> }} WorkspacePackage */

/**
 * Read a JSON object file, with the file path in any error.
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
export function readJsonObject(file) {
  let value
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file}: must contain a JSON object`)
  }
  return value
}

/**
 * The workspace packages of the repo at `root`, from its `pnpm-workspace.yaml` (none if the file
 * is missing or has no `packages:`). A folder matched by a glob without a `package.json` is
 * skipped, as pnpm does; an explicitly listed folder without one is an error.
 * @param {string} root
 * @returns {WorkspacePackage[]}
 */
export function listWorkspacePackages(root) {
  const wsFile = join(root, 'pnpm-workspace.yaml')
  if (!existsSync(wsFile)) return []
  const entries = parseWorkspacePackages(readFileSync(wsFile, 'utf8'))
  /** @type {WorkspacePackage[]} */
  const packages = []
  for (const { dir, fromGlob } of expandWorkspaceEntries(entries, fsListSubdirs(root))) {
    const file = join(root, dir, 'package.json')
    if (!existsSync(file)) {
      if (fromGlob) continue
      throw new Error(`pnpm-workspace.yaml lists "${dir}", but ${dir}/package.json does not exist`)
    }
    packages.push({ dir, manifest: readJsonObject(file) })
  }
  return packages
}

/** Dependency fields that make one workspace package need another at install time. */
export const RUNTIME_DEP_FIELDS = /** @type {const} */ ([
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
])

/**
 * Names a package.json depends on through the given fields.
 * @param {Record<string, unknown>} manifest
 * @param {readonly string[]} [fields]
 * @returns {string[]}
 */
export function dependencyNames(manifest, fields = RUNTIME_DEP_FIELDS) {
  /** @type {Set<string>} */
  const names = new Set()
  for (const field of fields) {
    const deps = manifest[field]
    if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
      for (const name of Object.keys(deps)) names.add(name)
    }
  }
  return [...names]
}

/**
 * Order items so each comes after every item it depends on (`deps` naming other items; unknown
 * names are ignored). Stable: independent items keep their input order. A cycle (including a
 * package depending on itself) is an error that names the cycle.
 * @template {{ name: string, deps: readonly string[] }} T
 * @param {readonly T[]} items
 * @returns {T[]}
 */
export function orderByDependencies(items) {
  /** @type {Map<string, T>} */
  const byName = new Map()
  for (const item of items) {
    if (byName.has(item.name)) throw new Error(`duplicate workspace package name "${item.name}"`)
    byName.set(item.name, item)
  }
  /** @type {T[]} */
  const ordered = []
  /** @type {Set<string>} */
  const done = new Set()
  /** @type {string[]} */
  const stack = []
  const visit = (/** @type {T} */ item) => {
    if (done.has(item.name)) return
    const at = stack.indexOf(item.name)
    if (at !== -1) {
      throw new Error(
        `dependency cycle between workspace packages: ${[...stack.slice(at), item.name].join(' -> ')}`,
      )
    }
    stack.push(item.name)
    for (const dep of item.deps) {
      const target = byName.get(dep)
      if (target) visit(target)
    }
    stack.pop()
    done.add(item.name)
    ordered.push(item)
  }
  for (const item of items) visit(item)
  return ordered
}
