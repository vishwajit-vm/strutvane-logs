/**
 * The sanitiser: turns ANY value into a JSON-safe, size-bounded, redacted copy. It never throws.
 *
 * One walk does two jobs (cheaper than two passes, as measured in spike 09):
 *
 * 1. **Safety.** It handles:
 *    - circular references and very deep nesting
 *    - `BigInt`, `Error` (with cause chains), `Map`/`Set`, binary data and functions
 *    - throwing getters and Proxies
 *    - huge strings, arrays and objects
 * 2. **Redaction before storage** (RFC-0004 §6):
 *    - *By key:* any key whose normalised name contains a sensitive word (`password`, `token`, …),
 *      at any depth, becomes `[REDACTED]`. False positives (e.g. `tokenCount`) are preferred over
 *      leaks.
 *    - *By pattern,* inside every string including messages:
 *      - JWTs
 *      - Bearer/Basic credentials
 *      - credentials in URLs
 *      - PEM private keys
 *      - Luhn-valid card numbers
 *    - Custom keys and patterns can be added.
 *
 * Errors are serialised to the contracts' `LogError` shape: `name`, `message`, `stack`, `code`,
 * `cause`.
 *
 * @module
 */

/** The built-in pattern rules. Each one is proven necessary by a tripwire test. */
export type PatternRule = 'jwt' | 'bearer' | 'urlCredentials' | 'privateKey' | 'pan'

/** Sanitiser settings. */
export interface SanitizeOptions {
  /** Redact by key and by pattern. `false` keeps only the safety transformations. */
  readonly redact: boolean
  /** Extra sensitive key fragments, e.g. `['iban']` (matched like the built-ins). */
  readonly extraKeys: readonly string[]
  /** Extra patterns; every match is replaced by `[REDACTED]`. */
  readonly extraPatterns: readonly RegExp[]
  /** Disable built-in rules (only meant for tests that prove each rule matters). */
  readonly disable: ReadonlySet<PatternRule>
  readonly maxDepth: number
  readonly maxStringLength: number
  readonly maxArrayLength: number
  readonly maxObjectKeys: number
  readonly maxCauseDepth: number
}

/** Safe defaults. */
export const DEFAULT_SANITIZE: SanitizeOptions = Object.freeze({
  redact: true,
  extraKeys: [],
  extraPatterns: [],
  disable: new Set<PatternRule>(),
  maxDepth: 8,
  maxStringLength: 8_192,
  maxArrayLength: 200,
  maxObjectKeys: 200,
  maxCauseDepth: 5,
})

/** The replacement for redacted values. */
export const REDACTED = '[REDACTED]'

/** Key fragments that mark a value as secret, matched against the normalised key name. */
const SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'privatekey',
  'credential',
  'sessionid',
]

/** Normalise a key for matching: lowercase, without `-` and `_` (so api_key, api-key, apiKey match). */
export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '')
}

interface PatternDef {
  readonly rule: PatternRule
  readonly re: RegExp
  readonly replace: string | ((match: string) => string)
}

const PATTERNS: readonly PatternDef[] = [
  // PEM private keys, complete or truncated at the end of the string.
  {
    rule: 'privateKey',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replace: '[REDACTED:private-key]',
  },
  // JSON Web Tokens: three base64url segments, starting with the encoded '{"' header.
  {
    rule: 'jwt',
    re: /eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g,
    replace: '[REDACTED:jwt]',
  },
  // HTTP credentials in free text: "Bearer abc…", "Basic dXNlcjpwYXNz", "Token …".
  {
    rule: 'bearer',
    re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (m) => `${m.split(/\s+/)[0]} ${REDACTED}`,
  },
  // Credentials inside URLs: scheme://user:password@host → scheme://user:[REDACTED]@host
  {
    rule: 'urlCredentials',
    re: /([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi,
    replace: (m) => m.replace(/:([^:@]+)@$/, `:${REDACTED}@`),
  },
  // Card numbers: 13–19 digits (optional single spaces/dashes), not glued to other digits, Luhn-valid.
  {
    rule: 'pan',
    re: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g,
    replace: (m) => (luhnValid(m.replace(/[ -]/g, '')) ? '[REDACTED:pan]' : m),
  },
]

/** Luhn checksum, used to recognise card numbers. */
export function luhnValid(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** Make sure a custom pattern is global, so every occurrence is replaced. */
function asGlobal(re: RegExp): RegExp {
  return re.global ? re : new RegExp(re.source, `${re.flags}g`)
}

/**
 * Redact secret patterns inside a string (built-ins + `extraPatterns`).
 *
 * @example
 * redactString('db=postgres://app:hunter2@db:5432/x') // 'db=postgres://app:[REDACTED]@db:5432/x'
 */
export function redactString(
  value: string,
  options: Pick<SanitizeOptions, 'disable' | 'extraPatterns'> = DEFAULT_SANITIZE,
): string {
  let out = value
  // Short strings can't contain the long patterns; skip the regexes for them (hot path).
  const short = out.length < 13
  if (!short || out.includes('eyJ') || out.includes('://')) {
    for (const p of PATTERNS) {
      if (options.disable.has(p.rule)) continue
      p.re.lastIndex = 0
      if (!p.re.test(out)) continue
      p.re.lastIndex = 0
      out =
        typeof p.replace === 'string' ? out.replace(p.re, p.replace) : out.replace(p.re, p.replace)
    }
  }
  for (const re of options.extraPatterns) {
    const g = asGlobal(re)
    g.lastIndex = 0
    out = out.replace(g, REDACTED)
  }
  return out
}

/** An `Error` serialised to the contracts' `LogError` shape (plus any extra own properties). */
interface SerialisedError {
  name?: string
  message?: string
  stack?: string
  code?: string
  cause?: unknown
  errors?: unknown
  [key: string]: unknown
}

/** A function that turns any value into a safe, redacted, JSON-serialisable copy. */
export type Sanitizer = (value: unknown) => unknown

/** Create a sanitiser bound to `options` (merged over {@link DEFAULT_SANITIZE}). */
export function createSanitizer(options: Partial<SanitizeOptions> = {}): Sanitizer {
  const o: SanitizeOptions = { ...DEFAULT_SANITIZE, ...options }
  const fragments = [...SENSITIVE_KEY_FRAGMENTS, ...o.extraKeys.map(normaliseKey)]
  const extraPatterns = o.extraPatterns.map(asGlobal)
  const keyCache = new Map<string, boolean>()
  const isSensitiveKey = (key: string): boolean => {
    let hit = keyCache.get(key)
    if (hit === undefined) {
      const n = normaliseKey(key)
      hit = fragments.some((f) => n.includes(f))
      if (keyCache.size < 10_000) keyCache.set(key, hit)
    }
    return hit
  }

  const str = (s: string): string => {
    const cut =
      s.length > o.maxStringLength
        ? `${s.slice(0, o.maxStringLength)}…[truncated ${s.length - o.maxStringLength} chars]`
        : s
    return o.redact ? redactString(cut, { disable: o.disable, extraPatterns }) : cut
  }

  const walk = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    switch (typeof value) {
      case 'string':
        return str(value)
      case 'number':
        return Number.isFinite(value) ? value : String(value)
      case 'boolean':
        return value
      case 'bigint':
        return value.toString()
      case 'undefined':
        return undefined
      case 'symbol':
        return value.toString()
      case 'function':
        return `[Function ${value.name || 'anonymous'}]`
      default:
        break
    }
    if (value === null) return null
    const obj = value as object
    if (seen.has(obj)) return '[Circular]'
    if (depth >= o.maxDepth) return '[MaxDepth]'
    seen.add(obj)
    try {
      if (obj instanceof Error) return serialiseError(obj, depth, seen, 0)
      if (obj instanceof Date) {
        return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString()
      }
      if (ArrayBuffer.isView(obj)) return `[Binary ${obj.byteLength} bytes]`
      if (obj instanceof ArrayBuffer) return `[Binary ${obj.byteLength} bytes]`
      if (obj instanceof Map) {
        const entries = [...obj.entries()].slice(0, o.maxObjectKeys)
        return walk(Object.fromEntries(entries.map(([k, v]) => [String(k), v])), depth, seen)
      }
      if (obj instanceof Set) return walk([...obj].slice(0, o.maxArrayLength), depth, seen)
      if (Array.isArray(obj)) return walkArray(obj, depth, seen)
      const toJSON = (obj as { toJSON?: unknown }).toJSON
      if (typeof toJSON === 'function') {
        try {
          return walk(toJSON.call(obj), depth + 1, seen)
        } catch {
          return '[toJSON threw]'
        }
      }
      return walkObject(obj, depth, seen)
    } catch {
      return '[Unserialisable]'
    } finally {
      seen.delete(obj)
    }
  }

  const walkArray = (arr: readonly unknown[], depth: number, seen: WeakSet<object>): unknown[] => {
    const len = Math.min(arr.length, o.maxArrayLength)
    const out: unknown[] = new Array(len)
    for (let i = 0; i < len; i++) {
      let item: unknown
      try {
        item = arr[i]
      } catch {
        item = '[Unreadable]'
      }
      const v = walk(item, depth + 1, seen)
      out[i] = v === undefined ? null : v
    }
    if (arr.length > len) out.push(`[…${arr.length - len} more items]`)
    return out
  }

  const walkObject = (obj: object, depth: number, seen: WeakSet<object>): unknown => {
    let keys: string[]
    try {
      keys = Object.keys(obj)
    } catch {
      return '[Unreadable object]'
    }
    const out: Record<string, unknown> & { _truncatedKeys?: number } = {}
    const limit = Math.min(keys.length, o.maxObjectKeys)
    for (let i = 0; i < limit; i++) {
      const key = keys[i] as string
      if (o.redact && isSensitiveKey(key)) {
        out[key] = REDACTED
        continue
      }
      let v: unknown
      try {
        v = (obj as Record<string, unknown>)[key]
      } catch {
        v = '[Unreadable]'
      }
      const w = walk(v, depth + 1, seen)
      if (w !== undefined) out[key] = w
    }
    if (keys.length > limit) out._truncatedKeys = keys.length - limit
    return out
  }

  const serialiseError = (
    err: Error,
    depth: number,
    seen: WeakSet<object>,
    causeDepth: number,
  ): SerialisedError => {
    const out: SerialisedError = {}
    try {
      out.name = err.name
      out.message = str(String(err.message))
      if (typeof err.stack === 'string') out.stack = str(err.stack)
      const code = (err as { code?: unknown }).code
      if (code !== undefined) out.code = typeof code === 'string' ? str(code) : String(code)
      const cause = (err as { cause?: unknown }).cause
      if (cause !== undefined) out.cause = serialiseCause(cause, depth, seen, causeDepth)
      if (err instanceof AggregateError) out.errors = walk(err.errors, depth + 1, seen)
      for (const key of Object.keys(err)) {
        if (key in out || key === 'cause') continue
        let v: unknown
        try {
          v = (err as unknown as Record<string, unknown>)[key]
        } catch {
          v = '[Unreadable]'
        }
        out[key] = o.redact && isSensitiveKey(key) ? REDACTED : walk(v, depth + 1, seen)
      }
    } catch {
      out.name = out.name ?? 'Error'
      out.message = out.message ?? '[unreadable error]'
    }
    return out
  }

  const serialiseCause = (
    cause: unknown,
    depth: number,
    seen: WeakSet<object>,
    causeDepth: number,
  ): unknown => {
    if (causeDepth >= o.maxCauseDepth) return '[MaxCauseDepth]'
    if (!(cause instanceof Error)) return walk(cause, depth + 1, seen)
    if (seen.has(cause)) return '[Circular]'
    seen.add(cause)
    try {
      return serialiseError(cause, depth + 1, seen, causeDepth + 1)
    } finally {
      seen.delete(cause)
    }
  }

  return (value: unknown): unknown => {
    try {
      return walk(value, 0, new WeakSet())
    } catch {
      return '[Unserialisable]'
    }
  }
}
