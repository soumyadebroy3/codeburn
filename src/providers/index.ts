import { claude } from './claude.js'
import { cline } from './cline.js'
import { codebuff } from './codebuff.js'
import { codex } from './codex.js'
import { copilot } from './copilot.js'
import { droid } from './droid.js'
import { gemini } from './gemini.js'
import { ibmBob } from './ibm-bob.js'
import { kiloCode } from './kilo-code.js'
import { kimi } from './kimi.js'
import { kiro } from './kiro.js'
import { mistralVibe } from './mistral-vibe.js'
import { mux } from './mux.js'
import { openclaw } from './openclaw.js'
import { pi, omp } from './pi.js'
import { qwen } from './qwen.js'
import { rooCode } from './roo-code.js'
import type { Provider, SessionSource } from './types.js'

/// Eagerly-imported providers: no native deps, cheap to load on every CLI invocation.
const coreProviders: Provider[] = [claude, cline, codebuff, codex, copilot, droid, gemini, ibmBob, kimi, kiloCode, kiro, mistralVibe, mux, openclaw, pi, omp, qwen, rooCode]

/// Lazy-loaded providers: open native sqlite / large json on disk, may fail when the
/// underlying tool isn't installed. Each entry is a literal `() => import(...)` so the
/// bundler can statically analyze module paths — do NOT compute the path from a string.
/// Adding a provider here is a one-line change.
type LazyProviderSpec = {
  name: string
  load: () => Promise<Record<string, unknown>>
  exportName: string
}

const LAZY_PROVIDERS: readonly LazyProviderSpec[] = [
  { name: 'antigravity',  load: () => import('./antigravity.js'),  exportName: 'antigravity' },
  { name: 'goose',        load: () => import('./goose.js'),        exportName: 'goose' },
  { name: 'cursor',       load: () => import('./cursor.js'),       exportName: 'cursor' },
  { name: 'opencode',     load: () => import('./opencode.js'),     exportName: 'opencode' },
  { name: 'cursor-agent', load: () => import('./cursor-agent.js'), exportName: 'cursor_agent' },
  { name: 'crush',        load: () => import('./crush.js'),        exportName: 'crush' },
  { name: 'forge',        load: () => import('./forge.js'),        exportName: 'forge' },
  // 'warp' is intentionally NOT registered in this fork. Opening Warp's group
  // container (~/Library/Group Containers/2BBY89MBSN.dev.warp/.../warp.sqlite)
  // trips macOS's "access data from other apps" prompt on every menubar
  // refresh, and an ad-hoc-signed app can't persist the grant — so it nags
  // endlessly. warp.ts and its tests are kept for a future opt-in / re-enable.
  // Upstream (getagentseal/codeburn) still enables Warp.
]

const lazyCache = new Map<string, Provider | null>()

async function loadLazy(name: string): Promise<Provider | null> {
  if (lazyCache.has(name)) return lazyCache.get(name) ?? null
  const spec = LAZY_PROVIDERS.find(p => p.name === name)
  if (!spec) {
    lazyCache.set(name, null)
    return null
  }
  try {
    const mod = await spec.load()
    const provider = (mod[spec.exportName] as Provider | undefined) ?? null
    lazyCache.set(name, provider)
    return provider
  } catch {
    lazyCache.set(name, null)
    return null
  }
}

export async function getAllProviders(): Promise<Provider[]> {
  const lazy = await Promise.all(LAZY_PROVIDERS.map(p => loadLazy(p.name)))
  return [...coreProviders, ...lazy.filter((p): p is Provider => p != null)]
}

export const providers = coreProviders

export async function discoverAllSessions(providerFilter?: string): Promise<SessionSource[]> {
  const allProviders = await getAllProviders()
  const filtered = providerFilter && providerFilter !== 'all'
    ? allProviders.filter(p => p.name === providerFilter)
    : allProviders
  const all: SessionSource[] = []
  for (const provider of filtered) {
    const sessions = await provider.discoverSessions()
    all.push(...sessions)
  }
  return all
}

export async function getProvider(name: string): Promise<Provider | undefined> {
  if (LAZY_PROVIDERS.some(p => p.name === name)) {
    return (await loadLazy(name)) ?? undefined
  }
  return coreProviders.find(p => p.name === name)
}
