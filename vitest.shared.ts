// Managed by strutvane-tooling (canonical/vitest.shared.ts). Do not edit in package repos:
// change it in strutvane-tooling and run `pnpm sync` there. Repo-specific settings belong in
// vitest.config.ts, which merges this file.
import { defineConfig } from 'vitest/config'

/** Shared Vitest defaults for every Strutvane package repo. */
export const sharedConfig = defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Fail loudly instead of silently passing.
    passWithNoTests: false,
    allowOnly: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // Type-level tests (`*.test-d.ts`) run on every test run.
    typecheck: { enabled: true, include: ['test/**/*.test-d.ts'], tsconfig: './tsconfig.json' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
      reporter: ['text', 'lcov'],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
})
