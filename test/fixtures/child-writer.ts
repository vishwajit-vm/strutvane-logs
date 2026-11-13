/**
 * One writer process for the multi-process test.
 *   node test/fixtures/child-writer.ts <dir> <id> <count> <maxFileBytes>
 * Each process writes its own tagged files (`YYYY-MM-DD.w<id>.ndjson`), as createLogger does for
 * cluster workers.
 */
import { createLogger } from '../../src/create.ts'

const [dir = '.', id = '0', count = '1000', maxFileBytes = String(30 * 1024 * 1024)] =
  process.argv.slice(2)
const log = createLogger({
  path: dir,
  driver: 'file',
  retentionDays: 0,
  maxDailyBytes: Number(maxFileBytes),
  writerTag: `w${id}`,
  env: {},
  queue: { maxRecords: 100_000, maxBytes: 128 * 1024 * 1024 },
})
const n = Number(count)
for (let i = 0; i < n; i++) {
  log.info('multi-process', { proc: Number(id), i, pad: 'q'.repeat(60 + (i % 200)) })
  if (i % 200 === 199) await new Promise((r) => setImmediate(r))
}
const result = await log.close(30_000)
process.stdout.write(`${JSON.stringify({ id, result, stats: log.stats() })}\n`)
