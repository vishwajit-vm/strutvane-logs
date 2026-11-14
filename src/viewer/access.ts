/**
 * Who may open the log viewer (RFC-0004 §6). Logs are sensitive even after redaction (ids, routes,
 * error messages, timing), so access is **closed by default** and checked on every request.
 *
 * Decision order:
 *
 * 1. **IP allow-list** (optional, all modes): a client outside it gets a 404.
 * 2. **`authorize(request)`** (if provided) is the only rule. `true` allows; `false` or a thrown
 *    error hides the viewer (404). Use it to plug in your own auth (e.g. "admins only").
 * 3. **Local development** (`APP_ENV=local`): allowed, so `pnpm dev` just works, but only when the
 *    request is addressed to a loopback host (`localhost`, `127.0.0.1` or `[::1]`, any port) in
 *    both the `Host` header and the URL. A page on another site can make a browser send requests
 *    to a local server under its own host name (DNS rebinding); those carry a foreign `Host` and
 *    get a 404. When the peer address is known (`ip`, from the socket), it must also be loopback
 *    (`127.0.0.0/8`, `::1`, `::ffff:127.x.x.x`): a dev server bound to `0.0.0.0` must not open the
 *    viewer to another machine that simply sends `Host: localhost`. When the peer is unknown,
 *    only the host check applies, because some runtimes and adapters don't expose the socket
 *    peer; refusing there would break `pnpm dev` while the `Host` check still blocks rebinding.
 * 4. **Viewer token** (`LOGS_VIEWER_TOKEN`, at least 16 characters), in every mode, so a dev
 *    server reached through Docker, WSL or a VM (a non-loopback peer) can still be opened: allowed with
 *    `Authorization: Bearer <token>` or a signed session cookie. Opening the page once with
 *    `?token=<token>` sets the cookie (HttpOnly, SameSite=Strict, 8 h) and redirects to a clean URL.
 * 5. **Otherwise the viewer doesn't exist** (404), so production is safe even if you forget it.
 *
 * Secrets are compared in constant time, through SHA-256 digests so their length isn't leaked.
 *
 * @module
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { BlockList, isIP } from 'node:net'
import type { Env } from '../config.ts'

/** Minimum viewer token length. Shorter tokens are rejected (too easy to guess). */
export const MIN_TOKEN_LENGTH = 16

/** Session cookie name. */
export const SESSION_COOKIE = 'sv_logs_session'

/** How long a viewer session cookie stays valid. */
export const SESSION_TTL_MS: number = 8 * 60 * 60 * 1000

/** Your own access rule. Return `true` to allow the request. */
export type AuthorizeFn = (request: Request) => boolean | Promise<boolean>

/** The outcome of an access check. */
export type AccessDecision =
  | { readonly kind: 'allow'; readonly mode: 'authorize' | 'local' | 'token' }
  /** A valid `?token=` on the page: set this cookie and redirect. */
  | { readonly kind: 'login'; readonly cookie: string }
  /** Token mode, but no valid credentials: 401. */
  | { readonly kind: 'unauthenticated' }
  /** Pretend the viewer doesn't exist: 404. */
  | { readonly kind: 'hidden' }

/** Resolved access settings. */
export interface AccessPolicy {
  readonly authorize: AuthorizeFn | undefined
  readonly token: string | undefined
  readonly local: boolean
  readonly allowList: BlockList | undefined
  readonly cookiePath: string
  readonly now: () => number
}

/** Compare two secrets in constant time (digests first, so different lengths don't leak). */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest()
  const db = createHash('sha256').update(b).digest()
  return timingSafeEqual(da, db) && a.length === b.length
}

/**
 * Build an IP allow-list from addresses and CIDR ranges (`10.0.0.0/8`, `::1`, `fd00::/8`).
 *
 * @throws TypeError on an invalid entry, so a typo can't silently open or close the viewer
 */
export function buildAllowList(entries: readonly string[]): BlockList {
  const list = new BlockList()
  for (const entry of entries) {
    const [address = '', prefix] = entry.trim().split('/')
    const family = isIP(address)
    if (family === 0)
      throw new TypeError(`ipAllowList: "${entry}" is not an IP address or CIDR range`)
    const type = family === 4 ? 'ipv4' : 'ipv6'
    if (prefix === undefined) {
      list.addAddress(address, type)
      continue
    }
    const bits = Number(prefix)
    if (!/^\d{1,3}$/.test(prefix) || bits > (family === 4 ? 32 : 128)) {
      throw new TypeError(`ipAllowList: "${entry}" has an invalid prefix length`)
    }
    list.addSubnet(address, bits, type)
  }
  return list
}

/** Is `ip` in the allow-list? IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4`) are unwrapped. */
export function ipAllowed(list: BlockList, ip: string | undefined): boolean {
  if (!ip) return false
  const plain = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip
  const family = isIP(plain)
  if (family === 0) return false
  return list.check(plain, family === 4 ? 'ipv4' : 'ipv6')
}

/** `localhost`, `127.0.0.1` or `[::1]`, with an optional port (`:1`–`:65535`). Nothing else. */
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i

/**
 * Is `host` (a `Host` header or URL host) exactly a loopback name with an optional port? Lookalikes
 * such as `localhost.evil.test`, `127.0.0.1.nip.io` or a trailing dot are rejected.
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false
  const match = LOOPBACK_HOST.exec(host.trim())
  if (!match) return false
  const port = match[1]
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535)
}

/** Is the request addressed to a loopback host, in its `Host` header (when sent) and its URL? */
export function addressedToLoopback(request: Request): boolean {
  const header = request.headers.get('host')
  if (header !== null && !isLoopbackHost(header)) return false
  try {
    return isLoopbackHost(new URL(request.url).host)
  } catch {
    return false
  }
}

/** Loopback peers: `127.0.0.0/8` and `::1` (BlockList also matches `::ffff:127.x.x.x`). */
const LOOPBACK_PEERS: BlockList = (() => {
  const list = new BlockList()
  list.addSubnet('127.0.0.0', 8, 'ipv4')
  list.addAddress('::1', 'ipv6')
  return list
})()

/**
 * Is `ip` (a socket peer address) a loopback address: `127.0.0.0/8`, `::1` or an IPv4-mapped
 * `::ffff:127.x.x.x`? Anything that isn't an IP address (empty, a host name) is `false`.
 */
export function isLoopbackAddress(ip: string | null | undefined): boolean {
  if (!ip) return false
  const family = isIP(ip)
  if (family === 0) return false
  return LOOPBACK_PEERS.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

/** Validate the configured token. A token that's too short is a configuration error. */
export function validateToken(token: string | undefined, source: string): string | undefined {
  if (token === undefined || token === '') return undefined
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new TypeError(`${source} must be at least ${MIN_TOKEN_LENGTH} characters long`)
  }
  return token
}

/** Read the viewer token from the environment. A short token is ignored, so the viewer stays closed. */
export function tokenFromEnv(env: Env, name = 'LOGS_VIEWER_TOKEN'): string | undefined {
  try {
    return validateToken(env[name]?.trim(), name)
  } catch {
    return undefined
  }
}

function sign(token: string, expires: number): string {
  return createHmac('sha256', token).update(`strutvane-logs-viewer:${expires}`).digest('base64url')
}

/** Create a session cookie value for `token`, valid until `expires` (epoch ms). */
export function sessionValue(token: string, expires: number): string {
  return `${expires}.${sign(token, expires)}`
}

/** Is `value` a valid, unexpired session cookie for `token`? */
export function verifySession(token: string, value: string, nowMs: number): boolean {
  const dot = value.indexOf('.')
  if (dot <= 0) return false
  const expiresText = value.slice(0, dot)
  if (!/^\d{1,16}$/.test(expiresText)) return false
  const expires = Number(expiresText)
  if (expires <= nowMs) return false
  return safeEqual(value.slice(dot + 1), sign(token, expires))
}

/** Read one cookie from a `Cookie` header. */
export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** Build the `Set-Cookie` header for a new session. */
export function sessionCookie(policy: AccessPolicy, token: string, secure: boolean): string {
  const expires = policy.now() + SESSION_TTL_MS
  return [
    `${SESSION_COOKIE}=${sessionValue(token, expires)}`,
    `Path=${policy.cookiePath}`,
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

/**
 * Decide whether `request` may use the viewer.
 *
 * @param isPage `true` for the HTML page (the only place `?token=` login is accepted)
 */
export async function decideAccess(
  policy: AccessPolicy,
  request: Request,
  ip: string | undefined,
  isPage: boolean,
): Promise<AccessDecision> {
  if (policy.allowList && !ipAllowed(policy.allowList, ip)) return { kind: 'hidden' }

  if (policy.authorize) {
    try {
      return (await policy.authorize(request)) === true
        ? { kind: 'allow', mode: 'authorize' }
        : { kind: 'hidden' }
    } catch {
      return { kind: 'hidden' }
    }
  }

  if (policy.local) {
    // Unknown peer: host-only check (see the module docs for why it doesn't fail closed).
    const peerOk = ip === undefined || isLoopbackAddress(ip)
    if (peerOk && addressedToLoopback(request)) return { kind: 'allow', mode: 'local' }
    // Not a loopback request (a dev server in Docker, WSL or a VM): only the token can open it,
    // and a request that presents no credential at all still sees no viewer (404, not 401).
    const presents =
      request.headers.get('authorization')?.toLowerCase().startsWith('bearer ') === true ||
      readCookie(request.headers.get('cookie'), SESSION_COOKIE) !== undefined ||
      (isPage && new URL(request.url).searchParams.has('token'))
    if (!policy.token || !presents) return { kind: 'hidden' }
  }

  const token = policy.token
  if (!token) return { kind: 'hidden' }

  const auth = request.headers.get('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return safeEqual(auth.slice(7).trim(), token)
      ? { kind: 'allow', mode: 'token' }
      : { kind: 'unauthenticated' }
  }

  const cookie = readCookie(request.headers.get('cookie'), SESSION_COOKIE)
  if (cookie && verifySession(token, cookie, policy.now())) return { kind: 'allow', mode: 'token' }

  if (isPage && request.method === 'GET') {
    const given = new URL(request.url).searchParams.get('token')
    if (given !== null && safeEqual(given, token)) {
      return {
        kind: 'login',
        cookie: sessionCookie(policy, token, new URL(request.url).protocol === 'https:'),
      }
    }
  }
  return { kind: 'unauthenticated' }
}
