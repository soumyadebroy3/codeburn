import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import snapshotData from './data/litellm-snapshot.json'
import { fetchWithTimeout } from './fetch-utils.js'

export type ModelCosts = {
  inputCostPerToken: number
  outputCostPerToken: number
  /**
   * 5-minute ephemeral cache write rate. Anthropic charges 1.25× the base
   * input rate. The historical `cache_creation_input_token_cost` LiteLLM
   * field maps here.
   */
  cacheWriteCostPerToken: number
  /**
   * 1-hour ephemeral cache write rate. Anthropic charges 2× the base input
   * rate. LiteLLM doesn't currently expose a separate field, so we derive
   * `inputCostPerToken * 2` when not provided. Heavy Claude Code users
   * default to 1h cache, so this is the dominant rate in practice.
   */
  cacheWrite1hCostPerToken: number
  cacheReadCostPerToken: number
  webSearchCostPerRequest: number
  fastMultiplier: number
}

type PriceOverrideRates = {
  input: number
  output: number
  cacheRead?: number
  cacheCreation?: number
}

type LiteLLMEntry = {
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_creation_input_token_cost?: number
  cache_read_input_token_cost?: number
  provider_specific_entry?: { fast?: number }
}

type SnapshotEntry = [number, number, number | null, number | null]

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const WEB_SEARCH_COST = 0.01
const ONE_HOUR_CACHE_WRITE_MULTIPLIER_FROM_FIVE_MINUTE_RATE = 1.6

const FAST_MULTIPLIERS: Record<string, number> = {
  'claude-opus-4-7': 6,
  'claude-opus-4-6': 6,
}

// Explicit USD/token prices for Cursor's house "composer" models, which have
// no LiteLLM pricing entry. Cursor publishes these house-model rates in its
// models table at cursor.com/docs/models (provider "Cursor", USD per 1M
// tokens): composer-2/2.5: $0.50 input, $2.50 output, $0.20 cache read;
// composer-1.5: $3.50/$17.50/$0.35; composer-1: $1.25/$10/$0.125. Cursor
// publishes no separate cache-write rate for these, so cache write uses the
// input rate. These are self-contained (SnapshotEntry tuples fed through
// buildOverrideCosts) so they do not depend on the LiteLLM snapshot and win
// over any stale/aliased pricing. Previously composer-* aliased to Claude
// Sonnet, which billed Cursor house usage at Anthropic proxy rates.
const BUILTIN_PRICE_OVERRIDES: Record<string, SnapshotEntry> = {
  'composer-2.5': [0.5e-6, 2.5e-6, 0.5e-6, 0.2e-6],
  'composer-2':   [0.5e-6, 2.5e-6, 0.5e-6, 0.2e-6],
  'composer-1.5': [3.5e-6, 17.5e-6, 3.5e-6, 0.35e-6],
  'composer-1':   [1.25e-6, 10e-6, 1.25e-6, 0.125e-6],
}

// Build a ModelCosts from a SnapshotEntry-shaped tuple, applying the same
// finite/non-negative floors and cache-cost heuristics as loadSnapshot so the
// override entries behave identically to snapshot entries. Kept self-contained
// (no tupleToCosts helper in this fork).
function buildOverrideCosts(raw: SnapshotEntry): ModelCosts {
  const [input, output, cacheWrite, cacheRead] = raw
  const inRate = Number.isFinite(input) && input >= 0 ? input : 0
  const outRate = Number.isFinite(output) && output >= 0 ? output : 0
  return {
    inputCostPerToken: inRate,
    outputCostPerToken: outRate,
    cacheWriteCostPerToken: typeof cacheWrite === 'number' && Number.isFinite(cacheWrite) && cacheWrite >= 0 ? cacheWrite : inRate * 1.25,
    cacheWrite1hCostPerToken: inRate * 2,
    cacheReadCostPerToken: typeof cacheRead === 'number' && Number.isFinite(cacheRead) && cacheRead >= 0 ? cacheRead : inRate * 0.1,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: 1,
  }
}

function applyBuiltinPriceOverrides(pricing: Map<string, ModelCosts>): Map<string, ModelCosts> {
  for (const [name, raw] of Object.entries(BUILTIN_PRICE_OVERRIDES)) {
    pricing.set(name, buildOverrideCosts(raw))
  }
  return pricing
}

function loadSnapshot(): Map<string, ModelCosts> {
  const map = new Map<string, ModelCosts>()
  for (const [name, raw] of Object.entries(snapshotData as unknown as Record<string, SnapshotEntry>)) {
    const [input, output, cacheWrite, cacheRead] = raw
    // Defensively floor input rate to a finite non-negative number. The
    // snapshot entry shape promises a number, but a hand-edited entry that
    // shipped `null` here would otherwise cascade NaN through every
    // *PerToken multiplication and silently zero out (or break with NaN)
    // every cost calculation downstream.
    const inRate = Number.isFinite(input) && input >= 0 ? input : 0
    const outRate = Number.isFinite(output) && output >= 0 ? output : 0
    map.set(name, {
      inputCostPerToken: inRate,
      outputCostPerToken: outRate,
      cacheWriteCostPerToken: typeof cacheWrite === 'number' && Number.isFinite(cacheWrite) && cacheWrite >= 0 ? cacheWrite : inRate * 1.25,
      cacheWrite1hCostPerToken: inRate * 2,
      cacheReadCostPerToken: typeof cacheRead === 'number' && Number.isFinite(cacheRead) && cacheRead >= 0 ? cacheRead : inRate * 0.1,
      webSearchCostPerRequest: WEB_SEARCH_COST,
      fastMultiplier: FAST_MULTIPLIERS[name] ?? 1,
    })
  }
  // TEMP (2026-06-09): Fable 5 / Mythos 5 launch pricing, $10/M input and $50/M
  // output, until LiteLLM indexes them. The running CLI reports `claude-fable-5`,
  // which would otherwise floor to $0. Added as snapshot fallbacks so a real
  // LiteLLM entry, once it exists, takes precedence. Remove then. (upstream #463)
  const tempLaunch: ModelCosts = {
    inputCostPerToken: 0.00001,
    outputCostPerToken: 0.00005,
    cacheWriteCostPerToken: 0.0000125,
    cacheWrite1hCostPerToken: 0.00002,
    cacheReadCostPerToken: 0.000001,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: 1,
  }
  for (const id of ['claude-fable-5', 'claude-mythos-5']) {
    if (!map.has(id)) map.set(id, { ...tempLaunch })
  }
  return map
}

let pricingCache: Map<string, ModelCosts> = applyBuiltinPriceOverrides(loadSnapshot())
let sortedPricingKeys: string[] | null = null

function getSortedPricingKeys(): string[] {
  if (sortedPricingKeys === null) {
    sortedPricingKeys = Array.from(pricingCache.keys()).sort((a, b) => b.length - a.length)
  }
  return sortedPricingKeys
}

function getCacheDir(): string {
  if (process.env['CODEBURN_CACHE_DIR']) return process.env['CODEBURN_CACHE_DIR']
  return join(homedir(), '.cache', 'codeburn')
}

function getCachePath(): string {
  return join(getCacheDir(), 'litellm-pricing.json')
}

/// Clamp a per-token rate to a sane non-negative value. Defense in depth
/// against a tampered LiteLLM JSON shipping a negative `input_cost_per_token`,
/// which would otherwise produce negative costs that subtract from totals.
/// We use Number.isFinite to also reject NaN/Infinity, and cap at $1/token
/// (well above the most expensive frontier model) so a stray decimal-place
/// shift in the upstream JSON can't wildly inflate spend numbers either.
function safePerTokenRate(n: number | undefined): number | null {
  if (n === undefined || !Number.isFinite(n) || n < 0) return null
  if (n > 1) return 1
  return n
}

function parseLiteLLMEntry(entry: LiteLLMEntry): ModelCosts | null {
  const inputCost = safePerTokenRate(entry.input_cost_per_token)
  const outputCost = safePerTokenRate(entry.output_cost_per_token)
  if (inputCost === null || outputCost === null) return null
  const cacheWrite = safePerTokenRate(entry.cache_creation_input_token_cost) ?? inputCost * 1.25
  const cacheRead = safePerTokenRate(entry.cache_read_input_token_cost) ?? inputCost * 0.1
  return {
    inputCostPerToken: inputCost,
    outputCostPerToken: outputCost,
    cacheWriteCostPerToken: cacheWrite,
    cacheWrite1hCostPerToken: inputCost * 2,
    cacheReadCostPerToken: cacheRead,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: entry.provider_specific_entry?.fast ?? 1,
  }
}

async function fetchAndCachePricing(): Promise<Map<string, ModelCosts>> {
  // Bounded: runs on every CLI invocation (the menubar shells out and blocks on
  // it). Without a timeout a half-open network after wake-from-sleep makes
  // fetch() hang forever, wedging the menubar's loading spinner. On timeout the
  // caller's catch falls back to the bundled price snapshot.
  const response = await fetchWithTimeout(LITELLM_URL)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = await response.json() as Record<string, LiteLLMEntry>
  const pricing = new Map<string, ModelCosts>()

  for (const [name, entry] of Object.entries(data)) {
    const costs = parseLiteLLMEntry(entry)
    if (!costs) continue
    pricing.set(name, costs)
    // Also index by stripped name so lookups work without provider prefix:
    // 'anthropic/claude-opus-4-6' is also queryable as 'claude-opus-4-6'.
    // First write wins so direct-provider entries take precedence over re-hosters.
    const stripped = name.replace(/^[^/]+\//, '')
    if (stripped !== name && !pricing.has(stripped)) pricing.set(stripped, costs)
  }

  await mkdir(getCacheDir(), { recursive: true })
  // Atomic-rename pattern matches daily-cache.ts / codex-cache.ts so a crash
  // mid-write never leaves a half-written pricing JSON. Concurrent CLI
  // invocations race only on the final rename (last-writer-wins, both with
  // valid content) instead of interleaving bytes.
  const finalPath = getCachePath()
  const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
  const payload = JSON.stringify({
    timestamp: Date.now(),
    data: Object.fromEntries(pricing),
  })
  const handle = await open(tempPath, 'w', 0o600)
  try {
    await handle.writeFile(payload, { encoding: 'utf-8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tempPath, finalPath)
  } catch {
    try { await unlink(tempPath) } catch { /* ignore */ }
  }

  return pricing
}

async function loadCachedPricing(): Promise<Map<string, ModelCosts> | null> {
  try {
    const raw = await readFile(getCachePath(), 'utf-8')
    const cached = JSON.parse(raw) as { timestamp: number; data: Record<string, ModelCosts> }
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null
    const map = new Map<string, ModelCosts>()
    for (const [name, raw] of Object.entries(cached.data)) {
      // Migration: cache files written before the 1h-cache split land here
      // missing `cacheWrite1hCostPerToken`. Default it from the input rate so
      // arithmetic stays finite even when reading a stale file.
      const inRate = Number.isFinite(raw.inputCostPerToken) ? raw.inputCostPerToken : 0
      map.set(name, {
        ...raw,
        cacheWrite1hCostPerToken: typeof raw.cacheWrite1hCostPerToken === 'number'
          && Number.isFinite(raw.cacheWrite1hCostPerToken)
          ? raw.cacheWrite1hCostPerToken
          : inRate * 2,
      })
    }
    return map
  } catch {
    return null
  }
}

function mergeSnapshotFallbacks(pricing: Map<string, ModelCosts>): Map<string, ModelCosts> {
  // The runtime LiteLLM cache can be stale or incomplete; fill any gaps from
  // the bundled snapshot so models we ship pricing for never read as $0
  // (upstream PR #367).
  for (const [name, costs] of loadSnapshot()) {
    if (!pricing.has(name)) pricing.set(name, costs)
  }
  // Builtin composer overrides win even over LiteLLM/cache pricing, so
  // re-apply after the snapshot fill so a freshly fetched pricing map still
  // uses Cursor-published composer rates rather than any inherited entry.
  return applyBuiltinPriceOverrides(pricing)
}

export async function loadPricing(): Promise<void> {
  const cached = await loadCachedPricing()
  if (cached) {
    pricingCache = mergeSnapshotFallbacks(cached)
    sortedPricingKeys = null
    return
  }

  try {
    pricingCache = mergeSnapshotFallbacks(await fetchAndCachePricing())
    sortedPricingKeys = null
  } catch {
    // snapshot already loaded at init; nothing more to do
  }
}

// Known model name variants that providers emit but LiteLLM/fallback don't index under.
// OMP emits 'anthropic--claude-4.6-opus' (double-dash, dot version, tier-last).
// getCanonicalName strips any 'provider/' prefix first, so only the post-strip
// forms need to be listed here.
const BUILTIN_ALIASES: Record<string, string> = {
  'anthropic--claude-4.6-opus':    'claude-opus-4-6',
  'anthropic--claude-4.6-sonnet':  'claude-sonnet-4-6',
  'anthropic--claude-4.5-opus':    'claude-opus-4-5',
  'anthropic--claude-4.5-sonnet':  'claude-sonnet-4-5',
  'anthropic--claude-4.5-haiku':   'claude-haiku-4-5',
  'claude-sonnet-4.6':             'claude-sonnet-4-6',
  'claude-sonnet-4.5':             'claude-sonnet-4-5',
  'claude-opus-4.7':               'claude-opus-4-7',
  'claude-opus-4.6':               'claude-opus-4-6',
  'claude-opus-4.5':               'claude-opus-4-5',
  // Warp emits Claude variants with tier/reasoning suffixes LiteLLM doesn't
  // index; map them to canonical pricing IDs (upstream PR #378).
  'claude-4-6-sonnet-high':        'claude-sonnet-4-6',
  'claude-4-6-sonnet-low':         'claude-sonnet-4-6',
  'claude-4-6-sonnet-medium':      'claude-sonnet-4-6',
  'claude-4-6-sonnet-high-fast':   'claude-sonnet-4-6',
  'claude-4-7-opus-xhigh':         'claude-opus-4-7',
  'claude-4-7-opus-xhigh-fast':    'claude-opus-4-7',
  'cursor-auto':                    'claude-sonnet-4-5',
  'cursor-agent-auto':             'claude-sonnet-4-5',
  'copilot-auto':                  'claude-sonnet-4-5',
  'copilot-openai-auto':           'gpt-5.3-codex',
  'copilot-anthropic-auto':        'claude-sonnet-4-5',
  'ibm-bob-auto':                  'claude-sonnet-4-5',
  'kiro-auto':                     'claude-sonnet-4-5',
  'cline-auto':                    'claude-sonnet-4-5',
  'openclaw-auto':                 'claude-sonnet-4-5',
  'qwen-auto':                     'claude-sonnet-4-5',
  'kimi-auto':                     'kimi-k2-thinking',
  'kimi-code':                     'kimi-k2-thinking',
  'kimi-for-coding':               'kimi-k2-thinking',
  'mimo-v2-flash':                 'xiaomi/mimo-v2-flash',
  'kat-coder-pro-v1':              'kwaipilot/kat-coder-pro',
  // ZCode / Hermes run GLM-5.2 (both spellings). Not yet in the bundled
  // snapshot; price via the GLM-5.1 sibling `glm-5` so cost isn't $0. resolveAlias
  // lowercases before lookup, so the lowercase entry also covers 'GLM-5.2'. (#537/#544/#545)
  'GLM-5.2':                        'glm-5',
  'glm-5.2':                        'glm-5',
  // Grok Build's own id (`grok-build`/`grok-build-0.1`) isn't in LiteLLM, so
  // upstream's alias resolves to $0. Price via grok-code-fast-1 — xAI's coding
  // model that Grok Build runs on — so the default model isn't silently free.
  // Still flagged costIsEstimated. (#521, corrected)
  'grok-build':                    'grok-code-fast-1',
  'grok-build-0.1':                'grok-code-fast-1',
  // open-design records Codex models with an `openai-codex:` prefix that the
  // canonicalizer (slash-only) doesn't strip. (#559)
  'openai-codex:gpt-5.5':          'gpt-5.5',
  // Cursor emits dot-version tier-last names plus tier/reasoning suffixes
  // that LiteLLM does not index (`-high`, `-low`, `-medium`, `-thinking`,
  // `-high-thinking`, `-fast-mode`). Missing aliases here surface as $0 in
  // the dashboard for users on non-Auto models (issue #159). Sources: the
  // display map at `src/providers/cursor.ts:modelDisplayNames`, Cursor's
  // public model docs at https://cursor.com/docs/models, and forum bug
  // reports that quote literal slugs (e.g. forum.cursor.com/t/154933).
  'claude-4-sonnet':                'claude-sonnet-4',
  'claude-4-sonnet-1m':             'claude-sonnet-4',
  'claude-4.5-sonnet':              'claude-sonnet-4-5',
  'claude-4.6-sonnet':              'claude-sonnet-4-6',
  'claude-4.5-sonnet-thinking':     'claude-sonnet-4-5',
  'claude-4-sonnet-thinking':       'claude-sonnet-4-5',
  'claude-4-opus':                  'claude-opus-4-5',
  'claude-4.5-opus-high-thinking':  'claude-opus-4-5',
  'gpt-4.1':                        'gpt-4.1',
  'gpt-5.2-low':                    'gpt-5',
  'gpt-5.1-codex-high':             'gpt-5.3-codex',
  // Antigravity Gemini model IDs resolve to preview-priced entries.
  'gemini-3.1-pro':                 'gemini-3.1-pro-preview',
  'gemini-3-flash':                 'gemini-3-flash-preview',
  'gemini-3.1-pro-high':            'gemini-3.1-pro-preview',
  'gemini-3.1-pro-low':             'gemini-3.1-pro-preview',
  'gemini-3-flash-agent':           'gemini-3-flash-preview',
  'gemini-3-pro':                   'gemini-3-pro-preview',
  'gemini-3.1-flash-image':         'gemini-3.1-flash-image-preview',
  'gemini-3.1-flash-lite':          'gemini-3.1-flash-lite-preview',
  // Gemini 3.5 Flash thinking variants (upstream PR #377). Resolve to the
  // canonical id; pricing applies once LiteLLM indexes it (the bundled
  // snapshot does not yet ship a gemini-3.5-flash entry).
  'gemini-3.5-flash-high':          'gemini-3.5-flash',
  'gemini-3.5-flash-medium':        'gemini-3.5-flash',
  'gemini-3.5-flash-low':           'gemini-3.5-flash',
  'Gemini 3.5 Flash (High)':        'gemini-3.5-flash',
  'Gemini 3.5 Flash (Medium)':      'gemini-3.5-flash',
  'Gemini 3.5 Flash (Low)':         'gemini-3.5-flash',
}

let userAliases: Record<string, string> = {}
let userPriceOverrides: Map<string, ModelCosts> = new Map()
let userPriceOverridesConfig: Record<string, PriceOverrideRates> = {}
let sortedPriceOverrideKeys: string[] | null = null
let lowercasePriceOverrideIndex: Map<string, ModelCosts> | null = null

// Called once during CLI startup after config is loaded.
// User aliases take precedence over built-ins.
export function setModelAliases(aliases: Record<string, string>): void {
  userAliases = aliases
}

// USD-per-1M -> USD/token, clamped through the same safePerTokenRate guard the
// snapshot/LiteLLM paths use so a hand-edited config can't cascade NaN/negatives.
function priceOverrideRatePerToken(usdPerMillion: number | undefined): number | null {
  if (typeof usdPerMillion !== 'number') return null
  return safePerTokenRate(usdPerMillion / 1_000_000)
}

// Called once during CLI startup after config is loaded.
// Config/CLI rates are USD per 1,000,000 tokens; ModelCosts stores USD/token.
export function setPriceOverrides(overrides: Record<string, PriceOverrideRates>): void {
  const next = new Map<string, ModelCosts>()
  const nextConfig: Record<string, PriceOverrideRates> = {}
  for (const [model, rates] of Object.entries(overrides)) {
    if (!model || !rates || typeof rates !== 'object') continue
    nextConfig[model] = { ...rates }
    const input = priceOverrideRatePerToken(rates.input)
    const output = priceOverrideRatePerToken(rates.output)
    if (input === null || output === null) continue
    const cacheCreation = priceOverrideRatePerToken(rates.cacheCreation)
    const cacheRead = priceOverrideRatePerToken(rates.cacheRead)
    // Build ModelCosts inline (mirrors loadSnapshot): default cache-write from
    // 1.25× input and cache-read from 0.1× input when the override omits them.
    next.set(model, {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheWriteCostPerToken: cacheCreation ?? input * 1.25,
      cacheWrite1hCostPerToken: input * 2,
      cacheReadCostPerToken: cacheRead ?? input * 0.1,
      webSearchCostPerRequest: WEB_SEARCH_COST,
      fastMultiplier: 1,
    })
  }
  userPriceOverrides = next
  userPriceOverridesConfig = nextConfig
  sortedPriceOverrideKeys = null
  lowercasePriceOverrideIndex = null
}

function getSortedPriceOverrideKeys(): string[] {
  if (sortedPriceOverrideKeys === null) {
    sortedPriceOverrideKeys = Array.from(userPriceOverrides.keys()).sort((a, b) => b.length - a.length)
  }
  return sortedPriceOverrideKeys
}

function getLowercasePriceOverrideIndex(): Map<string, ModelCosts> {
  if (lowercasePriceOverrideIndex === null) {
    lowercasePriceOverrideIndex = new Map()
    for (const [key, costs] of userPriceOverrides) {
      const lk = key.toLowerCase()
      if (!lowercasePriceOverrideIndex.has(lk)) lowercasePriceOverrideIndex.set(lk, costs)
    }
  }
  return lowercasePriceOverrideIndex
}

function getPriceOverrideExact(...keys: string[]): ModelCosts | null {
  for (const key of keys) {
    const costs = userPriceOverrides.get(key)
    if (costs) return costs
  }
  return null
}

function getPriceOverridePrefix(canonical: string): ModelCosts | null {
  for (const key of getSortedPriceOverrideKeys()) {
    if (canonical.startsWith(key + '-') || canonical === key) {
      return userPriceOverrides.get(key)!
    }
  }
  return null
}

function getPriceOverrideCaseInsensitive(canonical: string, withPrefix: string): ModelCosts | null {
  const lowerIndex = getLowercasePriceOverrideIndex()
  return lowerIndex.get(canonical.toLowerCase()) ?? lowerIndex.get(withPrefix.toLowerCase()) ?? null
}

// Deterministic fingerprint of the configured overrides. Used by the daily
// cache to invalidate when override rates change (config values, not the
// per-token ModelCosts, so the empty-override hash stays '').
export function getPriceOverridesConfigHash(): string {
  // Control-char field (0x01) / record (0x02) separators so a value that
  // contains a plain delimiter can't forge a hash collision. Matches the
  // getLocalModelSavingsConfigHash convention upstream.
  const FIELD_SEP = String.fromCharCode(1)
  const RECORD_SEP = String.fromCharCode(2)
  // The builtin composer overrides participate so that editing
  // BUILTIN_PRICE_OVERRIDES in a release invalidates cached daily costs the
  // same way a user override does — otherwise days finalized under the old
  // composer pricing (Sonnet proxy rates) would never be recomputed.
  const builtin = `builtin${FIELD_SEP}${JSON.stringify(BUILTIN_PRICE_OVERRIDES)}`
  const keys = Object.keys(userPriceOverridesConfig).sort()
  if (keys.length === 0) return builtin
  const parts = keys.map(k => {
    const rates = userPriceOverridesConfig[k]!
    return [
      k,
      rates.input,
      rates.output,
      rates.cacheRead ?? '',
      rates.cacheCreation ?? '',
    ].join(FIELD_SEP)
  })
  return [builtin, ...parts].join(RECORD_SEP)
}

function resolveAlias(model: string): string {
  if (Object.hasOwn(userAliases, model)) return userAliases[model]!
  if (Object.hasOwn(BUILTIN_ALIASES, model)) return BUILTIN_ALIASES[model]!
  const lowercase = model.toLowerCase()
  if (lowercase !== model && Object.hasOwn(BUILTIN_ALIASES, lowercase)) return BUILTIN_ALIASES[lowercase]!
  return model
}
function getCanonicalName(model: string): string {
  return model
    .replace(/@.*$/, '')       // strip pin: claude-sonnet-4-6@20250929 -> claude-sonnet-4-6
    .replace(/-\d{8}$/, '')   // strip date: claude-sonnet-4-20250514 -> claude-sonnet-4
    .replace(/^[^/]+\//, '') // strip provider prefix: anthropic/foo -> foo
}

// Some models are indexed by LiteLLM under a base id but reported with a
// pricing-equivalent suffix (`:thinking`, `:cloud`, `-TEE`). Strip a known
// suffix so the base entry is found instead of falling through to $0. (#634)
function stripKnownPricingVariantSuffix(model: string): string | null {
  const withoutColonSuffix = model.replace(/:(thinking|cloud)$/i, '')
  if (withoutColonSuffix !== model) return withoutColonSuffix

  const withoutTeeSuffix = model.replace(/-TEE$/i, '')
  if (withoutTeeSuffix !== model) return withoutTeeSuffix

  return null
}

export function getModelCosts(model: string): ModelCosts | null {
  // Try with provider prefix preserved (azure/gpt-5.4, openrouter/anthropic/claude-opus-4.6)
  const withPrefix = model.replace(/@.*$/, '').replace(/-\d{8}$/, '')
  const canonicalName = getCanonicalName(model)
  const canonical = resolveAlias(canonicalName)

  // A user price override is authoritative: it must win over snapshot/LiteLLM
  // pricing and over configured aliases. Checked exact-first (raw model,
  // prefixed, pre-alias canonical, resolved canonical) before any cache hit.
  const override = getPriceOverrideExact(model, withPrefix, canonicalName, canonical)
  if (override) return override

  if (pricingCache.has(withPrefix)) return pricingCache.get(withPrefix)!

  if (pricingCache.has(canonical)) return pricingCache.get(canonical)!

  // Prefix override before the sorted-key snapshot scan, so `gpt-5` overrides
  // `gpt-5-foo` — but only after the exact snapshot checks above, so a more
  // specific snapshot entry (`gpt-5-mini`) still wins for its own id.
  const prefixOverride = getPriceOverridePrefix(canonical)
  if (prefixOverride) return prefixOverride

  // Iterate keys longest-first so a model id like `gpt-5-mini` matches the
  // `gpt-5-mini` entry rather than collapsing to the shorter `gpt-5` entry
  // due to dictionary insertion order.
  for (const key of getSortedPricingKeys()) {
    if (canonical.startsWith(key + '-') || canonical === key) {
      return pricingCache.get(key)!
    }
  }

  // Case-insensitive override as a last resort before falling through to the
  // suffix-variant retry and $0. Never changes an exact/prefix match above.
  const caseInsensitiveOverride = getPriceOverrideCaseInsensitive(canonical, withPrefix)
  if (caseInsensitiveOverride) return caseInsensitiveOverride

  // Last resort: strip a known pricing-equivalent suffix (`:thinking`,
  // `:cloud`, `-TEE`) and re-resolve, so a variant prices like its base
  // instead of falling through to $0. (#634)
  const withPrefixVariant = stripKnownPricingVariantSuffix(withPrefix)
  if (withPrefixVariant && withPrefixVariant !== withPrefix) {
    const variantCosts = getModelCosts(withPrefixVariant)
    if (variantCosts) return variantCosts
  }

  const canonicalVariant = stripKnownPricingVariantSuffix(canonical)
  if (canonicalVariant && canonicalVariant !== canonical && canonicalVariant !== withPrefixVariant) {
    const variantCosts = getModelCosts(canonicalVariant)
    if (variantCosts) return variantCosts
  }

  return null
}

// Warn at most once per unknown model name per process. Without this, a model
// missing from the pricing snapshot would silently price at $0 for every
// session that used it, hiding real spend until the user noticed.
const warnedUnknownModels = new Set<string>()

/// Heuristic for "this looks like a local model that will never be in LiteLLM's
/// pricing JSON". We suppress the unknown-model warning for these because the
/// "update codeburn" advice can't help — local Ollama models, llama.cpp tags,
/// LM Studio loads, etc. are billed locally and don't have public pricing.
/// Users still get $0 in cost reports for them (correct — local inference is
/// effectively free); the warning was just noise.
function looksLikeLocalModel(name: string): boolean {
  // Ollama and LM Studio tags include `:tag` (e.g. qwen3.6:35b-a3b-bf16).
  if (name.includes(':') && !name.startsWith('http')) return true
  // GGUF / quantized fingerprints commonly seen in local inference.
  if (/[-_](q[2-8](_[a-z0-9]+)?|bf16|fp16|gguf|f16|f32)$/i.test(name)) return true
  return false
}

function shouldWarnAboutUnknownModel(name: string): boolean {
  if (!name || name === '<synthetic>') return false
  if (warnedUnknownModels.has(name)) return false
  // Suppress for local/quantized models — the "update codeburn" hint is
  // actively misleading there. Users who need cost visibility for local
  // inference can still set an alias via `codeburn model-alias`.
  if (looksLikeLocalModel(name)) return false
  // The warning fired on every CLI invocation (including the default
  // dashboard) which made first launches look broken — three "no pricing
  // data" lines greet a user before the dashboard even draws. Now opt-in
  // via --verbose. The unknown model still costs $0 in reports; users who
  // suspect missing models run `codeburn --verbose` to see the list.
  if (process.env['CODEBURN_VERBOSE'] !== '1') return false
  return true
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  /**
   * 5-minute ephemeral cache writes (priced at 1.25× input). For backward
   * compatibility, callers that don't yet split by TTL pass the entire
   * cache_creation total here and 0 for `cacheCreationTokens1h` — that
   * preserves old behaviour byte-for-byte.
   */
  cacheCreationTokens: number,
  cacheReadTokens: number,
  webSearchRequests: number,
  speed: 'standard' | 'fast' = 'standard',
  /**
   * Portion of `cacheCreationTokens` that was written to the 1-hour cache
   * tier. Default 0 so callers that predate the cache-tier split keep
   * compiling and produce the same total. Anthropic prices 1h cache
   * writes at 1.6× the 5-minute write rate.
   */
  oneHourCacheCreationTokens = 0,
): number {
  const costs = getModelCosts(model)
  if (!costs) {
    if (shouldWarnAboutUnknownModel(model)) {
      warnedUnknownModels.add(model)
      // Strip control characters and cap length: model names come from JSONL
      // payloads written by external tools, so a hostile or corrupt file
      // could embed terminal escape sequences here.
      const safeName = model.replaceAll(/[\x00-\x1F\x7F-\x9F]/g, '?').slice(0, 200)
      const aliasHint = `Map it with: codeburn model-alias "${safeName}" <known-model>`
      process.stderr.write(
        `codeburn: no pricing data for model "${safeName}" — costs for this model will show $0. ` +
        `${aliasHint}, or update with: npx @soumyadebroy3/codeburn@latest.\n`
      )
    }
    return 0
  }

  const multiplier = speed === 'fast' ? costs.fastMultiplier : 1

  // Clamp negative inputs to 0. A corrupt JSONL that emits a negative token
  // count would otherwise produce a negative cost that silently subtracts
  // from real spend in aggregate totals. NaN is also handled here; the
  // arithmetic below short-circuits to 0 when any operand is non-finite.
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0)
  const safeOneHourCacheCreation = safe(oneHourCacheCreationTokens)
  const safeCacheCreation = Math.max(safe(cacheCreationTokens), safeOneHourCacheCreation)
  const safeFiveMinuteCacheCreation = Math.max(0, safeCacheCreation - safeOneHourCacheCreation)

  return multiplier * (
    safe(inputTokens) * costs.inputCostPerToken +
    safe(outputTokens) * costs.outputCostPerToken +
    // 1h portion priced at 1.6× the 5m write rate; 5m portion = total - 1h.
    // Previously double-counted 1h tokens by adding (total × 5m) + (1h × 2× input).
    safeFiveMinuteCacheCreation * costs.cacheWriteCostPerToken +
    safeOneHourCacheCreation * costs.cacheWriteCostPerToken * ONE_HOUR_CACHE_WRITE_MULTIPLIER_FROM_FIVE_MINUTE_RATE +
    safe(cacheReadTokens) * costs.cacheReadCostPerToken +
    safe(webSearchRequests) * costs.webSearchCostPerRequest
  )
}

const autoModelNames: Record<string, string> = {
  'cursor-auto': 'Cursor (auto)',
  'cursor-agent-auto': 'Cursor (auto)',
  'copilot-auto': 'Copilot (auto)',
  'copilot-openai-auto': 'Copilot (OpenAI)',
  'copilot-anthropic-auto': 'Copilot (Anthropic)',
  'ibm-bob-auto': 'IBM Bob (auto)',
  'kiro-auto': 'Kiro (auto)',
  'cline-auto': 'Cline (auto)',
  'openclaw-auto': 'OpenClaw (auto)',
  'qwen-auto': 'Qwen (auto)',
  'kimi-auto': 'Kimi (auto)',
}

const SHORT_NAMES: Record<string, string> = {
  // ZCode/Hermes GLM-5.2 resolves to the priced `glm-5` sibling; label it. (#537)
  'glm-5': 'GLM-5',
  // TEMP (2026-06-09): until deriveClaudeShortName or LiteLLM cover them. (upstream #463)
  'claude-fable-5': 'Fable 5',
  'claude-mythos-5': 'Mythos 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-5': 'Opus 4.5',
  'claude-opus-4-1': 'Opus 4.1',
  'claude-opus-4': 'Opus 4',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4': 'Sonnet 4',
  'claude-3-7-sonnet': 'Sonnet 3.7',
  'claude-3-5-sonnet': 'Sonnet 3.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-3-5-haiku': 'Haiku 3.5',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
  'gpt-4.1-nano': 'GPT-4.1 Nano',
  'gpt-4.1-mini': 'GPT-4.1 Mini',
  'gpt-4.1': 'GPT-4.1',
  'codex-auto-review': 'Codex Auto Review',
  'gpt-5.5-pro': 'GPT-5.5 Pro',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4-pro': 'GPT-5.4 Pro',
  'gpt-5.4-nano': 'GPT-5.4 Nano',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.3': 'GPT-5.3',
  'gpt-5.2-pro': 'GPT-5.2 Pro',
  'gpt-5.2-low': 'GPT-5.2 Low',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini',
  'gpt-5.1-codex': 'GPT-5.1 Codex',
  'gpt-5.1': 'GPT-5.1',
  'gpt-5-pro': 'GPT-5 Pro',
  'gpt-5-nano': 'GPT-5 Nano',
  'gpt-5-mini': 'GPT-5 Mini',
  'gpt-5': 'GPT-5',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
  'gemini-3-flash-preview': 'Gemini 3 Flash',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'kimi-k2-thinking-turbo': 'Kimi K2 Thinking Turbo',
  'kimi-k2-thinking': 'Kimi K2 Thinking',
  'kimi-thinking-preview': 'Kimi Thinking',
  'kimi-k2.6': 'Kimi K2.6',
  'kimi-k2.5': 'Kimi K2.5',
  'kimi-k2p5': 'Kimi K2.5',
  'kimi-k2-instruct': 'Kimi K2 Instruct',
  'kimi-k2-0905': 'Kimi K2',
  'kimi-k2': 'Kimi K2',
  'kimi-latest': 'Kimi Latest',
  'moonshot-v1': 'Moonshot v1',
  'deepseek-v4-pro': 'DeepSeek v4 Pro',
  'deepseek-v4-flash': 'DeepSeek v4 Flash',
  'deepseek-coder-max': 'DeepSeek Coder Max',
  'deepseek-coder': 'DeepSeek Coder',
  'deepseek-r1': 'DeepSeek R1',
  'o4-mini': 'o4-mini',
  'o3': 'o3',
  'MiniMax-M2.7-highspeed': 'MiniMax M2.7 Highspeed',
  'MiniMax-M2.7': 'MiniMax M2.7',
}

// Sorted longest-first so more-specific prefixes match before shorter ones.
// Without this, `gpt-5-mini` could resolve to "GPT-5" (the entry for `gpt-5`)
// if it happened to be iterated before `gpt-5-mini`, hiding a distinct model
// behind the wrong display name and pricing tier.
const SORTED_SHORT_NAMES: [string, string][] = Object.entries(SHORT_NAMES)
  .sort((a, b) => b[0].length - a[0].length)

export function getShortModelName(model: string): string {
  if (autoModelNames[model]) return autoModelNames[model]
  const canonical = resolveAlias(getCanonicalName(model))
  for (const [key, name] of SORTED_SHORT_NAMES) {
    if (canonical.startsWith(key)) return name
  }
  return canonical
}
