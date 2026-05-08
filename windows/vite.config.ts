import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
  build: {
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: false,
  },
})
