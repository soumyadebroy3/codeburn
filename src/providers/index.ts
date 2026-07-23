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
import { grok } from './grok.js'
import { lingtaiTui } from './lingtai-tui.js'
import { openDesign } from './open-design.js'
import { zerostack } from './zerostack.js'
import type { Provider, SessionSource } from './types.js'

/// Eagerly-imported providers: no native deps, cheap to load on every CLI invocation.
const coreProviders: Provider[] = [claude, cline, codebuff, codex, copilot, droid, gemini, ibmBob, kimi, kiloCode, kiro, mistralVibe, mux, openclaw, pi, omp, qwen, rooCode, grok, lingtaiTui, openDesign, zerostack]

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
  { name: 'zcode',        load: () => import('./zcode.js'),        exportName: 'zcode' },
  { name: 'hermes',       load: () => import('./hermes.js'),       exportName: 'hermes' },
  { name: 'zed',          load: () => import('./zed.js'),          exportName: 'zed' },
  { name: 'devin',        load: () => import('./devin.js'),        exportName: 'devin' },
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

// Canonical set of every provider name (core + lazy), used to validate the
// --provider CLI flag. Computed lazily so importing this module never depends on
// every provider object being defined at load time. (upstream #501)
let allProviderNamesCache: string[] | undefined
export function allProviderNames(): readonly string[] {
  allProviderNamesCache ??= [
    ...coreProviders.map(p => p.name),
    ...LAZY_PROVIDERS.map(s => s.name),
  ].sort()
  return allProviderNamesCache
}

export async function getAllProviders(): Promise<Provider[]> {
  const lazy = await Promise.all(LAZY_PROVIDERS.map(p => loadLazy(p.name)))
  return [...coreProviders, ...lazy.filter((p): p is Provider => p != null)]
}

export const providers = coreProviders

// Isolate one provider's discovery. A provider that throws (a crafted/corrupt
// file reaching a string op, an unexpected on-disk shape) must never take down
// the whole scan and blank every other provider's usage. Warn once per
// provider per run, then skip it. Mirrors the parse-failure isolation already
// used per-file in parser.ts. (upstream #650)
const warnedDiscoveryFailures = new Set<string>()
export async function safeDiscoverSessions(provider: Provider): Promise<SessionSource[]> {
  try {
    return await provider.discoverSessions()
  } catch (err) {
    if (!warnedDiscoveryFailures.has(provider.name)) {
      warnedDiscoveryFailures.add(provider.name)
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        `codeburn: skipped ${provider.name} discovery after an error: ${msg}\n`
      )
    }
    return []
  }
}

export async function discoverAllSessions(
  providerFilter?: string,
  // Injectable for tests so the isolation loop itself is exercised, not just
  // the helper. Defaults to the real registry.
  providerList?: Provider[],
): Promise<SessionSource[]> {
  const allProviders = providerList ?? await getAllProviders()
  const filtered = providerFilter && providerFilter !== 'all'
    ? allProviders.filter(p => p.name === providerFilter)
    : allProviders
  const all: SessionSource[] = []
  for (const provider of filtered) {
    const sessions = await safeDiscoverSessions(provider)
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
