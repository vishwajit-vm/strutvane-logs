---
"@strutvane/logs": patch
---

Redaction and viewer improvements:

- Redaction uses the sensitive key lists from `@strutvane/core`, adding passphrases, one-time and MFA codes, PINs, card data, signatures, sessions, salts and more; short words such as `pin`, `ssn` and `otp` match as whole words only. New patterns hide secret query parameters and well-known prefixed API keys, and integers that are Luhn-valid card numbers. `registerSensitiveKeys` adds keys at runtime for every logger in the process.
- Request lines log the route template when known, otherwise the path with secrets redacted, token-like segments masked and its length capped (`safePath`, `loggedPath`).
- Viewer: local mode answers only requests addressed to `localhost`, `127.0.0.1` or `[::1]`; live tails free their slot on every way a stream can end (new `stallBeats`, `maxQueuedBytes` and `maxDurationMs` tail options); `/api/tail` and `/api/download` accept GET only; scoped viewers get days only from `/api/files`; record pages read files backwards in bounded chunks (cursors are now byte offsets).
- The provider accepts `viewer.authorize`, `ipAllowList`, `scopeRecords` and `onAudit` (from `config/logging.ts` or `createLogsProvider(options)`) and passes the hook's `clientAddress` to the viewer.
