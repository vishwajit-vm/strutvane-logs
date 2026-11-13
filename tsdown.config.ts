import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    http: 'src/http/index.ts',
    node: 'src/adapters/node.ts',
    hono: 'src/adapters/hono.ts',
    express: 'src/adapters/express.ts',
    viewer: 'src/viewer/index.ts',
    provider: 'src/provider.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: true,
  sourcemap: true,
  clean: true,
  // dependencies and peerDependencies (contracts, hono, express) are never bundled by default.
  deps: { neverBundle: ['hono', 'express', '@strutvane/contracts', '@strutvane/core'] },
})
