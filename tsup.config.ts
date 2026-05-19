import { defineConfig } from 'tsup'

// Source maps are useful in dev (CODEBURN_DEV=1 or `npm run dev`) but leak
// the absolute path of the build machine and the original TypeScript when
// shipped in the npm tarball. `npm run build` (which feeds prepublishOnly)
// runs without CODEBURN_DEV, so the published bundle is map-free.
const includeSourceMap = process.env.CODEBURN_DEV === '1'

export default defineConfig({
  // main.ts is the bundled entry; src/cli.ts is a tiny Node-18-parseable
  // launcher copied verbatim to dist/cli.js by the build script. Bundling
  // the launcher would inline ES imports and defeat the version-guard,
  // because the imports run before the runtime check.
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: includeSourceMap,
  dts: false,
})
