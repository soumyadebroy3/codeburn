/**
 * Plan presence detection across the AI tools codeburn supports.
 *
 * Codeburn does NOT auto-detect plan tiers — every supported provider
 * requires the user to run `codeburn plan set --provider <X> <plan-id>`
 * once for the subscriptions they actually have. The first-run UX is
 * uniform (no special-casing for Claude, no Keychain dialog, no magic).
 *
 * This module's only job is "what AI tools does the user actually use?"
 * For each subscription-tiered provider with session data on disk and no
 * plan configured, we surface a hint card with the exact command to run.
 *
 * BYOK / pay-as-you-go tools (Goose, OpenCode, Roo Code, Kilo Code, Pi,
 * OMP, Droid, Qwen, OpenClaw, Gemini) deliberately produce no banner and
 * no hint — their "API-equivalent spend" IS the bill.
 */

import type { Plan, PlanId } from './config.js'
import { planDisplayName } from './plans.js'

/** A provider we know the user has used (sessions on disk) but whose plan tier we cannot determine offline. */
export type ProviderPresence = {
  provider: string
  displayName: string
  /** Suggested preset id if the user runs `codeburn plan set` later. */
  suggestedPresetIds: PlanId[]
}

export type DetectionResult = {
  presenceOnly: ProviderPresence[]
}

// ────────────────────────────────────────────────────────────────────────────
// Presence detection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Every provider with subscription tiers worth recommending gets an entry
 * here. The user sets their plan with one explicit command per
 * subscription — no magic, no surprise dialogs.
 */
const PRESENCE_SUGGESTIONS: Record<string, PlanId[]> = {
  claude:       ['claude-pro', 'claude-max', 'claude-max-5x'],
  codex:        ['codex-plus', 'codex-pro'],
  cursor:       ['cursor-pro', 'cursor-business'],
  'cursor-agent': ['cursor-pro', 'cursor-business'],
  copilot:      ['copilot-pro', 'copilot-business', 'copilot-enterprise'],
  kiro:         ['kiro-pro'],
  antigravity:  ['antigravity-pro'],
}

const PROVIDERS_WITH_NO_SUBSCRIPTION = new Set([
  'goose', 'opencode', 'roo-code', 'kilo-code', 'pi', 'omp',
  'droid', 'qwen', 'openclaw', 'gemini',
])

/**
 * Probe whether the user has any session data for a given provider. Uses
 * the existing `discoverSessions()` interface so detection is
 * implementation-agnostic — we don't need to know where each tool stores
 * its files.
 */
async function providerHasAnySessions(name: string): Promise<boolean> {
  try {
    const { getAllProviders } = await import('./providers/index.js')
    const all = await getAllProviders()
    const provider = all.find(p => p.name === name)
    if (!provider) return false
    const sources = await provider.discoverSessions()
    return sources.length > 0
  } catch {
    return false
  }
}

export async function detectPresenceOnly(
  alreadyConfiguredProviders: Set<string>,
): Promise<ProviderPresence[]> {
  const presence: ProviderPresence[] = []
  for (const [providerName, suggestedPresetIds] of Object.entries(PRESENCE_SUGGESTIONS)) {
    if (PROVIDERS_WITH_NO_SUBSCRIPTION.has(providerName)) continue
    if (alreadyConfiguredProviders.has(providerName)) continue
    if (!(await providerHasAnySessions(providerName))) continue
    presence.push({
      provider: providerName,
      displayName: providerDisplayName(providerName),
      suggestedPresetIds,
    })
  }
  return presence
}

function providerDisplayName(name: string): string {
  switch (name) {
    case 'claude':        return 'Claude Code'
    case 'codex':         return 'Codex (OpenAI)'
    case 'cursor':        return 'Cursor'
    case 'cursor-agent':  return 'Cursor Agent'
    case 'copilot':       return 'GitHub Copilot'
    case 'kiro':          return 'Kiro'
    case 'antigravity':   return 'Antigravity'
    default:              return name
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Top-level entry point
// ────────────────────────────────────────────────────────────────────────────

/**
 * Probe local session data and return providers that the user demonstrably
 * uses but hasn't yet set a plan for.
 *
 * `existingPlans` tells us which providers already have a plan configured
 * so we don't pester the user with hint cards for things they've set.
 */
export async function detectPlans(existingPlans: Record<string, Plan>): Promise<DetectionResult> {
  const configured = new Set<string>(Object.keys(existingPlans))
  const presenceOnly = await detectPresenceOnly(configured)
  return { presenceOnly }
}

/** Render a one-line hint per presence-only provider. */
export function presenceHintLines(presence: ProviderPresence[]): string[] {
  return presence.map(p => {
    const presets = p.suggestedPresetIds.map(planDisplayName).join(' / ')
    return `${p.displayName}: codeburn plan set --provider ${p.provider} <${p.suggestedPresetIds.join('|')}>  (${presets})`
  })
}
