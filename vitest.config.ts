import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Several integration tests spawn the real CLI via `node --import tsx
    // src/cli.ts`, which compiles the (now large) source graph on each run
    // (~3.5s). Tests that do more than one spawn exceed vitest's 5s default,
    // especially under load — a pre-existing fragility that grew as the CLI
    // surface expanded. 30s is generous for real CLI spawns while still
    // catching a genuine hang.
    testTimeout: 30_000,
  },
})
