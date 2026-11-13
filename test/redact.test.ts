/**
 * Redaction and sanitising (RFC-0004 §3). Property tests with fast-check, plus tripwires: turning
 * off each built-in rule must make a matching secret leak, which proves every rule is needed.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
  createSanitizer,
  DEFAULT_SANITIZE,
  luhnValid,
  normaliseKey,
  type PatternRule,
  REDACTED,
  redactString,
} from '../src/redact.ts'

const sanitize = createSanitizer()

/** A serialised error, as the tests read it. */
interface ErrShape {
  name?: unknown
  message?: unknown
  stack?: unknown
  code?: unknown
  extra?: unknown
  cause?: unknown
  errors?: unknown
}
const json = (v: unknown): string => JSON.stringify(sanitize(v))

const SECRETS: Record<PatternRule, string> = {
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl',
  bearer: 'Bearer abcdefghijklmnop1234',
  urlCredentials: 'postgres://app:hunter2secret@db:5432/main',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
  pan: '4111 1111 1111 1111',
}
const LEAK: Record<PatternRule, string> = {
  jwt: 'c2lnbmF0dXJlLXZhbHVl',
  bearer: 'abcdefghijklmnop1234',
  urlCredentials: 'hunter2secret',
  privateKey: 'MIIEowIBAAKCAQEA',
  pan: '4111 1111 1111 1111',
}

describe('key-based redaction', () => {
  test.each([
    'password',
    'userPassword',
    'passwd',
    'pwd',
    'client_secret',
    'accessToken',
    'refresh-token',
    'Authorization',
    'cookie',
    'set-cookie',
    'apiKey',
    'api_key',
    'X-API-KEY',
    'privateKey',
    'credentials',
    'sessionId',
  ])('%s is redacted at any depth', (key) => {
    const out = sanitize({ a: { b: [{ [key]: 'super-secret-value' }] } })
    expect(JSON.stringify(out)).not.toContain('super-secret-value')
    expect(JSON.stringify(out)).toContain(REDACTED)
  })

  test('ordinary keys are kept', () => {
    expect(sanitize({ user: 'ana', invoiceId: 7, note: undefined })).toEqual({
      user: 'ana',
      invoiceId: 7,
    })
    // Fragment matching is deliberately broad: a key merely containing "token" is redacted too.
    expect(sanitize({ tokenizer: 'x' })).toEqual({ tokenizer: REDACTED })
  })

  test('extraKeys extend the list and are normalised', () => {
    const s = createSanitizer({ extraKeys: ['IBAN_number'] })
    expect(s({ ibanNumber: 'DE89370400440532013000' })).toEqual({ ibanNumber: REDACTED })
  })

  test('normaliseKey removes case, dashes and underscores', () => {
    expect(normaliseKey('X-Api_Key')).toBe('xapikey')
  })

  test('redact: false keeps values but still applies safety limits', () => {
    const s = createSanitizer({ redact: false, maxStringLength: 5 })
    expect(s({ password: 'abcdefgh' })).toEqual({ password: 'abcde…[truncated 3 chars]' })
  })
})

describe('pattern-based redaction', () => {
  for (const rule of Object.keys(SECRETS) as PatternRule[]) {
    test(`${rule}: redacted inside free text`, () => {
      const out = redactString(`before ${SECRETS[rule]} after`)
      expect(out).not.toContain(LEAK[rule])
      expect(out).toContain('before')
    })

    test(`${rule}: tripwire — disabling the rule leaks the secret`, () => {
      const out = redactString(`x ${SECRETS[rule]} y`, {
        disable: new Set([rule]),
        extraPatterns: [],
      })
      expect(out).toContain(LEAK[rule])
    })
  }

  test('URL credentials keep the user and host', () => {
    expect(redactString('postgres://app:pw12@db/x')).toBe(`postgres://app:${REDACTED}@db/x`)
  })

  test('a truncated private key is still redacted', () => {
    expect(redactString('-----BEGIN PRIVATE KEY-----\nMIIabc')).toBe('[REDACTED:private-key]')
  })

  test('Luhn-invalid digit runs (order numbers) are kept', () => {
    expect(redactString('order 4111111111111112')).toBe('order 4111111111111112')
    expect(luhnValid('4111111111111111')).toBe(true)
    expect(luhnValid('41x1')).toBe(false)
  })

  test('extraPatterns replace every match, global flag or not', () => {
    const s = createSanitizer({ extraPatterns: [/EMP-\d+/] })
    expect(s('EMP-1 and EMP-22')).toBe(`${REDACTED} and ${REDACTED}`)
  })

  test('short strings skip the regexes but still get extra patterns', () => {
    expect(redactString('abc', { disable: new Set(), extraPatterns: [/b/g] })).toBe(`a${REDACTED}c`)
  })
})

describe('properties (fast-check)', () => {
  test('a secret under a sensitive key never survives, whatever the surrounding data', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 6 }).filter((s) => !REDACTED.includes(s)),
        fc.constantFrom('password', 'apiKey', 'authorization', 'client_secret', 'sessionId'),
        fc.jsonValue(),
        (secret, key, noise) => {
          const out = JSON.stringify(sanitize({ noise, nested: { [key]: secret } }))
          return (
            !out.includes(JSON.stringify(secret).slice(1, -1)) ||
            JSON.stringify(noise).includes(secret)
          )
        },
      ),
      { numRuns: 300 },
    )
  })

  test('JWTs embedded anywhere in a string are redacted', () => {
    const b64 = fc.stringMatching(/^[A-Za-z0-9_-]{4,40}$/)
    fc.assert(
      fc.property(fc.string(), b64, b64, b64, fc.string(), (pre, h, p, s, post) => {
        const token = `eyJ${h}.${p}.${s}`
        const out = redactString(`${pre} ${token} ${post}`)
        return !out.includes(token)
      }),
      { numRuns: 300 },
    )
  })

  test('the sanitiser never throws and always returns JSON-serialisable output', () => {
    fc.assert(
      fc.property(
        fc.anything({
          withBigInt: true,
          withDate: true,
          withMap: true,
          withSet: true,
          withTypedArray: true,
        }),
        (v) => {
          const out = sanitize(v)
          expect(() => JSON.stringify(out)).not.toThrow()
        },
      ),
      { numRuns: 500 },
    )
  })
})

describe('safety transformations', () => {
  test('circular references, depth and size limits', () => {
    const a: { name: string; self?: unknown } = { name: 'a' }
    a.self = a
    expect(sanitize(a)).toEqual({ name: 'a', self: '[Circular]' })

    const s = createSanitizer({ maxDepth: 2, maxArrayLength: 2, maxObjectKeys: 1 })
    expect(s({ x: { y: { z: 1 } } })).toEqual({ x: { y: '[MaxDepth]' } })
    expect(s([1, 2, 3, 4])).toEqual([1, 2, '[…2 more items]'])
    expect(s({ a: 1, b: 2, c: 3 })).toEqual({ a: 1, _truncatedKeys: 2 })
  })

  test('special values', () => {
    expect(
      sanitize({
        n: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        big: 10n,
        sym: Symbol('s'),
        fn: function named() {},
        anon: (() => () => {})(),
        date: new Date(0),
        bad: new Date(Number.NaN),
        buf: Buffer.from('abc'),
        ab: new ArrayBuffer(4),
        map: new Map([['k', { password: 'x' }]]),
        set: new Set([1, 2]),
        nul: null,
        arr: [undefined],
      }),
    ).toEqual({
      n: 'NaN',
      inf: 'Infinity',
      big: '10',
      sym: 'Symbol(s)',
      fn: '[Function named]',
      anon: '[Function anonymous]',
      date: '1970-01-01T00:00:00.000Z',
      bad: 'Invalid Date',
      buf: '[Binary 3 bytes]',
      ab: '[Binary 4 bytes]',
      map: { k: { password: REDACTED } },
      set: [1, 2],
      nul: null,
      arr: [null],
    })
  })

  test('hostile objects: throwing getters, throwing toJSON, revoked proxies', () => {
    const getter = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error('nope')
      },
    })
    expect(sanitize(getter)).toEqual({ boom: '[Unreadable]' })
    expect(sanitize({ toJSON: () => ({ ok: true }) })).toEqual({ ok: true })
    expect(
      sanitize({
        toJSON() {
          throw new Error('x')
        },
      }),
    ).toBe('[toJSON threw]')
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    expect(() => sanitize({ p: proxy })).not.toThrow()
    const arr = new Proxy([1], {
      get(target, key) {
        if (key === '0') throw new Error('x')
        return Reflect.get(target, key)
      },
    })
    expect(sanitize(arr)).toEqual(['[Unreadable]'])
  })

  test('errors keep name, message, stack, code, cause chain and aggregate errors; secrets in messages are redacted', () => {
    const root = Object.assign(new Error('db at postgres://u:pw123456@h/x failed'), {
      code: 'ECONNREFUSED',
      extra: 1,
    })
    const err = new Error('outer', { cause: root })
    const out = sanitize(err) as ErrShape
    expect(out.name).toBe('Error')
    expect(out.message).toBe('outer')
    expect(typeof out.stack).toBe('string')
    const cause = out.cause as ErrShape
    expect(cause.code).toBe('ECONNREFUSED')
    expect(cause.extra).toBe(1)
    expect(String(cause.message)).not.toContain('pw123456')

    const agg = sanitize(new AggregateError([new Error('a')], 'many')) as ErrShape
    expect((agg.errors as ErrShape[])[0]?.message).toBe('a')

    const numeric = sanitize(Object.assign(new Error('x'), { code: 42 })) as ErrShape
    expect(numeric.code).toBe('42')

    const nonErrorCause = sanitize(
      new Error('x', { cause: { password: 'p', why: 'w' } }),
    ) as ErrShape
    expect(nonErrorCause.cause).toEqual({ password: REDACTED, why: 'w' })
  })

  test('a deep cause chain is cut at maxCauseDepth', () => {
    let e = new Error('e0')
    for (let i = 1; i < 10; i++) e = new Error(`e${i}`, { cause: e })
    const out = JSON.stringify(createSanitizer({ maxCauseDepth: 2 })(e))
    expect(out).not.toContain('"e0"')
  })

  test('defaults are frozen', () => {
    expect(Object.isFrozen(DEFAULT_SANITIZE)).toBe(true)
    expect(json('plain')).toBe('"plain"')
  })
})
