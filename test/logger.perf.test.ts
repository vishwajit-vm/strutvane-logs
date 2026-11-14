/**
 * Performance budgets for the pipeline. Outside the quality gate (timings depend on machine load):
 * run with `vitest run --config vitest.perf.config.ts` on a quiet machine. PERF_BUDGET_FACTOR
 * scales the budgets (e.g. 2 on a slow CI runner).
 */
import { expect, test } from 'vitest'
import { createPipelineLogger } from '../src/logger.ts'
import { memoryTransport } from './helpers.ts'

const factor = Number(process.env['PERF_BUDGET_FACTOR'] ?? '1') || 1

test('a log call does not block: 5,000 calls well under a second', () => {
  const log = createPipelineLogger({ transport: memoryTransport({ delayMs: 5 }) })
  const started = performance.now()
  for (let i = 0; i < 5_000; i++) log.info('fast', { i })
  expect(performance.now() - started).toBeLessThan(1_000 * factor)
})

test('throughput: 50k records/s or more through the pipeline', async () => {
  const t = memoryTransport()
  const log = createPipelineLogger({
    transport: t,
    queue: { maxRecords: 200_000, maxBytes: 256 * 1024 * 1024 },
  })
  const n = 50_000
  const started = performance.now()
  for (let i = 0; i < n; i++)
    log.info('request handled', { method: 'GET', route: '/api/v1/invoices', status: 200, i })
  await log.drain(30_000)
  const perSecond = n / ((performance.now() - started) / 1000)
  expect(log.stats().written).toBe(n)
  expect(perSecond).toBeGreaterThan(50_000 / factor)
})
