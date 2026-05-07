import type { Plan, PlanId, PlanProvider } from './config.js'

export const PLAN_PROVIDERS: PlanProvider[] = ['all', 'claude', 'codex', 'cursor']
export const PLAN_IDS: PlanId[] = [
  'claude-pro', 'claude-max', 'claude-max-5x',
  'codex-plus', 'codex-pro',
  'cursor-pro', 'cursor-business',
  'copilot-pro', 'copilot-business', 'copilot-enterprise',
  'kiro-pro', 'antigravity-pro',
  'custom', 'none',
]

export const PRESET_PLANS: Record<string, Omit<Plan, 'setAt'>> = {
  'claude-pro':       { id: 'claude-pro',       monthlyUsd: 20,  provider: 'claude', resetDay: 1 },
  'claude-max':       { id: 'claude-max',       monthlyUsd: 200, provider: 'claude', resetDay: 1 },
  'claude-max-5x':    { id: 'claude-max-5x',    monthlyUsd: 100, provider: 'claude', resetDay: 1 },
  // Codex (ChatGPT) plans. ChatGPT Plus = $20/mo with limited Codex; Pro = $200/mo with heavier quota.
  'codex-plus':       { id: 'codex-plus' as PlanId, monthlyUsd: 20,  provider: 'codex', resetDay: 1 },
  'codex-pro':        { id: 'codex-pro' as PlanId,  monthlyUsd: 200, provider: 'codex', resetDay: 1 },
  // Cursor plans
  'cursor-pro':       { id: 'cursor-pro',       monthlyUsd: 20,  provider: 'cursor', resetDay: 1 },
  'cursor-business':  { id: 'cursor-business' as PlanId, monthlyUsd: 40, provider: 'cursor', resetDay: 1 },
  // GitHub Copilot
  'copilot-pro':        { id: 'copilot-pro' as PlanId,        monthlyUsd: 10, provider: 'all', resetDay: 1 },
  'copilot-business':   { id: 'copilot-business' as PlanId,   monthlyUsd: 19, provider: 'all', resetDay: 1 },
  'copilot-enterprise': { id: 'copilot-enterprise' as PlanId, monthlyUsd: 39, provider: 'all', resetDay: 1 },
  // Other tools — best-effort prices, override with `codeburn plan set --provider <p> --monthly <usd>`.
  'kiro-pro':          { id: 'kiro-pro' as PlanId,          monthlyUsd: 20, provider: 'all', resetDay: 1 },
  'antigravity-pro':   { id: 'antigravity-pro' as PlanId,   monthlyUsd: 20, provider: 'all', resetDay: 1 },
}

export function isPlanProvider(value: string): value is PlanProvider {
  return PLAN_PROVIDERS.includes(value as PlanProvider)
}

export function isPlanId(value: string): value is PlanId {
  return PLAN_IDS.includes(value as PlanId)
}

export function getPresetPlan(id: string): Omit<Plan, 'setAt'> | null {
  if (id in PRESET_PLANS) {
    return PRESET_PLANS[id as keyof typeof PRESET_PLANS]
  }
  return null
}

const DISPLAY_NAMES: Record<string, string> = {
  'claude-pro':         'Claude Pro',
  'claude-max':         'Claude Max 20x',
  'claude-max-5x':      'Claude Max 5x',
  'codex-plus':         'ChatGPT Plus (Codex)',
  'codex-pro':          'ChatGPT Pro (Codex)',
  'cursor-pro':         'Cursor Pro',
  'cursor-business':    'Cursor Business',
  'copilot-pro':        'GitHub Copilot Pro',
  'copilot-business':   'GitHub Copilot Business',
  'copilot-enterprise': 'GitHub Copilot Enterprise',
  'kiro-pro':           'Kiro Pro',
  'antigravity-pro':    'Antigravity Pro',
  custom:               'Custom',
  none:                 'None',
}

export function planDisplayName(id: PlanId | string): string {
  return DISPLAY_NAMES[id] ?? id
}
