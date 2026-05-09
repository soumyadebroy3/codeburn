import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// `__APP_VERSION__` is referenced in src/components/Footer.tsx for the popover
// footer "v<x>" display. Read it from src-tauri/tauri.conf.json's version
// field — that file is freshly stamped by build-msi.ps1 right before this
// vite build runs, so it's always the canonical release version. Without
// this define, the identifier is undefined at runtime and React's render
// throws ReferenceError, which crashes the popover to a white screen with
// no visible error (production WebView2 has no devtools).
const tauriConfPath = fileURLToPath(new URL('./src-tauri/tauri.conf.json', import.meta.url))
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8')) as { version?: string }
const appVersion = tauriConf.version ?? 'dev'

// Tauri spawns the dev server on port 1420 by default. Keep clearScreen off so
// Rust-side build errors stay visible in the same terminal.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: false,
  },
})
