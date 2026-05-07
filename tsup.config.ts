import { defineConfig } from 'tsup'

// Source maps are useful in dev (CODEBURN_DEV=1 or `npm run dev`) but leak
// the absolute path of the build machine and the original TypeScript when
// shipped in the npm tarball. `npm run build` (which feeds prepublishOnly)
// runs without CODEBURN_DEV, so the published bundle is map-free.
const includeSourceMap = process.env.CODEBURN_DEV === '1'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: includeSourceMap,
  dts: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
})
