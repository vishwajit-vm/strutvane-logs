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

/**
 * Fake API keys are assembled at runtime from prefix + body, so no secret-shaped literal ever sits
 * in the source: secret scanners (GitHub push protection and others) would rightly flag one.
 */
const fakeKey = (prefix: string, body: string): string => `${prefix}${body}`
const FAKE_STRIPE_KEY = fakeKey('sk_live_', '51HxAbCdEfGh12345678')

const SECRETS: Record<PatternRule, string> = {
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl',
  bearer: 'Bearer abcdefghijklmnop1234',
  urlCredentials: 'postgres://app:hunter2secret@db:5432/main',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
  pan: '4111 1111 1111 1111',
  queryString: 'https://app.test/callback?code=q7Zr4Ns9Kp2&state=1',
  apiKey: FAKE_STRIPE_KEY,
}
const LEAK: Record<PatternRule, string> = {
  jwt: 'c2lnbmF0dXJlLXZhbHVl',
  bearer: 'abcdefghijklmnop1234',
  urlCredentials: 'hunter2secret',
  queryString: 'q7Zr4Ns9Kp2',
  apiKey: FAKE_STRIPE_KEY,
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

/** A value that must never appear in sanitised output. */
const CANARY = 'canary-q7Zr4Ns9Kp2'

describe('redaction canaries (keys shared with core)', () => {
  test.each([
    'passphrase',
    'otp',
    'otpCode',
    'totpSecret',
    'mfa_code',
    'cvv',
    'cvc2',
    'ssn',
    'userSSN',
    'pin',
    'cardPin',
    'signature',
    'sig',
    'x-sig',
    'appkey',
    'app_key',
    'sid',
    'twilio_sid',
    'recoveryCodes',
    'backup_code',
    'salt',
    'iban',
    'cardNumber',
    'accessKey',
    'signingKey',
    'encryptionKey',
    'jwt',
    'bearer',
    'session',
    'csrfToken',
  ])('%s is redacted at any depth, for strings, numbers and objects', (key) => {
    const out = JSON.stringify(
      sanitize({
        [key]: CANARY,
        nested: { list: [{ [key]: 987654321 }], deep: { a: { b: { [key]: { v: CANARY } } } } },
      }),
    )
    expect(out).not.toContain(CANARY)
    expect(out).not.toContain('987654321')
  })

  test('short words only match whole words, so ordinary keys survive', () => {
    expect(
      sanitize({ shipping: 'a', inside: 'b', className: 'c', design: 'd', footprint: 'e' }),
    ).toEqual({ shipping: 'a', inside: 'b', className: 'c', design: 'd', footprint: 'e' })
  })

  test('registerSensitiveKeys hides keys in sanitisers that already exist', async () => {
    const { registerSensitiveKeys } = await import('../src/index.ts')
    const s = createSanitizer()
    expect(s({ birthPlace: CANARY })).toEqual({ birthPlace: CANARY })
    registerSensitiveKeys(['birthPlace'])
    expect(JSON.stringify(s({ birthPlace: CANARY, owner: { birth_place: CANARY } }))).not.toContain(
      CANARY,
    )
    // Viewer output is re-sanitised with the same rules.
    expect(JSON.stringify(createSanitizer()({ BIRTHPLACE: CANARY }))).not.toContain(CANARY)
  })
})

describe('redaction canaries (patterns)', () => {
  test.each([
    ['?token=', 'GET /reset?token=CANARY'],
    ['&signature=', 'https://cdn.test/f.pdf?x=1&signature=CANARY'],
    ['&sig=', '/download?id=4&sig=CANARY'],
    ['?key=', 'https://maps.test/api?key=CANARY'],
    ['?code=', 'https://app.test/oauth/callback?code=CANARY&state=xyz'],
    ['&password=', 'login?user=ann&password=CANARY'],
    ['&secret=', 'hook?secret=CANARY'],
    ['&access_token=', 'https://api.test/me?fmt=json&access_token=CANARY'],
    ['&refresh_token=', 'POST /token?refresh_token=CANARY'],
    ['&client_secret=', '/oauth?client_id=1&client_secret=CANARY'],
    ['X-Amz-Signature', 'https://s3.test/o?X-Amz-Credential=AK%2F1&X-Amz-Signature=CANARY'],
    ['#access_token=', 'https://app.test/#access_token=CANARY&expires_in=3600'],
    ['short ?pin=', '?pin=CANARY'],
  ])('query parameter %s is hidden, other parameters kept', (_name, text) => {
    const out = redactString(text.replace('CANARY', CANARY))
    expect(out).not.toContain(CANARY)
    expect(out).toContain(REDACTED)
  })

  test('the parameter name and the other parameters are kept', () => {
    expect(redactString('/cb?code=abc&state=xyz')).toBe(`/cb?code=${REDACTED}&state=xyz`)
    expect(redactString('/search?q=keyboard&page=2')).toBe('/search?q=keyboard&page=2')
    expect(redactString('see ?monkey=1')).toBe('see ?monkey=1')
  })

  test.each([
    fakeKey('sv_live_', 'Ab12Cd34Ef56Gh78'),
    fakeKey('sv_test_', 'Ab12Cd34Ef56Gh78'),
    fakeKey('sk_live_', '51HxAbCdEfGh12345678'),
    fakeKey('sk_test_', '51HxAbCdEfGh12345678'),
    fakeKey('rk_live_', '51HxAbCdEfGh12345678'),
    fakeKey('whsec_', 'AbCdEfGh1234567890AbCd'),
    fakeKey('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
    fakeKey('gho_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
    fakeKey('github_pat_', '11ABCDEFG0123456789_abcdefghijklmnop'),
    fakeKey('glpat-', 'A1b2C3d4E5f6G7h8I9j0'),
    fakeKey('npm_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
    fakeKey('xoxb-', '1234567890-abcdefghij'),
    fakeKey('xoxp-', '1234567890-abcdefghij'),
    fakeKey('xoxa-', '1234567890-abcdefghij'),
    fakeKey('AKIA', 'IOSFODNN7EXAMPLE'),
    fakeKey('ASIA', 'IOSFODNN7EXAMPLE'),
    fakeKey('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
  ])('prefixed key %s is hidden in text, in nested objects and in error messages', (key) => {
    expect(redactString(`using ${key} now`)).not.toContain(key)
    expect(JSON.stringify(sanitize({ a: [{ note: `k=${key}` }] }))).not.toContain(key)
    expect(JSON.stringify(sanitize(new Error(`bad key ${key}`)))).not.toContain(key)
  })

  test('prefixes glued to other words, or too short, are not treated as keys', () => {
    expect(redactString('task_live_x and ghp_short')).toBe('task_live_x and ghp_short')
    expect(redactString('AKIAIOSFODNN7EXAMPLEX1')).toBe('AKIAIOSFODNN7EXAMPLEX1')
  })
})

describe('card numbers stored as numbers', () => {
  test('Luhn-valid 13–19 digit integers and BigInts are hidden at any depth', () => {
    const out = sanitize({
      card: { value: 4111111111111111, list: [5555555555554444] },
      amex: 378282246310005,
      big: 4111111111111111n,
      visa13: 4222222222222,
    }) as Record<string, unknown>
    const text = JSON.stringify(out)
    for (const leak of ['4111111111111111', '5555555555554444', '378282246310005', '4222222222222'])
      expect(text).not.toContain(leak)
    expect(out['amex']).toBe('[REDACTED:pan]')
    expect(out['big']).toBe('[REDACTED:pan]')
  })

  test('ordinary numbers are kept: Luhn-invalid, too short, timestamps, fractions, negatives', () => {
    const now = 1_763_078_400_000 // ms timestamp: starts with 1, never treated as a card
    const values = {
      invalid: 4111111111111112,
      short: 411111111111,
      ms: now,
      us: now * 1000,
      fraction: 4111111111111.5,
      negative: -4111111111111111,
      big: 1_763_078_400_000_000_000n,
    }
    const out = sanitize(values) as Record<string, unknown>
    expect(out).toEqual({ ...values, big: '1763078400000000000' })
  })

  test('disabling the pan rule (tripwire) or redaction keeps numbers', () => {
    expect(createSanitizer({ disable: new Set(['pan']) })(4111111111111111)).toBe(4111111111111111)
    expect(createSanitizer({ redact: false })(4111111111111111n)).toBe('4111111111111111')
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
