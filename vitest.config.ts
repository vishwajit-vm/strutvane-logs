import { defineConfig, mergeConfig } from 'vitest/config'
import { sharedConfig } from './vitest.shared.ts'

// Repo-specific overrides. Shared defaults come from strutvane-tooling.
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      // Real files, real child processes and timing-based tests: run files one at a time so they
      // don't compete for the disk and CPU, and give slow CI machines room.
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
)
