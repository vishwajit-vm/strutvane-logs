// Managed by strutvane-tooling (canonical/vitest.perf.config.ts). Do not edit in package repos.
//
// Runs ONLY performance-budget tests (`*.perf.test.ts`, `*.perf.test.tsx`). They are kept out of
// the normal quality gate because timings depend on machine load, and the gate must be
// deterministic. Run them with `vitest run --config vitest.perf.config.ts` (script: `test:perf`)
// on a quiet machine or in a dedicated CI job. PERF_BUDGET_FACTOR scales the budgets.
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['**/*.perf.test.ts', '**/*.perf.test.tsx'],
    exclude: [...configDefaults.exclude],
    environment: 'node',
    passWithNoTests: true,
    allowOnly: false,
    // One file at a time, so benchmarks don't compete with each other for CPU.
    fileParallelism: false,
  },
})
